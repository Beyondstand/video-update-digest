"use strict";

const BWM = {
  host:null, canvas:null, ctx:null, width:0, height:0, viewportW:0, viewportH:0, covered:0,
  async setContent(html, requestedWidth = 900) {
    if (typeof html !== "string" || html.length > 30000000) throw new Error("报告内容无效或过大");
    // Only the authenticated task page supplies this document. Untrusted model
    // HTML was rebuilt using common.js's allowlist before reaching this point.
    this.host?.remove();
    const host = document.createElement("div");
    host.id = "__bwm_host";
    host.style.cssText = `width:${requestedWidth}px;margin:0;`;
    host.innerHTML = html;
    document.body.appendChild(host);
    this.host = host;
    await Promise.all([...host.querySelectorAll("img")].map(img => new Promise((resolve,reject) => {
      if (!/^data:image\/png;base64,/.test(img.getAttribute("src") || "")) { reject(new Error("报告含非本地截图")); return; }
      const finish = error => { clearTimeout(timer); img.onload = img.onerror = null; error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error("截图图片加载超时")),15000);
      img.onload = () => finish(); img.onerror = () => finish(new Error("截图图片无法解码"));
      if (img.complete) finish(img.naturalWidth ? null : new Error("截图图片无效"));
    })));
    await document.fonts.ready;
    const maxWidth = Math.floor(window.innerWidth);
    if (maxWidth < 320) throw new Error("工作窗口过窄，请增大窗口");
    // Layout adapts to narrow screens; wider windows are cropped, not squeezed.
    this.width = Math.min(requestedWidth,maxWidth);
    host.style.width = `${this.width}px`;
    document.body.style.width = `${this.width}px`;
    for (const element of host.querySelectorAll("table,pre")) element.style.maxWidth = "100%";
    for (const element of host.querySelectorAll("img")) {
      element.style.maxWidth = `${Math.min(this.width,element.naturalWidth)}px`;
      element.style.marginLeft = "auto"; element.style.marginRight = "auto";
    }
    await this.paint();
    this.height = document.documentElement.scrollHeight;
    this.viewportW = window.innerWidth; this.viewportH = window.innerHeight;
    if (host.scrollWidth > this.width + 1) throw new Error("报告存在横向溢出，请简化表格后重试");
    if (!this.height || this.height > 30000) throw new Error("报告过长（最多 30000 像素），未生成截断图片");
    const scale = Math.min(2,30000/this.height,Math.sqrt(24000000/(this.width*this.height)));
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.ceil(this.width*scale); this.canvas.height = Math.ceil(this.height*scale);
    this.ctx = this.canvas.getContext("2d");
    if (!this.ctx) throw new Error("无法创建报告画布");
    this.ctx.scale(scale,scale); this.ctx.fillStyle = "#f5f6f8"; this.ctx.fillRect(0,0,this.width,this.height);
    this.covered = 0;
    return this.dimensions();
  },
  paint() { return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); },
  dimensions() {
    const rect = this.host.getBoundingClientRect();
    return {width:this.width,height:document.documentElement.scrollHeight,viewportW:window.innerWidth,viewportH:window.innerHeight,y:window.scrollY,left:rect.left};
  },
  async scrollTo(y) {
    if (!this.host) throw new Error("报告未初始化");
    window.scrollTo(0,Math.max(0,y));
    await this.paint();
    return this.dimensions();
  },
  async appendSlice(slice) {
    if (!this.canvas || slice.viewportW !== this.viewportW || slice.viewportH !== this.viewportH || slice.height !== this.height) throw new Error("截图尺寸已改变");
    if (slice.y > this.covered + .5 || slice.y + slice.viewportH <= this.covered) throw new Error("截图覆盖不连续");
    const img = new Image();
    await new Promise((resolve,reject) => { img.onload=resolve; img.onerror=()=>reject(new Error("分片图片无效")); img.src=slice.dataUrl; });
    const sx = img.naturalWidth/slice.viewportW, sy = img.naturalHeight/slice.viewportH;
    if (Math.abs(sx-sy) > .03 || !Number.isFinite(sx) || sx <= 0) throw new Error("截图像素比例无效");
    const height = Math.min(slice.viewportH,this.height-slice.y);
    this.ctx.drawImage(img,slice.left*sx,0,this.width*sx,height*sy,0,slice.y,this.width,height);
    this.covered = slice.y+height;
    return {ok:true,covered:this.covered};
  },
  finish() {
    if (!this.canvas || this.covered < this.height) throw new Error("报告尚未截取完整");
    const maxBase64=Math.ceil(8*1024*1024/3)*4;
    let canvas=this.canvas;
    try {
      let png=canvas.toDataURL("image/png");
      for (let attempt=0;png.length-22>maxBase64&&attempt<5;attempt++) {
        const minimumWidth=Math.min(this.width,720);
        if (canvas.width<=minimumWidth) break;
        const ratio=Math.min(.85,Math.sqrt(maxBase64/(png.length-22))*.92);
        const next=document.createElement("canvas");
        next.width=Math.max(minimumWidth,Math.floor(canvas.width*ratio));
        next.height=Math.max(1,Math.round(canvas.height*next.width/canvas.width));
        const ctx=next.getContext("2d");
        if (!ctx) throw new Error("无法缩小邮件报告图片");
        ctx.drawImage(canvas,0,0,next.width,next.height);
        canvas.width=0;canvas.height=0;canvas=next;
        png=canvas.toDataURL("image/png");
      }
      if (!png.startsWith("data:image/png;base64,")) throw new Error("报告超过画布导出限制");
      if (png.length-22>maxBase64) throw new Error("完整报告图片仍超过 8 MiB，请减少截图或缩短报告");
      return {png};
    } finally {
      canvas.width=0;canvas.height=0;
      this.canvas.width=0;this.canvas.height=0;this.canvas=null;this.ctx=null;
    }
  },
};
window.BWM = BWM;
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg,sender,respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("runner.html")) return false;
    (async () => {
      if (msg?.type === "setContent") return BWM.setContent(msg.html,msg.width);
      if (msg?.type === "scrollTo") return BWM.scrollTo(msg.y);
      if (msg?.type === "appendSlice") return BWM.appendSlice(msg);
      if (msg?.type === "finish") return BWM.finish();
      throw new Error("未知渲染消息");
    })().then(respond,error => respond({error:error.message}));
    return true;
  });
}
