"use strict";

// Shared by the popup, task page, and renderer; no third-party runtime code.
globalThis.BWMUtils = (() => {
  const DEFAULTS = {
    modelSiteId: "", modelVision: "false",
    modelApi: "", modelKey: "", modelName: "", platform: "bilibili", uid: "", douyinAuthor: "",
    to: "", from: "", smtpPass: "", smtpHost: "", smtpPort: "465", relayUrl: "https://bili-watch-mail-relay.jrjbasjd.workers.dev", relayKey: "", intervalHours: "6", lecture: "false",
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const emailOK = value => typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);

  function endpoint(value, label, allowLoopback = false) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${label}不是有效网址`); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(allowLoopback && local && url.protocol === "http:")) {
      throw new Error(`${label}必须使用 HTTPS${allowLoopback ? "（仅本机模型可用 HTTP）" : ""}`);
    }
    if (url.username || url.password || url.hash || url.search) throw new Error(`${label}请勿包含账号、密钥、查询参数或 # 片段`);
    return url.href.replace(/\/+$/, "");
  }

  function douyinUid(value) {
    const input = String(value || "").trim();
    if (/^https?:/i.test(input)) {
      let u;
      try { u = new URL(input); } catch { throw new Error("抖音主页链接无效"); }
      if (!["douyin.com", "www.douyin.com"].includes(u.hostname)) throw new Error("请填写 douyin.com 的作者主页");
      const m = u.pathname.match(/^\/user\/([\w.-]+)\/?$/);
      if (!m) throw new Error("抖音主页链接应包含 /user/sec_uid");
      return m[1];
    }
    if (!/^[\w.-]{6,200}$/.test(input)) throw new Error("抖音 sec_uid 无效");
    return input;
  }

  function validateConfig(raw) {
    const cfg = {...DEFAULTS};
    for (const key of Object.keys(DEFAULTS)) if (raw[key] !== undefined) cfg[key] = String(raw[key]).trim();
    cfg.modelApi = endpoint(cfg.modelApi, "模型 API 地址", true);
    cfg.relayUrl = endpoint(cfg.relayUrl, "中继地址");
    if (cfg.modelSiteId && !/^[A-Za-z0-9_-]{1,80}$/.test(cfg.modelSiteId)) throw new Error("API 记录无效，请在管理页重新选择");
    for (const [key,label] of [["modelKey","模型 API Key"],["modelName","模型名"],["smtpPass","SMTP 授权码"]]) {
      if (key === "modelKey" || (key === "modelName" && !cfg.modelSiteId)) continue;
      if (!cfg[key] || /[\r\n]/.test(cfg[key])) throw new Error(`请填写有效的${label}`);
    }
    if (cfg.modelSiteId) cfg.modelKey = "";
    if (cfg.relayKey.length < 24 || /[^\x21-\x7e]/.test(cfg.relayKey)) throw new Error("中继密钥至少需要 24 个非空格 ASCII 字符，并与 Worker 的 ACCESS_KEY 一致");
    if (!emailOK(cfg.from) || !emailOK(cfg.to)) throw new Error("请填写有效的发件和收件邮箱（每项一个地址）");
    if (cfg.smtpHost && !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(cfg.smtpHost)) throw new Error("SMTP 服务器应填写域名，不含协议或端口");
    if (!["465", "587"].includes(cfg.smtpPort)) throw new Error("SMTP 端口仅支持 465 或 587");
    const hours = Number(cfg.intervalHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error("检查间隔应为 1 到 168 小时");
    if (cfg.platform === "bilibili") {
      if (!/^\d{1,20}$/.test(cfg.uid)) throw new Error("B 站 UID 应为数字");
    } else if (cfg.platform === "douyin") douyinUid(cfg.douyinAuthor);
    else throw new Error("不支持的监控平台");
    return cfg;
  }

  // Parse into an inert template, then build a fresh allowlisted tree. Never
  // attach untrusted nodes; even image URLs are discarded before insertion.
  function sanitizeReport(html) {
    if (typeof html !== "string" || html.length > 200000) throw new Error("报告 HTML 无效或过长");
    const template = document.createElement("template");
    template.innerHTML = html;
    const safe = document.createElement("div");
    const allowed = new Set("H2 H3 P UL OL LI TABLE THEAD TBODY TFOOT TR TH TD DIV SPAN STRONG EM B I BR BLOCKQUOTE CODE PRE".split(" "));
    const drop = new Set("SCRIPT STYLE IFRAME FRAME OBJECT EMBED LINK META BASE IMG SVG MATH VIDEO AUDIO SOURCE FORM INPUT BUTTON TEXTAREA SELECT TEMPLATE NOSCRIPT".split(" "));
    const classes = new Set(["ts", "quote", "formula", "card"]);
    let count = 0;
    function copy(node, parent, depth = 0) {
      if (++count > 15000 || depth > 80) throw new Error("报告结构过于复杂");
      if (node.nodeType === 3) { parent.appendChild(document.createTextNode(node.textContent)); return; }
      if (node.nodeType === 8) {
        if (/^FIG[1-5]$/.test(node.data)) parent.appendChild(document.createComment(node.data));
        return;
      }
      if (node.nodeType !== 1 || drop.has(node.tagName)) return;
      let target = parent;
      if (allowed.has(node.tagName)) {
        target = document.createElement(node.tagName.toLowerCase());
        const cls = (node.getAttribute("class") || "").split(/\s+/).filter(c => classes.has(c));
        if (cls.length) target.className = cls.join(" ");
        for (const attr of ["colspan", "rowspan"]) {
          const n = Number(node.getAttribute(attr));
          if (["TD","TH"].includes(node.tagName) && Number.isInteger(n) && n >= 1 && n <= 20) target.setAttribute(attr,String(n));
        }
        parent.appendChild(target);
      }
      for (const child of node.childNodes) copy(child, target, depth + 1);
    }
    for (const node of template.content.childNodes) copy(node, safe);
    return safe.innerHTML;
  }

  async function requestText(url, options = {}, timeoutMs = 120000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {...options, signal:controller.signal, redirect:"error", credentials:"omit"});
      const text = await response.text();
      return {ok:response.ok, status:response.status, text};
    } catch (error) {
      if (controller.signal.aborted) throw new Error("请求超时，请稍后重试");
      throw error;
    } finally { clearTimeout(timer); }
  }

  function validateModel(out, shotCount, wantLecture) {
    if (!out || typeof out !== "object" || Array.isArray(out)) throw new Error("模型输出必须是 JSON 对象");
    for (const key of ["reportHtml", "summary", "review"]) {
      if (typeof out[key] !== "string" || !out[key].trim() || out[key].length > (key === "reportHtml" ? 80000 : 12000)) throw new Error(`模型输出 ${key} 缺失、类型错误或过长`);
    }
    if (!Array.isArray(out.captions) || out.captions.length !== shotCount || out.captions.some(c => typeof c !== "string" || c.length > 1000)) throw new Error("模型图注数量或格式不正确");
    if (wantLecture) {
      const lec = out.lecture;
      if (!lec || typeof lec !== "object" || Array.isArray(lec)) throw new Error("讲解页 lecture 输出缺失");
      if (typeof lec.title !== "string" || !lec.title.trim() || lec.title.length > 200) throw new Error("讲解页标题无效");
      if (typeof lec.subtitle !== "string" || lec.subtitle.length > 300) throw new Error("讲解页副标题无效");
      if (!Array.isArray(lec.chapters) || lec.chapters.length < 2 || lec.chapters.length > 10) throw new Error("讲解页章节数应在 2~10 之间");
      for (const ch of lec.chapters) {
        if (!ch || typeof ch !== "object" || Array.isArray(ch)) throw new Error("讲解页章节无效");
        if (typeof ch.title !== "string" || !ch.title.trim() || ch.title.length > 120) throw new Error("讲解页章节标题无效");
        if (typeof ch.body !== "string" || !ch.body.trim() || ch.body.length > 6000) throw new Error("讲解页章节正文无效");
        if (ch.fig !== undefined && ch.fig !== null) {
          const n = Number(ch.fig);
          if (!Number.isInteger(n) || n < 1 || n > shotCount) throw new Error("讲解页图片序号超出截图范围");
        }
      }
    } else {
      delete out.lecture;
    }
    return {...out, reportHtml:sanitizeReport(out.reportHtml)};
  }
  return {DEFAULTS, escapeHtml, emailOK, endpoint, douyinUid, validateConfig, sanitizeReport, requestText, validateModel};
})();
