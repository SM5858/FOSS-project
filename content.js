// content.js
// 注入到每个页面（含Chrome内置PDF阅读器）
// 职责：监听文本选中 -> 计算悬浮窗位置 -> 请求翻译 -> 渲染悬浮窗

(() => {
  let popupEl = null;
  let lastSelectedText = "";
  let hideTimer = null;

  // ---------- 悬浮窗 DOM ----------
  function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement("div");
    popupEl.id = "ht-translate-popup";
    popupEl.className = "ht-translate-popup ht-hidden";
    popupEl.innerHTML = `
      <div class="ht-popup-header">
        <span class="ht-popup-lang"></span>
        <button class="ht-popup-close" title="关闭">×</button>
      </div>
      <div class="ht-popup-body">
        <div class="ht-popup-original"></div>
        <div class="ht-popup-divider"></div>
        <div class="ht-popup-result">翻译中…</div>
      </div>
    `;
    document.documentElement.appendChild(popupEl);

    popupEl.querySelector(".ht-popup-close").addEventListener("click", hidePopup);
    // 鼠标进入悬浮窗时不要被外部点击逻辑关闭
    popupEl.addEventListener("mousedown", (e) => e.stopPropagation());
    return popupEl;
  }

  function showPopupAt(x, y) {
    const el = ensurePopup();
    el.classList.remove("ht-hidden");
    // 简单边界保护，避免超出视口
    const margin = 12;
    const maxX = window.innerWidth - 340;
    const maxY = window.innerHeight - 160;
    el.style.left = Math.min(Math.max(x, margin), Math.max(maxX, margin)) + "px";
    el.style.top = Math.min(Math.max(y, margin), Math.max(maxY, margin)) + "px";
  }

  function hidePopup() {
    if (popupEl) popupEl.classList.add("ht-hidden");
  }

  function setPopupContent({ original, result, targetLangLabel, isError }) {
    const el = ensurePopup();
    el.querySelector(".ht-popup-lang").textContent = targetLangLabel || "";
    el.querySelector(".ht-popup-original").textContent = original || "";
    const resultEl = el.querySelector(".ht-popup-result");
    resultEl.textContent = result;
    resultEl.classList.toggle("ht-popup-error", !!isError);
  }

  // ---------- 划词监听（普通文本 / 常规PDF文字层） ----------
  document.addEventListener("mouseup", (e) => {
    // 给浏览器一点时间完成选区更新
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => handleSelection(e), 30);
  });

  // 点击页面空白处关闭悬浮窗
  document.addEventListener("mousedown", (e) => {
    if (popupEl && !popupEl.contains(e.target)) {
      hidePopup();
    }
  });

  function handleSelection(e) {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";

    if (!text || text.length < 1) {
      return; // 没有选中内容，不打扰用户，保留上次结果直到用户点别处
    }
    if (text === lastSelectedText) return;
    lastSelectedText = text;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const x = rect.left + window.scrollX;
    const y = rect.bottom + window.scrollY + 8;

    showPopupAt(rect.left, rect.bottom + 8);
    requestTranslation(text);
  }

  // ---------- 请求翻译（转发给 background service worker） ----------
  function requestTranslation(text) {
    chrome.storage.sync.get(["targetLang", "enabled"], (cfg) => {
      if (cfg.enabled === false) return; // 用户在popup里关闭了插件
      const targetLang = cfg.targetLang || "ZH";

      setPopupContent({
        original: text,
        result: "翻译中…",
        targetLangLabel: `→ ${targetLang}`,
      });

      chrome.runtime.sendMessage(
        { type: "TRANSLATE_TEXT", text, targetLang },
        (response) => {
          if (chrome.runtime.lastError) {
            setPopupContent({
              original: text,
              result: "翻译请求失败，请检查网络或API Key设置",
              targetLangLabel: `→ ${targetLang}`,
              isError: true,
            });
            return;
          }
          if (response && response.ok) {
            setPopupContent({
              original: text,
              result: response.translatedText,
              targetLangLabel: `→ ${targetLang}`,
            });
          } else {
            setPopupContent({
              original: text,
              result: (response && response.error) || "翻译失败",
              targetLangLabel: `→ ${targetLang}`,
              isError: true,
            });
          }
        }
      );
    });
  }

  // ---------- 扫描版PDF：区域框选（占位实现） ----------
  // 说明：常规文本走上面的 selectionchange 逻辑即可。
  // 扫描版PDF没有文字层，需要用户按住 Alt 拖框选一块区域，
  // 对该区域截图后交给OCR识别，再走同样的 requestTranslation 流程。
  // 这里先留出交互骨架，OCR部分（Tesseract.js）作为下一步接入。
  let isDragging = false;
  let dragStart = null;
  let selectionBoxEl = null;

  document.addEventListener("mousedown", (e) => {
    if (!e.altKey) return; // 按住 Alt 触发框选模式，避免与普通划词冲突
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    selectionBoxEl = document.createElement("div");
    selectionBoxEl.id = "ht-selection-box";
    document.documentElement.appendChild(selectionBoxEl);
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging || !selectionBoxEl) return;
    const x = Math.min(dragStart.x, e.clientX);
    const y = Math.min(dragStart.y, e.clientY);
    const w = Math.abs(e.clientX - dragStart.x);
    const h = Math.abs(e.clientY - dragStart.y);
    Object.assign(selectionBoxEl.style, {
      left: x + "px",
      top: y + "px",
      width: w + "px",
      height: h + "px",
    });
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    if (selectionBoxEl) {
      // TODO: 下一步在此处调用 Tesseract.js 对该区域截图做OCR识别，
      // 识别结果文本再传入 requestTranslation()
      selectionBoxEl.remove();
      selectionBoxEl = null;
    }
  });
})();
