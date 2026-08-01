const enabledToggle = document.getElementById("enabledToggle");
const langSelect = document.getElementById("langSelect");

// 语言列表来自共享的 window.HTDict（与页内弹窗、options 共用同一份）
window.HTDict.fillLangSelect(langSelect, null);

chrome.storage.sync.get(["enabled", "targetLang"], (cfg) => {
  enabledToggle.checked = cfg.enabled !== false;
  if (cfg.targetLang) langSelect.value = cfg.targetLang;
});

enabledToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabledToggle.checked });
});

langSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ targetLang: langSelect.value });
});
