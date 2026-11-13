'use strict';
const $ = id => document.getElementById(id);
let state = null, currentLog = null, preferredDay = null, pollTimer, sequence = 0, viewerSequence = 0;
const unknownMail = status => ['unknown','delivery_unknown','sending_unknown'].includes(status);
const mailLabel = status => ({sent:'SMTP 已接受',accepted:'SMTP 已接受',updated:'旧版本已发送，更新版尚未发送',sending:'邮件发送中',queued:'邮件待发送',pending:'邮件待发送',failed:'发信失败',rejected:'发信失败',unknown:'投递待确认',delivery_unknown:'投递待确认',sending_unknown:'投递待确认',disabled:'未自动发送',not_sent:'未发送'}[status] || '未发送');
async function send(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({ type: 'daylog:' + type, ...fields });
  if (!result || result.ok === false) throw new Error(result?.error || '日报后台暂不可用，请重新加载扩展后重试');
  return result;
}
function setStatus(text, kind = 'info') {
  $('status').className = text ? 'status ' + kind : 'status hidden';
  $('status').textContent = text || '';
}
function localDay(offset = 0) {
  const date = new Date(); date.setDate(date.getDate() + offset);
  return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
}
function running(day) { return (state?.runningDays || []).includes(day); }

// Render supported Markdown using DOM text nodes. Model output never enters
// innerHTML, and only http(s) links become clickable.
function inlineMarkdown(parent, source) {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g;
  let start = 0, match;
  while ((match = pattern.exec(source))) {
    parent.append(document.createTextNode(source.slice(start, match.index)));
    let node;
    if (match[1]) {
      try {
        const url = new URL(match[2]);
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error('invalid link');
        node = document.createElement('a'); node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.textContent = match[1];
      } catch { node = document.createTextNode(match[0]); }
    } else {
      node = document.createElement(match[3] ? 'strong' : match[4] ? 'code' : 'em');
      node.textContent = match[3] || match[4] || match[5];
    }
    parent.append(node); start = pattern.lastIndex;
  }
  parent.append(document.createTextNode(source.slice(start)));
}
function renderMarkdown(markdown) {
  const body = document.createDocumentFragment(); let list;
  for (const raw of String(markdown || '').split('\n')) {
    const text = raw.trim();
    if (!text) { list = null; continue; }
    let node, match;
    if ((match = /^(#{1,4})\s+(.*)$/.exec(text))) { list = null; node = document.createElement('h' + match[1].length); inlineMarkdown(node, match[2]); }
    else if (/^[-*]\s+/.test(text)) {
      if (!list) { list = document.createElement('ul'); body.append(list); }
      node = document.createElement('li'); inlineMarkdown(node, text.replace(/^[-*]\s+/,'')); list.append(node); continue;
    } else if (/^(?:---|\*\*\*|___)$/.test(text)) { list = null; node = document.createElement('hr'); }
    else { list = null; node = document.createElement('p'); inlineMarkdown(node, text); }
    body.append(node);
  }
  return body;
}
function renderState() {
  $('today-pages').textContent = String(state.todayPages || 0);
  $('today-key-short').textContent = state.today || localDay();
  const settings = state.settings || {};
  $('capture-state').textContent = settings.captureEnabled ? '网页内容采集已开启' : '当前不采集新网页正文；仍可使用历史标题和网址生成日报。';
  $('auto-state').textContent = settings.autoEnabled ? '自动生成：每天 ' + (settings.summaryTime || '23:50') : '定时生成未开启；可手动生成日报。';
  $('email-state').textContent = settings.emailEnabled ? '生成成功后自动发送邮件（已开启）' : '生成后自动发送邮件（未开启）';
  $('gen-today').disabled = running(state.today || localDay());
  $('gen-yesterday').disabled = running(localDay(-1));
  const list = $('log-list'); list.replaceChildren();
  if (!state.logs?.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '暂无日报'; list.append(empty); }
  for (const log of state.logs || []) {
    const button = document.createElement('button'); button.className = 'log-item' + (currentLog?.day === log.day ? ' selected' : '');
    button.type = 'button'; button.dataset.day = log.day;
    const day = document.createElement('span'); day.className = 'day'; day.textContent = log.day;
    const meta = document.createElement('span'); meta.className = 'meta' + (log.error ? ' badge-err' : '');
    meta.textContent = running(log.day) ? '任务执行中…' : log.error ? '生成失败，点击查看' : (log.hasMarkdown ? (log.pageCount || 0) + ' 页 · ' + mailLabel(log.mailStatus) : '暂无内容');
    button.append(day,meta); button.addEventListener('click',()=>openLog(log.day).catch(e=>setStatus(e.message,'err'))); list.append(button);
  }
}
function renderViewer(rec) {
  $('viewer-title').textContent = '浏览日报 ' + rec.day;
  const count = Number.isFinite(rec.includedCount) ? rec.includedCount : null;
  $('viewer-meta').textContent = '记录 ' + (rec.pageCount || 0) + ' 页' + (count !== null ? '，其中 ' + count + ' 页进入总结' : '') + (rec.model ? ' · ' + rec.model : '');
  $('viewer-mail-status').textContent = mailLabel(rec.mailStatus) + (rec.mailError ? '：' + rec.mailError : '');
  $('close-viewer').classList.remove('hidden');
  $('viewer-actions').classList.toggle('hidden', !rec.markdown);
  const disabled = !rec.markdown || running(rec.day);
  $('send-mail').disabled = disabled || ['sent','accepted','sending','queued'].includes(rec.mailStatus);
  $('send-mail').textContent = ['sent','accepted'].includes(rec.mailStatus) ? '已发送' : rec.mailStatus === 'updated' ? '发送更新版到邮箱' : unknownMail(rec.mailStatus) ? '核对邮箱后重试' : rec.mailStatus === 'failed' || rec.mailStatus === 'rejected' ? '重试发送到邮箱' : '发送到邮箱';
  if (rec.error && !rec.markdown) { const p = document.createElement('p'); p.textContent = '生成失败：' + rec.error; $('viewer-body').replaceChildren(p); }
  else $('viewer-body').replaceChildren(renderMarkdown(rec.markdown));
  if(rec.markdown&&rec.jobError){const warning=document.createElement('p');warning.className='notice';warning.textContent='本次生成失败，下面显示上次成功报告：'+rec.jobError;$('viewer-body').prepend(warning);}
}
async function openLog(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('日报日期无效');
  const request = ++viewerSequence;
  const rec = await send('GET_LOG', { day });
  if (request !== viewerSequence) return;
  if (!rec?.day) throw Error('找不到此日期的日报，任务可能尚未完成');
  currentLog = rec; renderViewer(rec); renderState();
}
async function refresh() {
  const request = ++sequence;
  try {
    const latest = await send('STATE'); if (request !== sequence) return;
    state = latest; renderState();
    if (preferredDay && state.logs?.some(log=>log.day === preferredDay && log.hasMarkdown)) { const day = preferredDay; preferredDay = null; await openLog(day); }
    else if (currentLog) {
      if (!state.logs?.some(log=>log.day === currentLog.day)) closeViewer();
      else {
        const updated = await send('GET_LOG', {day:currentLog.day});
        if (request === sequence && currentLog && updated.day === currentLog.day && JSON.stringify(updated) !== JSON.stringify(currentLog)) { currentLog = updated; renderViewer(updated); }
        else if (currentLog) $('send-mail').disabled = running(currentLog.day) || ['sent','accepted','sending','queued'].includes(currentLog.mailStatus);
      }
    }
  } catch(error) { if (request === sequence) setStatus(error.message || '无法读取日报状态','err'); }
  finally {
    if (request === sequence) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(refresh, document.hidden ? 15000 : state?.runningDays?.length || state?.logs?.some(log=>['sending','queued'].includes(log.mailStatus)) ? 1500 : 5000);
    }
  }
}
function closeViewer() {
  viewerSequence++;
  currentLog = null; $('viewer-title').textContent = '报告预览'; $('viewer-meta').textContent = ''; $('viewer-mail-status').textContent = '';
  $('viewer-actions').classList.add('hidden'); $('close-viewer').classList.add('hidden');
  const p = document.createElement('p'); p.className = 'empty'; p.textContent = '选择左侧日期查看日报，或先生成一份。'; $('viewer-body').replaceChildren(p);
}
async function generate(day) {
  await send('GENERATE', { day }); preferredDay = day;
  setStatus('已启动 ' + day + ' 的日报任务，完成后可在此查看。','info'); await refresh();
}
async function sendMail() {
  if (!currentLog?.markdown) return;
  const day = currentLog.day, confirmUnknown = unknownMail(currentLog.mailStatus);
  if (confirmUnknown && !confirm('上次投递结果尚未确认。请先检查收件箱和垃圾邮件；再次发送可能产生重复邮件。已核对邮箱，仍要重试吗？')) return;
  await send('SEND_MAIL', { day, confirmUnknown });
  setStatus('已启动 ' + day + ' 的邮件任务，请查看日报投递状态。','info'); await refresh();
}
async function copyLog() {
  if (!currentLog?.markdown) return;
  await navigator.clipboard.writeText(currentLog.markdown); setStatus('日报已复制到剪贴板','ok');
}
function downloadLog() {
  if (!currentLog?.markdown) return;
  const url = URL.createObjectURL(new Blob([currentLog.markdown], {type:'text/markdown;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = '浏览日报-' + currentLog.day + '.md'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function action(id, task) {
  $(id).addEventListener('click',async()=>{
    $(id).disabled = true;
    try { await task(); } catch(error) { setStatus(error.message || '操作失败','err'); }
    finally { $(id).disabled = false; if (state) renderState(); if (currentLog) renderViewer(currentLog); }
  });
}
function open(path) { return chrome.tabs.create({url:chrome.runtime.getURL(path)}); }
document.addEventListener('DOMContentLoaded',()=>{
  action('open-options',()=>open('daylog/options.html'));
  action('open-api',()=>open('keydock/options.html'));
  action('open-mail',()=>open('daylog/options.html#mail-settings'));
  action('gen-today',()=>generate(state?.today || localDay()));
  action('gen-yesterday',()=>generate(localDay(-1)));
  action('send-mail',sendMail); action('copy-log',copyLog); action('download-log',downloadLog);
  $('close-viewer').addEventListener('click',closeViewer);
  refresh();
});
document.addEventListener('visibilitychange',()=>{ if (!document.hidden) { clearTimeout(pollTimer); refresh(); } });
window.addEventListener('beforeunload',()=>clearTimeout(pollTimer));
