'use strict';
const $ = id => document.getElementById(id);
const MAIL_FIELDS = ['to','from','smtpPass','smtpHost','smtpPort','relayUrl','relayKey'];
let settingsLoaded = false;
async function send(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({ type: 'daylog:' + type, ...fields });
  if (!result || result.ok === false) throw new Error(result?.error || '日报后台暂不可用，请重新加载扩展后重试');
  return result;
}
function status(id, text, error = false) {
  $(id).textContent = text; $(id).style.color = error ? '#b43d38' : '#2d7650';
}
function fill(s = {}) {
  $('captureEnabled').checked = s.captureEnabled === true;
  $('autoEnabled').checked = s.autoEnabled === true;
  $('summaryTime').value = s.summaryTime || '23:50';
  $('emailEnabled').checked = s.emailEnabled === true;
  $('sendContent').checked = s.sendContent !== false;
  $('excerptLen').value = s.excerptLen || 800;
  $('maxPages').value = s.maxPages || 100;
  $('excludePatterns').value = Array.isArray(s.excludePatterns) ? s.excludePatterns.join('\n') : '';
}
function collect() {
  return {
    captureEnabled: $('captureEnabled').checked,
    autoEnabled: $('autoEnabled').checked,
    summaryTime: $('summaryTime').value || '23:50',
    emailEnabled: $('emailEnabled').checked,
    sendContent: $('sendContent').checked,
    excerptLen: Number($('excerptLen').value),
    maxPages: Number($('maxPages').value),
    excludePatterns: $('excludePatterns').value.split('\n').map(x => x.trim()).filter(Boolean)
  };
}
async function load() {
  const state = await send('STATE');
  fill(state.settings); settingsLoaded = true; $('save').disabled = false;
}
async function loadMail() {
  const result = await send('MAIL_SETTINGS');
  for (const key of MAIL_FIELDS) $('mail-' + key).value = result.mail?.[key] || (key === 'smtpPort' ? '465' : '');
  $('save-mail').disabled = false;
}
async function saveSettings() {
  if (!settingsLoaded) throw new Error('设置尚未读取，请刷新页面后重试');
  for (const id of ['summaryTime','excerptLen','maxPages']) if (!$(id).reportValidity()) return;
  await send('SAVE_SETTINGS', { settings: collect() });
  status('save-status', '日报设置已保存');
}
async function saveMail() {
  const mail = Object.fromEntries(MAIL_FIELDS.map(key => [key, $('mail-' + key).value.trim()]));
  await send('SAVE_MAIL_SETTINGS', { mail });
  status('mail-save-status', '邮件设置已保存（日报和视频共用）');
}
async function clearData() {
  if (!confirm('确定清空浏览日报数据？将删除已采集页面、日报及相关状态，不会修改 API 管理和邮箱设置。此操作无法撤销。')) return;
  await send('CLEAR_DATA'); await load();
  status('save-status', '浏览日报数据已清空，API 和邮箱设置未改动');
}
function action(id, statusId, task) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try { await task(); }
    catch (error) { status(statusId, error.message || '操作失败', true); }
    finally { $(id).disabled = false; }
  });
}
function open(path) { chrome.tabs.create({ url: chrome.runtime.getURL(path) }).catch(error => status('save-status', error.message, true)); }
document.addEventListener('DOMContentLoaded', () => {
  $('save').disabled = true; $('save-mail').disabled = true;
  $('open-api').addEventListener('click', () => open('keydock/options.html'));
  $('open-reports').addEventListener('click', () => open('daylog/popup.html'));
  action('save', 'save-status', saveSettings);
  action('save-mail', 'mail-save-status', saveMail);
  action('clear-data', 'save-status', clearData);
  load().catch(error => status('save-status', error.message, true));
  loadMail().catch(error => status('mail-save-status', error.message, true));
  if (location.hash === '#mail-settings') $('mail-settings').open = true;
});
