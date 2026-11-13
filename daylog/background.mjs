import './core.js';
import './mail.js';
import './engine.js';
const C=globalThis.DayLogCore,E=globalThis.DayLogEngine;
const MAIL_FIELDS=['to','from','smtpPass','smtpHost','smtpPort','relayUrl','relayKey'];
const ALARM='daylog-daily',launches=new Map();
const uiPage=url=>['daylog/popup.html','daylog/options.html','popup.html'].some(p=>url===chrome.runtime.getURL(p));
const baseUrl=url=>String(url||'').split('?')[0].split('#')[0];
async function schedule(){const s=await E.settings();if(!s.autoEnabled){await chrome.alarms.clear(ALARM);return;}await chrome.alarms.create(ALARM,{when:C.nextAlarm(Date.now(),s.summaryTime)});}
async function launch(day,mode='generate',confirmUnknown=false){
 C.validDay(day);if(launches.has(day))return launches.get(day);
 const promise=(async()=>{
  const tabs=await chrome.tabs.query({});if(tabs.some(t=>t.url?.startsWith(chrome.runtime.getURL('daylog/runner.html'))&&new URL(t.url).searchParams.get('day')===day))return {ok:true,alreadyRunning:true};
  const query=new URLSearchParams({day,mode,confirm:String(confirmUnknown)});
  await chrome.windows.create({url:chrome.runtime.getURL('daylog/runner.html')+'?'+query,type:'normal',focused:false,width:850,height:650});
  return {ok:true,started:true};
 })();launches.set(day,promise);try{return await promise;}finally{launches.delete(day);}
}
async function capture(message,sender){
 const s=await E.settings();if(!s.captureEnabled)return {ok:true,ignored:true};
 const payload=message.payload||{},url=C.normalizeUrl(payload.url),source=C.normalizeUrl(sender.url);
 if(!url||!source||new URL(url).origin!==new URL(source).origin||C.excluded(url,s.excludePatterns))return {ok:true,ignored:true};
 return navigator.locks.request('daylog-data',async()=>{
  const current=await E.settings();if(!current.captureEnabled||C.excluded(url,current.excludePatterns))return {ok:true,ignored:true};
  const storageKey=E.key('day',C.dayKey(Date.now())),data=await E.get(storageKey)||{pages:{}};
  if(!data.pages[url]&&Object.keys(data.pages).length>=500)return {ok:true,ignored:true};
  const old=data.pages[url]||{},text=String(payload.text||'').slice(0,4000);
  data.pages[url]={url,title:String(payload.title||old.title||'').slice(0,300),text:text.length>(old.text||'').length?text:old.text||'',visits:(old.visits||0)+1,lastVisit:Date.now()};
  await chrome.storage.local.set({[storageKey]:data});return {ok:true};
 });
}
async function handle(message,sender){
 const type=message.type.slice('daylog:'.length),url=baseUrl(sender.url);
 if(type==='POLICY')return {ok:true,...await E.settings()};
 if(type==='CAPTURE')return capture(message,sender);
 if(type==='STATE')return E.state();
 if(type==='GET_LOG'){
  C.validDay(message.day);const rec=await E.get(E.key('log',message.day));if(!rec){const job=await E.get(E.key('job',message.day));return job?.error?{day:message.day,markdown:'',error:job.error,pageCount:0}:null;}
  const cfg=await E.config(),mail=(await E.get(E.key('mail',message.day)))?.[cfg.to]||{};
  const {day,markdown,model,createdAt,pageCount,includedCount,contentCount}=rec;
  const job=await E.get(E.key('job',day));
  const tabs=await chrome.tabs.query({});const active=tabs.some(t=>t.url?.startsWith(chrome.runtime.getURL('daylog/runner.html'))&&new URL(t.url).searchParams.get('day')===day);
  return {day,markdown,model,createdAt,pageCount,includedCount,contentCount,jobError:job?.status==='failed'?job.error:'',mailStatus:mail.status==='sending'&&!active?'delivery_unknown':mail.status==='sent'&&mail.reportId!==rec.reportId?'updated':mail.status||'none',mailError:mail.error||''};
 }
 if(type==='MAIL_SETTINGS'){
  if(url!==chrome.runtime.getURL('daylog/options.html'))throw Error('此页面不能读取邮件配置');
  const cfg=await E.config();return {ok:true,mail:Object.fromEntries(MAIL_FIELDS.map(k=>[k,cfg[k]||'']))};
 }
 if(type==='SAVE_MAIL_SETTINGS'){
  if(url!==chrome.runtime.getURL('daylog/options.html'))throw Error('此页面不能修改邮件配置');
  const mail=Object.fromEntries(MAIL_FIELDS.map(k=>[k,String(message.mail?.[k]||'').trim()])),normalized=DayLogMail.mailSettings(mail);
  await navigator.locks.request('bwm-config',async()=>{const cfg=(await chrome.storage.local.get('config')).config||{};await chrome.storage.local.set({config:{...cfg,...Object.fromEntries(MAIL_FIELDS.map(k=>[k,normalized[k]]))}});});return {ok:true};
 }
 if(type==='SAVE_SETTINGS'){
  const s=C.settings(message.settings);if(s.emailEnabled)DayLogMail.mailSettings(await E.config());
  await chrome.storage.local.set({'daylog:settings':s});await schedule();return {ok:true};
 }
 if(type==='GENERATE')return launch(message.day,'generate');
 if(type==='SEND_MAIL'){
  if(!(await E.settings()).emailEnabled)throw Error('请先在日报设置中勾选将每日报告发送到邮箱');
  if(!(await E.get(E.key('log',message.day)))?.markdown)throw Error('请先生成该日的报告');
  return launch(message.day,'mail',message.confirmUnknown===true);
 }
 if(type==='CLEAR_DATA'){
  if(launches.size)throw Error('日报任务正在启动，请等待完成后再清理');
  const tabs=await chrome.tabs.query({});if(tabs.some(t=>t.url?.startsWith(chrome.runtime.getURL('daylog/runner.html'))))throw Error('日报任务正在运行，请等待完成后再清理');
  await navigator.locks.request('daylog-data',async()=>{const all=await chrome.storage.local.get(null);await chrome.storage.local.set({'daylog:epoch':(all['daylog:epoch']||0)+1});await chrome.storage.local.remove(Object.keys(all).filter(k=>/^daylog:(day|log|job|mail):/.test(k)));});return {ok:true};
 }
 throw Error('未知日报操作');
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(sender.id!==chrome.runtime.id||typeof message?.type!=='string'||!message.type.startsWith('daylog:'))return false;
 const type=message.type.slice(7),url=baseUrl(sender.url);
 const content=['POLICY','CAPTURE'].includes(type)&&sender.tab&&sender.frameId===0&&/^https?:\/\//.test(sender.url||'');
 const ui=!['POLICY','CAPTURE'].includes(type)&&uiPage(url);
 if(!content&&!ui)return false;
 handle(message,sender).then(respond,error=>respond({ok:false,error:String(error.message||'日报操作失败').slice(0,500)}));return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void (async()=>{try{const s=await E.settings();if(s.autoEnabled)await launch(C.targetDay(alarm.scheduledTime||Date.now()));}finally{await schedule();}})().catch(()=>{});});
chrome.runtime.onInstalled.addListener(()=>{void schedule();});
chrome.runtime.onStartup.addListener(()=>{void (async()=>{await schedule();await E.cleanup();const s=await E.settings();if(!s.autoEnabled||!s.captureEnabled)return;const date=new Date();date.setDate(date.getDate()-1);const yesterday=C.dayKey(date),rec=await E.get(E.key('log',yesterday));if(!rec?.markdown)await launch(yesterday);else if(s.emailEnabled)await launch(yesterday,'mail');})().catch(()=>{});});
void schedule();
