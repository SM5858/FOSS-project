const enabledToggle = document.getElementById("enabledToggle");
const langSelect = document.getElementById("langSelect");

// The language list comes from the shared window.HTDict (shared with the in-page popup and options)
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
