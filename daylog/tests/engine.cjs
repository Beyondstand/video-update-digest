const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),{webcrypto}=require('crypto');
const core=require('../core.js');
const root=path.resolve(__dirname,'../..');
function fixture(){
 const data={config:{modelSiteId:'chosen',modelApi:'https://model.example.test/v1',modelName:'selected',from:'sender@example.test',to:'reader@example.test',smtpPass:'smtp-fixture',smtpHost:'smtp.example.test',smtpPort:'465',relayUrl:'https://relay.example.test',relayKey:'fixture-relay-key-long-enough-12345'},'daylog:settings':{captureEnabled:true,emailEnabled:false}},locks=new Map();
 const local={get:async names=>names===null?structuredClone(data):Object.fromEntries((Array.isArray(names)?names:[names]).map(k=>[k,structuredClone(data[k])])),set:async obj=>Object.assign(data,structuredClone(obj)),remove:async names=>{for(const k of Array.isArray(names)?names:[names])delete data[k];}};
 const chrome={storage:{local},history:{search:async()=>[],getVisits:async()=>[]},tabs:{query:async()=>[]},runtime:{getURL:p=>'chrome-extension://test/'+p,sendMessage:async()=>({ok:true,data:{modelSiteId:'chosen',modelApi:'https://model.example.test/v1',modelName:'selected',modelKey:'session-fixture'}})}};
 const navigator={locks:{request:async(name,options,task)=>{if(typeof options==='function'){task=options;options={};}if(options.ifAvailable&&locks.has(name))return task(null);const before=locks.get(name)||Promise.resolve();let done;const current=new Promise(r=>done=r);locks.set(name,current);await before;try{return await task({name});}finally{done();if(locks.get(name)===current)locks.delete(name);}}}};
 const ctx=vm.createContext({chrome,navigator,crypto:webcrypto,URL,URLSearchParams,TextEncoder,TextDecoder,Uint8Array,Response,Request,AbortController,setTimeout,clearTimeout,btoa,atob,console,fetch:async()=>{throw Error('Unexpected network');}});
 for(const name of ['common.js','daylog/core.js','daylog/mail.js','daylog/engine.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),ctx);
 const day=core.dayKey(Date.now()),k=kind=>'daylog:'+kind+':'+day;
 data[k('day')]={pages:{'https://read.example/a':{url:'https://read.example/a',title:'A',text:'正文中有关键结论',visits:1,lastVisit:Date.now()}}};
 let modelCalls=0,mailCalls=0;
 ctx.BWMUtils.requestText=async(url,options)=>{
  if(url.includes('chat/completions')){modelCalls++;const p=JSON.parse(JSON.parse(options.body).messages[1].content);return {ok:true,status:200,text:JSON.stringify({choices:[{message:{content:JSON.stringify({overview:'概览',entries:p.items.map(i=>({index:i.index,summary:'摘要 '+i.title}))})}}]})};}
  mailCalls++;return {ok:true,status:200,text:'{"ok":true}'};
 };
 return {ctx,chrome,data,day,k,calls:()=>({modelCalls,mailCalls})};
}
test('defaults are opt-in; URLs remove credentials and retain meaningful document identifiers',()=>{
 const s=core.settings();assert.equal(s.captureEnabled,false);assert.equal(s.autoEnabled,false);assert.equal(s.emailEnabled,false);
 assert.equal(core.normalizeUrl('https://u:p@example.test/a'),null);assert.equal(core.normalizeUrl('https://example.test/a?id=7&api_key=private&utm_source=x#foo'),'https://example.test/a?id=7');
 assert.throws(()=>core.dayRange('2026-02-31'));
});
test('every included item needs its own model summary and input is strictly bounded',()=>{
 const pages=Array.from({length:300},(_,i)=>({url:'https://example.test/'+String(i).repeat(100),title:'标题'.repeat(100),text:'正文'.repeat(2000),lastVisit:Date.now()+i}));
 const items=core.items(pages,core.settings({maxPages:300,excerptLen:2000}));assert.ok(JSON.stringify(items).length<=40000);assert.ok(items.length<=300);
 assert.throws(()=>core.markdown('2026-11-08',items,300,{overview:'ok',entries:[]}),/逐条摘要/);
 const result=core.markdown('2026-11-08',[{index:1,title:'Only title',url:'https://example.test',time:'12:00',text:''}],1,{overview:'ok',entries:[{index:1,summary:'资料不足'}]});assert.match(result,/未采集正文/);
});
test('local reports generate without email, reuse identical inputs and preserve unrelated state',async()=>{
 const f=fixture();f.data.keydock={sites:['keep']};f.data.taskState={jobs:{keep:true}};
 await f.ctx.DayLogEngine.run(f.day);await f.ctx.DayLogEngine.run(f.day);
 assert.deepEqual(f.calls(),{modelCalls:1,mailCalls:0});assert.match(f.data[f.k('log')].markdown,/正文|摘要/);assert.equal(f.data.taskState.jobs.keep,true);assert.equal(f.data.keydock.sites[0],'keep');
});
test('enabled mail uses existing SMTP config without a video UID and sends once per report/recipient',async()=>{
 const f=fixture();f.data['daylog:settings'].emailEnabled=true;
 await f.ctx.DayLogEngine.run(f.day);await f.ctx.DayLogEngine.run(f.day);await f.ctx.DayLogEngine.run(f.day,'mail');
 assert.deepEqual(f.calls(),{modelCalls:1,mailCalls:1});assert.equal(f.data[f.k('mail')][f.data.config.to].status,'sent');
});
test('a genuinely updated report has a new message ID and may be mailed as an update',async()=>{
 const f=fixture();f.data['daylog:settings'].emailEnabled=true;await f.ctx.DayLogEngine.run(f.day);const first=f.data[f.k('mail')][f.data.config.to].messageId;
 f.data[f.k('day')].pages['https://read.example/a'].text+=' New findings';await f.ctx.DayLogEngine.run(f.day);
 assert.deepEqual(f.calls(),{modelCalls:2,mailCalls:2});assert.notEqual(f.data[f.k('mail')][f.data.config.to].messageId,first);
});
test('turning off email before summary completes prevents submission',async()=>{
 const f=fixture();f.data['daylog:settings'].emailEnabled=true;const original=f.ctx.BWMUtils.requestText;
 f.ctx.BWMUtils.requestText=async(...args)=>{const response=await original(...args);f.data['daylog:settings'].emailEnabled=false;return response;};
 await f.ctx.DayLogEngine.run(f.day);assert.equal(f.calls().mailCalls,0);assert.ok(f.data[f.k('log')].markdown);
});
test('uncertain delivery pauses resends, explicit confirmation retries without a model call',async()=>{
 const f=fixture();f.data['daylog:settings'].emailEnabled=true;await f.ctx.DayLogEngine.run(f.day);
 f.data[f.k('mail')][f.data.config.to].status='sending';const before=f.calls();
 await f.ctx.DayLogEngine.run(f.day,'mail');assert.equal(f.calls().mailCalls,before.mailCalls);assert.equal(f.data[f.k('mail')][f.data.config.to].status,'delivery_unknown');
 await f.ctx.DayLogEngine.run(f.day,'mail',true);assert.equal(f.calls().mailCalls,before.mailCalls+1);assert.equal(f.calls().modelCalls,1);
});
test('cached report mail retry does not need a live model key',async()=>{
 const f=fixture();await f.ctx.DayLogEngine.run(f.day);f.data['daylog:settings'].emailEnabled=true;f.chrome.runtime.sendMessage=async()=>({ok:false,error:'Key unavailable'});
 await f.ctx.DayLogEngine.run(f.day,'mail');assert.equal(f.calls().mailCalls,1);assert.equal(f.calls().modelCalls,1);
});
test('daily visits use actual timestamps rather than lifetime visit counts',async()=>{
 const f=fixture(),range=core.dayRange(f.day);f.chrome.history.search=async()=>[{url:'https://history.example/a',title:'A',visitCount:900}];f.chrome.history.getVisits=async()=>[{visitTime:range.start-1},{visitTime:range.start+1000},{visitTime:range.end+1}];
 const map=await f.ctx.DayLogEngine.collectHistory(f.day,core.settings());assert.equal(map['https://history.example/a'].visits,1);
 const merged=core.merge({'https://history.example/a':{text:'body',visits:20,lastVisit:range.start+9000}},map);assert.equal(merged[0].visits,1);assert.equal(merged[0].lastVisit,range.start+1000);
});
test('explicitly requested title-only history reports work without enabling new-page capture',async()=>{
 const f=fixture(),range=core.dayRange(f.day);f.data['daylog:settings'].captureEnabled=false;delete f.data[f.k('day')];
 f.chrome.history.search=async()=>[{url:'https://history.example/title-only',title:'Only history'}];f.chrome.history.getVisits=async()=>[{visitTime:range.start+5000}];
 await f.ctx.DayLogEngine.run(f.day);assert.match(f.data[f.k('log')].markdown,/未采集正文/);assert.equal(f.calls().mailCalls,0);
});
test('invalid per-item output does not replace a successful report or send mail',async()=>{
 const f=fixture();await f.ctx.DayLogEngine.run(f.day);const old=f.data[f.k('log')].markdown;f.data[f.k('day')].pages['https://read.example/a'].text+=' changed';f.data['daylog:settings'].emailEnabled=true;
 f.ctx.BWMUtils.requestText=async()=>({ok:true,status:200,text:JSON.stringify({choices:[{message:{content:'{"overview":"bad","entries":[]}'}}]})});
 const result=await f.ctx.DayLogEngine.run(f.day);assert.equal(result.ok,false);assert.equal(f.data[f.k('log')].markdown,old);assert.equal(f.calls().mailCalls,0);
});
test('ninety-day cleanup removes only daily history records',async()=>{
 const f=fixture();f.data['daylog:log:2001-01-01']={markdown:'old'};f.data['day:2001-01-01']='unrelated';f.data.taskState={keep:true};
 await f.ctx.DayLogEngine.cleanup();assert.equal(f.data['daylog:log:2001-01-01'],undefined);assert.equal(f.data['day:2001-01-01'],'unrelated');assert.equal(f.data.taskState.keep,true);
});
