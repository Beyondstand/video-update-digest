import test from 'node:test';
import assert from 'node:assert/strict';
const local = { config: { modelApi:'https://api.legacy.example/v1',modelName:'legacy-model',modelKey:'sk-legacy-test-secret-12345',from:'sender@example.test',to:'receiver@example.test',smtpPass:'smtp-test-private',relayKey:'relay-test-private',intervalHours:'12' }, taskState:{jobs:{keep:{status:'sent'}}} }, session = {}, alarms = new Map();
const clone = value => structuredClone(value);
const area = data => ({get:async key=>({[key]:clone(data[key])}),set:async values=>Object.assign(data,clone(values)),setAccessLevel:async()=>{}});
const event = () => ({addListener(){}});
let listener, responseKey='sk-auto-first-123456789', fetches=0;
globalThis.chrome={storage:{local:area(local),session:area(session)},runtime:{id:'integrated-test',getURL:path=>'chrome-extension://integrated-test/'+path,onMessage:{addListener:fn=>{listener=fn;}},onStartup:event(),onInstalled:event(),getManifest:()=>({host_permissions:['<all_urls>']})},alarms:{create:async(n,c)=>alarms.set(n,c),get:async n=>alarms.get(n),clear:async n=>alarms.delete(n),onAlarm:event()},permissions:{contains:async()=>true,remove:async()=>{throw Error('Must not release required video host access');}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}}};
globalThis.fetch=async()=>{fetches++;return new Response(JSON.stringify({data:{account:'test-label',api_key:responseKey}}),{headers:{'content-type':'application/json'}});};
const sender = page => ({id:'integrated-test',url:chrome.runtime.getURL(page)});
const send = (type,fields={},page='keydock/options.html') => new Promise((resolve,reject)=>{
 const accepted=listener({type:'keydock:'+type,...fields},sender(page),result=>result.ok?resolve(result.data):reject(Error(result.error)));
 if(!accepted)reject(Error('Rejected sender'));
});
const mailSnapshot = () => Object.fromEntries(['from','to','smtpPass','relayKey','intervalHours'].map(k=>[k,local.config[k]]));
const expectedMail = mailSnapshot();
let boot=0;
async function startWorker(){await import('../src/background.mjs?integration='+boot++);await send('MODEL_STATE');}

test('integrated model selection, credential isolation and lifecycle',async t=>{
 await startWorker(); let manualId,autoId;
 await t.test('legacy model credentials migrate to session without importing mail fields',async()=>{
  manualId=local.config.modelSiteId;assert.ok(manualId);assert.equal(local.config.modelKey,'');
  assert.equal(session.keys[manualId].key,'sk-legacy-test-secret-12345');
  const state=await send('STATE');
  for(const value of ['sender@example.test','receiver@example.test','smtp-test-private','relay-test-private','sk-legacy-test-secret-12345'])assert.ok(!JSON.stringify(state).includes(value));
  assert.ok(!JSON.stringify(local.keydock).includes('sk-legacy-test-secret'));
  assert.deepEqual(mailSnapshot(),expectedMail);assert.equal(local.taskState.jobs.keep.status,'sent');
 });
 await t.test('only the task page can resolve model credentials',async()=>{
  const model=await send('MODEL_CONFIG',{id:manualId},'runner.html');assert.equal(model.modelKey,'sk-legacy-test-secret-12345');
  await assert.rejects(send('MODEL_CONFIG',{id:manualId}),/Rejected sender/);
  await assert.rejects(send('GET_KEY',{id:manualId},'popup.html'),/Rejected sender/);
  await assert.rejects(send('GET_KEY',{id:manualId},'runner.html'),/Rejected sender/);
  let answered=false;assert.equal(listener({type:'keydock:GET_KEY',id:manualId},sender('content.html'),()=>{answered=true;}),false);assert.equal(answered,false);
  assert.equal(listener({type:'run-now'},sender('popup.html'),()=>{}),false);
 });
 await t.test('select and rotate managed keys without persisting them in model configuration',async()=>{
  await send('SELECT_MODEL',{id:manualId},'popup.html');await send('SET_KEY',{id:manualId,key:'sk-rotated-private-test-12345'});
  assert.equal((await send('MODEL_CONFIG',{id:manualId},'runner.html')).modelKey,'sk-rotated-private-test-12345');
  assert.equal(local.config.modelKey,'');assert.ok(!JSON.stringify(local).includes('sk-rotated-private-test'));
  assert.deepEqual(mailSnapshot(),expectedMail);
 });
 await t.test('user-selected image capability works independently of provider and keeps the session key',async()=>{
  const site=local.keydock.sites.find(s=>s.id===manualId);
  await send('SAVE_SITE',{site:{...site,vision:true}});await send('SELECT_MODEL',{id:manualId});
  const enabled=await send('MODEL_CONFIG',{id:manualId},'runner.html');
  assert.equal(enabled.modelVision,'true');assert.equal(enabled.modelKey,'sk-rotated-private-test-12345');
  await send('SAVE_SITE',{site:{...site,vision:false}});
  assert.equal((await send('MODEL_CONFIG',{id:manualId},'runner.html')).modelVision,'false');
  assert.deepEqual(mailSnapshot(),expectedMail);
 });
 await t.test('clearing secrets stops the selected model without falling back',async()=>{
  await send('CLEAR_KEYS');assert.equal(local.config.modelSiteId,manualId);
  await assert.rejects(send('MODEL_CONFIG',{id:manualId},'runner.html'),/会话 Key 不可用/);
  assert.equal((await send('MODEL_STATE',{},'popup.html')).active.available,false);
 });
 await t.test('browser-session loss does not restore an old persisted private key',async()=>{
  await send('SET_KEY',{id:manualId,key:'sk-session-before-restart-12345'});
  for(const k of Object.keys(session))delete session[k];await startWorker();
  await assert.rejects(send('MODEL_CONFIG',{id:manualId},'runner.html'),/会话 Key 不可用/);
  assert.equal(local.config.modelSiteId,manualId);assert.equal(local.config.modelKey,'');
 });
 await t.test('read-only platform refresh supplies the selected model with the latest key',async()=>{
  ({id:autoId}=await send('SAVE_SITE',{site:{origin:'https://console.auto.example',account:'test-label',mode:'json',endpoint:'/api/key',enabled:false,modelApi:'https://api.auto.example/v1',modelName:'auto-model'}}));
  await send('REFRESH',{id:autoId});assert.equal(fetches,1);await send('SELECT_MODEL',{id:autoId});
  assert.equal((await send('MODEL_CONFIG',{id:autoId},'runner.html')).modelKey,responseKey);
  responseKey='sk-auto-updated-123456789';local.keydock.sites.find(s=>s.id===autoId).lastAttemptAt=0;
  await send('REFRESH',{id:autoId});assert.equal((await send('MODEL_CONFIG',{id:autoId},'runner.html')).modelKey,responseKey);
  assert.ok(!JSON.stringify(local).includes(responseKey));assert.deepEqual(mailSnapshot(),expectedMail);
 });
 await t.test('model list uses own Key and returns only model IDs',async()=>{
  const original=globalThis.fetch;let headers;
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.auto.example/v1/models');headers=options.headers;assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return new Response(JSON.stringify({data:[{id:'model-b'},{id:'model-a'},{id:'model-a'}]}));};
  try{assert.deepEqual(await send('LIST_MODELS',{id:autoId,modelApi:'https://api.auto.example/v1'}),['model-a','model-b']);assert.equal(headers.Authorization,'Bearer '+responseKey);}finally{globalThis.fetch=original;}
 });
 await t.test('removing a selected API blocks resolution until an explicit new selection',async()=>{
  await send('DELETE_SITE',{id:autoId});assert.equal(local.config.modelSiteId,autoId);
  const model=await send('MODEL_STATE');assert.equal(model.active.missing,true);
  await assert.rejects(send('MODEL_CONFIG',{id:autoId},'runner.html'),/已移除/);
  await assert.rejects(send('SELECT_MODEL',{id:''},'popup.html'),/请先/);assert.equal(local.config.modelSiteId,autoId);assert.equal(local.config.modelKey,'');
  assert.deepEqual(mailSnapshot(),expectedMail);assert.equal(local.taskState.jobs.keep.status,'sent');
 });
});
