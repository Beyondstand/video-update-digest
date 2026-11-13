'use strict';
globalThis.DayLogEngine = (()=>{
 const C=DayLogCore, key=(kind,day)=>`daylog:${kind}:${C.validDay(day)}`;
 const get=async name=>(await chrome.storage.local.get(name))[name];
 const settings=async()=>C.settings(await get('daylog:settings'));
 const config=async()=>({...BWMUtils.DEFAULTS,...await get('config')});
 const save=async(k,v)=>chrome.storage.local.set({[k]:v});
 const setJob=async(day,fields)=>save(key('job',day),{...await get(key('job',day)),...fields,updatedAt:Date.now()});
 const epoch=async()=>await get('daylog:epoch')||0;
 async function checkEpoch(expected){if(await epoch()!==expected)throw Error('日报数据已清理，本次任务已停止');}
 async function collectHistory(day,s){
  const range=C.dayRange(day), history=await chrome.history.search({text:'',startTime:range.start,endTime:range.end+1,maxResults:3000}), out={};let next=0;
  await Promise.all(Array.from({length:Math.min(8,history.length)},async()=>{for(;;){const index=next++;if(index>=history.length)return;const item=history[index],url=C.normalizeUrl(item.url);if(!url||C.excluded(url,s.excludePatterns))continue;
   const visits=await chrome.history.getVisits({url:item.url});const today=visits.filter(v=>v.visitTime>=range.start&&v.visitTime<=range.end);if(!today.length)continue;
   const latest=Math.max(...today.map(v=>v.visitTime));const old=out[url];out[url]={url,title:String(item.title||old?.title||'').slice(0,300),text:'',visits:(old?.visits||0)+today.length,lastVisit:Math.max(old?.lastVisit||0,latest)};
  }}));return out;
 }
 async function model(cfg){
  if(!cfg.modelSiteId)throw Error('请先在 API 管理页填写自己的 Key 并选择模型');
  const response=await chrome.runtime.sendMessage({type:'keydock:MODEL_CONFIG',id:cfg.modelSiteId});
  if(!response?.ok||!response.data?.modelKey)throw Error(response?.error||'所选 API 的会话 Key 不可用');
  return response.data;
 }
 async function generate(day,expected){
  const s=await settings();
  await setJob(day,{status:'building',error:''});
  const captured=(await get(key('day',day)))?.pages||{};
  const pages=C.merge(captured,await collectHistory(day,s)).filter(p=>!C.excluded(p.url,s.excludePatterns));
  if(!pages.length)throw Error(`${day} 没有可总结的浏览记录`);
  const list=C.items(pages,s),cfg=await model(await config());
  const input=JSON.stringify({items:list,modelSiteId:cfg.modelSiteId,modelApi:cfg.modelApi,modelName:cfg.modelName});
  const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  let record=await get(key('log',day));
  if(record?.fingerprint===fingerprint&&record.markdown)return record;
  await checkEpoch(expected);
  const response=await BWMUtils.requestText(BWMUtils.endpoint(cfg.modelApi,'模型 API 地址',true)+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.modelKey},body:JSON.stringify({model:cfg.modelName,temperature:.3,messages:C.prompts(day,list,pages.length)})},120000);
  if(!response.ok)throw Error(`模型接口返回 HTTP ${response.status}`);
  let result;
  try{const text=JSON.parse(response.text).choices?.[0]?.message?.content;if(typeof text!=='string'||text.length>200000)throw Error();result=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw Error('模型未返回有效的逐条摘要 JSON，请重试或选择支持此格式的模型');}
  const markdown=C.markdown(day,list,pages.length,result);
  record={day,markdown,model:cfg.modelName,createdAt:Date.now(),pageCount:pages.length,includedCount:list.length,contentCount:list.filter(i=>i.text).length,reportId:crypto.randomUUID(),fingerprint};
  await navigator.locks.request('daylog-data',async()=>{await checkEpoch(expected);await save(key('log',day),record);});
  return record;
 }
 async function sendReport(day,expected,confirmUnknown=false){
  if(!(await settings()).emailEnabled)throw Error('请先在日报设置中勾选“将每日报告发送到邮箱”');
  const record=await get(key('log',day));if(!record?.markdown)throw Error('请先生成该日的报告');
  const cfg=await config();
  // Validate without sending or requiring a video UID/model key.
  DayLogMail.mailSettings(cfg);
  const storageKey=key('mail',day),ledger=await get(storageKey)||{},previous=ledger[cfg.to];
  if(previous?.status==='sent'&&previous.reportId===record.reportId)return {alreadySent:true};
  if(['sending','delivery_unknown'].includes(previous?.status)&&!confirmUnknown){
   ledger[cfg.to]={...previous,status:'delivery_unknown',error:'投递结果未确认，请先核对邮箱；重试可能产生重复邮件'};await save(storageKey,ledger);return {deliveryUnknown:true};
  }
  const entry={status:'sending',messageId:previous?.reportId===record.reportId&&previous.messageId?previous.messageId:crypto.randomUUID(),reportId:record.reportId,updatedAt:Date.now(),error:''};
  ledger[cfg.to]=entry;
  await navigator.locks.request('daylog-data',async()=>{await checkEpoch(expected);await save(storageKey,ledger);});
  await setJob(day,{status:'sending',error:''});
  try {
   // Re-read the switch immediately before external submission.
   if(!(await settings()).emailEnabled)throw Object.assign(Error('日报发信选项已关闭，本次未发送'),{deliveryUnknown:false});
   await checkEpoch(expected);
   await DayLogMail.send(cfg,`【浏览日报】${day}`,record.markdown,entry.messageId);
   entry.status='sent';entry.error='';
  }catch(error){entry.status=error.deliveryUnknown===false?'failed':'delivery_unknown';entry.error=error.message;}
  entry.updatedAt=Date.now();
  await navigator.locks.request('daylog-data',async()=>{await checkEpoch(expected);await save(storageKey,ledger);});
  return {mailStatus:entry.status,mailError:entry.error};
 }
 async function run(day,mode='generate',confirmUnknown=false){
  C.validDay(day);
  return navigator.locks.request('daylog-job:'+day,{ifAvailable:true},async lock=>{
   if(!lock)return {ok:false,error:'该日期的日报任务正在运行'};
   const expected=await epoch();
   try{
    await setJob(day,{status:mode==='mail'?'sending':'building',error:''});
    if(mode==='generate')await generate(day,expected);
    let mail={};if(mode==='mail'||(await settings()).emailEnabled)mail=await sendReport(day,expected,confirmUnknown);
    await setJob(day,{status:mail.deliveryUnknown||mail.mailStatus==='delivery_unknown'?'delivery_unknown':mail.mailStatus==='failed'?'mail_failed':'complete',error:mail.mailError||''});
    await cleanup();return {ok:true,...mail};
   }catch(error){if(await epoch()===expected)await setJob(day,{status:'failed',error:String(error.message||error).slice(0,500)});return {ok:false,error:String(error.message||error)};}
  });
 }
 async function cleanup(){const all=await chrome.storage.local.get(null),cutoff=new Date();cutoff.setDate(cutoff.getDate()-90);const dates=Object.keys(all).filter(k=>/^daylog:(day|log|job|mail):\d{4}-\d{2}-\d{2}$/.test(k)).filter(k=>C.dayRange(k.slice(-10)).end<+cutoff);if(dates.length)await chrome.storage.local.remove(dates);}
 async function state(){
  const all=await chrome.storage.local.get(null),s=C.settings(all['daylog:settings']),cfg={...BWMUtils.DEFAULTS,...all.config},days=new Set();
  for(const k of Object.keys(all))if(/^daylog:(log|job):\d{4}-\d{2}-\d{2}$/.test(k))days.add(k.slice(-10));
  const tabs=await chrome.tabs.query({}),runningDays=tabs.filter(t=>t.url?.startsWith(chrome.runtime.getURL('daylog/runner.html'))).map(t=>new URL(t.url).searchParams.get('day'));
  const logs=[...days].sort().reverse().slice(0,90).map(day=>{const rec=all[key('log',day)]||{},job=all[key('job',day)]||{},mail=all[key('mail',day)]?.[cfg.to]||{};return {day,pageCount:rec.pageCount||0,includedCount:rec.includedCount||0,createdAt:rec.createdAt||0,hasMarkdown:Boolean(rec.markdown),error:job.status==='failed'?job.error:'',mailStatus:mail.status==='sending'&&!runningDays.includes(day)?'delivery_unknown':mail.status==='sent'&&mail.reportId!==rec.reportId?'updated':mail.status||'none',mailError:mail.error||'',jobStatus:job.status};});
  return {ok:true,today:C.dayKey(Date.now()),todayPages:Object.keys(all[key('day',C.dayKey(Date.now()))]?.pages||{}).length,settings:s,logs,runningDays};
 }
 return {key,get,settings,config,collectHistory,generate,sendReport,run,state,cleanup};
})();
