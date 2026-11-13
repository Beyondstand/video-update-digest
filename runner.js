"use strict";
(async () => {
  const status = document.getElementById("status");
  const refresh = async () => {
    const {logs=[]} = await chrome.storage.local.get("logs");
    status.textContent = logs.slice(-15).map(l => `[${l.t}] ${l.m}`).join("\n");
  };
  chrome.storage.onChanged.addListener((changes,area) => { if (area === "local" && changes.logs) void refresh(); });
  try {
    const current = await chrome.tabs.getCurrent();
    globalThis.taskWindowId = current.windowId;
    await navigator.locks.request("bwm-pipeline",{ifAvailable:true},async lock => {
      if (!lock) { await log("已有任务在运行，本次检查跳过"); return; }
      await run();
    });
  } catch (e) { await log(`运行失败：${e.message || e}`); }
  finally {
    await refresh();
    await chrome.runtime.sendMessage({type:"runner-finished"}).catch(() => {});
    // Only this extension page is closed here. Owned video/render tabs are
    // cleaned up by their respective finally blocks, never user tabs.
    const current = await chrome.tabs.getCurrent();
    if (current) await chrome.tabs.remove(current.id).catch(() => {});
  }
})();
