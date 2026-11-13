import { AppError, DEFAULT_SETTINGS, normalizeConfig, validateSettings, nextDaily, permissionPattern, readKey, maskedKey, validateKey, modelTarget, createVault, unlockVault, exportVaultKey, importVaultKey, sealValue } from './core.mjs';
import { createModelIntegration } from './integration.mjs';

const ALARM = 'keydock-daily';
const WATCHDOG = 'keydock-watchdog';
let mutationQueue = Promise.resolve();
let batchRunning = false;
const inFlight = new Map();

const getDB = async () => {
  const { keydock } = await chrome.storage.local.get('keydock');
  return keydock || { sites: [], settings: { ...DEFAULT_SETTINGS } };
};
const getSecrets = async () => (await chrome.storage.session.get('keys')).keys || {};
const getVault = async () => (await chrome.storage.local.get('keydockVault')).keydockVault || null;
const setVault = vault => chrome.storage.local.set({ keydockVault: vault });
const getVaultState = async () => (await chrome.storage.session.get('vaultState')).vaultState || null;
const setVaultState = state => state ? chrome.storage.session.set({ vaultState: state }) : chrome.storage.session.remove('vaultState');

/* 金库已解锁时，Key 写入同步加密进本机金库；未解锁则仅存会话（与旧行为一致）。 */
async function vaultPut(id, key) {
  const state = await getVaultState();
  const vault = await getVault();
  if (!state?.rawKey || !vault?.entries) return;
  const vk = await importVaultKey(state.rawKey);
  vault.entries[id] = await sealValue(vk, key);
  await setVault(vault);
}
async function vaultDrop(id) {
  const vault = await getVault();
  if (!vault?.entries || !(id in vault.entries)) return;
  delete vault.entries[id];
  await setVault(vault);
}
const serial = task => {
  const result = mutationQueue.then(task);
  mutationQueue = result.catch(() => {});
  return result;
};
const mutate = task => serial(async () => {
  const db = await getDB();
  const result = await task(db);
  await chrome.storage.local.set({ keydock: db });
  return result;
});
const modelIntegration = createModelIntegration({ getDB, getSecrets, mutate, serial });

async function updateBadge() {
  const db = await getDB();
  const secrets = await getSecrets();
  const errors = db.sites.filter(site => site.status === 'error').length;
  const count = db.sites.filter(site => secrets[site.id]?.key).length;
  await chrome.action.setBadgeText({ text: errors ? '!' : count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: errors ? '#b66d24' : '#167766' });
  await chrome.action.setTitle({ title: `视频更新速递 · API ${count} 个 Key${errors ? ` · ${errors} 个读取异常` : ''}` });
}

async function schedule() {
  const db = await getDB();
  const times = db.settings.paused ? [] : db.sites.filter(site => site.enabled && site.mode === 'json').map(site => site.nextRunAt || Date.now());
  if (times.length) await chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 1000, Math.min(...times)) });
  else await chrome.alarms.clear(ALARM);
}

async function vaultInfo() {
  const vault = await getVault();
  const state = await getVaultState();
  return { enabled: Boolean(vault), unlocked: Boolean(vault && state?.rawKey), entries: vault ? Object.keys(vault.entries).length : 0 };
}

async function publicState() {
  const db = await getDB();
  const secrets = await getSecrets();
  return {
    settings: db.settings, batchRunning, model: await modelIntegration.modelState(),
    vault: await vaultInfo(),
    sites: db.sites.map(site => ({ ...site, hasKey: Boolean(secrets[site.id]?.key), maskedKey: maskedKey(secrets[site.id]?.key) }))
  };
}

async function releaseUnusedPermission(origin) {
  if (!origin) return;
  if (chrome.runtime.getManifest?.().host_permissions?.includes('<all_urls>')) return;
  const pattern = permissionPattern(origin);
  const db = await getDB();
  if (!db.sites.some(site => site.mode === 'json' && permissionPattern(site.origin) === pattern)) {
    await chrome.permissions.remove({ origins: [pattern] });
  }
}

async function refreshSite(id, automatic = false) {
  if (inFlight.has(id)) return inFlight.get(id);
  const job = (async () => {
    let snapshot;
    await mutate(db => {
      const site = db.sites.find(item => item.id === id);
      if (!site) throw new AppError('MISSING', '此记录已删除。');
      if (site.mode !== 'json') throw new AppError('MANUAL', '此平台使用本地管理，请粘贴完整 Key。');
      if (automatic && (!site.enabled || db.settings.paused || site.nextRunAt > Date.now())) return;
      if (!automatic && site.lastAttemptAt && Date.now() - site.lastAttemptAt < 10000) throw new AppError('BUSY', '刚刚已检查，请等待 10 秒后重试。');
      snapshot = { ...site };
      site.status = 'updating'; site.lastError = ''; site.lastAttemptAt = Date.now();
      site.nextRunAt = nextDaily(Date.now(), db.settings.updateTime);
    });
    if (!snapshot) return;
    try {
      const granted = await chrome.permissions.contains({ origins: [permissionPattern(snapshot.origin)] });
      if (!granted) throw new AppError('PERMISSION', '网站访问授权已取消，请点击编辑后重新保存授权。');
      const key = await readKey(snapshot);
      await mutate(async db => {
        const site = db.sites.find(item => item.id === id);
        if (!site || site.revision !== snapshot.revision) return;
        const secrets = await getSecrets();
        secrets[id] = { key };
        await chrome.storage.session.set({ keys: secrets });
        await vaultPut(id, key);
        site.status = 'ok'; site.lastSuccessAt = Date.now(); site.lastError = ''; site.errorCode = '';
      });
    } catch (error) {
      await mutate(db => {
        const site = db.sites.find(item => item.id === id);
        if (!site || site.revision !== snapshot.revision) return;
        site.status = 'error'; site.lastError = error instanceof AppError ? error.message : '读取失败，请稍后重试。';
        site.errorCode = error instanceof AppError ? error.code : 'UNKNOWN';
      });
    } finally { await updateBadge(); await schedule(); }
  })();
  inFlight.set(id, job);
  try { return await job; } finally { inFlight.delete(id); }
}

async function runBatch(automatic = false) {
  if (batchRunning) return;
  batchRunning = true;
  try {
    const db = await getDB();
    if (automatic && db.settings.paused) return;
    const ids = db.sites.filter(site => site.mode === 'json' && (!automatic || (site.enabled && (!site.nextRunAt || site.nextRunAt <= Date.now())))).map(site => site.id);
    for (const id of ids) { try { await refreshSite(id, automatic); } catch { /* A deleted or edited record is skipped. */ } }
  } finally { batchRunning = false; await schedule(); await updateBadge(); }
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const secrets = await getSecrets();
  const { bootstrapped } = await chrome.storage.session.get('bootstrapped');
  await mutate(db => {
    for (const site of db.sites) {
      if (site.status === 'updating') { site.status = 'idle'; site.nextRunAt = Date.now(); }
      if (!bootstrapped && site.mode === 'json' && site.enabled && !secrets[site.id]?.key) site.nextRunAt = Date.now();
    }
  });
  await chrome.storage.session.set({ bootstrapped: true });
  await modelIntegration.migrateLegacy();
  if (!(await chrome.alarms.get(WATCHDOG))) await chrome.alarms.create(WATCHDOG, { periodInMinutes: 30 });
  await updateBadge(); await schedule();
}

async function handle(message) {
  await ready;
  switch (message?.type) {
    case 'STATE': return publicState();
    case 'MODEL_STATE': return modelIntegration.modelState();
    case 'SELECT_MODEL': return modelIntegration.selectModel(message.id || '');
    case 'MODEL_CONFIG': {
      try { return await modelIntegration.resolveModelConfig(message.id); }
      catch (error) {
        if (error instanceof AppError && error.code === 'EMPTY') {
          const v = await vaultInfo();
          if (v.enabled && !v.unlocked) throw new AppError('VAULT_LOCKED', '已启用加密保存但未解锁，请打开 API 管理页输入保管密码。');
        }
        throw error;
      }
    }
    case 'LIST_MODELS': {
      const target = modelTarget({modelApi:message.modelApi,modelName:'list'});
      const stored = message.id ? (await getSecrets())[message.id]?.key : '';
      const key = validateKey(message.key || stored || '');
      const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),15000);
      try {
        const response = await fetch(target.modelApi+'/models',{method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
        if (!response.ok) throw new AppError('MODELS',`无法读取模型列表（HTTP ${response.status}），请核对 Key，或手动填写模型 ID。`);
        const reader=response.body?.getReader(); if(!reader)throw Error('empty');
        const chunks=[];let size=0;
        try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1024*1024){await reader.cancel();throw Error('large');}chunks.push(part.value);}}finally{reader.releaseLock();}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        const json=JSON.parse(new TextDecoder().decode(bytes));
        const ids=[...new Set((Array.isArray(json.data)?json.data:[]).map(item=>item?.id).filter(id=>typeof id==='string'&&id.length>0&&id.length<=200&&!/[\s\u0000-\u001f\u007f]/.test(id)))].sort().slice(0,300);
        if(!ids.length)throw Error('no models');return ids;
      } catch(error) {if(error instanceof AppError)throw error;throw new AppError('MODELS','模型列表不可用，请手动填写服务商提供的模型 ID。');}
      finally {clearTimeout(timer);}
    }
    case 'SAVE_SITE': {
      const config = normalizeConfig(message.site);
      if (config.mode === 'json' && !(await chrome.permissions.contains({ origins: [permissionPattern(config.origin)] }))) throw new AppError('PERMISSION', '请先允许访问该网站。');
      let previousOrigin;
      const id = await mutate(async db => {
        const existing = message.site.id ? db.sites.find(site => site.id === message.site.id) : null;
        if (message.site.id && !existing) throw new AppError('MISSING', '此记录已删除。');
        previousOrigin = existing?.origin;
        if (db.sites.some(site => site.origin === config.origin && site.id !== existing?.id)) throw new AppError('DUPLICATE', '同一网站共用登录态，当前每站只支持一条记录，请编辑已有记录。');
        if (!existing && db.sites.length >= 50) throw new AppError('LIMIT', '最多管理 50 个网站。');
        const id = existing?.id || crypto.randomUUID();
        const sameSource = existing && ['origin', 'account', 'mode', 'endpoint', 'keyPath', 'identityPath'].every(field => existing[field] === config[field]);
        if (!sameSource) {
          const secrets = await getSecrets(); delete secrets[id];
          await chrome.storage.session.set({ keys: secrets });
        }
        const site = { ...config, id, revision: crypto.randomUUID(), createdAt: existing?.createdAt || Date.now(),
          status: sameSource && existing.status !== 'updating' ? existing.status : 'idle',
          lastError: sameSource ? existing.lastError : '', errorCode: sameSource ? existing.errorCode || '' : '',
          lastSuccessAt: sameSource ? existing.lastSuccessAt : 0, lastAttemptAt: sameSource ? existing.lastAttemptAt : 0,
          nextRunAt: sameSource && !(config.enabled && !existing.enabled) ? existing.nextRunAt : Date.now() };
        if (existing) Object.assign(existing, site);
        else db.sites.push(site);
        return id;
      });
      await releaseUnusedPermission(previousOrigin);
      await schedule(); await updateBadge();
      return { id };
    }
    case 'TOGGLE_SITE': {
      await mutate(db => {
        const site = db.sites.find(site => site.id === message.id);
        if (!site) throw new AppError('MISSING', '此记录已删除。');
        if (site.mode !== 'json') throw new AppError('MANUAL', '本地管理不支持自动读取。');
        site.enabled = Boolean(message.enabled); site.revision = crypto.randomUUID();
        if (site.status === 'updating') site.status = 'idle';
        if (site.enabled) site.nextRunAt = Date.now();
      });
      await schedule(); return {};
    }
    case 'DELETE_SITE': {
      let removedOrigin;
      await mutate(async db => {
        removedOrigin = db.sites.find(site => site.id === message.id)?.origin;
        db.sites = db.sites.filter(site => site.id !== message.id);
        const secrets = await getSecrets(); delete secrets[message.id];
        await chrome.storage.session.set({ keys: secrets });
        await vaultDrop(message.id);
      });
      await releaseUnusedPermission(removedOrigin);
      await schedule(); await updateBadge(); return {};
    }
    case 'SET_SETTINGS': {
      const settings = validateSettings(message.settings);
      await mutate(db => {
        const timeChanged = settings.updateTime !== db.settings.updateTime;
        if (settings.paused && !db.settings.paused) for (const site of db.sites) {
          site.revision = crypto.randomUUID();
          if (site.status === 'updating') site.status = 'idle';
        }
        db.settings = settings;
        if (timeChanged) for (const site of db.sites) if (site.nextRunAt > Date.now()) site.nextRunAt = nextDaily(Date.now(), settings.updateTime);
      });
      await schedule(); await updateBadge(); return {};
    }
    case 'SET_KEY': {
      const key = validateKey(message.key);
      await mutate(async db => {
        const site = db.sites.find(site => site.id === message.id);
        if (!site) throw new AppError('MISSING', '此记录已删除。');
        const secrets = await getSecrets(); secrets[site.id] = { key };
        await chrome.storage.session.set({ keys: secrets });
        await vaultPut(site.id, key);
        site.revision = crypto.randomUUID(); site.status = 'ok'; site.lastSuccessAt = Date.now(); site.lastError = ''; site.errorCode = '';
      });
      await updateBadge(); return {};
    }
    case 'GET_KEY': {
      const db = await getDB();
      if (!db.sites.some(site => site.id === message.id)) throw new AppError('MISSING', '此记录已删除。');
      const secrets = await getSecrets();
      if (!secrets[message.id]?.key) throw new AppError('EMPTY', '本次浏览器会话还没有 Key，请先读取或粘贴。');
      return { key: secrets[message.id].key };
    }
    case 'CLEAR_KEYS': {
      await mutate(async db => {
        for (const site of db.sites) { site.revision = crypto.randomUUID(); if (site.status === 'updating') site.status = 'idle'; }
        await chrome.storage.session.set({ keys: {} });
        await setVaultState(null);
      });
      await updateBadge(); return {};
    }
    case 'VAULT_SETUP': {
      const secrets = await getSecrets();
      const keys = Object.fromEntries(Object.entries(secrets).map(([id, value]) => [id, value.key]));
      const vault = await createVault(keys, message.passphrase);
      const { vaultKey } = await unlockVault(vault, message.passphrase);
      await setVault(vault);
      await setVaultState({ rawKey: await exportVaultKey(vaultKey) });
      await updateBadge(); return await vaultInfo();
    }
    case 'VAULT_UNLOCK': {
      const vault = await getVault();
      if (!vault) throw new AppError('VAULT', '尚未启用加密保存。');
      const { keys } = await unlockVault(vault, message.passphrase);
      // 会话里可能已有锁定期间自动读取到的新 Key：合并后整体重封进金库（会话值优先）
      const secrets = await getSecrets();
      const merged = { ...keys };
      for (const [id, value] of Object.entries(secrets)) if (value?.key) merged[id] = value.key;
      const fresh = await createVault(merged, message.passphrase);
      const { vaultKey } = await unlockVault(fresh, message.passphrase);
      await mutate(async () => {
        for (const [id, key] of Object.entries(merged)) secrets[id] = { key };
        await chrome.storage.session.set({ keys: secrets });
        await setVault(fresh);
        await setVaultState({ rawKey: await exportVaultKey(vaultKey) });
      });
      await updateBadge(); return await vaultInfo();
    }
    case 'VAULT_LOCK': {
      await setVaultState(null);
      await updateBadge(); return await vaultInfo();
    }
    case 'VAULT_CHANGE_PASSWORD': {
      const vault = await getVault();
      if (!vault) throw new AppError('VAULT', '尚未启用加密保存。');
      const { keys } = await unlockVault(vault, message.current);
      const next = await createVault(keys, message.passphrase);
      const { vaultKey } = await unlockVault(next, message.passphrase);
      await setVault(next);
      await setVaultState({ rawKey: await exportVaultKey(vaultKey) });
      return await vaultInfo();
    }
    case 'VAULT_DISABLE': {
      const vault = await getVault();
      if (vault) {
        // 销毁前要求验证口令，防止误操作清空本机加密副本
        await unlockVault(vault, message.passphrase);
      }
      await setVaultState(null);
      await chrome.storage.local.remove('keydockVault');
      await updateBadge(); return await vaultInfo();
    }
    case 'REFRESH': { await refreshSite(message.id); return {}; }
    case 'REFRESH_ALL': { void runBatch().catch(() => {}); return { started: true }; }
    default: throw new AppError('MESSAGE', '未知操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message?.type?.startsWith('keydock:')) return false;
  const type = message.type.slice('keydock:'.length), url = sender.url?.split('?')[0];
  const manager = url === chrome.runtime.getURL('keydock/options.html');
  const popup = url === chrome.runtime.getURL('popup.html') && ['MODEL_STATE','SELECT_MODEL'].includes(type);
  const runner = ['runner.html','daylog/runner.html'].some(page=>url === chrome.runtime.getURL(page)) && type === 'MODEL_CONFIG';
  if (!(manager && type !== 'MODEL_CONFIG') && !popup && !runner) return false;
  handle({ ...message, type }).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof AppError ? error.message : '操作失败，请重新打开插件后重试。' }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if ([ALARM, WATCHDOG].includes(alarm.name)) void ready.then(() => runBatch(true)).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { void ready.then(() => runBatch(true)).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void ready.then(schedule).catch(() => {}); });
const ready = initialize();
void ready.then(() => runBatch(true)).catch(() => {});
