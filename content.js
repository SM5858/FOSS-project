// content.js
// 注入到每个页面（含Chrome内置PDF阅读器）
// 职责：
//   - 单击一个英文单词 -> 词典查询（音标/词性/多条释义/例句 + 目标语言一行义）
//   - 拖拽选中一段文本 -> 整句翻译
//   两种交互共用一个悬浮窗，展示区(.ht-popup-body)由各自的渲染函数填充。

(() => {
  let popupEl = null;
  let lastSelectedText = "";
  let hideTimer = null;
  // 记录当前弹窗展示的内容，语言下拉切换时用它以新语言重跑同一个查询/翻译
  let currentRerun = null;

  // ---------- 悬浮窗 DOM ----------
  function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement("div");
    popupEl.id = "ht-translate-popup";
    popupEl.className = "ht-translate-popup ht-hidden";
    popupEl.innerHTML = `
      <div class="ht-popup-header">
        <span class="ht-popup-lang"></span>
        <div class="ht-popup-header-right">
          <select class="ht-lang-select" title="Target language"></select>
          <button class="ht-popup-close" title="Close">×</button>
        </div>
      </div>
      <div class="ht-popup-body"></div>
    `;
    document.documentElement.appendChild(popupEl);

    const langSel = popupEl.querySelector(".ht-lang-select");
    window.HTDict.fillLangSelect(langSel, null);
    // 在弹窗里换语言：立即保存为默认值 + 用新语言重跑当前查询/翻译
    langSel.addEventListener("change", () => {
      const lang = langSel.value;
      chrome.storage.sync.set({ targetLang: lang });
      if (currentRerun) currentRerun(lang);
    });

    popupEl.querySelector(".ht-popup-close").addEventListener("click", hidePopup);
    // 悬浮窗内部的交互不应触发外部的关闭/取词逻辑
    popupEl.addEventListener("mousedown", (e) => e.stopPropagation());
    popupEl.addEventListener("click", (e) => e.stopPropagation());
    return popupEl;
  }

  function showPopupAt(x, y) {
    const el = ensurePopup();
    el.classList.remove("ht-hidden");
    const margin = 12;
    const maxX = window.innerWidth - 340;
    const maxY = window.innerHeight - 160;
    el.style.left = Math.min(Math.max(x, margin), Math.max(maxX, margin)) + "px";
    el.style.top = Math.min(Math.max(y, margin), Math.max(maxY, margin)) + "px";
  }

  function hidePopup() {
    if (popupEl) popupEl.classList.add("ht-hidden");
  }

  function setHeader(label, lang) {
    const el = ensurePopup();
    el.querySelector(".ht-popup-lang").textContent = label || "";
    if (lang) el.querySelector(".ht-lang-select").value = lang;
  }

  function setBodyHTML(html) {
    ensurePopup().querySelector(".ht-popup-body").innerHTML = html;
  }

  function setBodyMessage(message, isError) {
    setBodyHTML(
      `<div class="ht-popup-result${isError ? " ht-popup-error" : ""}"></div>`
    );
    ensurePopup().querySelector(".ht-popup-result").textContent = message;
  }

  // ---------- 整句翻译渲染（拖拽选中） ----------
  function renderTranslation({ original, result, isError }) {
    setBodyHTML(`
      <div class="ht-popup-original"></div>
      <div class="ht-popup-divider"></div>
      <div class="ht-popup-result${isError ? " ht-popup-error" : ""}"></div>
    `);
    const body = ensurePopup();
    body.querySelector(".ht-popup-original").textContent = original || "";
    body.querySelector(".ht-popup-result").textContent = result || "";
  }

  // ==========================================================================
  // 交互 1：拖拽选中一段文本 -> 整句翻译（只在"真正拖拽"时触发；双击不算）
  // ==========================================================================
  let pressX = 0;
  let pressY = 0;
  let movedDuringPress = false;

  document.addEventListener("mousedown", (e) => {
    pressX = e.clientX;
    pressY = e.clientY;
    movedDuringPress = false;
    // 点击悬浮窗以外的地方就关闭它
    if (popupEl && !popupEl.contains(e.target)) hidePopup();
  });

  document.addEventListener("mousemove", (e) => {
    if (Math.abs(e.clientX - pressX) > 4 || Math.abs(e.clientY - pressY) > 4) {
      movedDuringPress = true;
    }
  });

  document.addEventListener("mouseup", (e) => {
    clearTimeout(hideTimer);
    // 只有真正拖拽（鼠标移动过）才走整句翻译；单击/双击不在这里处理，
    // 这样双击查词时不会同时弹出翻译。
    if (!movedDuringPress) return;
    hideTimer = setTimeout(() => handleSelection(e), 30);
  });

  function handleSelection() {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";

    // 空选区（普通单击）交给下面的 click -> 单词词典逻辑处理
    if (!text) return;
    if (text === lastSelectedText) return;
    lastSelectedText = text;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    showPopupAt(rect.left, rect.bottom + 8);
    requestTranslation(text);
  }

  function requestTranslation(text, targetLangOverride) {
    const run = (targetLang) => {
      currentRerun = (lang) => requestTranslation(text, lang);
      setHeader("Translate", targetLang);
      renderTranslation({ original: text, result: "Translating…" });

      chrome.runtime.sendMessage(
        { type: "TRANSLATE_TEXT", text, targetLang },
        (response) => {
          if (chrome.runtime.lastError) {
            renderTranslation({
              original: text,
              result: "Translation request failed. Check your network or API Key.",
              isError: true,
            });
            return;
          }
          if (response && response.ok) {
            renderTranslation({ original: text, result: response.translatedText });
          } else {
            renderTranslation({
              original: text,
              result: (response && response.error) || "Translation failed",
              isError: true,
            });
          }
        }
      );
    };

    if (targetLangOverride) {
      run(targetLangOverride);
    } else {
      chrome.storage.sync.get(["targetLang", "enabled"], (cfg) => {
        if (cfg.enabled === false) return;
        run(cfg.targetLang || "ZH");
      });
    }
  }

  // ==========================================================================
  // 交互 2：双击一个英文单词 -> 词典查询
  // 用双击而不是单击：单击是网页/应用（如 Google Docs 的 File/Edit 工具栏）到处都在
  // 用的动作，用单击查词会把这些界面挡住；双击某个词是"查这个词"的自然手势，几乎不冲突。
  // ==========================================================================
  document.addEventListener("dblclick", (e) => {
    if (popupEl && popupEl.contains(e.target)) return;

    // 双击链接/按钮/输入框等可交互元素时不打扰，保留其原有行为
    if (e.target.closest &&
        e.target.closest("a, button, input, textarea, select, [contenteditable], [role='button']")) {
      return;
    }

    chrome.storage.sync.get(["enabled"], (cfg) => {
      if (cfg.enabled === false) return;
      const found = getWordAtPoint(e.clientX, e.clientY);
      if (!found || !found.word) return;
      lastSelectedText = ""; // 避免双击产生的选区被翻译去重逻辑影响
      showPopupAt(found.rect.left, found.rect.bottom + 8);
      requestWordLookup(found.word);
    });
  });

  // 取鼠标位置下的单词与其屏幕矩形
  function getWordAtPoint(clientX, clientY) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(clientX, clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range) return null;

    const node = range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;

    const text = node.textContent;
    const isWordChar = (ch) => /[A-Za-z'\-]/.test(ch);

    let i = range.startOffset;
    // 光标落在单词末尾（下一个字符不是词字符）时，回退到词内
    if (i >= text.length || !isWordChar(text[i])) {
      if (i > 0 && isWordChar(text[i - 1])) i -= 1;
    }
    if (i < 0 || i >= text.length || !isWordChar(text[i])) return null;

    let start = i;
    let end = i;
    while (start > 0 && isWordChar(text[start - 1])) start -= 1;
    while (end < text.length && isWordChar(text[end])) end += 1;

    const word = text.slice(start, end);
    if (!/[A-Za-z]/.test(word)) return null; // 纯符号不查

    const wordRange = document.createRange();
    wordRange.setStart(node, start);
    wordRange.setEnd(node, end);
    const rect = wordRange.getBoundingClientRect();
    return { word, rect };
  }

  function requestWordLookup(word, targetLangOverride) {
    const run = (targetLang) => {
      currentRerun = (lang) => requestWordLookup(word, lang);
      setHeader("Dictionary", targetLang);
      setBodyMessage(`Looking up “${word}”…`);

      chrome.runtime.sendMessage(
        { type: "LOOKUP_WORD", word, targetLang },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            setBodyMessage("Lookup failed. Check your network.", true);
            return;
          }
          if (response.ok) {
            setBodyHTML(window.HTDict.buildDictionaryHTML(response));
          } else {
            setBodyMessage(response.error || "No definition found", true);
          }
        }
      );
    };

    if (targetLangOverride) {
      run(targetLangOverride);
    } else {
      chrome.storage.sync.get(["targetLang"], (cfg) => run(cfg.targetLang || "ZH"));
    }
  }

  // ==========================================================================
  // 扫描版PDF：区域框选（占位实现，后续接入 OCR）
  // ==========================================================================
  // 说明：按住 Alt 拖框选一块区域，对该区域截图交给OCR识别后再走整句翻译。
  let isDragging = false;
  let dragStart = null;
  let selectionBoxEl = null;

  document.addEventListener("mousedown", (e) => {
    if (!e.altKey) return; // 按住 Alt 触发框选模式，避免与普通划词/取词冲突
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
