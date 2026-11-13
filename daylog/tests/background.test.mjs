import test from 'node:test';
import assert from 'node:assert/strict';

// This fixture never accesses a real browser profile, history database, API or
// SMTP endpoint. Cloned asynchronous storage exposes lost-update races.
const local = {
  config: { uid:'',platform:'bilibili',modelSiteId:'chosen-model',modelApi:'https://model.example.test/v1',modelName:'test-model',modelKey:'',modelVision:'false',intervalHours:'12',from:'before@example.test',to:'before-receiver@example.test',smtpPass:'before-smtp-secret',relayKey:'before-relay-secret-at-least-24',relayUrl:'https://relay.example.test',smtpHost:'smtp.example.test',smtpPort:'465' },
  keydock: { sites:[{id:'chosen-model',account:'test-label'}],settings:{paused:true} },
  taskState: {jobs:{video:{status:'sent',uuid:'keep-video'}}},
  sentBvids:['BVKEEPME']
};
const clone = value => structuredClone(value);
const delay = () => new Promise(resolve=>setTimeout(resolve,0));
const storage = {
  async get(keys){await delay();if(keys===null)return clone(local);const names=Array.isArray(keys)?keys:[keys];return Object.fromEntries(names.map(k=>[k,clone(local[k])]));},
  async set(values){await delay();Object.assign(local,clone(values));},
  async remove(keys){await delay();for(const key of Array.isArray(keys)?keys:[keys])delete local[key];}
};
const events = () => ({callbacks:[],addListener(fn){this.callbacks.push(fn);},emit(...args){for(const fn of this.callbacks)fn(...args);}});
const onMessage=events(),onAlarm=events(),onInstalled=events(),onStartup=events();
const alarms = new Map([['bwm-check',{periodInMinutes:720}],['keydock-daily',{when:12345}]]),alarmOps=[];
const createdWindows=[];let tabs=[],historyReads=0,networkCalls=0;
const locks=new Map(),lockCalls=[];
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request(name,options,callback){
  lockCalls.push(name);
  if(typeof options==='function'){callback=options;options={};}
  if(options?.ifAvailable&&locks.has(name))return Promise.resolve(callback(null));
  const previous=locks.get(name)||Promise.resolve();
  const result=previous.catch(()=>{}).then(()=>callback({name,mode:'exclusive'}));
  const tail=result.catch(()=>{});locks.set(name,tail);
  return result.finally(()=>{if(locks.get(name)===tail)locks.delete(name);});
}}}});
globalThis.fetch=async()=>{networkCalls++;throw Error('External network is forbidden in the fixture');};
globalThis.chrome={
 storage:{local:storage},
 runtime:{id:'daylog-fixture',getURL:path=>'chrome-extension://daylog-fixture/'+path,onMessage,onInstalled,onStartup,sendMessage:async()=>{throw Error('No runner or model calls in message tests');}},
 alarms:{get:async name=>alarms.get(name),create:async(name,config)=>{alarmOps.push(['create',name]);alarms.set(name,clone(config));},clear:async name=>{alarmOps.push(['clear',name]);return alarms.delete(name);},onAlarm},
 tabs:{query:async()=>clone(tabs)},
 windows:{create:async config=>{createdWindows.push(clone(config));return {id:99};}},
 history:{search:async()=>{historyReads++;throw Error('Real history must not be read by message routing tests');},getVisits:async()=>{historyReads++;throw Error('Real visits must not be read by message routing tests');}}
};
await import('../../common.js');
await import('../background.mjs');
const listener=onMessage.callbacks[0];
const page = path => ({id:chrome.runtime.id,url:chrome.runtime.getURL(path)});
const content = (url='https://content.example.test/article') => ({id:chrome.runtime.id,url,frameId:0,tab:{id:41,url}});
const send = (type,fields={},sender=page('daylog/options.html')) => new Promise((resolve,reject)=>{
 const accepted=listener({type:'daylog:'+type,...fields},sender,resolve);
 if(!accepted)reject(Error('Message rejected before handler'));
});
async function denied(message,sender){let called=false;assert.equal(listener(message,sender,()=>{called=true;}),false);await delay();assert.equal(called,false);}
const goodMail={to:'receiver@example.test',from:'sender@example.test',smtpPass:'smtp-auth-fixture',smtpHost:'smtp.example.test',smtpPort:'587',relayUrl:'https://relay.example.test',relayKey:'relay-fixture-key-with-at-least-24-chars'};
const settingFields=['captureEnabled','autoEnabled','emailEnabled','summaryTime','sendContent','excerptLen','maxPages','excludePatterns'];

test('daily background respects message boundaries, settings and storage isolation',async t=>{
 await t.test('unrelated messages and external senders are not answered',async()=>{
  for(const type of ['run-now','keydock:STATE','PAGE_CAPTURE',undefined])await denied({type},page('daylog/options.html'));
  await denied({type:'daylog:STATE'},{...page('daylog/options.html'),id:'another-extension'});
  await denied({type:'daylog:POLICY'},{...content(),frameId:1});
  await denied({type:'daylog:CAPTURE'},{...content(),tab:undefined});
 });
 await t.test('content scripts can read capture policy but cannot read reports, credentials or clear data',async()=>{
  const policy=await send('POLICY',{},content());assert.equal(policy.ok,true);
  assert.equal(policy.captureEnabled,false);assert.equal(policy.autoEnabled,false);assert.equal(policy.emailEnabled,false);
  assert.equal(policy.sendContent,true);assert.equal(policy.summaryTime,'23:50');assert.equal(policy.excerptLen,800);assert.equal(policy.maxPages,100);
  assert.deepEqual(policy.excludePatterns,[]);assert.deepEqual(Object.keys(policy).sort(),['ok',...settingFields].sort());
  for(const type of ['STATE','GET_LOG','MAIL_SETTINGS','SAVE_MAIL_SETTINGS','CLEAR_DATA','GENERATE','SEND_MAIL','SAVE_SETTINGS'])await denied({type:'daylog:'+type,day:'2026-11-08'},content());
  const ignored=await send('CAPTURE',{payload:{url:content().url,title:'Disabled',text:'Must not persist'}},content());assert.equal(ignored.ignored,true);
  assert.ok(!Object.keys(local).some(k=>k.startsWith('daylog:day:')));
 });
 await t.test('mail configuration reads are options-only and expose exactly the mail whitelist',async()=>{
  const mail=await send('MAIL_SETTINGS');assert.equal(mail.ok,true);assert.deepEqual(Object.keys(mail.mail).sort(),Object.keys(goodMail).sort());
  assert.ok(!JSON.stringify(mail).includes('chosen-model'));assert.ok(!JSON.stringify(mail).includes('test-model'));
  for(const path of ['daylog/popup.html','popup.html']){const result=await send('MAIL_SETTINGS',{},page(path));assert.equal(result.ok,false);assert.match(result.error,/不能读取/);}
 });
 await t.test('mail settings save without a video UID and change only shared mail fields',async()=>{
  const previous=clone(local.config);
  const result=await send('SAVE_MAIL_SETTINGS',{mail:{...goodMail,uid:'INJECTED-UID',modelSiteId:'hijacked',modelKey:'must-not-store',intervalHours:'1',platform:'changed'}});
  assert.equal(result.ok,true);assert.equal(local.config.uid,'');
  for(const field of Object.keys(goodMail))assert.equal(local.config[field],goodMail[field]);
  for(const field of ['uid','modelSiteId','modelApi','modelName','modelKey','modelVision','intervalHours','platform'])assert.equal(local.config[field],previous[field]);
  assert.ok(!JSON.stringify(local).includes('must-not-store'));
  for(const path of ['daylog/popup.html','popup.html'])assert.equal((await send('SAVE_MAIL_SETTINGS',{mail:goodMail},page(path))).ok,false);
 });
 await t.test('settings whitelist ignores embedded model and mail fields',async()=>{
  const preserved=clone(local.config);
  assert.equal((await send('SAVE_SETTINGS',{settings:{captureEnabled:true,autoEnabled:false,emailEnabled:false,summaryTime:'23:50',excludePatterns:['*://excluded.example.test/*'],apiKey:'not-stored',smtpPass:'not-stored'}})).ok,true);
  assert.deepEqual(Object.keys(local['daylog:settings']).sort(),settingFields.sort());assert.deepEqual(local.config,preserved);
  assert.ok(!JSON.stringify(local['daylog:settings']).includes('not-stored'));
 });
 await t.test('cross-origin capture spoofing and excluded sites are ignored',async()=>{
  const before=clone(local);
  assert.equal((await send('CAPTURE',{payload:{url:'https://other.example.test/private',text:'must-not-capture'}},content())).ignored,true);
  assert.equal((await send('CAPTURE',{payload:{url:'https://excluded.example.test/private',text:'must-not-capture'}},content('https://excluded.example.test/private'))).ignored,true);
  assert.deepEqual(local,before);
 });
 await t.test('capture rechecks exclusions changed while waiting for the data lock',async()=>{
  let unlock,entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const holding=navigator.locks.request('daylog-data',async()=>{entered();await new Promise(resolve=>{unlock=resolve;});});
  await ready;const before=lockCalls.filter(name=>name==='daylog-data').length;
  const url='https://content.example.test/newly-excluded';
  const pending=send('CAPTURE',{payload:{url,text:'must-not-be-persisted'}},content(url));
  const deadline=Date.now()+2000;
  while(lockCalls.filter(name=>name==='daylog-data').length===before){assert.ok(Date.now()<deadline,'capture queued for lock');await delay();}
  await send('SAVE_SETTINGS',{settings:{...local['daylog:settings'],excludePatterns:['*://content.example.test/newly-excluded']}});
  unlock();await holding;assert.equal((await pending).ignored,true);
  const stored=local['daylog:day:'+DayLogCore.dayKey(Date.now())];assert.ok(!stored?.pages?.[url]);
 });
 await t.test('concurrent legitimate captures do not lose pages or increments',async()=>{
  await Promise.all(Array.from({length:24},(_,i)=>{const url='https://content.example.test/article/'+i;return send('CAPTURE',{payload:{url,title:'Page '+i,text:'captured body '+i}},content(url));}));
  const key='daylog:day:'+DayLogCore.dayKey(Date.now());
  assert.equal(Object.keys(local[key].pages).length,24);
  await Promise.all(Array.from({length:10},()=>{const url='https://content.example.test/article/0';return send('CAPTURE',{payload:{url,title:'Page 0',text:'captured body 0'}},content(url));}));
  assert.equal(local[key].pages['https://content.example.test/article/0'].visits,11);
 });
 await t.test('public state exposes aggregates, not captured text or credentials',async()=>{
  const state=await send('STATE',{},page('daylog/popup.html'));assert.equal(state.ok,true);assert.equal(state.todayPages,24);
  for(const secret of ['captured body','smtp-auth-fixture','relay-fixture-key','sender@example.test','receiver@example.test'])assert.ok(!JSON.stringify(state).includes(secret));
  const bad=await send('GET_LOG',{day:'../../config'},page('daylog/popup.html'));assert.equal(bad.ok,false);assert.match(bad.error,/日期无效/);
 });
 await t.test('daily scheduling has its own alarm and does not disturb video or KeyDock alarms',async()=>{
  const video=clone(alarms.get('bwm-check')),keydock=clone(alarms.get('keydock-daily'));
  await send('SAVE_SETTINGS',{settings:{captureEnabled:true,autoEnabled:true,emailEnabled:false,summaryTime:'22:45'}});
  const alarm=alarms.get('daylog-daily');assert.ok(alarm.when>Date.now());assert.equal(new Date(alarm.when).getHours(),22);assert.equal(new Date(alarm.when).getMinutes(),45);
  await send('SAVE_SETTINGS',{settings:{captureEnabled:false,autoEnabled:true,emailEnabled:false}});assert.equal(alarms.has('daylog-daily'),true);
  await send('SAVE_SETTINGS',{settings:{autoEnabled:false}});assert.equal(alarms.has('daylog-daily'),false);
  onAlarm.emit({name:'bwm-check',scheduledTime:Date.now()});onAlarm.emit({name:'keydock-daily',scheduledTime:Date.now()});await delay();assert.equal(createdWindows.length,0);
  assert.deepEqual(alarms.get('bwm-check'),video);assert.deepEqual(alarms.get('keydock-daily'),keydock);assert.ok(alarmOps.every(([,name])=>name==='daylog-daily'));
 });
 await t.test('email checkbox requires valid mail settings without requiring UID',async()=>{
  const keep=clone(local.config);local.config={...local.config,smtpPass:''};
  const invalid=await send('SAVE_SETTINGS',{settings:{captureEnabled:true,emailEnabled:true}});assert.equal(invalid.ok,false);assert.match(invalid.error,/SMTP/);
  local.config=keep;assert.equal((await send('SAVE_SETTINGS',{settings:{captureEnabled:true,emailEnabled:true,autoEnabled:false}})).ok,true);assert.equal(local['daylog:settings'].emailEnabled,true);assert.equal(local.config.uid,'');
 });
 await t.test('clear only removes daylog content and preserves API, mail and video data',async()=>{
  const protectedKeys=['config','keydock','taskState','sentBvids'];const before=Object.fromEntries(protectedKeys.map(k=>[k,clone(local[k])]));
  const day=DayLogCore.dayKey(Date.now());for(const kind of ['log','job','mail'])local['daylog:'+kind+':'+day]={fixture:true};
  local['daylog:epoch']=7;const settings=clone(local['daylog:settings']);
  const result=await send('CLEAR_DATA');assert.equal(result.ok,true);
  assert.ok(!Object.keys(local).some(k=>/^daylog:(day|log|job|mail):/.test(k)));assert.equal(local['daylog:epoch'],8);assert.deepEqual(local['daylog:settings'],settings);
  for(const key of protectedKeys)assert.deepEqual(local[key],before[key]);
 });
 await t.test('clear refuses while a daily runner is active',async()=>{
  const day=DayLogCore.dayKey(Date.now());local['daylog:log:'+day]={markdown:'keep this report'};
  tabs=[{id:3,url:chrome.runtime.getURL('daylog/runner.html')+'?day='+day+'&mode=generate'}];
  const before=clone(local),result=await send('CLEAR_DATA');assert.equal(result.ok,false);assert.match(result.error,/任务正在运行/);assert.deepEqual(local,before);tabs=[];
 });
 await t.test('daily alarm launches a separate runner for yesterday before six and does nothing when disabled',async()=>{
  await send('SAVE_SETTINGS',{settings:{captureEnabled:false,autoEnabled:true,emailEnabled:false,summaryTime:'02:30'}});
  onAlarm.emit({name:'daylog-daily',scheduledTime:new Date(2026,10,8,2,30).getTime()});
  for(let i=0;i<100&&!createdWindows.length;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(createdWindows.length,1);const target=new URL(createdWindows[0].url);
  assert.equal(target.pathname,'/daylog/runner.html');assert.equal(target.searchParams.get('day'),'2026-11-07');assert.equal(target.searchParams.get('mode'),'generate');
  await send('SAVE_SETTINGS',{settings:{autoEnabled:false}});onAlarm.emit({name:'daylog-daily',scheduledTime:Date.now()});await new Promise(r=>setTimeout(r,30));assert.equal(createdWindows.length,1);
 });
 assert.equal(historyReads,0);assert.equal(networkCalls,0);
});
