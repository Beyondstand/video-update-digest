import { normalizeOrigin, normalizeConfig, permissionPattern, validateKey } from './core.mjs';
import { findProfile } from './profiles.mjs';

const icons = {
  key: '<circle cx="8" cy="8" r="4"/><path d="m11 11 9 9m-3-3 3-3m-6 0 3-3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  expand: '<path d="M14 3h7v7m-1-6-9 9M10 4H4v16h16v-6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="m16 3 5 5-12 12H4v-5L16 3Z"/><path d="m13 6 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  trash: '<path d="M4 7h16M9 7V3h6v4M6 7l1 14h10l1-14M10 11v6m4-6v6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>'
};
function icon(name) {
  const wrapper = document.createElement('span');
  wrapper.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
  return wrapper.firstChild;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label, className, iconName, action) {
  const node = el('button', className);
  node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
  if (iconName) node.append(icon(iconName));
  if (!className.includes('icon-button')) node.append(document.createTextNode(label));
  node.addEventListener('click', action);
  return node;
}

document.querySelector('#app').innerHTML = `
  <header><div class="brandmark" data-icon="key"></div><div class="brand">KeyDock<small>视频更新速递 · API 管理</small></div><div class="header-spacer"></div><button id="expand" class="icon-button" aria-label="打开完整管理页" title="打开完整管理页" data-icon="expand"></button><span class="version">v1.4</span></header>
  <div class="eyebrow">A LITTLE ORDER, EVERY DAY</div><h1>每一天，密钥就位。</h1><p class="intro">把各个平台的 API Key，收进一个安静的角落。</p>
  <div class="privacy-chip"><span data-icon="shield"></span>个人 Key 默认仅存会话 · 可选加密存本机 · 无云同步</div>
  <div class="stats"><div class="stat"><b id="total">0</b><span>管理平台</span></div><div class="stat"><b id="ready-count">0</b><span>本次会话有 Key</span></div><div class="stat"><b id="auto-count">0</b><span>已开启自动读取</span></div></div>
  <section class="model-connection" aria-labelledby="model-connection-title"><h2 id="model-connection-title">视频与浏览日报使用的 API</h2><p id="active-model" aria-live="polite">正在读取…</p><ol class="setup-help"><li>添加平台，填写模型 API 地址。</li><li>输入自己的 API Key，读取并选择模型 ID，也可手动填写。</li><li>保存后点击“用于总结”。费用由你的服务商结算。</li></ol></section>
  <div class="section-head"><h2>我的平台 <small id="list-count">00</small></h2><button id="add-site" class="button primary"><span data-icon="plus"></span>添加平台</button></div>
  <div id="sites" class="platform-list" aria-live="polite"></div>
  <div class="platform-note">支持读取接口的平台可开启每日同步；首次需在对应网站登录。</div>
  <div class="control-bar"><div><span>每日读取</span><input id="update-time" type="time" aria-label="每日读取 Key 时间" value="09:00"></div><button id="refresh-all" class="button secondary"><span data-icon="refresh"></span>检查全部接口</button></div>
  <div class="task-toggle"><label class="switch-label"><input id="auto-enabled" class="switch" type="checkbox" role="switch" checked>每日自动读取 Key</label><span class="task-hint" id="task-hint">浏览器关闭时，下次启动补查</span></div>
  <div class="control-bar"><div><span>加密保存</span><b id="vault-state">未启用</b></div><button id="vault-action" class="button secondary">启用加密保存</button></div>
  <div class="task-toggle"><span class="task-hint" id="vault-hint">开启后个人 Key 以保管密码加密（PBKDF2+AES-GCM）存入本机，重启浏览器后只需输入一次保管密码，免重输 Key。忘记密码将无法解密，只能清除后重新录入。</span><button id="vault-change" class="text-button" hidden>修改密码</button><button id="vault-disable" class="text-button" hidden>停用加密保存</button></div>
  <div class="bottom-row"><span class="local"><span data-icon="lock"></span>PERSONAL KEYS · SESSION / ENCRYPTED</span><button id="clear-keys" class="text-button">清空个人会话 Key</button></div>
  <details class="privacy"><summary>数据如何保管？</summary><p>KeyDock 中的个人 Key 默认只存放在浏览器会话内存；浏览器重启、扩展停用或重新加载后清除。启用「加密保存」后，Key 以保管密码派生的 AES-GCM 密钥加密（PBKDF2-SHA-256，30 万次迭代）存入本机，重启后输入保管密码解锁即可恢复，密文之外不含任何明文；忘记密码将无法解密，只能停用后重新录入。网址、账号备注、模型地址和任务设置保存在本机。KeyDock 不导入、展示或向模型发送邮箱、SMTP 授权码及中继密钥。邮件配置继续由视频插件独立保存。<br>自动读取只向配置的原网站发起 GET 请求，不创建或删除 Key。选择“用于总结”后，任务仅向设置的模型 API 发送该平台 Key。Key 不可用时会停止新的模型调用。不读取剪贴板；复制会将 Key 写入系统剪贴板。设备、浏览器或目标网站受损时仍可能暴露信息。</p></details>
  <p class="footer-caption">YOUR KEYS. YOUR BROWSER.</p>
  <dialog id="site-dialog" aria-labelledby="site-title"><div class="dialog-content"><div class="dialog-top"><h2 id="site-title">添加平台</h2><button class="icon-button close-dialog" aria-label="关闭" data-icon="close"></button></div>
    <form id="site-form"><label class="form-label" for="origin">网站网址</label><input id="origin" type="url" required placeholder="https://console.example.com" autocomplete="off" spellcheck="false">
    <label class="form-label" for="account">账号 / 账号备注</label><input id="account" required maxlength="160" placeholder="例如：我的 API（无需填写邮箱）" autocomplete="off" spellcheck="false">
    <label class="form-label" for="model-api">模型 API 地址</label><input id="model-api" type="url" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false">
    <label class="form-label" for="site-api-key">API Key</label><input id="site-api-key" type="password" autocomplete="new-password" placeholder="输入自己的 API Key；编辑时留空保留原 Key"><label class="form-label" for="model-name">模型 ID</label><input id="model-name" list="model-options" maxlength="200" placeholder="服务商提供的模型 ID" autocomplete="off" spellcheck="false"><datalist id="model-options"></datalist><button id="load-models" type="button" class="button secondary">读取可选模型</button><p class="form-hint">点击读取后从输入框列表选择，也可手动填写服务商提供的准确模型 ID。用于总结时必填。上方网站网址用于管理 Key；这里填写支持 chat/completions 的模型 base URL。</p>
    <label class="check-row"><input id="model-vision" type="checkbox"><span>此模型支持图片输入（用于无字幕视频的关键帧分析；不确定时保持关闭）</span></label>
    <label class="form-label" for="mode">管理方式</label><select id="mode"><option value="manual">本地管理 · 自己粘贴 Key</option><option value="json">自动读取 · 已确认的 JSON 接口</option></select>
    <div class="notice" id="site-notice">本地管理不需要网站访问权限。请在官网创建 Key 后粘贴到此扩展。</div>
    <div id="api-fields" hidden class="advanced"><label class="form-label" for="endpoint">读取接口路径（仅 GET）</label><input id="endpoint" placeholder="/api/key?account={account}" spellcheck="false" autocomplete="off"><p class="form-hint">必须与网站同源。{account} 会替换为账号。这里需要真实的管理接口，不能填写模型调用地址。</p>
    <label class="form-label" for="key-path">Key 的 JSON 字段</label><input id="key-path" value="data.api_key" spellcheck="false">
    <label class="form-label" for="identity-path">账号校验字段</label><input id="identity-path" value="data.account" spellcheck="false"><p class="form-hint">应与上方账号完全一致。留空表示账号仅作备注，无法核对当前登录用户。每个网站仅管理一个登录账号。</p>
    <label class="check-row"><input id="site-enabled" type="checkbox" checked><span>开启每日自动读取，可随时关闭</span></label></div>
    <p id="site-error" class="error-text" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary close-dialog">取消</button><button id="save-site" type="submit" class="button primary">保存平台</button></div></form></div></dialog>
  <dialog id="key-dialog" aria-labelledby="key-title"><div class="dialog-content"><div class="dialog-top"><h2 id="key-title">录入 API Key</h2><button class="icon-button close-dialog" aria-label="关闭" data-icon="close"></button></div><form id="key-form"><p class="form-hint" id="key-site"></p><label class="form-label" for="manual-key">完整 API Key</label><input id="manual-key" type="password" required maxlength="8192" placeholder="粘贴完整 Key，不要使用遮罩值" autocomplete="new-password" spellcheck="false"><p class="form-hint">仅保存在本次浏览器会话中，浏览器重启后清除。请另行妥善保管原始 Key。</p><p id="key-error" class="error-text" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary close-dialog">取消</button><button class="button primary" type="submit">存入会话</button></div></form></div></dialog>
  <dialog id="confirm-dialog" aria-labelledby="confirm-title"><div class="dialog-content"><h2 id="confirm-title">确认操作</h2><p class="form-hint" id="confirm-message"></p><div class="dialog-actions"><button id="confirm-cancel" class="button secondary">取消</button><button id="confirm-ok" class="button primary">确认</button></div></div></dialog>
  <dialog id="vault-dialog" aria-labelledby="vault-title"><div class="dialog-content"><div class="dialog-top"><h2 id="vault-title">启用加密保存</h2><button class="icon-button close-dialog" aria-label="关闭" data-icon="close"></button></div><form id="vault-form"><p class="form-hint" id="vault-dialog-hint"></p>
    <label class="form-label" for="vault-current" hidden>当前保管密码</label><input id="vault-current" type="password" autocomplete="current-password" placeholder="当前保管密码" hidden spellcheck="false">
    <label class="form-label" for="vault-pass">保管密码</label><input id="vault-pass" type="password" required maxlength="256" autocomplete="new-password" placeholder="至少 8 个字符" spellcheck="false">
    <label class="form-label" for="vault-pass2" hidden>再输入一次</label><input id="vault-pass2" type="password" maxlength="256" autocomplete="new-password" placeholder="再输入一次" hidden spellcheck="false">
    <p class="form-hint">保管密码仅用于本机加解密，不上传任何服务器；忘记密码将无法恢复已保存的 Key。</p>
    <p id="vault-error" class="error-text" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary close-dialog">取消</button><button id="vault-save" class="button primary" type="submit">确认</button></div></form></div></dialog>
  <div id="toast" role="status" hidden></div>`;
document.querySelectorAll('[data-icon]').forEach(node => node.append(icon(node.dataset.icon)));
const $ = selector => document.querySelector(selector);
let state = { sites: [], settings: { updateTime: '09:00', paused: false } };
let editId = null;
let keySiteId = null;
let toastTimer;
let renderSequence = 0;
let pollTimer;
const revealTimers = new Set();

async function send(type, fields = {}) {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('请在 Edge 中加载此扩展后使用。');
  const result = await chrome.runtime.sendMessage({ type: 'keydock:' + type, ...fields });
  if (!result?.ok) throw new Error(result?.error || '插件后台暂不可用，请重新打开插件。');
  return result.data;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3800);
}
async function action(task) {
  try { await task(); await load(); } catch (error) { toast(error.message); }
}
function formatTime(time) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
}
function confirmAction(title, message) {
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
  const dialog = $('#confirm-dialog'); dialog.showModal();
  return new Promise(resolve => {
    const done = value => { dialog.close(); resolve(value); };
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    dialog.oncancel = event => { event.preventDefault(); done(false); };
  });
}
function openKey(site) {
  keySiteId = site.id; $('#key-form').reset(); $('#key-error').hidden = true;
  $('#key-site').textContent = `${site.origin} · ${site.account}`;
  $('#key-dialog').showModal(); $('#manual-key').focus();
}
function showMode() {
  const auto = $('#mode').value === 'json'; $('#api-fields').hidden = !auto;
  $('#endpoint').required = auto;
  let profile;
  try { profile = findProfile(normalizeOrigin($('#origin').value)); } catch { /* The user is still typing. */ }
  if (!$('#model-api').value && !$('#model-name').value && profile?.modelApi) { $('#model-api').value = profile.modelApi; $('#model-name').value = profile.modelName; }
  const notice = auto ? '请先核实网站支持读取完整 Key。自动读取会使用当前浏览器的登录态，仅访问配置的同源 GET 接口；整合版复用视频插件已有的网站权限。' : profile?.note || '请在官网创建 Key 后粘贴到此扩展；不需要提供网站密码。';
  $('#site-notice').textContent = notice + (editId ? ' 修改网站、账号或读取配置会清除该记录的会话 Key，请保管原始值。' : '');
}
function openSite(site, origin = '') {
  editId = site?.id || null; $('#site-form').reset(); $('#site-error').hidden = true;
  $('#site-title').textContent = site ? '编辑平台' : '添加平台';
  $('#origin').value = site?.origin || origin; $('#account').value = site?.account || '';
  $('#model-api').value = site?.modelApi || ''; $('#model-name').value = site?.modelName || ''; $('#model-vision').checked = site?.vision === true; $('#model-options').replaceChildren();
  $('#mode').value = site?.mode || 'manual'; $('#endpoint').value = site?.endpoint || '';
  $('#key-path').value = site?.keyPath || 'data.api_key'; $('#identity-path').value = site?.identityPath ?? 'data.account';
  $('#site-enabled').checked = site?.enabled ?? true;
  showMode(); $('#site-dialog').showModal();
  (origin ? $('#account') : $('#origin')).focus();
}

function renderCard(site) {
  const profile = findProfile(site.origin);
  const card = el('article', 'site-card'); card.dataset.siteId = site.id;
  const selected = state.model?.selectedId === site.id;
  if (selected) card.classList.add('selected');
  const top = el('div', 'site-top');
  top.append(el('div', 'site-avatar', new URL(site.origin).hostname.slice(0, 1).toUpperCase()));
  const heading = el('div', 'site-heading');
  heading.append(el('div', 'site-name', profile?.name || new URL(site.origin).hostname), el('div', 'site-account', site.account));
  top.append(heading);
  const tools = el('div', 'site-tools');
  tools.append(button('编辑平台', 'icon-button', 'edit', () => openSite(site)), button('移除此平台', 'icon-button', 'trash', () => action(async () => {
    if (await confirmAction('移除此平台？', '仅移除插件中的记录和会话 Key，不会删除官网上的 Key。')) await send('DELETE_SITE', { id: site.id });
  })));
  top.append(tools); card.append(top);
  const modelInfo = el('div', 'model-meta');
  modelInfo.append(el('div', '', site.modelName || '未配置模型 ID'), el('div', '', site.modelApi || '仅管理 Key，尚未配置模型地址'));
  card.append(modelInfo);
  const keyRow = el('div', 'key-row'); const keyText = el('code', 'key-text', site.maskedKey); keyRow.append(keyText);
  const reveal = button('显示 15 秒', 'icon-button', 'eye', async () => {
    if (reveal.dataset.shown === 'true') { keyText.textContent = site.maskedKey; reveal.dataset.shown = 'false'; return; }
    try {
      const { key } = await send('GET_KEY', { id: site.id });
      keyText.textContent = key; reveal.dataset.shown = 'true';
      const timer = setTimeout(() => { keyText.textContent = site.maskedKey; reveal.dataset.shown = 'false'; revealTimers.delete(timer); }, 15000);
      revealTimers.add(timer);
    } catch (error) { toast(error.message); }
  }); reveal.disabled = !site.hasKey;
  const copy = button('复制 API Key', 'icon-button', 'copy', async () => {
    try { const { key } = await send('GET_KEY', { id: site.id }); await navigator.clipboard.writeText(key); toast('Key 已复制到系统剪贴板'); }
    catch (error) { toast(error.message); }
  }); copy.disabled = !site.hasKey;
  keyRow.append(reveal, copy); card.append(keyRow);
  let statusText = site.hasKey ? `会话已保存 · ${formatTime(site.lastSuccessAt)}` : site.lastSuccessAt ? '会话已清空，请重新读取或录入' : '等待首次读取或录入';
  if (site.status === 'updating') statusText = '正在读取，请稍候…';
  if (site.status === 'error') statusText = `${site.lastError}${site.hasKey ? '（当前显示上次的 Key）' : ''}`;
  const status = el('div', `site-status ${site.status === 'error' || site.status === 'updating' ? site.status : site.hasKey ? 'ok' : ''}`);
  status.append(el('span', 'dot'), el('span', '', statusText)); card.append(status);
  const bottom = el('div', 'site-bottom'); const left = el('div');
  left.append(button(site.mode === 'json' ? '立即读取' : '录入 Key', 'text-button', null, () => site.mode === 'json' ? action(async () => { await send('REFRESH', { id: site.id }); }) : openKey(site)));
  left.append(button('打开官网', 'text-button', null, () => chrome.tabs.create({ url: site.origin + (profile?.consolePath || '/') })));
  bottom.append(left);
  const auto = el('label', 'switch-label');
  const toggle = el('input', 'switch'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch');
  toggle.checked = site.mode === 'json' && site.enabled; toggle.disabled = site.mode !== 'json';
  toggle.setAttribute('aria-label', `${profile?.name || new URL(site.origin).hostname} 自动读取`);
  toggle.addEventListener('change', () => action(() => send('TOGGLE_SITE', { id: site.id, enabled: toggle.checked })));
  auto.append(toggle, document.createTextNode(site.mode === 'json' ? '自动读取' : '本地管理'));
  bottom.append(auto); card.append(bottom);
  const use = button(selected ? '当前用于总结' : '用于总结', 'button ' + (selected ? 'secondary' : 'primary') + ' use-model', null, () => action(async () => {
    await send('SELECT_MODEL', { id: site.id }); toast('已用于总结；邮件设置保持原样');
  }));
  use.disabled = selected || !site.hasKey || !site.modelApi || !site.modelName;
  card.append(use);
  if (site.mode === 'json' && !site.identityPath) card.append(el('p', 'form-hint', '账号仅作备注，未校验接口返回的用户身份。'));
  return card;
}

async function load() {
  const sequence = ++renderSequence;
  try {
    const data = await send('STATE');
    if (sequence !== renderSequence) return;
    state = data;
    const active = state.model.active;
    $('#active-model').textContent = active.available ? `${active.label} · ${active.modelName} · ${active.modelApi}` : `${active.label}：会话 Key 或模型信息不可用，请重新录入或选择。`;
    $('#active-model').className = active.available ? '' : 'model-warning';

    revealTimers.forEach(clearTimeout); revealTimers.clear();
    $('#total').textContent = state.sites.length;
    $('#ready-count').textContent = state.sites.filter(site => site.hasKey).length;
    $('#auto-count').textContent = state.settings.paused ? 0 : state.sites.filter(site => site.enabled && site.mode === 'json').length;
    $('#list-count').textContent = String(state.sites.length).padStart(2, '0');
    if (document.activeElement !== $('#update-time')) $('#update-time').value = state.settings.updateTime;
    $('#auto-enabled').checked = !state.settings.paused;
    $('#task-hint').textContent = state.settings.paused ? '已暂停 Key 读取 · 可手动读取' : '仅控制 Key 读取，不影响视频检查';
    $('#refresh-all').disabled = state.batchRunning || !state.sites.some(site => site.mode === 'json');
    const list = $('#sites'); list.replaceChildren();
    if (state.sites.length) state.sites.forEach(site => list.append(renderCard(site)));
    else {
      const empty = el('div', 'empty'); const graphic = el('div', 'empty-icon'); graphic.append(icon('key'));
      empty.append(graphic, el('strong', '', '从第一个平台开始'), el('p', '', '添加网站和账号，再选择本地管理或每日读取。'));
      empty.append(button('添加 API 平台', 'button secondary', 'plus', () => openSite(null))); list.append(empty);
    }
    clearTimeout(pollTimer);
    if (state.batchRunning || state.sites.some(site => site.status === 'updating')) pollTimer = setTimeout(load, 1200);
    renderVault();
  } catch (error) { toast(error.message); }
}

let vaultMode = 'setup';
function renderVault() {
  const vault = state.vault || { enabled: false, unlocked: false, entries: 0 };
  $('#vault-state').textContent = !vault.enabled ? '未启用' : vault.unlocked ? `已解锁 · ${vault.entries} 个 Key 已加密` : '已锁定 · 重启后已自动清除会话 Key';
  $('#vault-action').textContent = !vault.enabled ? '启用加密保存' : vault.unlocked ? '锁定' : '解锁';
  $('#vault-change').hidden = !vault.enabled;
  $('#vault-disable').hidden = !vault.enabled;
}
function openVault(mode) {
  vaultMode = mode; $('#vault-form').reset(); $('#vault-error').hidden = true;
  const titles = { setup: '启用加密保存', unlock: '解锁加密保存', change: '修改保管密码', disable: '停用加密保存' };
  const hints = {
    setup: '设置保管密码后，当前会话中的全部个人 Key 将加密保存到本机。',
    unlock: '输入保管密码，恢复本机保存的个人 Key 到本次会话。',
    change: '输入当前密码并设置新密码，全部 Key 将用新密码重新加密。',
    disable: '停用后本机加密副本将被删除；会话中的 Key 不受影响。请确认原始 Key 可随时重新录入。'
  };
  $('#vault-title').textContent = titles[mode]; $('#vault-dialog-hint').textContent = hints[mode];
  $('#vault-current').hidden = $('#vault-current').previousElementSibling.hidden = mode !== 'change';
  const need2 = mode === 'setup' || mode === 'change';
  $('#vault-pass2').hidden = $('#vault-pass2').previousElementSibling.hidden = !need2;
  $('#vault-pass').autocomplete = mode === 'unlock' ? 'current-password' : 'new-password';
  $('#vault-dialog').showModal(); $('#vault-pass').focus();
}

$('#expand').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#add-site').addEventListener('click', () => openSite(null));
$('#mode').addEventListener('change', showMode); $('#origin').addEventListener('input', showMode);
document.querySelectorAll('.close-dialog').forEach(node => node.addEventListener('click', () => node.closest('dialog').close()));
$('#key-dialog').addEventListener('close', () => { $('#manual-key').value = ''; keySiteId = null; });
$('#site-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#site-error').hidden = true; $('#save-site').disabled = true;
  try {
    const enteredKey = $('#site-api-key').value.trim(); if(enteredKey)validateKey(enteredKey);
    const config = normalizeConfig({
      origin: $('#origin').value, account: $('#account').value, mode: $('#mode').value,
      modelApi: $('#model-api').value, modelName: $('#model-name').value, vision: $('#model-vision').checked,
      endpoint: $('#endpoint').value, keyPath: $('#key-path').value, identityPath: $('#identity-path').value,
      enabled: $('#mode').value === 'json' && $('#site-enabled').checked
    });
    if (config.mode === 'json' && !(await chrome.permissions.contains({ origins: [permissionPattern(config.origin)] }))) throw new Error('请先在 Edge 扩展管理页允许访问此网站，再保存自动读取配置。');
    const { id } = await send('SAVE_SITE', { site: { ...config, id: editId } });
    if (enteredKey) await send('SET_KEY',{id,key:enteredKey});
    $('#site-dialog').close(); $('#site-api-key').value=''; await load(); toast('平台已保存，请点击用于总结');
    if (config.mode === 'manual' && !editId && !enteredKey) openKey(state.sites.find(site => site.id === id));
  } catch (error) { $('#site-error').textContent = error.message; $('#site-error').hidden = false; }
  finally { $('#save-site').disabled = false; }
});
$('#key-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#key-error').hidden = true;
  try { await send('SET_KEY', { id: keySiteId, key: $('#manual-key').value.trim() }); $('#key-dialog').close(); await load(); toast('已存入本次浏览器会话'); }
  catch (error) { $('#key-error').textContent = error.message; $('#key-error').hidden = false; }
});
$('#auto-enabled').addEventListener('change', () => action(() => send('SET_SETTINGS', { settings: { ...state.settings, paused: !$('#auto-enabled').checked } })));
$('#update-time').addEventListener('change', () => action(() => send('SET_SETTINGS', { settings: { ...state.settings, updateTime: $('#update-time').value } })));
$('#refresh-all').addEventListener('click', () => action(async () => { await send('REFRESH_ALL'); pollTimer = setTimeout(load, 400); }));
$('#clear-keys').addEventListener('click', () => action(async () => {
  if (await confirmAction('清空个人会话 Key？', '平台和任务设置保留。若已用于总结，需重新录入或读取才能继续。不会删除官网 Key。')) { await send('CLEAR_KEYS'); toast('个人会话 Key 已清空'); }
}));
$('#vault-action').addEventListener('click', () => {
  const vault = state.vault || { enabled: false, unlocked: false };
  if (!vault.enabled) openVault('setup');
  else if (vault.unlocked) action(async () => { await send('VAULT_LOCK'); toast('已锁定，会话中的明文 Key 已清除'); });
  else openVault('unlock');
});
$('#vault-change').addEventListener('click', () => openVault('change'));
$('#vault-disable').addEventListener('click', async () => {
  if (await confirmAction('停用加密保存？', '本机加密副本将被删除；会话中的 Key 不受影响。忘记密码时这是唯一恢复途径（重新录入）。')) openVault('disable');
});
$('#vault-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#vault-error').hidden = true; $('#vault-save').disabled = true;
  try {
    const pass = $('#vault-pass').value;
    if (vaultMode === 'setup' || vaultMode === 'change') {
      if (pass !== $('#vault-pass2').value) throw new Error('两次输入的保管密码不一致。');
      if (pass.length < 8) throw new Error('保管密码至少 8 个字符。');
    }
    const payload = vaultMode === 'change' ? { current: $('#vault-current').value, passphrase: pass } : { passphrase: pass };
    if (vaultMode === 'disable') {
      await send('VAULT_DISABLE', payload); toast('已停用加密保存');
    } else {
      await send(vaultMode === 'setup' ? 'VAULT_SETUP' : vaultMode === 'unlock' ? 'VAULT_UNLOCK' : 'VAULT_CHANGE_PASSWORD', payload);
      toast(vaultMode === 'setup' ? '已启用加密保存，当前 Key 已加密存本机' : vaultMode === 'unlock' ? '已解锁，本机 Key 已恢复到会话' : '保管密码已修改');
    }
    $('#vault-dialog').close(); await load();
  } catch (error) { $('#vault-error').textContent = error.message; $('#vault-error').hidden = false; }
  finally { $('#vault-save').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { document.querySelectorAll('.key-text').forEach((node, index) => { node.textContent = state.sites[index]?.maskedKey || ''; }); } });
if (globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener(() => { void load(); });
void load();

$('#site-dialog').addEventListener('close',()=>{$('#site-api-key').value='';});
$('#load-models').addEventListener('click',async()=>{
 const button=$('#load-models');button.disabled=true;
 try {const ids=await send('LIST_MODELS',{id:editId,modelApi:$('#model-api').value,key:$('#site-api-key').value.trim()});$('#model-options').replaceChildren(...ids.map(id=>{const option=document.createElement('option');option.value=id;return option;}));toast('已读取 '+ids.length+' 个模型，请在模型 ID 输入框中选择');$('#model-name').focus();}
 catch(error){toast(error.message);}finally{button.disabled=false;}
});
