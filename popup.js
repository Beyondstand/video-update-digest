"use strict";
const FIELDS = Object.keys(BWMUtils.DEFAULTS);
const MODEL_FIELDS = new Set(["modelSiteId","modelApi","modelKey","modelName","modelVision"]);
let modelRefreshSequence = 0;
const $ = id => document.getElementById(id);
function syncPlatform() {
  const bili = $("platform").value === "bilibili";
  $("biliAuthorField").style.display = bili ? "" : "none";
  $("douyinAuthorField").style.display = bili ? "none" : "";
}
const configFromForm = model => BWMUtils.validateConfig({...Object.fromEntries(FIELDS.filter(key=>!MODEL_FIELDS.has(key)).map(key => [key,$(key).type === "checkbox" ? String($(key).checked) : $(key).value.trim()])),...model});
async function modelMessage(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({type:"keydock:"+type,...fields});
  if (!result?.ok) throw new Error(result?.error || "API 管理页暂不可用，请重新加载扩展");
  return result.data;
}
async function refreshModel() {
  const sequence = ++modelRefreshSequence;
  const state = await modelMessage("MODEL_STATE");
  if (sequence !== modelRefreshSequence) return;
  const select = $("modelProfile"); select.replaceChildren();
  const options = !state.selectedId ? [state.active,...state.options] : state.active.missing ? [...state.options,state.active] : state.active.legacy ? [state.active,...state.options.filter(item=>item.id)] : state.options;
  for (const item of options) {
    const option = new Option(item.label+(item.available ? "" : "（需录入 Key 或模型信息）"),item.id);
    option.disabled = !item.available; select.add(option);
  }
  select.value = state.selectedId;
  const active = state.active;
  $("modelStatus").textContent = active.available ? `${active.modelName} · ${active.modelApi}` : "所选 API 不可用，请打开管理页，填写自己的 API Key、模型地址和模型 ID，并点击“用于视频总结”。";
  $("modelStatus").style.color = active.available ? "" : "#b1473c";
}
function scopeFor(cfg) { return [cfg.platform,cfg.platform === "douyin" ? BWMUtils.douyinUid(cfg.douyinAuthor) : cfg.uid,cfg.to].join("|"); }
async function refreshLog() {
  const {logs=[],taskState,config={}} = await chrome.storage.local.get(["logs","taskState","config"]);
  $("status").textContent = logs.length ? logs.slice(-12).map(l=>`[${l.t}] ${l.m}`).join("\n") : "就绪";
  $("status").scrollTop=$("status").scrollHeight;
  let scope;
  try { scope=scopeFor({...BWMUtils.DEFAULTS,...config}); } catch { scope=""; }
  const jobs=Object.values(taskState?.jobs || {}).filter(j=>j.scope === scope);
  const unknown=jobs.filter(j=>j.status === "delivery_unknown" || j.status === "sending").length;
  $("retryUnknown").hidden=!unknown;
  const waiting=jobs.filter(j=>j.status === "waiting_subtitle").length;
  const failed=jobs.filter(j=>j.status === "failed").length;
  $("queue").textContent=`等待字幕 ${waiting} · 待重试 ${failed} · 发送待确认 ${unknown}`;
}
async function load() {
  const {config={}}=await chrome.storage.local.get("config");
  for (const [key,value] of Object.entries({...BWMUtils.DEFAULTS,...config})) {
    if (!FIELDS.includes(key) || MODEL_FIELDS.has(key)) continue;
    const element=$(key);
    if (element.type === "checkbox") { element.checked = String(value) === "true"; continue; }
    element.value=String(value);
    if (element.tagName === "SELECT" && element.value !== String(value) && key === "intervalHours") {
      element.add(new Option(`每 ${value} 小时（自定义）`,String(value))); element.value=String(value);
    }
  }
  syncPlatform(); await Promise.all([refreshLog(),refreshModel()]);
}
async function save() {
  return navigator.locks.request("bwm-config",async()=>{
    const latest={...BWMUtils.DEFAULTS,...(await chrome.storage.local.get("config")).config};
    const model=Object.fromEntries([...MODEL_FIELDS].map(k=>[k,latest[k]]));
    const config=configFromForm(model);
    await chrome.storage.local.set({config});
    return config;
  });
}
async function start() {
  const result=await chrome.runtime.sendMessage({type:"run-now"});
  if (!result?.ok) throw new Error(result?.error || "无法启动任务");
  $("status").textContent=result.alreadyRunning ? "已有任务正在运行" : "已启动独立工作窗口，完成后自动关闭";
}
function action(id,fn) {
  $(id).addEventListener("click",async()=>{
    $(id).disabled=true;
    try { await fn(); }
    catch(e) { $("status").textContent=`❌ ${e.message || e}`; }
    finally { $(id).disabled=false; }
  });
}
action("save",async()=>{ await save(); $("status").textContent="✅ 配置已保存"; });
action("run",async()=>{ await save(); await start(); });
action("manageApi",()=>chrome.runtime.openOptionsPage());
$("modelProfile").addEventListener("change",async()=>{
  $("modelProfile").disabled=true;
  try { await modelMessage("SELECT_MODEL",{id:$("modelProfile").value}); await refreshModel(); }
  catch(e){ $("status").textContent=e.message; await refreshModel().catch(()=>{}); }
  finally { $("modelProfile").disabled=false; }
});
action("retryUnknown",async()=>{
  const cfg=await save();
  await navigator.locks.request("bwm-pipeline",{ifAvailable:true},async lock=>{
    if (!lock) throw new Error("任务仍在运行，请等待结束后核对邮箱再重试");
    const {taskState}=await chrome.storage.local.get("taskState");
    for (const job of Object.values(taskState?.jobs || {})) {
      if (job.scope === scopeFor(cfg) && ["sending","delivery_unknown"].includes(job.status)) {
        job.status="prepared"; job.nextAttempt=0; job.error="";
      }
    }
    if (taskState) await chrome.storage.local.set({taskState});
  });
  await start();
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area === "local" && (changes.logs || changes.taskState)) void refreshLog();
  if((area === "local" && (changes.config || changes.keydock)) || (area === "session" && changes.keys)) void refreshModel().catch(e=>{ $("modelStatus").textContent=e.message; });
});
$("platform").addEventListener("change",syncPlatform);
load().catch(e=>{ $("status").textContent=e.message; });

action('openDayLog',()=>chrome.tabs.create({url:chrome.runtime.getURL('daylog/popup.html')}));
async function refreshDailyMail(){const state=await chrome.runtime.sendMessage({type:'daylog:STATE'});if(state?.settings)$('dailyEmailQuick').checked=state.settings.emailEnabled;}
$('dailyEmailQuick').addEventListener('change',async()=>{try{const state=await chrome.runtime.sendMessage({type:'daylog:STATE'});const res=await chrome.runtime.sendMessage({type:'daylog:SAVE_SETTINGS',settings:{...state.settings,emailEnabled:$('dailyEmailQuick').checked}});if(!res?.ok)throw Error(res?.error||'无法保存日报邮件选项');}catch(e){$('status').textContent=e.message+'；请到日报设置中配置共用邮件';await refreshDailyMail();}});
chrome.storage.onChanged.addListener((c,area)=>{if(area==='local'&&c['daylog:settings'])void refreshDailyMail();});
void refreshDailyMail();
