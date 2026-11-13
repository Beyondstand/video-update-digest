const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
function event(){const callbacks=new Set();return {addListener:fn=>callbacks.add(fn),removeListener:fn=>callbacks.delete(fn),emit:(...args)=>{for(const fn of callbacks)fn(...args);}};}
function sandbox() {
 const data={};
 const local={
  get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(data[k])])),
  set:async values=>{for(const [k,v]of Object.entries(values))data[k]=structuredClone(v);},
  remove:async key=>{delete data[key];},
 };
 const chrome={storage:{local},tabs:{onActivated:event(),onUpdated:event(),remove:async()=>{}},runtime:{id:'test',getURL:file=>'chrome-extension://test/'+file,sendMessage:async()=>({ok:true})}};
 const ctx=vm.createContext({chrome,console:{log(){}},TextEncoder,TextDecoder,URL,Response,Request,AbortController,AbortSignal,btoa,atob,setTimeout,clearTimeout,crypto:webcrypto,taskWindowId:2,fetch:async()=>{throw new Error('Unexpected network');}});
 vm.runInContext(read('common.js'),ctx);vm.runInContext(read('pipeline.js'),ctx);
 return {ctx,chrome,data};
}
const config={modelApi:'https://model.example.test/v1',modelKey:'dummy',modelName:'dummy',platform:'bilibili',uid:'123',to:'to@example.test',from:'from@example.test',smtpPass:'dummy',smtpPort:'465',relayUrl:'https://relay.example.test',relayKey:'test-relay-key-at-least-24-characters',intervalHours:'6'};
test('managed model configuration omits personal keys from persistent config',()=>{
 const {ctx}=sandbox();const managed=ctx.BWMUtils.validateConfig({...config,modelSiteId:'managed-test',modelKey:'stale-secret'});
 assert.equal(managed.modelKey,'');assert.equal(managed.modelSiteId,'managed-test');assert.equal(managed.smtpPass,config.smtpPass);
 assert.throws(()=>ctx.BWMUtils.validateConfig({...config,modelSiteId:'bad\r\nid'}),/API 记录/);
});
test('managed model requests resolve the latest session key on every call',async()=>{
 const {ctx,chrome}=sandbox();let key='session-first',headers=[];
 chrome.runtime.sendMessage=async message=>{assert.equal(message.type,'keydock:MODEL_CONFIG');return {ok:true,data:{modelSiteId:'managed',modelApi:config.modelApi,modelName:config.modelName,modelKey:key}};};
 ctx.fetch=async(url,options)=>{headers.push(options.headers.Authorization);return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));};
 const bound={...config,modelSiteId:'managed',modelKey:'never-use-this-stale-key'};
 await ctx.modelJson(bound,[]);key='session-rotated';await ctx.modelJson(bound,[]);
 assert.deepEqual(headers,['Bearer session-first','Bearer session-rotated']);assert.equal(bound.modelKey,'never-use-this-stale-key');
});
test('missing managed key never calls a provider with cached or demo credentials',async()=>{
 const {ctx,chrome}=sandbox();let calls=0;ctx.fetch=async()=>{calls++;throw Error('Must not fetch');};
 chrome.runtime.sendMessage=async()=>({ok:false,error:'会话 Key 不可用'});
 await assert.rejects(ctx.modelJson({...config,modelSiteId:'managed'},[]),/会话 Key 不可用/);assert.equal(calls,0);
});
test('changing a managed API target interrupts an in-progress model job',async()=>{
 const {ctx,chrome}=sandbox();let calls=0;ctx.fetch=async()=>{calls++;};
 chrome.runtime.sendMessage=async()=>({ok:true,data:{modelSiteId:'managed',modelApi:'https://changed.example/v1',modelName:config.modelName,modelKey:'new-key'}});
 await assert.rejects(ctx.modelJson({...config,modelSiteId:'managed'},[]),/API 配置发生变化/);assert.equal(calls,0);
});
const metadata={id:'BVTEST',title:'test',owner:'test',ownerId:123,platform:'bilibili',platformLabel:'B站',url:'https://www.bilibili.com/video/BVTEST/',duration:300,desc:'',cid:1};
function pipeline(ctx,data,ids) {
 data.config=config;ctx.getConfig=async()=>data.config;ctx.getOrCreateBiliTab=async()=>({id:22,windowId:2});ctx.fetchVideoList=async()=>ids.map(id=>({id,title:id}));ctx.fetchMeta=async(t,c,j)=>({...metadata,id:j.id});
 ctx.fetchSubtitle=async()=>'subtitle';ctx.fetchTextVersion=async()=>null;ctx.pickTimestamps=async()=>[30];ctx.captureShots=async()=>[];ctx.summarize=async()=>({reportHtml:'<p>ok</p>',summary:'ok',review:'ok',captions:[]});ctx.buildReportHtml=()=>'<p>ok</p>';ctx.renderLongPng=async()=>'data:image/png;base64,AA==';ctx.sendMail=async()=>{};
}
test('extension render page can finish loading',async()=>{const {ctx,chrome}=sandbox();chrome.tabs.get=async()=>({status:'complete',url:'chrome-extension://test/render.html'});assert.equal((await ctx.waitTabComplete(1)).status,'complete');});
test('injected page failure cannot be mistaken for successful capture',async()=>{const {ctx,chrome}=sandbox();chrome.scripting={executeScript:async()=>[{result:undefined}]};await assert.rejects(ctx.pageEval(1,()=>{}),/页面脚本未成功/);});
test('always creates an owned, muted tab in task window',async()=>{
 const {ctx,chrome}=sandbox();const actions=[];
 chrome.tabs.create=async o=>{actions.push(['create',o]);return {id:33,windowId:2,...o};};chrome.tabs.update=async(id,o)=>{actions.push(['update',o]);return {id,windowId:2,...o};};
 const tab=await ctx.getOrCreateBiliTab();assert.equal(tab.id,33);assert.equal(actions[0][1].windowId,2);assert.equal(actions[1][1].muted,true);assert.equal(actions[0][1].url,'about:blank');
});
function captureMock(ctx,chrome) {
 let now=1000;ctx.Date=class extends Date{static now(){return now;}};ctx.sleep=async ms=>{now+=ms;};
 chrome.tabs.get=async()=>({id:22,windowId:2,url:metadata.url});chrome.tabs.update=async()=>{};chrome.tabs.query=async()=>[{id:22,url:metadata.url}];
 return ()=>now;
}
test('capture uses target window and respects rate limit',async()=>{
 const {ctx,chrome}=sandbox();const now=captureMock(ctx,chrome),calls=[];
 chrome.tabs.captureVisibleTab=async id=>{calls.push([id,now()]);return 'png';};
 for(let i=0;i<3;i++)await ctx.captureTarget(22,metadata.url);
 assert.ok(calls.every(c=>c[0]===2));assert.ok(calls[1][1]-calls[0][1]>=650);assert.ok(calls[2][1]-calls[1][1]>=650);
});
test('switching tabs during capture discards image',async()=>{
 const {ctx,chrome}=sandbox();captureMock(ctx,chrome);
 chrome.tabs.captureVisibleTab=async()=>{chrome.tabs.onActivated.emit({windowId:2,tabId:99});return 'private-page';};
 await assert.rejects(ctx.captureTarget(22,metadata.url),/截图已丢弃/);
});
test('no subtitles: wait, do not send or mark sent',async()=>{
 const {ctx,data}=sandbox();pipeline(ctx,data,['BVWAIT']);let mail=0;ctx.fetchSubtitle=async()=>null;ctx.sendMail=async()=>mail++;
 await ctx.run();await ctx.run();assert.equal(mail,0);assert.equal(Object.values(data.taskState.jobs)[0].status,'waiting_subtitle');
});
test('no subtitle but comment text link: summarize from text version',async()=>{
 const {ctx,data}=sandbox();pipeline(ctx,data,['BVTEXT']);let mail=0,captured=null;
 ctx.fetchSubtitle=async()=>null;
 ctx.fetchTextVersion=async()=>'文字版正文……（非逐字字幕）';
 ctx.summarize=async(c,m,s)=>{captured={sourceKind:m.sourceKind,sourceNote:m.sourceNote,text:s};return {reportHtml:'<p>ok</p>',summary:'ok',review:'ok',captions:[]};};
 ctx.sendMail=async()=>mail++;
 await ctx.run();
 assert.equal(mail,1);assert.equal(Object.values(data.taskState.jobs)[0].status,'sent');
 assert.equal(captured.sourceKind,'text_version');assert.match(captured.text,/文字版正文/);assert.match(captured.sourceNote,/文字版/);
});
test('no subtitle and no text link beyond 24h: explain in summary instead of waiting',async()=>{
 const {ctx,data}=sandbox();pipeline(ctx,data,['BVEXPLAIN']);let mail=0,captured=null;
 ctx.fetchMeta=async(t,c,j)=>({...metadata,id:j.id,pubdate:Math.floor(Date.now()/1000)-48*3600});
 ctx.fetchSubtitle=async()=>null;ctx.fetchTextVersion=async()=>null;
 ctx.summarize=async(c,m,s)=>{captured={sourceKind:m.sourceKind,sourceNote:m.sourceNote,text:s};return {reportHtml:'<p>ok</p>',summary:'ok',review:'ok',captions:[]};};
 ctx.sendMail=async()=>mail++;
 await ctx.run();
 assert.equal(mail,1);assert.equal(Object.values(data.taskState.jobs)[0].status,'sent');
 assert.equal(captured.sourceKind,'desc_only');assert.equal(captured.text,null);assert.match(captured.sourceNote,/未找到「文字版」链接/);
});
test('failure of two videos does not starve the third',async()=>{
 const {ctx,data}=sandbox();pipeline(ctx,data,['BVFAIL1','BVFAIL2','BVGOOD']);const sent=[];
 ctx.fetchMeta=async(t,c,j)=>{if(j.id!=='BVGOOD')throw Error('unavailable');return {...metadata,id:j.id};};ctx.sendMail=async()=>sent.push(true);
 await ctx.run();assert.equal(sent.length,1);assert.equal(Object.values(data.taskState.jobs).find(j=>j.id==='BVGOOD').status,'sent');
});
test('mail checkpoint is reused after a definite SMTP rejection',async()=>{
 const {ctx,data}=sandbox();pipeline(ctx,data,['BVTEST']);let builds=0,mails=0;
 ctx.renderLongPng=async()=>{builds++;return 'data:image/png;base64,AA==';};ctx.sendMail=async()=>{if(++mails===1)throw Error('SMTP rejected');};
 await ctx.run();Object.values(data.taskState.jobs)[0].nextAttempt=0;await ctx.run();assert.equal(builds,1);assert.equal(mails,2);
});
test('prepared mail can retry after the managed model key is cleared',async()=>{
 const {ctx,chrome,data}=sandbox();pipeline(ctx,data,['BVTEST']);let builds=0,mails=0,resolutions=0;
 ctx.renderLongPng=async()=>{builds++;return 'data:image/png;base64,AA==';};ctx.sendMail=async()=>{if(++mails===1)throw Error('SMTP rejected');};
 await ctx.run();data.config={...config,modelSiteId:'cleared-api',modelKey:''};Object.values(data.taskState.jobs)[0].nextAttempt=0;
 chrome.runtime.sendMessage=async()=>{resolutions++;return {ok:false,error:'Key cleared'};};
 await ctx.run();assert.equal(builds,1);assert.equal(mails,2);assert.equal(resolutions,0);assert.equal(Object.values(data.taskState.jobs)[0].status,'sent');
});
test('uncertain delivery is not automatically resent',async()=>{
 const {ctx,data}=sandbox();pipeline(ctx,data,['BVTEST']);let mails=0;
 ctx.sendMail=async()=>{mails++;throw Object.assign(Error('timeout'),{deliveryUnknown:true});};
 await ctx.run();await ctx.run();assert.equal(mails,1);assert.equal(Object.values(data.taskState.jobs)[0].status,'delivery_unknown');
});
test('interrupted sending checkpoint becomes uncertain on next run',async()=>{
 const {ctx,data}=sandbox();pipeline(ctx,data,['BVTEST']);const scope=ctx.queueScope(config);
 data.taskState={jobs:{sample:{id:'BVTEST',title:'test',scope,status:'sending',uuid:'test',attempts:0}}};let mails=0;ctx.sendMail=async()=>mails++;
 // Use the actual queue key so rediscovery does not create another record.
 data.taskState.jobs[scope+'|BVTEST']=data.taskState.jobs.sample;delete data.taskState.jobs.sample;
 await ctx.run();assert.equal(mails,0);assert.equal(Object.values(data.taskState.jobs)[0].status,'delivery_unknown');
});
test('subtitle bounds reject partial data but accept timed coverage',()=>{
 const {ctx}=sandbox();assert.equal(ctx.usableSubtitle([{from:1,to:2,content:'unrelated'}],3600),null);
 const body=Array.from({length:10},(_,i)=>({from:i*30,to:(i+1)*30,content:'正文'}));assert.equal(ctx.usableSubtitle(body,300).length,10);
});
test('lecture output is required only when the option is enabled',()=>{
 const {ctx}=sandbox();
 // sanitizeReport 需要 DOM；测试只需验证 lecture 校验分支，给一个空模板桩即可
 ctx.document={createElement:tag=>tag==='template'
  ? {set innerHTML(v){this.content={childNodes:[]};},content:{childNodes:[]}}
  : {childNodes:[],appendChild(){},innerHTML:'',createTextNode:t=>({nodeType:3,textContent:t}),createComment:d=>({nodeType:8,data:d})}};
 const base={reportHtml:'<p>ok</p>',summary:'s',review:'r',captions:['c']};
 const lecture={title:'讲解',subtitle:'导语',chapters:[{title:'一',body:'正文',fig:1},{title:'二',body:'正文'}]};
 assert.equal(ctx.BWMUtils.validateModel(structuredClone(base),1).lecture,undefined);
 assert.equal(ctx.BWMUtils.validateModel(structuredClone({...base,lecture}),1,true).lecture.title,'讲解');
 assert.throws(()=>ctx.BWMUtils.validateModel(structuredClone(base),1,true),/lecture 输出缺失/);
 assert.throws(()=>ctx.BWMUtils.validateModel(structuredClone({...base,lecture:{...lecture,chapters:[{title:'一',body:'x',fig:2},{title:'二',body:'x'}]}}),1,true),/图片序号/);
 assert.throws(()=>ctx.BWMUtils.validateModel(structuredClone({...base,lecture:{...lecture,chapters:[{title:'',body:'x'},{title:'二',body:'x'}]}}),1,true),/章节标题/);
});
test('lecture page is a self-contained dark explainer with chapters and figures',()=>{
 const {ctx}=sandbox();
 const html=ctx.buildLectureHtml({...metadata,title:'<video>'},{title:'T',subtitle:'S',chapters:[
  {title:'问题',body:'先给直觉。\n\n再给公式 `K(w)=⟨∇f,∇f⟩`。',fig:1},
  {title:'结论',body:'收尾。'},
 ]},[{t:30,dataUrl:'data:image/png;base64,AA=='},{t:60,dataUrl:'data:image/png;base64,BB=='}]);
 assert.ok(html.includes('id="step-1"')&&html.includes('id="step-2"'));
 assert.ok(html.includes('STEP 01')&&html.includes('nav class="toc"'));
 assert.ok(html.includes('data:image/png;base64,AA=='));
 assert.ok(!html.includes('BB=='));
 assert.ok(html.includes('<code>K(w)=⟨∇f,∇f⟩</code>'));
 assert.ok(html.includes('&lt;video&gt;')&&!html.includes('<video>'));
 assert.ok(html.includes('lang="zh-CN"')&&html.includes('#1C1C1C'));
});
test('mail attaches lecture.html only when provided',()=>{
 const {ctx}=sandbox();const png=Buffer.from('png').toString('base64');
 const plain=ctx.buildMime(config,'s','<p>b</p>',png,'test-id',null,null);
 assert.ok(!plain.includes('lecture.html'));
 const withLecture=ctx.buildMime(config,'s','<p>b</p>',png,'test-id',null,'<html>讲</html>');
 assert.ok(withLecture.includes('filename="lecture.html"'));
 assert.ok(withLecture.includes(Buffer.from('<html>讲</html>').toString('base64')));
});
test('long transcript splitting preserves every character',()=>{const {ctx}=sandbox();const text=('字幕'.repeat(14000)+'\n').repeat(3);const parts=ctx.splitTranscript(text);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=12000));assert.ok(ctx.buildPrompt(metadata,'尾部内容'.repeat(12000),[]).endsWith('尾部内容'.repeat(12000)));});
test('rejects HTTP credentials except loopback model; requires relay auth',()=>{
 const {ctx}=sandbox();const validate=ctx.BWMUtils.validateConfig;
 assert.throws(()=>validate({...config,relayUrl:'http://relay.example.test'}),/HTTPS/);assert.throws(()=>validate({...config,modelApi:'http://model.example.test'}),/HTTPS/);assert.throws(()=>validate({...config,relayKey:''}),/中继密钥/);
 assert.equal(validate({...config,modelApi:'http://127.0.0.1:8000/v1'}).modelApi,'http://127.0.0.1:8000/v1');
});
test('relay auth header is sent and false success response is rejected',async()=>{
 const {ctx}=sandbox();let options;
 ctx.fetch=async(url,init)=>{options=init;return new Response(JSON.stringify({ok:false,error:'rejected',deliveryUnknown:false}),{status:200});};
 await assert.rejects(ctx.sendMail(config,'test','<p>test</p>','data:image/png;base64,AA==','test-id'),/rejected/);
 assert.equal(options.headers.Authorization,'Bearer '+config.relayKey);assert.equal(JSON.parse(options.body).port,465);
});
test('mail escapes text and folds Unicode subject without splitting codepoints',()=>{
 const {ctx}=sandbox();const title='视频测试📺'.repeat(50);const word=ctx.encWord(title);const parts=word.split('\r\n ');
 assert.ok(parts.every(p=>p.length<=75));assert.equal(parts.map(p=>Buffer.from(p.slice(10,-2),'base64').toString('utf8')).join(''),title);
 assert.ok(!ctx.buildMailBody({...metadata,title:'<img src=x>'},{summary:'<img src=y>',review:'ok'}).includes('<img src=y>'));
});

function relayModule() {
 const ctx=vm.createContext({Response,Request,TextEncoder,TextDecoder,Uint8Array,atob,btoa,setTimeout,clearTimeout,connect:()=>{throw Error('No real sockets in tests');}});
 const code=read('relay-worker.js').replace('import {connect} from "cloudflare:sockets";','').replace('export async function smtpSend','async function smtpSend').replace('export default','globalThis.relay =');
 vm.runInContext(code,ctx);return ctx;
}
function socketFixture(replies,{stall=false}={}) {
 const bytes=replies.map(text=>new TextEncoder().encode(text));let closed=0;const writes=[];
 const socket={readable:{getReader:()=>({read:async()=>bytes.length?{value:bytes.shift(),done:false}:stall?new Promise(()=>{}):{done:true},releaseLock(){}})},writable:{getWriter:()=>({write:async b=>{writes.push(new TextDecoder().decode(b));},releaseLock(){}})},close:async()=>{closed++;},closed:Promise.resolve()};
 return {socket,writes,closed:()=>closed};
}
const smtpPayload={host:'smtp.example.test',port:465,user:'from@example.test',pass:'dummy',from:'from@example.test',to:'to@example.test',rawMimeBase64:btoa('Subject: test\r\n\r\n.body\r\n')};
test('SMTP accepts fragmented multiline replies, enables TLS, dot-stuffs, closes',async()=>{
 const {smtpSend}=relayModule();const f=socketFixture(['220 ','ready\r\n','250-first\r\n250 AUTH LOGIN\r\n','334 user\r\n','334 pass\r\n','235 ok\r\n','250 ok\r\n','250 ok\r\n','354 data\r\n','250 queued\r\n']);let mode;
 const result=await smtpSend(smtpPayload,(address,options)=>{mode=options.secureTransport;return f.socket;},50);
 assert.equal(result.ok,true);assert.equal(mode,'on');assert.ok(f.writes.some(s=>s.includes('\r\n..body\r\n.\r\n')));assert.equal(f.closed(),1);
});
test('SMTP timeout interrupts stalled read and closes connection',async()=>{
 const {smtpSend}=relayModule();const f=socketFixture([],{stall:true});const result=await smtpSend(smtpPayload,()=>f.socket,10);
 assert.equal(result.ok,false);assert.match(result.error,/超时/);assert.equal(result.deliveryUnknown,false);assert.ok(f.closed()>=1);
});
test('SMTP disconnect after message submission reports uncertain delivery',async()=>{
 const {smtpSend}=relayModule();const f=socketFixture(['220 ready\r\n','250 ok\r\n','334 user\r\n','334 pass\r\n','235 ok\r\n','250 ok\r\n','250 ok\r\n','354 data\r\n']);
 const result=await smtpSend(smtpPayload,()=>f.socket,50);assert.equal(result.deliveryUnknown,true);assert.equal(f.closed(),1);
});
test('worker requires Authorization and rejects SMTP header injection',async()=>{
 const {relay}=relayModule();const env={ACCESS_KEY:config.relayKey};
 let response=await relay.fetch(new Request('https://relay.example.test/?key='+config.relayKey,{method:'POST',body:'{}'}),env);assert.equal(response.status,403);
 response=await relay.fetch(new Request('https://relay.example.test',{method:'POST',headers:{Authorization:'Bearer '+config.relayKey},body:JSON.stringify({...smtpPayload,to:'a@example.test\r\nRCPT TO:<b@example.test>'})}),env);assert.equal(response.status,400);
});
test('587 negotiates STARTTLS before credentials',async()=>{
 const {smtpSend}=relayModule();const plain=socketFixture(['220 ready\r\n','250 STARTTLS\r\n','220 go\r\n']);
 const secure=socketFixture(['250 AUTH LOGIN\r\n','334 user\r\n','334 pass\r\n','235 ok\r\n','250 ok\r\n','250 ok\r\n','354 data\r\n','250 accepted\r\n']);plain.socket.startTls=()=>secure.socket;let mode;
 const response=await smtpSend({...smtpPayload,port:587},(a,o)=>{mode=o.secureTransport;return plain.socket;},50);
 assert.equal(response.ok,true);assert.equal(mode,'starttls');assert.deepEqual(plain.writes,['EHLO bwm-relay\r\n','STARTTLS\r\n']);assert.ok(secure.writes.includes('AUTH LOGIN\r\n'));
});


test('generic protocol uses user model without vendor overrides',async()=>{
 const {ctx}=sandbox();let body;
 ctx.fetch=async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));};
 await ctx.modelJson({...config,modelApi:'https://api.provider.example/v1',modelName:'user-selected-model'},[{role:'user',content:'test'}]);
 assert.equal(body.model,'user-selected-model');assert.equal(body.thinking,undefined);assert.equal(body.max_completion_tokens,undefined);assert.equal(body.temperature,.3);
});
test('generic providers do not receive vendor-specific parameters',async()=>{
 const {ctx}=sandbox();let body;
 ctx.fetch=async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));};
 await ctx.modelJson({...config,modelName:'user-selected-model'},[{role:'user',content:'test'}]);
 assert.equal(body.thinking,undefined);assert.equal(body.max_completion_tokens,undefined);
});

test('mail includes a downloadable PNG and a standards-shaped preview CID',()=>{
 const {ctx}=sandbox();const png=Buffer.from('original png bytes').toString('base64');
 const mime=ctx.buildMime(config,'test','<p>report</p><img src="cid:long.png">',png,'mime-roundtrip',{mimeType:'image/jpeg',base64:Buffer.from('preview bytes').toString('base64')});
 assert.match(mime,/Content-Type: multipart\/mixed;/);
 assert.match(mime,/Content-Disposition: attachment; filename="video-summary\.png"/);
 const tail=mime.split('Content-Disposition: attachment; filename="video-summary.png"\r\n')[1];
 const payload=tail.split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\s/g,'');
 assert.equal(Buffer.from(payload,'base64').toString(),'original png bytes');
 const htmlPart=mime.split('Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
 const html=Buffer.from(htmlPart.replace(/\s/g,''),'base64').toString();
 assert.ok(html.includes('cid:preview-mime-roundtrip@bwm.local'));
 assert.ok(mime.includes('Content-ID: <preview-mime-roundtrip@bwm.local>'));
 assert.ok(!html.includes('cid:long.png'));
});
test('inline preview does not replace original attachment bytes',()=>{
 const {ctx}=sandbox();const original=Buffer.from('full resolution image').toString('base64'),preview=Buffer.from('small preview').toString('base64');
 const mime=ctx.buildMime(config,'test','<img src="cid:long.png">',original,'separate-images',{mimeType:'image/jpeg',base64:preview});
 assert.equal(mime.split(original).length-1,1);assert.equal(mime.split(preview).length-1,1);
 assert.ok(ctx.buildMailBody(metadata,{summary:'test',review:'test'}).includes('video-summary.png'));
});
test('video-region crop accounts for screenshot device pixels',async()=>{
 const {ctx}=sandbox();const calls=[];
 ctx.Image=class{constructor(){this.naturalWidth=2560;this.naturalHeight=1700;}set src(value){this.onload();}};
 const canvas={getContext:()=>({drawImage:(...args)=>calls.push(args)}),toDataURL:()=> 'cropped'};
 ctx.document={createElement:()=>canvas};
 assert.equal(await ctx.cropVideoCapture('png',{x:400,y:0,width:480,height:850,viewportW:1280,viewportH:850}),'cropped');
 assert.deepEqual(calls[0].slice(1),[800,0,960,1700,0,0,960,1700]);
});
test('login promotion cannot silently become a video screenshot',async()=>{
 const {ctx,chrome}=sandbox();let captures=0;
 chrome.tabs.get=async()=>({id:22,url:metadata.url,status:'complete'});chrome.tabs.update=async()=>{};
 chrome.tabs.captureVisibleTab=async()=>{captures++;return 'not-a-video';};
 ctx.document={getElementById:()=>({getBoundingClientRect:()=>({width:500})})};
 chrome.scripting={executeScript:async({func,args=[]})=>[{result:await func(...args)}]};
 await assert.rejects(ctx.ensureVideoUnobscured(22),/登录提示遮挡视频/);assert.equal(captures,0);
});

test('decoded video frames are preferred over page screenshots',async()=>{
 const {ctx,chrome}=sandbox();let captures=0;const draws=[];
 const video={duration:60,readyState:4,currentTime:0,seeking:false,videoWidth:576,videoHeight:1024,pause(){}};
 const canvas={getContext:()=>({drawImage:(...a)=>draws.push(a)}),toDataURL:()=> 'data:image/png;base64,AA=='};
 ctx.document={querySelector:()=>video,createElement:tag=>tag==='canvas'?canvas:{},head:{appendChild(){}},getElementById:()=>({getBoundingClientRect:()=>({width:500})})};
 ctx.requestAnimationFrame=callback=>callback();
 chrome.tabs.get=async()=>({id:22,status:'complete',url:metadata.url});chrome.tabs.update=async()=>{};
 chrome.tabs.captureVisibleTab=async()=>{captures++;return 'page';};chrome.scripting={executeScript:async({func,args=[]})=>[{result:await func(...args)}]};
 const shots=await ctx.captureShots({id:22},{...metadata,platform:'douyin'},[0]);
 assert.equal(shots[0].method,'video-canvas');assert.equal(captures,0);assert.deepEqual(draws[0].slice(1),[0,0,576,1024]);
});
test('frame analysis requires explicit user vision capability',()=>{
 const {ctx}=sandbox();const cfg={...config,modelApi:'https://api.provider.example/v1',modelName:'user-selected-model',modelVision:'true'},meta={...metadata,platform:'douyin'},shots=[{t:10,dataUrl:'data:image/png;base64,AA=='}];
 assert.equal(ctx.canReadVisualFrames(cfg,meta,null,shots),true);
 assert.equal(ctx.canReadVisualFrames(config,meta,null,shots),false);
 assert.equal(ctx.canReadVisualFrames(cfg,metadata,null,shots),false);
 assert.equal(ctx.canReadVisualFrames(cfg,meta,'available subtitles',shots),false);
});
test('visual summary messages pair frame timestamps with image data and limits',async()=>{
 const {ctx}=sandbox();ctx.createInlinePreview=async()=>({mimeType:'image/jpeg',base64:'AA=='});
 const messages=await ctx.buildSummaryMessages({...config,modelApi:'https://api.provider.example/v1',modelName:'user-selected-model',modelVision:'true'},{...metadata,platform:'douyin'},null,[10],[{t:10,dataUrl:'data:image/png;base64,AA=='}]);
 assert.ok(Array.isArray(messages[1].content));assert.ok(messages[1].content[0].text.includes('未分析音频'));
 assert.ok(messages[1].content.some(c=>c.type==='text'&&c.text.includes('0:10')));
 assert.equal(messages[1].content.find(c=>c.type==='image_url').image_url.url,'data:image/jpeg;base64,AA==');
});
test('oversized PNG export is resized while preserving the whole page aspect',()=>{
 const sizes=[];
 class Canvas{constructor(w=0,h=0){this.width=w;this.height=h;}getContext(){return {drawImage:(source,x,y,w,h)=>sizes.push([w,h])};}toDataURL(){return 'data:image/png;base64,'+'A'.repeat(this.width>1000?12000000:1000000);}}
 const ctx=vm.createContext({window:{},document:{createElement:()=>new Canvas()}});vm.runInContext(read('render.js'),ctx);
 const renderer=ctx.window.BWM;renderer.canvas=new Canvas(1600,16000);renderer.width=800;renderer.height=8000;renderer.covered=8000;
 const out=renderer.finish();assert.ok(out.png.length<Math.ceil(8*1024*1024/3)*4+22);assert.ok(sizes.length>0);assert.ok(sizes.every(([w,h])=>Math.abs(h/w-10)<.01));
});

test('no unconfigured or legacy model can run without selecting a managed API',async()=>{const {ctx}=sandbox();await assert.rejects(ctx.getConfig(),/API 管理页/);assert.equal(ctx.BWMUtils.DEFAULTS.modelKey,'');assert.equal(ctx.BWMUtils.DEFAULTS.modelName,'');});

test('vault encrypts keys at rest and unlocks only with the correct passphrase',async()=>{
 const core=await import(pathToFileURL(path.join(root,'keydock/src/core.mjs')).href);
 const vault=await core.createVault({s1:'sk-secret-1234',s2:'tok-5678'},'correct horse battery');
 assert.ok(!JSON.stringify(vault).includes('sk-secret-1234'));
 assert.deepEqual(Object.keys(vault.entries).sort(),['s1','s2']);
 const unlocked=await core.unlockVault(vault,'correct horse battery');
 assert.deepEqual(unlocked.keys,{s1:'sk-secret-1234',s2:'tok-5678'});
 const exported=await core.exportVaultKey(unlocked.vaultKey);
 const reimported=await core.importVaultKey(exported);
 assert.equal(await core.openValue(reimported,vault.entries.s1),'sk-secret-1234');
 await assert.rejects(core.unlockVault(vault,'wrong password'),/不正确|损坏/);
 await assert.rejects(core.unlockVault({version:2,entries:{}},'correct horse battery'),/数据无效/);
 assert.throws(()=>core.vaultPassphrase('short'),/至少 8/);
});
