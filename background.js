"use strict";

// Long tasks run in runner.html, outside the MV3 worker's idle lifetime.
let launching = null;
const runnerUrl = chrome.runtime.getURL("runner.html");

async function ensureAlarm() {
  const {config={}} = await chrome.storage.local.get("config");
  const minutes = Math.min(168,Math.max(1,Number(config.intervalHours) || 6)) * 60;
  const current = await chrome.alarms.get("bwm-check");
  if (!current || current.periodInMinutes !== minutes) await chrome.alarms.create("bwm-check",{periodInMinutes:minutes});
}
async function launch() {
  if (launching) return launching;
  launching = (async () => {
    const tabs = await chrome.tabs.query({});
    if (tabs.some(t => t.url === runnerUrl || t.pendingUrl === runnerUrl)) return {ok:true,alreadyRunning:true};
    await chrome.windows.create({url:runnerUrl,type:"normal",focused:false,width:1100,height:850});
    return {ok:true};
  })();
  try { return await launching; } finally { launching = null; }
}
async function cleanupOwned(owner) {
  for (const id of owner.tabs || []) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab || tab.windowId !== owner.windowId) continue;
    let url;
    try { url = new URL(tab.url); } catch { continue; }
    if (tab.url.startsWith(chrome.runtime.getURL("")) || /(^|\.)(bilibili\.com|douyin\.com)$/.test(url.hostname) || tab.url === "about:blank") {
      await chrome.tabs.remove(id).catch(() => {});
    }
  }
}
chrome.tabs.onRemoved.addListener(id => {
  void (async () => {
    const {taskOwner} = await chrome.storage.session.get("taskOwner");
    if (taskOwner?.runnerTabId === id) {
      await cleanupOwned(taskOwner);
      const latest = (await chrome.storage.session.get("taskOwner")).taskOwner;
      if (latest?.runnerTabId === id) await chrome.storage.session.remove("taskOwner");
    }
  })().catch(console.error);
});
const initialize = () => {
  void chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"});
  void ensureAlarm();
};
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.alarms.onAlarm.addListener(a => { if (a.name === "bwm-check") void launch().catch(console.error); });
chrome.storage.onChanged.addListener((c,area) => { if (area === "local" && c.config) void ensureAlarm(); });
chrome.runtime.onMessage.addListener((msg,sender,respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === "run-now" && sender.url === chrome.runtime.getURL("popup.html")) {
    launch().then(respond,e => respond({ok:false,error:e.message}));
    return true;
  }
  if (msg?.type === "own-tab" && sender.url === runnerUrl && sender.tab) {
    (async () => {
      const tab = await chrome.tabs.get(msg.tabId);
      if (tab.windowId !== sender.tab.windowId) throw new Error("任务窗口不一致");
      const {taskOwner} = await chrome.storage.session.get("taskOwner");
      const owner = taskOwner?.runnerTabId === sender.tab.id ? taskOwner : {runnerTabId:sender.tab.id,windowId:sender.tab.windowId,tabs:[]};
      owner.tabs = [...new Set([...owner.tabs,tab.id])];
      await chrome.storage.session.set({taskOwner:owner});
      return {ok:true};
    })().then(respond,e => respond({ok:false,error:e.message}));
    return true;
  }
  if (msg?.type === "runner-finished" && sender.url === runnerUrl) respond({ok:true});
  return false;
});
