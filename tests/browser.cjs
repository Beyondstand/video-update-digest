// Run with PLAYWRIGHT_MODULE pointing to an installed playwright package if it
// is not in node_modules. Creates an isolated browser profile, intercepts all
// provider traffic, and never uses real accounts, API keys, or SMTP servers.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');const path=require('path');const assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.TEST_OUTPUT || path.join(root,'test-results'));
const profile=path.join(output,'profile');fs.mkdirSync(output,{recursive:true});
async function until(fn, timeout=30000) { const start=Date.now(); while(Date.now()-start<timeout) { if(await fn())return; await new Promise(r=>setTimeout(r,250)); } throw new Error('Condition timed out'); }
const config={modelApi:'https://model.example.test/v1',modelKey:'dummy',modelName:'dummy',platform:'bilibili',uid:'123',to:'to@example.test',from:'from@example.test',smtpPass:'dummy',smtpHost:'smtp.example.test',smtpPort:'465',relayUrl:'https://relay.example.test',relayKey:'test-relay-key-at-least-24-characters',intervalHours:'6'};
const videoPage=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f5f6f8}.bpx-player-container{height:650px;background:#0b3d66}video{width:100%;height:100%;object-fit:contain}</style><div class="bpx-player-container"><video src="https://media.example.test/video.webm" muted preload="auto"></video></div>`;
async function videoFixture(context) {
 const page=await context.newPage();
 const base64=await page.evaluate(async()=>{
  const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');let n=0;
  const draw=()=>{g.fillStyle='#0b3d66';g.fillRect(0,0,640,360);g.fillStyle='#ff8c1a';g.fillRect(30+(n++%20)*20,270,60,30);g.fillStyle='white';g.font='32px sans-serif';g.fillText('EDGE VIDEO TEST',110,170);};draw();
  const stream=c.captureStream(10);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});const chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);
  const finished=new Promise(r=>recorder.onstop=r);recorder.start();const timer=setInterval(draw,100);await new Promise(r=>setTimeout(r,2000));recorder.stop();await finished;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
  const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary);
 });
 await page.close();
 const bytes=Buffer.from(base64,'base64');
 // MediaRecorder uses an unknown-sized Segment and omits Duration. Add a
 // finite duration to Info so a real HTMLVideoElement supports normal seeking.
 const info=bytes.indexOf(Buffer.from([0x15,0x49,0xa9,0x66]));assert.ok(info>=0);
 const position=info+4;let sizeBytes=1,mask=0x80;while(!(bytes[position]&mask)){sizeBytes++;mask>>=1;}
 let size=bytes[position]&(mask-1);for(let i=1;i<sizeBytes;i++)size=size*256+bytes[position+i];
 const duration=Buffer.alloc(11);duration.set([0x44,0x89,0x88]);duration.writeDoubleBE(2000,3);
 const end=position+sizeBytes+size;const result=Buffer.concat([bytes.subarray(0,end),duration,bytes.subarray(end)]);
 let newSize=size+duration.length;for(let i=sizeBytes-1;i>=0;i--){result[position+i]=newSize&255;newSize=Math.floor(newSize/256);}result[position]|=mask;
 return result;
}
(async()=>{
 const launch=()=>chromium.launchPersistentContext(profile,{executablePath:process.env.EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,viewport:null,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
 let context=await launch();
 const results=[];const requests=[];let modelCount=0,mailCount=0,modelStarted=false,slowModel=process.env.FAST_BROWSER !== '1',mailedPayload;
 let managedId,managedKey='sk-managed-browser-fixture-12345';
 let page,extensionId;
 try {
  // Observe the real renderer before it releases its canvas. PNG dimensions
  // may shrink to fit the mail limit, so document coverage is the invariant.
  await context.addInitScript(()=>{
   if(location.protocol!=='chrome-extension:' || !location.pathname.endsWith('/render.html'))return;
   let renderer;
   Object.defineProperty(window,'BWM',{configurable:true,get(){return renderer;},set(api){
    renderer=api;const finish=api.finish;
    api.finish=async function(...args){
     const metrics={...this.dimensions(),covered:this.covered,endMarker:this.host.textContent.includes('END-OF-REPORT')};
     const result=finish.apply(this,args);
     await chrome.storage.local.set({browserTestRenderMetrics:metrics});
     return result;
    };
   }});
  });
  const fixture=await videoFixture(context);
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if (url.protocol==='chrome-extension:') return route.continue();
   requests.push(url.href);
   const cors={'Access-Control-Allow-Origin':request.headers().origin || '*','Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'*'};
   const json=body=>route.fulfill({status:200,headers:cors,contentType:'application/json',body:JSON.stringify(body)});
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
   if(url.hostname==='space.bilibili.com')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<a href="https://www.bilibili.com/video/BVTEST/">测试视频</a>'});
   if(url.hostname==='www.bilibili.com')return route.fulfill({contentType:'text/html; charset=utf-8',body:videoPage});
   if(url.hostname==='media.example.test')return route.fulfill({contentType:'video/webm',body:fixture});
   if(url.hostname==='api.bilibili.com') {
    if(url.pathname.includes('web-interface/view'))return json({code:0,data:{title:'测试视频：全流程与长图',owner:{mid:123,name:'测试作者'},pages:[{cid:1,duration:2}],desc:'用于隔离环境回归验证',pubdate:1}});
    if(url.pathname.includes('/player/v2'))return json({data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://subtitle.example.test/cues'}]}}});
    return route.fulfill({headers:cors,contentType:'text/xml',body:'<i></i>'});
   }
   if(url.hostname==='subtitle.example.test')return json({body:Array.from({length:10},(_,i)=>({from:i*.2,to:(i+1)*.2,content:'这是用于测试的完整字幕，介绍回归验证和边界条件。'}))});
   if(url.hostname==='model.example.test') {
    assert.equal(request.headers().authorization,'Bearer '+managedKey,'task uses the selected and rotated KeyDock key');
    modelCount++;modelStarted=true;
    await new Promise(r=>setTimeout(r,slowModel?35000:1000));
    const html='<h2>流程验证报告</h2><script>window.PWNED=true</script><img src="https://evil.example.test/leak"><p class="card" onclick="alert(1)">应保留的安全内容</p>'+Array.from({length:420},(_,i)=>`<p>第 ${i+1} 段：验证长报告应完整生成，不应横向压缩，不应遗漏底部内容。</p>${i%90===0?'<!--FIG'+(Math.floor(i/90)+1)+'-->':''}`).join('')+'<h2>报告末尾标记 END-OF-REPORT</h2>';
    return json({choices:[{message:{content:JSON.stringify({reportHtml:html,summary:'<img src="https://evil.example.test/mail">这是测试摘要。',review:'【科学性】仅用于测试。',captions:['测试画面']})}}]});
   }
   if(url.hostname==='relay.example.test') {
    mailCount++;mailedPayload=JSON.parse(request.postData());assert.equal(request.headers().authorization,'Bearer '+config.relayKey);
    return json({ok:true,reply:'queued'});
   }
   return route.abort();
  });
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');extensionId=new URL(worker.url()).host;
  page=await context.newPage();await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(()=>!document.getElementById('modelStatus').textContent.includes('正在'));
  await page.evaluate(async cfg=>{await chrome.storage.local.clear();await chrome.storage.local.set({config:cfg});},config);
  await page.reload();
  const managerPromise=context.waitForEvent('page');await page.locator('#manageApi').click();const manager=await managerPromise;
  await manager.waitForURL(`chrome-extension://${extensionId}/keydock/options.html`);
  await manager.locator('#add-site').click();
  await manager.locator('#origin').fill('https://console.example.test');await manager.locator('#account').fill('演示账号');
  await manager.locator('#model-api').fill(config.modelApi);await manager.locator('#model-name').fill(config.modelName);
  await manager.locator('#save-site').click();await manager.locator('#key-dialog').waitFor({state:'visible'});
  await manager.locator('#manual-key').fill(managedKey);await manager.getByRole('button',{name:'存入会话',exact:true}).click();
  await until(()=>manager.locator('.site-card .key-text').count());
  assert.ok(!(await manager.locator('.site-card .key-text').innerText()).includes(managedKey),'key is masked');
  await manager.getByRole('button',{name:'用于总结',exact:true}).click();
  await until(()=>page.evaluate(async()=>Boolean((await chrome.storage.local.get('config')).config.modelSiteId)));
  managedId=await page.evaluate(async()=>(await chrome.storage.local.get('config')).config.modelSiteId);
  const linked=await page.evaluate(async()=>{
   const {config}=await chrome.storage.local.get('config');const session=await chrome.storage.session.get('keys');
   return {binding:config.modelSiteId,modelKey:config.modelKey,hasSessionKey:Boolean(session.keys[config.modelSiteId]?.key),from:config.from,to:config.to,smtpPass:config.smtpPass,relayKey:config.relayKey};
  });
  assert.equal(linked.modelKey,'');assert.equal(linked.hasSessionKey,true);
  for(const k of ['from','to','smtpPass','relayKey'])assert.equal(linked[k],config[k]);
  assert.ok(!(await manager.locator('body').innerText()).includes(config.from));
  results.push({case:'KeyDock manager opens from popup; local key masked and selected; mail settings preserved',status:'passed'});
  await manager.getByRole('button',{name:'录入 Key',exact:true}).click();managedKey='sk-managed-rotated-fixture-67890';
  await manager.locator('#manual-key').fill(managedKey);await manager.getByRole('button',{name:'存入会话',exact:true}).click();
  await until(()=>page.evaluate(async({id,key})=>(await chrome.storage.session.get('keys')).keys[id]?.key===key,{id:managedId,key:managedKey}));
  await manager.screenshot({path:path.join(output,'api-manager.png'),fullPage:true});await manager.close();
  results.push({case:'updated personal key stays in session; subsequent model request must use it',status:'passed'});
  const untouched=await context.newPage();await untouched.goto('https://www.bilibili.com/video/BVUSER/');
  await page.locator('#run').click();
  const start=Date.now();
  while(!modelStarted && Date.now()-start<30000)await new Promise(r=>setTimeout(r,250));
  assert.ok(modelStarted,'pipeline reaches model');
  // Explicitly stop the worker while the task page awaits a slow model. The
  // dedicated page must finish even after the scheduling worker is recycled.
  const cdp=await context.newCDPSession(page);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
  await until(()=>page.evaluate(async()=>{const jobs=Object.values((await chrome.storage.local.get('taskState')).taskState?.jobs || {});if(jobs.some(j=>j.status==='failed'))throw new Error(jobs.find(j=>j.status==='failed').error);return jobs.some(j=>j.status==='sent');}),120000);
  assert.equal(modelCount,1);assert.equal(mailCount,1);assert.equal(untouched.url(),'https://www.bilibili.com/video/BVUSER/');
  assert.ok(!requests.some(u=>u.includes('evil.example.test')));
  const mime=Buffer.from(mailedPayload.rawMimeBase64,'base64').toString('utf8');
  const pngPart=mime.match(/Content-Type: image\/png[\s\S]*?Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/);
  assert.ok(pngPart,'PNG attachment exists');
  const png=Buffer.from(pngPart[1].replace(/\s/g,''),'base64');
  fs.writeFileSync(path.join(output,'report.png'),png);
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  const renderMetrics=await page.evaluate(async()=>(await chrome.storage.local.get('browserTestRenderMetrics')).browserTestRenderMetrics);
  assert.ok(renderMetrics.height>16*renderMetrics.viewportH,'source report exceeds old 16-viewport limit');
  assert.ok(renderMetrics.covered>=renderMetrics.height && renderMetrics.endMarker,'whole report including footer was rendered');
  assert.ok(png.length<=8*1024*1024,'export fits PNG mail limit');
  assert.ok(Math.abs(width/height-renderMetrics.width/renderMetrics.height)<.001,'export preserves the full report aspect');
  results.push({case:'full pipeline; worker stopped; original user tab preserved; sanitized HTML; full report >16 viewports and bounded PNG',status:'passed',modelDelayMs:slowModel?35000:1000,width,height,pngBytes:png.length,renderMetrics,modelCount,mailCount});
  // A repeat run must skip the already-sent video.
  await until(()=>page.evaluate(async()=>!(await chrome.tabs.query({})).some(t=>t.url.endsWith('/runner.html'))));
  await page.locator('#run').click();
  await until(()=>page.evaluate(async()=>{const {logs=[]}=await chrome.storage.local.get('logs');return logs.at(-1)?.m.includes('发送 0 封');}));
  assert.equal(mailCount,1);results.push({case:'already-sent video is not resent',status:'passed'});
  await until(()=>page.evaluate(async()=>!(await chrome.tabs.query({})).some(t=>t.url.endsWith('/runner.html'))));
  // Test the actual browser sanitizer against mixed HTML namespaces and URLs.
  const sanitized=await page.evaluate(()=>BWMUtils.sanitizeReport('<svg><foreignObject><img src="https://evil.example.test/x"></foreignObject></svg><style>@import "https://evil.example.test/y"</style><p class="card bad" onclick="evil()">安全 <a href="javascript:evil()">文字</a></p><!--FIG1-->'));
  assert.equal(sanitized,'<p class="card">安全 文字</p><!--FIG1-->');results.push({case:'DOM allowlist strips active content and URLs',status:'passed'});
  // Renderer geometry at both a wide window and a narrow window, using actual
  // browser screenshots and canvas pixels. No model/network involved.
  for(const size of [{width:1600,height:600,dpr:1},{width:600,height:600,dpr:1},{width:1600,height:600,dpr:2}]) {
   const render=await context.newPage();await render.setViewportSize(size);await render.goto(`chrome-extension://${extensionId}/render.html`);
   const geometrySession=await context.newCDPSession(render);await geometrySession.send('Emulation.setDeviceMetricsOverride',{width:size.width,height:size.height,deviceScaleFactor:size.dpr,mobile:false});
   const info=await render.evaluate(()=>BWM.setContent('<div style="height:1600px;background:#00a060"><div style="height:50px;background:#ff0000"></div><div style="margin-top:1500px;height:50px;background:#0000ff"></div></div>',900));
   let y=0;
   while(y<info.height) {
    const pos=await render.evaluate(y=>BWM.scrollTo(y),y);
    const bytes=await render.screenshot();
    await render.evaluate(s=>BWM.appendSlice(s),{...pos,dataUrl:'data:image/png;base64,'+bytes.toString('base64')});
    y=Math.min(info.height,pos.y+pos.viewportH);
   }
   const geometry=await render.evaluate(()=>{
    const c=BWM.canvas,ctx=BWM.ctx;
    const scale=c.width/BWM.width;
    return {width:BWM.width,right:[...ctx.getImageData(Math.floor((BWM.width-2)*scale),Math.floor(20*scale),1,1).data],tail:[...ctx.getImageData(Math.floor(20*scale),Math.floor((BWM.height-20)*scale),1,1).data]};
   });
   assert.equal(geometry.width,Math.min(900,size.width));assert.deepEqual(geometry.right,[255,0,0,255]);assert.deepEqual(geometry.tail,[0,0,255,255]);
   results.push({case:'renderer crop/narrow layout '+size.width+' DPR '+size.dpr,status:'passed',geometry});await render.close();
  }
  await context.close();context=await launch();
  await context.route('**/*',route=>new URL(route.request().url()).protocol==='chrome-extension:'?route.continue():route.abort());
  page=await context.newPage();await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(()=>document.getElementById('modelStatus').textContent.includes('不可用'));
  const afterRestart=await page.evaluate(async()=>({...(await chrome.storage.local.get('config')).config,hasKey:Boolean((await chrome.storage.session.get('keys')).keys?.[document.getElementById('modelProfile').value]?.key)}));
  assert.equal(afterRestart.modelSiteId,managedId);assert.equal(afterRestart.modelKey,'');assert.equal(afterRestart.hasKey,false);
  for(const k of ['from','to','smtpPass','relayKey'])assert.equal(afterRestart[k],config[k]);
  results.push({case:'browser restart clears personal session key, preserves mail and binding, no demo fallback',status:'passed'});
  const reopened=await context.newPage();await reopened.goto(`chrome-extension://${extensionId}/keydock/options.html`);
  await reopened.getByRole('button',{name:'录入 Key',exact:true}).click();await reopened.locator('#manual-key').fill('sk-refilled-fixture-12345');
  await reopened.getByRole('button',{name:'存入会话',exact:true}).click();
  await until(()=>page.evaluate(()=>!document.getElementById('modelStatus').textContent.includes('不可用')));
  await reopened.locator('#clear-keys').click();await reopened.locator('#confirm-ok').click();
  await until(()=>page.evaluate(()=>document.getElementById('modelStatus').textContent.includes('不可用')));
  assert.equal(await page.evaluate(async()=>(await chrome.storage.local.get('config')).config.modelSiteId),managedId);
  await page.locator('#save').click();
  const finalConfig=await page.evaluate(async()=>(await chrome.storage.local.get('config')).config);
  assert.equal(finalConfig.modelSiteId,managedId);assert.equal(finalConfig.modelKey,'');
  for(const k of ['from','to','smtpPass','relayKey'])assert.equal(finalConfig[k],config[k]);
  assert.equal(await reopened.locator('#use-builtin').count(),0);
  results.push({case:'clear session blocks model; no builtin fallback or shared-key control; mail settings preserved',status:'passed'});
  console.log(JSON.stringify(results,null,2));
  fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify(results,null,2));
 } catch(error) {
  if(page && !page.isClosed())console.error(JSON.stringify(await page.evaluate(()=>chrome.storage.local.get(['logs','taskState'])),null,2));
  throw error;
 } finally { await context.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
