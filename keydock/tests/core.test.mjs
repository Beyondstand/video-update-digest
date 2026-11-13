import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, normalizeOrigin, endpointUrl, getPath, extractKey, readKey, nextDaily, maskedKey, validateKey, validateSettings, modelTarget } from '../src/core.mjs';

const config = () => normalizeConfig({ origin: 'https://example.com/console', account: 'user+1', mode: 'json', endpoint: '/api/key?account={account}', keyPath: 'data.key', identityPath: 'data.account' });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('model endpoint is separate from key-management website and rejects credentials in URLs',()=>{
 const provider=normalizeConfig({origin:'https://console.provider.example',account:'local'});
 assert.equal(provider.modelApi,'');assert.equal(provider.modelName,'');assert.equal(provider.vision,false);
 assert.equal(modelTarget({modelApi:'http://127.0.0.1:8888/v1/',modelName:'local'}).modelApi,'http://127.0.0.1:8888/v1');
 for(const api of ['http://api.example','https://user:password@api.example/v1','https://api.example/v1?key=secret'])assert.throws(()=>modelTarget({modelApi:api,modelName:'test'}));
 assert.throws(()=>modelTarget({modelApi:'https://api.example/v1',modelName:''}));
});

test('URL normalization, credential rejection and same-origin endpoint enforcement', () => {
  assert.equal(normalizeOrigin('https://example.com/console'), 'https://example.com');
  assert.equal(normalizeOrigin('http://127.0.0.1:8765'), 'http://127.0.0.1:8765');
  for (const origin of ['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/?key=secret']) assert.throws(() => normalizeOrigin(origin));
  for (const endpoint of ['//evil.test/api', '/\\evil.test/api', 'https://evil.test/api', '/api#key', '/api\n']) assert.throws(() => endpointUrl({ ...config(), endpoint }));
  assert.equal(endpointUrl(config()), 'https://example.com/api/key?account=user%2B1');
});
test('explicit site mode and endpoint required for automatic reads', () => {
  assert.equal(normalizeConfig({ origin: 'https://console.provider.example/console/api-keys', account: 'local' }).mode, 'manual');
  assert.throws(() => normalizeConfig({ origin:'https://example.com',account:'local',mode:'json' }));
  assert.throws(() => validateSettings({ updateTime: '25:00' }));
});
test('JSON extraction validates identity, own properties, API failures and masked keys', () => {
  assert.equal(extractKey({ data: { key: 'sk-secret-for-test', account: 'user+1' } }, config()), 'sk-secret-for-test');
  assert.throws(() => extractKey({ data: { key: 'sk-secret', account: 'another-user' } }, config()), /账号不匹配/);
  assert.throws(() => extractKey({ success: false, data: { key: 'sk-secret', account: 'user+1' } }, config()));
  assert.throws(() => getPath({}, '__proto__.secret'));
  assert.equal(getPath({ data: [{ key: 'test' }] }, 'data.0.key'), 'test');
  for (const value of ['sk-12****34', 'sk-12...34', 'sk-12••34', 'sk-secret\n', 'a b c']) assert.throws(() => validateKey(value));
  assert.equal(maskedKey('short'), '••••••••');
});
test('daily schedule uses next local calendar day', () => {
  const before = new Date(2026,10,5,8,0).getTime();
  assert.equal(nextDaily(before,'09:00'),new Date(2026,10,5,9,0).getTime());
  const after = new Date(2026,10,5,9,0).getTime();
  assert.equal(nextDaily(after,'09:00'),new Date(2026,10,6,9,0).getTime());
});
test('fetch is read-only with credentials, no redirects, no cache and no raw response errors', async () => {
  let observed;
  const key = await readKey(config(), async (url, options) => {
    observed = { url, ...options };
    return json({ data: { key:'sk-test-key', account:'user+1' } });
  });
  assert.equal(key,'sk-test-key');
  assert.equal(observed.method,'GET');assert.equal(observed.credentials,'include');
  assert.equal(observed.redirect,'error');assert.equal(observed.cache,'no-store');
  assert.equal(observed.referrerPolicy,'no-referrer'); assert.equal(observed.body,undefined);
  await assert.rejects(readKey(config(), async () => new Response('SECRET RESPONSE', {status:401})), error => error.code === 'AUTH' && !error.message.includes('SECRET'));
  await assert.rejects(readKey(config(), async () => new Response('<html>login</html>', { headers:{'content-type':'text/html'} })), error => error.code === 'FORMAT');
  await assert.rejects(readKey(config(), async () => new Response('broken', { headers:{'content-type':'application/json'} })), error => error.code === 'FORMAT');
  await assert.rejects(readKey(config(), async () => new Response('{}',{ headers:{'content-type':'application/json','content-length':'2000000'} })), error => error.code === 'FORMAT');
  await assert.rejects(readKey(config(), async (_url, options) => new Promise((_,reject) => options.signal.addEventListener('abort',() => reject(new Error('aborted')))), 15), error => error.code === 'NETWORK');
});
