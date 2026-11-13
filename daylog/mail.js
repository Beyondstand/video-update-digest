"use strict";

// The daily report uses the same authenticated HTTPS -> SMTP relay as video
// reports. This module never reads or persists settings or delivery state.
globalThis.DayLogMail = (() => {
  const MAX_OUTER_BASE64 = 28 * 1024 * 1024;
  const fail = message => Object.assign(new Error(message), { deliveryUnknown: false });
  function base64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let i=0;i<bytes.length;i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
    return btoa(binary);
  }
  const fold = value => value.match(/.{1,76}/g)?.join("\r\n") || "";
  function subjectWord(subject) {
    const words=[]; let chunk="",size=0;
    for (const character of String(subject).replace(/[\r\n]/g," ")) {
      const length=new TextEncoder().encode(character).length;
      if (size+length>42) { words.push(`=?UTF-8?B?${base64(chunk)}?=`);chunk="";size=0; }
      chunk+=character;size+=length;
    }
    if (chunk) words.push(`=?UTF-8?B?${base64(chunk)}?=`);
    return words.join("\r\n ");
  }
  function buildMime(cfg, subject, markdown, messageId) {
    if (!BWMUtils.emailOK(cfg?.from) || !BWMUtils.emailOK(cfg?.to)) throw fail("请填写有效的发件和收件邮箱（每项一个地址）");
    if (typeof messageId!=="string" || !/^[A-Za-z0-9-]{1,80}$/.test(messageId)) throw fail("邮件消息 ID 无效");
    if (typeof subject!=="string" || !subject.trim() || subject.length>2000) throw fail("邮件主题无效或过长");
    if (typeof markdown!=="string" || !markdown.trim() || markdown.length>4000000) throw fail("日报内容为空或过长");
    const boundary="=_daylog_"+messageId.replace(/-/g,"");
    const mixed=boundary+"_mixed",alternative=boundary+"_alt";
    const date=subject.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    const filename=date ? `report-${date}.md` : "daily-report.md";
    const html=`<!doctype html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.8;color:#25323a"><h1 style="font-size:20px">${BWMUtils.escapeHtml(subject.replace(/[\r\n]/g," "))}</h1><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit">${BWMUtils.escapeHtml(markdown)}</pre><p style="font-size:12px;color:#687680">完整日报同时附为 Markdown 文件。</p></body></html>`;
    const lines=[
      `From: ${cfg.from}`,`To: ${cfg.to}`,`Subject: ${subjectWord(subject)}`,
      `Date: ${new Date().toUTCString().replace("GMT","+0000")}`,`Message-ID: <${messageId}@daylog.local>`,
      "MIME-Version: 1.0",`Content-Type: multipart/mixed; boundary="${mixed}"`,"",
      `--${mixed}`,`Content-Type: multipart/alternative; boundary="${alternative}"`,"",
      `--${alternative}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64","",fold(base64(markdown)),
      `--${alternative}`,"Content-Type: text/html; charset=UTF-8","Content-Transfer-Encoding: base64","",fold(base64(html)),
      `--${alternative}--`,"",`--${mixed}`,`Content-Type: text/markdown; charset=UTF-8; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,"Content-Transfer-Encoding: base64","",fold(base64(markdown)),
      `--${mixed}--`,""
    ];
    return lines.join("\r\n");
  }
  function mailSettings(cfg) {
    if (!cfg || typeof cfg!=="object") throw fail("请先配置邮件中继");
    if (!BWMUtils.emailOK(cfg.from) || !BWMUtils.emailOK(cfg.to)) throw fail("请填写有效的发件和收件邮箱（每项一个地址）");
    let relayUrl;
    try { relayUrl=BWMUtils.endpoint(cfg.relayUrl,"中继地址"); } catch(error) { throw fail(error.message); }
    if (typeof cfg.relayKey!=="string" || cfg.relayKey.length<24 || /[^\x21-\x7e]/.test(cfg.relayKey)) throw fail("请配置有效的中继密钥（至少 24 个字符）");
    if (typeof cfg.smtpPass!=="string" || !/^[\x21-\x7e]{1,1024}$/.test(cfg.smtpPass)) throw fail("请配置有效的 SMTP 授权码");
    const domain=cfg.from.split("@")[1].toLowerCase();
    const inferred={"163.com":"smtp.163.com","126.com":"smtp.126.com","qq.com":"smtp.qq.com","gmail.com":"smtp.gmail.com","outlook.com":"smtp.office365.com"};
    const host=cfg.smtpHost || inferred[domain] || "";
    if (typeof host!=="string" || !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(host)) throw fail("请配置有效的 SMTP 服务器域名");
    const port=Number(cfg.smtpPort || 465);
    if (![465,587].includes(port)) throw fail("SMTP 端口仅支持 465 或 587");
    return {relayUrl,host,port,from:cfg.from,to:cfg.to,smtpHost:host,smtpPort:String(port),smtpPass:cfg.smtpPass,relayKey:cfg.relayKey};
  }
  async function send(cfg, subject, markdown, messageId) {
    const settings=mailSettings(cfg);
    const rawMimeBase64=base64(buildMime(cfg,subject,markdown,messageId));
    if (rawMimeBase64.length>MAX_OUTER_BASE64) throw fail("邮件超过 28 MiB，请缩短日报");
    let response;
    try {
      response=await BWMUtils.requestText(settings.relayUrl,{
        method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+cfg.relayKey},
        body:JSON.stringify({host:settings.host,port:settings.port,user:cfg.from,pass:cfg.smtpPass,from:cfg.from,to:cfg.to,rawMimeBase64})
      },120000);
    } catch {
      throw Object.assign(new Error("中继连接中断，邮件是否发送未确认，请先检查邮箱"),{deliveryUnknown:true});
    }
    let result;
    try { result=JSON.parse(response.text); } catch { throw Object.assign(new Error("中继响应无效，邮件是否发送未确认"),{deliveryUnknown:true}); }
    if (!response.ok || result?.ok!==true) {
      const definite=[400,401,403,405,413,503].includes(response.status) || result?.deliveryUnknown===false;
      // Do not echo the relay's arbitrary error body, which may contain
      // credentials or report contents when a proxy returns a diagnostic.
      throw Object.assign(new Error(`日报邮件发送失败（中继 HTTP ${Number(response.status)||0}）${definite?"":"，请先核对邮箱"}`),{deliveryUnknown:!definite});
    }
    return {ok:true,smtpAccepted:true};
  }
  return {buildMime,send,mailSettings};
})();
