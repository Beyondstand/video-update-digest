import test from 'node:test';
import assert from 'node:assert/strict';

const local = {}, session = {}, alarms = new Map();
let listener, onAlarm, fetchCount = 0, responseFactory;
const removedPermissions=[];
const clone = value => JSON.parse(JSON.stringify(value));
const event = callback => ({ addListener: callback });
function storageArea(data) {
  return { get: async key => ({ [key]: data[key] === undefined ? undefined : clone(data[key]) }), set: async values => Object.assign(data,clone(values)), setAccessLevel: async () => {} };
}
globalThis.chrome = {
  storage: { local: storageArea(local), session: storageArea(session) },
  runtime: { id:'keydock-test', getURL: path => `chrome-extension://keydock-test/${path}`, onMessage:event(fn => listener=fn), onStartup:event(() => {}), onInstalled:event(() => {}) },
  alarms: { create: async (name, config) => alarms.set(name, config), get: async name => alarms.get(name), clear: async name => alarms.delete(name), onAlarm:event(fn => onAlarm=fn) },
  permissions: { contains: async () => true, remove: async permissions => { removedPermissions.push(permissions);return true; } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor:async () => {}, setTitle:async () => {} }
};
globalThis.fetch = async (...args) => { fetchCount++; return responseFactory(...args); };
const response = (account='alice') => new Response(JSON.stringify({data:{api_key:'sk-private-test-key-12345',account}}),{headers:{'content-type':'application/json'}});
const sender={id:'keydock-test',url:'chrome-extension://keydock-test/keydock/options.html'};
const send = message => new Promise((resolve,reject) => { if (!listener({...message,type:"keydock:"+message.type},sender,result => result.ok ? resolve(result.data) : reject(new Error(result.error)))) reject(new Error('Rejected sender')); });
const waitFor = async predicate => { const deadline=Date.now()+4000; while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out');await new Promise(resolve=>setTimeout(resolve,5));} };
let imports=0;
async function boot(){await import(`../src/background.mjs?test=${imports++}`);await send({type:'STATE'});await waitFor(()=>!local.keydock.sites.some(site=>site.status==='updating'));}

test('background privacy, scheduling, controls, restarts and stale-request races', async t => {
  responseFactory=()=>response();await boot();
  let manualId, autoId;
  await t.test('local management stores keys only in session and public state is masked', async () => {
    ({id:manualId}=await send({type:'SAVE_SITE',site:{origin:'https://console.provider.example',account:'provider-label',mode:'manual',enabled:false}}));
    await send({type:'SET_KEY',id:manualId,key:'sk-only-in-session-987654'});
    assert(!JSON.stringify(local).includes('sk-only-in-session'));
    assert(JSON.stringify(session).includes('sk-only-in-session'));
    const state=await send({type:'STATE'});assert(!JSON.stringify(state).includes('sk-only-in-session'));
    assert.equal((await send({type:'GET_KEY',id:manualId})).key,'sk-only-in-session-987654');
    await send({type:'SAVE_SITE',site:{id:manualId,origin:'https://console.provider.example',account:'provider-label',mode:'manual',enabled:false}});
    assert.equal((await send({type:'GET_KEY',id:manualId})).key,'sk-only-in-session-987654','saving unchanged configuration must preserve the session key');
    await assert.rejects(send({type:'SAVE_SITE',site:{origin:'https://console.provider.example',account:'other',mode:'manual'}}),/同一网站/);
    let called=false;assert.equal(listener({type:'GET_KEY',id:manualId},{id:'other-extension',url:sender.url},()=>{called=true}),false);assert.equal(called,false);
  });
  await t.test('daily read saves latest key; GET failures preserve it', async () => {
    ({id:autoId}=await send({type:'SAVE_SITE',site:{origin:'https://example.com',account:'alice',mode:'json',endpoint:'/api/key',enabled:true}}));
    onAlarm({name:'keydock-daily'});
    await waitFor(()=>local.keydock.sites.find(site=>site.id===autoId).status==='ok');
    assert.equal(fetchCount,1);assert.equal((await send({type:'GET_KEY',id:autoId})).key,'sk-private-test-key-12345');
    responseFactory=()=>new Response('',{status:401});
    local.keydock.sites.find(site=>site.id===autoId).nextRunAt=0;
    onAlarm({name:'keydock-daily'});await waitFor(()=>local.keydock.sites.find(site=>site.id===autoId).status==='error');
    assert.equal((await send({type:'GET_KEY',id:autoId})).key,'sk-private-test-key-12345');
    assert.equal(local.keydock.sites.find(site=>site.id===autoId).errorCode,'AUTH');
  });
  await t.test('global pause and per-site disable block automatic fetches', async () => {
    await send({type:'SET_SETTINGS',settings:{updateTime:'08:30',paused:true}});
    const before=fetchCount;local.keydock.sites.find(site=>site.id===autoId).nextRunAt=0;
    onAlarm({name:'keydock-daily'});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(fetchCount,before);
    await send({type:'TOGGLE_SITE',id:autoId,enabled:false});
    await send({type:'SET_SETTINGS',settings:{updateTime:'08:30',paused:false}});
    onAlarm({name:'keydock-watchdog'});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(fetchCount,before);
  });
  await t.test('browser restart clears manual secrets and catches up enabled sites', async () => {
    responseFactory=()=>response();await send({type:'TOGGLE_SITE',id:autoId,enabled:true});
    local.keydock.sites.find(site=>site.id===autoId).nextRunAt=Date.now()+86400000;
    for(const key of Object.keys(session))delete session[key];
    const before=fetchCount;await boot();await waitFor(()=>fetchCount===before+1 && session.keys?.[autoId]);
    assert.equal(session.keys[manualId],undefined);assert(!JSON.stringify(local).includes('sk-private-test'));
    await send({type:'CLEAR_KEYS'});const next=fetchCount;await boot();
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(fetchCount,next,'worker wake must not refill cleared keys immediately');
  });
  await t.test('clear and delete invalidate in-flight responses', async () => {
    let finish; responseFactory=()=>new Promise(resolve=>finish=resolve);
    local.keydock.sites.find(site=>site.id===autoId).lastAttemptAt=0;
    const refresh=send({type:'REFRESH',id:autoId});await waitFor(()=>Boolean(finish));
    await send({type:'CLEAR_KEYS'});finish(response());await refresh;
    assert.equal(session.keys[autoId],undefined);
    finish=null;local.keydock.sites.find(site=>site.id===autoId).lastAttemptAt=0;
    const refresh2=send({type:'REFRESH',id:autoId});await waitFor(()=>Boolean(finish));
    await send({type:'DELETE_SITE',id:autoId});finish(response());await refresh2;
    assert.equal(session.keys[autoId],undefined);assert(!local.keydock.sites.some(site=>site.id===autoId));
    assert(removedPermissions.some(permission=>permission.origins.includes('https://example.com/*')),'deleting a platform must release its optional host permission');
  });
});
