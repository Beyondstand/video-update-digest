const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../..'),output=path.resolve(process.env.TEST_OUTPUT||path.join(root,'test-results-daylog'));
fs.mkdirSync(output,{recursive:true});
const until=async(fn,timeout=60000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,200));}throw Error('Condition timed out');};
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(output,'profile'),{executablePath:process.env.EDGE_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,viewport:{width:1180,height:950},args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
 let modelCalls=0,mailCalls=0,modelPending=false,mailUnknown=false,lastMime='',receivedItems;
 const results=[];
 try{
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.protocol==='chrome-extension:')return route.continue();
   if(url.hostname==='model.daylog.test'){
    modelCalls++;modelPending=true;assert.equal(request.headers().authorization,'Bearer sk-history-fixture-only-123456');
    const body=JSON.parse(request.postData()),input=JSON.parse(body.messages[1].content);receivedItems=input.items;
    assert.equal(body.model,'chosen-history-model');assert.ok(!JSON.stringify(input).includes('fixture-secret'));assert.ok(!JSON.stringify(input).includes('smtp-fixture'));
    await new Promise(r=>setTimeout(r,1500));
    return route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({overview:'今天阅读了技术资料与项目记录。',entries:input.items.map(i=>({index:i.index,summary:i.text?'已提取的要点：'+i.text.slice(0,80):'未读取正文，仅有历史标题与网址。'}))})}}]})});
   }
   if(url.hostname==='relay.daylog.test'){
    mailCalls++;assert.equal(request.headers().authorization,'Bearer daylog-relay-fixture-long-key-123456');const payload=JSON.parse(request.postData());assert.equal(payload.from,'sender@example.test');lastMime=Buffer.from(payload.rawMimeBase64,'base64').toString('utf8');
    return route.fulfill({status:mailUnknown?502:200,contentType:'application/json',body:JSON.stringify(mailUnknown?{ok:false,deliveryUnknown:true}:{ok:true})});
   }
   if(['articles.daylog.test','private.daylog.test'].includes(url.hostname))return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><title>${url.pathname==='/alpha'?'技术资料 A':'项目记录 B'}</title><main><h1>页面 ${url.pathname}</h1><p>这是 ${url.pathname} 的真实可见正文，包含该页面的结论、例子和待办事项。</p></main>`});
   return route.abort();
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
  const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(()=>Boolean(document.getElementById('openDayLog')));
  const settings=await context.newPage();await settings.goto(`chrome-extension://${id}/daylog/options.html`);
  await until(()=>settings.locator('#save').isEnabled());assert.equal(await settings.locator('#captureEnabled').isChecked(),false);assert.equal(await settings.locator('#autoEnabled').isChecked(),false);assert.equal(await settings.locator('#emailEnabled').isChecked(),false);
  const article=await context.newPage();await article.bringToFront();await article.goto('https://articles.daylog.test/disabled');await new Promise(r=>setTimeout(r,600));
  assert.equal(await popup.evaluate(async()=>Object.keys(await chrome.storage.local.get(null)).filter(k=>/^daylog:day:/.test(k)).length),0);
  results.push({case:'history capture, scheduled generation and daily mail are disabled initially',status:'passed'});
  await settings.locator('#mail-settings').evaluate(e=>{e.open=true;});
  for(const [key,value] of Object.entries({to:'reader@example.test',from:'sender@example.test',smtpPass:'smtp-fixture',smtpHost:'smtp.example.test',relayUrl:'https://relay.daylog.test',relayKey:'daylog-relay-fixture-long-key-123456'}))await settings.locator('#mail-'+key).fill(value);
  await settings.locator('#save-mail').click();await settings.waitForFunction(()=>document.getElementById('mail-save-status').textContent.includes('已保存'));
  assert.equal(await popup.evaluate(async()=>(await chrome.storage.local.get('config')).config.uid||''),'');
  const manager=await context.newPage();await manager.goto(`chrome-extension://${id}/keydock/options.html`);await manager.locator('#add-site').click();
  for(const [key,value] of Object.entries({origin:'https://console.daylog.test',account:'日报演示 API','model-api':'https://model.daylog.test/v1','model-name':'chosen-history-model','site-api-key':'sk-history-fixture-only-123456'}))await manager.locator('#'+key).fill(value);
  await manager.locator('#save-site').click();await manager.getByRole('button',{name:'用于总结',exact:true}).click();
  await settings.locator('#captureEnabled').check();await settings.locator('#excludePatterns').fill('*://private.daylog.test/*');await settings.locator('#save').click();await settings.waitForFunction(()=>document.getElementById('save-status').textContent.includes('已保存'));
  results.push({case:'daily reports share selected KeyDock API and SMTP settings without a video UID',status:'passed'});
  await article.bringToFront();await article.goto('https://articles.daylog.test/alpha?api_key=fixture-secret&utm_source=test');
  const today=await popup.evaluate(()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');});
  await until(()=>popup.evaluate(async day=>Object.keys((await chrome.storage.local.get('daylog:day:'+day))['daylog:day:'+day]?.pages||{}).some(u=>u.endsWith('/alpha')),today));
  await article.goto('https://private.daylog.test/secret');await new Promise(r=>setTimeout(r,500));
  await article.goto('https://articles.daylog.test/beta');await until(()=>popup.evaluate(async day=>Object.keys((await chrome.storage.local.get('daylog:day:'+day))['daylog:day:'+day]?.pages||{}).some(u=>u.endsWith('/beta')),today));
  await article.evaluate(()=>{history.pushState({},'', '/spa');document.title='SPA 后续页面';document.querySelector('main').textContent='SPA 页面新的可见正文与结论';});
  await until(()=>popup.evaluate(async day=>Object.keys((await chrome.storage.local.get('daylog:day:'+day))['daylog:day:'+day]?.pages||{}).some(u=>u.endsWith('/spa')),today));
  await popup.evaluate(async()=>{await chrome.history.addUrl({url:'https://old.daylog.test/only-title'});await chrome.storage.local.set({taskState:{jobs:{videoSent:{status:'sent'}}}});});
  await new Promise(r=>setTimeout(r,3500));
  const captured=await popup.evaluate(async day=>(await chrome.storage.local.get('daylog:day:'+day))['daylog:day:'+day].pages,today);
  assert.ok(!JSON.stringify(captured).includes('private.daylog.test'));assert.ok(!JSON.stringify(captured).includes('fixture-secret'));
  results.push({case:'live visible page and SPA excerpts captured; exclusions and URL credential removal respected',status:'passed'});
  const report=await context.newPage();await report.goto(`chrome-extension://${id}/daylog/popup.html`);await report.locator('#gen-today').click();await until(()=>modelPending);
  const cdp=await context.newCDPSession(popup);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
  await until(()=>popup.evaluate(async day=>Boolean((await chrome.storage.local.get('daylog:log:'+day))['daylog:log:'+day]?.markdown),today));
  await until(()=>popup.evaluate(async()=>!(await chrome.tabs.query({})).some(t=>t.url?.includes('/daylog/runner.html'))));
  assert.equal(modelCalls,1);assert.equal(mailCalls,0);assert.ok(receivedItems.some(i=>i.text.includes('真实可见正文')));assert.ok(receivedItems.some(i=>i.url.includes('old.daylog.test')&&!i.text));assert.ok(!receivedItems.some(i=>i.url.includes('private.daylog.test')));
  await report.reload();await report.locator('[data-day="'+today+'"]').click();await report.waitForFunction(()=>document.getElementById('viewer-body').textContent.includes('逐条网页摘要'));
  results.push({case:'daily runner survives worker stop, summarizes each included page, marks missing body, and does not mail while unchecked',status:'passed'});
  await settings.locator('#emailEnabled').check();await settings.locator('#save').click();await until(()=>popup.locator('#dailyEmailQuick').isChecked());
  await report.locator('#send-mail').click();await until(()=>popup.evaluate(async day=>Object.values((await chrome.storage.local.get('daylog:mail:'+day))['daylog:mail:'+day]||{}).some(m=>m.status==='sent'),today));
  await until(()=>popup.evaluate(async()=>!(await chrome.tabs.query({})).some(t=>t.url?.includes('/daylog/runner.html'))));
  assert.equal(modelCalls,1);assert.equal(mailCalls,1);assert.match(lastMime,/Content-Disposition: attachment; filename="report-\d{4}-\d{2}-\d{2}\.md"/);
  fs.writeFileSync(path.join(output,'daily-report.eml'),lastMime);results.push({case:'checked daily-mail option sends cached report with Markdown attachment and no additional model call',status:'passed'});
  fs.writeFileSync(path.join(output,'daily-report.md'),await popup.evaluate(async day=>(await chrome.storage.local.get('daylog:log:'+day))['daylog:log:'+day].markdown,today));
  await report.reload();await report.locator('#gen-today').click();await until(()=>popup.evaluate(async()=>!(await chrome.tabs.query({})).some(t=>t.url?.includes('/daylog/runner.html'))));await new Promise(r=>setTimeout(r,700));assert.equal(modelCalls,1);assert.equal(mailCalls,1);
  results.push({case:'same report version is reused and not emailed twice',status:'passed'});
  await popup.evaluate(async day=>{const key='daylog:mail:'+day,ledger=(await chrome.storage.local.get(key))[key];for(const item of Object.values(ledger))item.status='sending';await chrome.storage.local.set({[key]:ledger});},today);
  await report.reload();await report.locator('[data-day="'+today+'"]').click();await report.waitForFunction(()=>document.getElementById('send-mail').textContent.includes('核对'));
  report.once('dialog',dialog=>{assert.match(dialog.message(),/重复邮件/);dialog.dismiss();});await report.locator('#send-mail').click();await new Promise(r=>setTimeout(r,500));assert.equal(mailCalls,1);
  report.once('dialog',dialog=>dialog.accept());await report.locator('#send-mail').click();await until(()=>mailCalls===2);await until(()=>popup.evaluate(async day=>Object.values((await chrome.storage.local.get('daylog:mail:'+day))['daylog:mail:'+day]).every(m=>m.status==='sent'),today));
  await until(()=>popup.evaluate(async()=>!(await chrome.tabs.query({})).some(t=>t.url?.includes('/daylog/runner.html'))));assert.equal(modelCalls,1);
  results.push({case:'interrupted delivery becomes unknown; dismissing confirmation does not resend; explicit retry uses cached report',status:'passed'});
  await settings.locator('#autoEnabled').check();await settings.locator('#save').click();await until(()=>popup.evaluate(async()=>Boolean(await chrome.alarms.get('daylog-daily'))));
  assert.ok(await popup.evaluate(async()=>Boolean(await chrome.alarms.get('bwm-check'))));results.push({case:'daily schedule coexists with video schedule',status:'passed'});
  await report.reload();await report.locator('[data-day="'+today+'"]').click();await report.screenshot({path:path.join(output,'daily-report.png'),fullPage:true});
  await settings.locator('#mail-settings').evaluate(e=>{e.open=false;});await settings.screenshot({path:path.join(output,'daily-settings.png'),fullPage:true});
  const saved=await popup.evaluate(async()=>{const x=await chrome.storage.local.get(['config','keydock','taskState']);return JSON.stringify(x);});
  settings.once('dialog',d=>d.accept());await settings.locator('#clear-data').click();await settings.waitForFunction(()=>document.getElementById('save-status').textContent.includes('已清空'));
  assert.equal(await popup.evaluate(async()=>JSON.stringify(await chrome.storage.local.get(['config','keydock','taskState']))),saved);
  assert.equal(await popup.evaluate(async()=>Object.keys(await chrome.storage.local.get(null)).filter(k=>/^daylog:(day|log|job|mail):/.test(k)).length),0);
  results.push({case:'clear daily data preserves selected API, mail credentials and video queue',status:'passed'});
  fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
