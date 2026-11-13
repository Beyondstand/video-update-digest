import { findProfile } from './profiles.mjs';

export const DEFAULT_SETTINGS = Object.freeze({ updateTime: '09:00', paused: false });
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function normalizeOrigin(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new AppError('CONFIG', '请输入完整网址，例如 https://example.com'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError('CONFIG', '网站网址不能包含账号密码、查询参数或锚点。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new AppError('CONFIG', '网站必须使用 HTTPS；HTTP 仅允许本机测试。');
  }
  return url.origin;
}

export function permissionPattern(origin) {
  const url = new URL(normalizeOrigin(origin));
  return `${url.protocol}//${url.hostname}/*`;
}

export function modelTarget(input, optional = false) {
  const api = String(input.modelApi ?? '').trim();
  const modelName = String(input.modelName ?? '').trim();
  if (optional && !api && !modelName) return { modelApi: '', modelName: '' };
  let url;
  try { url = new URL(api); } catch { throw new AppError('MODEL', '请填写有效的模型 API 地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new AppError('MODEL', '模型地址必须使用 HTTPS（本机可用 HTTP），不能包含密钥、账号或查询参数。');
  }
  if (!modelName || modelName.length > 200 || /[\r\n\u0000-\u001f\u007f]/.test(modelName)) throw new AppError('MODEL', '请填写有效的模型 ID。');
  return { modelApi: url.href.replace(/\/+$/, ''), modelName };
}

export function validatePath(path, optional = false) {
  const value = String(path ?? '').trim();
  if (!value && optional) return '';
  const parts = value.split('.');
  if (!value || value.length > 240 || parts.some(part => !/^[a-zA-Z0-9_-]+$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new AppError('CONFIG', 'JSON 字段请使用点分隔，例如 data.api_key 或 data.keys.0.key。');
  }
  return value;
}

export function getPath(data, path) {
  validatePath(path);
  return path.split('.').reduce((value, part) => value !== null && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined, data);
}

export function endpointUrl(config) {
  if (/[\u0000-\u001f\u007f]/.test(String(config.endpoint ?? ''))) throw new AppError('CONFIG', '读取接口不能包含控制字符。');
  const path = String(config.endpoint ?? '').trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n]/.test(path) || path.length > 2000) {
    throw new AppError('CONFIG', '读取接口必须是本站路径，例如 /api/key?account={account}。');
  }
  const url = new URL(path.replaceAll('{account}', encodeURIComponent(config.account)), config.origin);
  if (url.origin !== config.origin || url.hash || url.username || url.password) {
    throw new AppError('CONFIG', '读取接口必须和网站同源，且不能包含锚点或登录信息。');
  }
  return url.href;
}

export function normalizeConfig(input) {
  const origin = normalizeOrigin(input.origin);
  const account = String(input.account ?? '').trim();
  if (!account || account.length > 160 || /[\r\n]/.test(account)) throw new AppError('CONFIG', '请填写账号，长度不超过 160 个字符。');
  const profile = findProfile(origin);
  const mode = input.mode ?? profile?.mode ?? 'manual';
  if (!['manual', 'json'].includes(mode)) throw new AppError('CONFIG', '请选择有效的管理方式。');
  const rawEndpoint = String(input.endpoint ?? profile?.endpoint ?? '');
  if (/[\u0000-\u001f\u007f]/.test(rawEndpoint)) throw new AppError('CONFIG', '读取接口不能包含控制字符。');
  const endpoint = rawEndpoint.trim();
  const config = {
    origin, account, endpoint, mode, vision: input.vision === true,
    ...modelTarget({ modelApi: input.modelApi ?? profile?.modelApi ?? '', modelName: input.modelName ?? profile?.modelName ?? '' }, true),
    keyPath: validatePath(input.keyPath ?? profile?.keyPath ?? 'data.api_key'),
    identityPath: validatePath(input.identityPath ?? profile?.identityPath ?? 'data.account', true),
    enabled: mode === 'json' && input.enabled !== false,
    profileId: profile?.id || 'custom'
  };
  if (mode === 'json' && !endpoint) throw new AppError('CONFIG', '自动读取需要配置已确认的读取接口。');
  if (endpoint) endpointUrl(config);
  return config;
}

export function validateSettings(input) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.updateTime)) throw new AppError('CONFIG', '请选择有效的每日更新时间。');
  return { updateTime: input.updateTime, paused: Boolean(input.paused) };
}

export function nextDaily(now, time = '09:00') {
  const [hour, minute] = time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function maskedKey(key) {
  if (!key) return '等待首次读取';
  if (key.length < 12) return '••••••••';
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

export function extractKey(json, config) {
  if (json?.success === false || json?.ok === false) throw new AppError('API', '网站接口返回失败，请检查登录状态和接口配置。');
  if (config.identityPath) {
    const identity = getPath(json, config.identityPath);
    if (!['string', 'number'].includes(typeof identity) || String(identity).trim() !== config.account) {
      throw new AppError('ACCOUNT', '接口返回的账号不匹配；请登录对应账号或检查账号校验字段。');
    }
  }
  const key = getPath(json, config.keyPath);
  return validateKey(key);
}

export function validateKey(key) {
  if (typeof key !== 'string' || key.length < 4 || key.length > 8192 || key.includes('...')) {
    throw new AppError('KEY', '请提供完整的 API Key；空白、遮罩和截断的 Key 无法使用。');
  }
  for (const ch of key) {
    const code = ch.codePointAt(0);
    if (/\s/.test(ch) || code < 0x20 || code === 0x7f || '*•…'.includes(ch)) {
      throw new AppError('KEY', '请提供完整的 API Key；空白、遮罩和截断的 Key 无法使用。');
    }
  }
  return key;
}

/* ================= 保管密码金库：PBKDF2-SHA-256 + AES-GCM 加密存本机 ================= */

export const VAULT_KDF_ITERATIONS = 300000;
const VAULT_CHECK = 'keydock-vault-v1';
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export function vaultPassphrase(value) {
  const pass = String(value ?? '');
  if (pass.length < 8 || pass.length > 256 || /[\r\n]/.test(pass)) throw new AppError('VAULT', '保管密码至少 8 个字符，且不含换行。');
  return pass;
}

export async function deriveVaultKey(passphrase, saltB64, iterations = VAULT_KDF_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations },
    material, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportVaultKey(key) {
  return b64(await crypto.subtle.exportKey('raw', key));
}

export async function importVaultKey(rawB64) {
  try {
    return await crypto.subtle.importKey('raw', unb64(rawB64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  } catch { throw new AppError('VAULT', '解锁状态无效，请重新输入保管密码。'); }
}

export async function sealValue(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(text)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function openValue(key, entry) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(entry.iv) }, key, unb64(entry.ct));
    return new TextDecoder().decode(pt);
  } catch { throw new AppError('VAULT', '保管密码不正确或数据已损坏。'); }
}

/* keysById: { [siteId]: keyString }。返回可存 chrome.storage.local 的纯 JSON 金库。 */
export async function createVault(keysById, passphrase) {
  const pass = vaultPassphrase(passphrase);
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveVaultKey(pass, salt);
  const entries = {};
  for (const [id, value] of Object.entries(keysById || {})) entries[id] = await sealValue(key, value);
  return { version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS, salt },
    verifier: await sealValue(key, VAULT_CHECK), entries };
}

function shapeCheck(vault) {
  if (!vault || typeof vault !== 'object' || vault.version !== 1 || !vault.kdf?.salt || !vault.verifier?.iv || typeof vault.entries !== 'object') {
    throw new AppError('VAULT', '加密保存数据无效，请停用后重新启用。');
  }
  return vault;
}

/* 解密全部条目；密码错误时抛错。返回 { keys: {siteId:key}, vaultKey: CryptoKey }。 */
export async function unlockVault(vault, passphrase) {
  shapeCheck(vault);
  const key = await deriveVaultKey(String(passphrase ?? ''), vault.kdf.salt, vault.kdf.iterations);
  if (await openValue(key, vault.verifier) !== VAULT_CHECK) throw new AppError('VAULT', '保管密码不正确。');
  const keys = {};
  for (const [id, entry] of Object.entries(vault.entries)) keys[id] = await openValue(key, entry);
  return { keys, vaultKey: key };
}

/* 已解锁（持有 vaultKey）时直接解密，无需口令。 */
export async function openEntries(vault, vaultKey) {
  shapeCheck(vault);
  const keys = {};
  for (const [id, entry] of Object.entries(vault.entries)) keys[id] = await openValue(vaultKey, entry);
  return keys;
}

export async function readKey(config, fetcher = fetch, timeoutMs = 15000) {
  if (!config.endpoint) throw new AppError('NEEDS_CONFIG', '此网站尚未适配，请在编辑中填写读取接口。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(endpointUrl(config), {
      method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal
    });
    if ([401, 403].includes(response.status)) throw new AppError('AUTH', '登录已失效或权限不足，请先打开网站重新登录。');
    if (response.status === 429) throw new AppError('RATE_LIMIT', '网站请求过于频繁，请稍后手动重试。');
    if (!response.ok) throw new AppError('HTTP', `读取失败（HTTP ${response.status}），已保留上次的 Key。`);
    const contentType = response.headers.get('content-type') || '';
    if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
      throw new AppError('FORMAT', '网站未返回 JSON，可能需要重新登录或专用适配。');
    }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new AppError('FORMAT', '接口响应过大，请检查读取接口。');
    const reader = response.body?.getReader();
    if (!reader) throw new AppError('FORMAT', '接口没有返回数据。');
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new AppError('FORMAT', '接口响应过大，请检查读取接口。'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let json;
    try { json = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new AppError('FORMAT', '接口返回的 JSON 无法解析。'); }
    return extractKey(json, config);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('NETWORK', controller.signal.aborted ? '请求超时，已保留上次的 Key。' : '网络请求失败；请检查网络、网站登录或是否发生重定向。');
  } finally { clearTimeout(timer); }
}
