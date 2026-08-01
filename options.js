const apiKeyInput = document.getElementById("apiKey");
const targetLangSelect = document.getElementById("targetLang");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

function getSelectedPlan() {
  return document.querySelector('input[name="plan"]:checked').value;
}

function setSelectedPlan(plan) {
  const radio = document.querySelector(`input[name="plan"][value="${plan}"]`);
  if (radio) radio.checked = true;
}

// 语言列表来自共享的 window.HTDict（与 popup、页内弹窗共用同一份）
window.HTDict.fillLangSelect(targetLangSelect, null);

// 加载已保存的配置
chrome.storage.sync.get(["apiKey", "targetLang", "isPro"], (cfg) => {
  if (cfg.apiKey) apiKeyInput.value = cfg.apiKey;
  if (cfg.targetLang) targetLangSelect.value = cfg.targetLang;
  setSelectedPlan(cfg.isPro ? "pro" : "free");
});

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyInput.value.trim();
  const targetLang = targetLangSelect.value;
  const isPro = getSelectedPlan() === "pro";

  chrome.storage.sync.set({ apiKey, targetLang, isPro, apiProvider: "deepl" }, () => {
    statusEl.textContent = "Saved";
    setTimeout(() => (statusEl.textContent = ""), 1800);
  });
});
