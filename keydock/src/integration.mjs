import '../../common.js';
import { AppError, modelTarget, normalizeConfig, validateKey } from './core.mjs';

const configLock = task => globalThis.navigator?.locks?.request ? navigator.locks.request('bwm-config', task) : task();
const defaults = () => globalThis.BWMUtils.DEFAULTS;
const readConfig = async () => (await chrome.storage.local.get('config')).config || {};

// Only model fields cross into the API manager. Mail credentials and video
// queues stay in their existing storage records and never enter public state.
export function createModelIntegration({ getDB, getSecrets, mutate, serial }) {
  async function migrateLegacy() {
    await mutate(db => configLock(async () => {
      const saved = await readConfig(), cfg = { ...defaults(), ...saved };
      const fingerprint = async key => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)))].map(x=>x.toString(16).padStart(2,'0')).join('');
      const retired = async key => Boolean(key) && await fingerprint(key) === 'daf0844962d7d6830e631c98934495e9a8b34a61988ef27ec2b566e989fefcc5';
      const previousSecrets = await getSecrets();
      for (const [id,value] of Object.entries(previousSecrets)) if (await retired(value.key)) delete previousSecrets[id];
      await chrome.storage.session.set({keys:previousSecrets});
      if (await retired(saved.modelKey)) { await chrome.storage.local.set({config:{...saved,modelKey:'',modelSiteId:''}}); return; }
      if (cfg.modelSiteId || !saved.modelKey || ['modelApi','modelName','modelKey'].every(k => cfg[k] === defaults()[k])) return;
      let target, key;
      try { target = modelTarget(cfg); key = validateKey(cfg.modelKey); } catch { return; }
      const secrets = await getSecrets();
      let site = db.sites.find(s => s.modelApi === target.modelApi && s.modelName === target.modelName && (!secrets[s.id]?.key || secrets[s.id].key === key));
      if (!site) {
        const apiOrigin = new URL(target.modelApi).origin;
        const preferredOrigin = apiOrigin;
        const origin = [preferredOrigin, apiOrigin].find(o => !db.sites.some(s => s.origin === o));
        if (!origin || db.sites.length >= 50) return;
        site = { ...normalizeConfig({ origin, account: '原视频总结配置', mode: 'manual', ...target }), id: crypto.randomUUID(), revision: crypto.randomUUID(), createdAt: Date.now(), lastAttemptAt: 0, nextRunAt: 0 };
        db.sites.push(site);
      }
      secrets[site.id] = { key };
      await chrome.storage.session.set({ keys: secrets });
      Object.assign(site, { status: 'ok', lastSuccessAt: Date.now(), lastError: '', errorCode: '' });
      await chrome.storage.local.set({ keydock: db, config: { ...saved, ...target, modelSiteId: site.id, modelKey: '' } });
    }));
  }

  async function modelState() {
    const cfg = { ...defaults(), ...await readConfig() }, db = await getDB(), secrets = await getSecrets();
    const options = db.sites.map(site => ({ id: site.id, label: `${new URL(site.origin).hostname} · ${site.account}`, modelApi: site.modelApi || '', modelName: site.modelName || '', available: Boolean(secrets[site.id]?.key && site.modelApi && site.modelName), sessionOnly: true }));
    let active;
    if (cfg.modelSiteId) {
      active = options.find(s => s.id === cfg.modelSiteId) || { id: cfg.modelSiteId, label: '所选 API 已移除，请重新选择', available: false, missing: true, sessionOnly: true };
    } else active = {id:'',label:'尚未配置 API，请添加平台并填写自己的 Key 和模型 ID',available:false,sessionOnly:true};
    return { selectedId: cfg.modelSiteId || '', active, options };
  }

  async function selectModel(id) {
    return serial(() => configLock(async () => {
      let fields;
      if (!id) throw new AppError('MODEL','请先在管理页添加平台、填写自己的 API Key 并选择模型 ID。');
      else {
        const site = (await getDB()).sites.find(s => s.id === id);
        if (!site) throw new AppError('MISSING', '此 API 记录已移除，请重新选择。');
        const target = modelTarget(site), secrets = await getSecrets();
        if (!secrets[id]?.key) throw new AppError('EMPTY', '请先为此平台录入或读取完整 Key。');
        fields = { ...target, modelSiteId: id, modelKey: '', modelVision: site.vision ? 'true' : 'false' };
      }
      const saved = await readConfig();
      await chrome.storage.local.set({ config: { ...saved, ...fields } });
      return { selectedId: fields.modelSiteId };
    }));
  }

  async function resolveModelConfig(id) {
    if (typeof id !== 'string' || !id) throw new AppError('MODEL', '未指定 API 记录。');
    const site = (await getDB()).sites.find(s => s.id === id);
    if (!site) throw new AppError('MISSING', '所选 API 已移除，请在 API 管理页重新选择。');
    const target = modelTarget(site), secrets = await getSecrets();
    if (!secrets[id]?.key) throw new AppError('EMPTY', '所选 API 的会话 Key 不可用，请在 API 管理页重新录入或读取。');
    return { ...target, modelSiteId: id, modelKey: validateKey(secrets[id].key), modelVision:site.vision?'true':'false' };
  }
  return { migrateLegacy, modelState, selectModel, resolveModelConfig };
}
