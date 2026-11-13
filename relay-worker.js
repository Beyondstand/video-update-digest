/**
 * Cloudflare Worker HTTPS -> SMTP relay, v1.2.
 * Deploy this whole ES module. Set secret ACCESS_KEY (24+ ASCII characters).
 * Paste the same secret into the extension's relay-key field.
 * Optional SMTP_HOST: restrict requests to one SMTP hostname.
 * Supported: implicit TLS on 465; STARTTLS on 587; SMTP AUTH LOGIN.
 * Credentials are processed in memory and are never logged or stored.
 */
import {connect} from "cloudflare:sockets";

const MAX_BODY = 30 * 1024 * 1024;
const MAX_MIME_BASE64 = 28 * 1024 * 1024;

export async function smtpSend(payload, openSocket = connect, timeoutMs = 15000) {
  let socket, reader, writer, buffer="", submissionStarted=false, accepted=false;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const close = () => { try { void socket?.close().catch(() => {}); } catch {} };
  const deadline = setTimeout(close,90000);
  async function timed(operation, label, limit=timeoutMs) {
    let timer;
    try {
      return await Promise.race([operation,new Promise((_,reject) => {
        timer=setTimeout(() => { close(); reject(new Error(`${label}超时`)); },limit);
      })]);
    } finally { clearTimeout(timer); }
  }
  function streams() {
    void socket.closed?.catch(() => {});
    reader=socket.readable.getReader(); writer=socket.writable.getWriter(); buffer="";
  }
  async function reply(codes) {
    const until=Date.now()+timeoutMs;
    let firstCode=null;
    for (;;) {
      const end=buffer.indexOf("\r\n");
      if (end >= 0) {
        const line=buffer.slice(0,end); buffer=buffer.slice(end+2);
        const match=/^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) throw new Error("SMTP 响应格式无效");
        const code=Number(match[1]);
        if (firstCode === null) firstCode=code;
        if (code !== firstCode) throw new Error("SMTP 多行响应状态不一致");
        if (match[2] === " ") {
          if (!codes.includes(code)) throw Object.assign(new Error(`SMTP 拒绝请求（${code}）`),{smtpRejected:true});
          return code;
        }
        continue;
      }
      const remaining=until-Date.now();
      if (remaining <= 0) throw new Error("SMTP 读取超时");
      const chunk=await timed(reader.read(),"SMTP 读取",remaining);
      if (chunk.done) throw new Error("SMTP 连接提前关闭");
      buffer+=decoder.decode(chunk.value,{stream:true});
      if (buffer.length > 65536) throw new Error("SMTP 响应过长");
    }
  }
  const write = (text, limit=timeoutMs) => timed(writer.write(encoder.encode(text)),"SMTP 写入",limit);
  async function cmd(text,codes) { await write(text+"\r\n"); return reply(codes); }
  try {
    socket=openSocket({hostname:payload.host,port:payload.port},{secureTransport:payload.port === 465 ? "on" : "starttls",allowHalfOpen:false});
    streams();
    await reply([220]);
    await cmd("EHLO bwm-relay",[250]);
    if (payload.port === 587) {
      await cmd("STARTTLS",[220]);
      reader.releaseLock(); writer.releaseLock();
      socket=socket.startTls(); streams();
      await cmd("EHLO bwm-relay",[250]);
    }
    await cmd("AUTH LOGIN",[334]);
    await cmd(btoa(payload.user),[334]);
    await cmd(btoa(payload.pass),[235]);
    await cmd(`MAIL FROM:<${payload.from}>`,[250]);
    await cmd(`RCPT TO:<${payload.to}>`,[250,251]);
    await cmd("DATA",[354]);
    const mime=atob(payload.rawMimeBase64);
    const body=mime.replace(/\r?\n/g,"\r\n").replace(/(^|\r\n)\./g,"$1..");
    submissionStarted=true;
    await write(body.replace(/\r\n$/,"")+"\r\n.\r\n");
    try { await reply([250]); }
    catch(error) { if (error.smtpRejected) submissionStarted=false; throw error; }
    accepted=true;
    await write("QUIT\r\n",1000).catch(() => {});
    return {ok:true,reply:"queued"};
  } catch(error) {
    if (accepted) return {ok:true,reply:"queued"};
    return {ok:false,error:String(error.message || "SMTP 发送失败"),deliveryUnknown:submissionStarted};
  } finally {
    clearTimeout(deadline); close();
    try { reader?.releaseLock(); } catch {}
    try { writer?.releaseLock(); } catch {}
  }
}

async function boundedJson(request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) throw new Error("too large");
  const reader=request.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks=[]; let total=0;
  try {
    for (;;) {
      const part=await reader.read();
      if (part.done) break;
      total+=part.value.length;
      if (total > MAX_BODY) { await reader.cancel(); throw new Error("too large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(total); let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request,env) {
    const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization"};
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
    const failure=(error,status)=>json({ok:false,error,deliveryUnknown:false},status);
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:cors});
    if (request.method !== "POST") return failure("仅接受 POST",405);
    if (!env.ACCESS_KEY || env.ACCESS_KEY.length < 24) return failure("中继尚未配置有效 ACCESS_KEY",503);
    if (request.headers.get("Authorization") !== `Bearer ${env.ACCESS_KEY}`) return failure("中继密钥错误",403);
    let p;
    try { p=await boundedJson(request); } catch(e) { return failure("请求体无效或过大",e.message === "too large" ? 413 : 400); }
    if (!p || typeof p !== "object" || Array.isArray(p)) return failure("请求格式无效",400);
    const email = value => typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
    if (!email(p.from) || !email(p.to) || p.user !== p.from || typeof p.pass !== "string" || !/^[\x21-\x7e]{1,1024}$/.test(p.pass)) return failure("邮箱或 SMTP 凭据格式无效",400);
    if (typeof p.host !== "string" || !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(p.host) || /\.(local|localhost|internal)$/i.test(p.host)) return failure("SMTP 域名无效",400);
    if (env.SMTP_HOST && p.host.toLowerCase() !== env.SMTP_HOST.toLowerCase()) return failure("SMTP 服务器不在允许范围",403);
    p.port=Number(p.port || 465);
    if (![465,587].includes(p.port)) return failure("仅支持 SMTP 465/587",400);
    if (typeof p.rawMimeBase64 !== "string" || !p.rawMimeBase64.length || p.rawMimeBase64.length > MAX_MIME_BASE64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.rawMimeBase64)) return failure("邮件内容无效或过大",400);
    try { atob(p.rawMimeBase64); } catch { return failure("邮件 base64 无效",400); }
    const result=await smtpSend(p);
    return json(result,result.ok ? 200 : 502);
  },
};
