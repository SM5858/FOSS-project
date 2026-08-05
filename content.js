// content.js
// Injected into every page (including Chrome's built-in PDF viewer)
// Responsibilities:
//   - Click an English word -> dictionary lookup (phonetic/POS/definitions/examples + one-line target-language gloss)
//   - Drag-select a span of text -> full-sentence translation
//   Both interactions share one popup; the content area (.ht-popup-body) is filled by their respective render functions.

(() => {
  let popupEl = null;
  let lastSelectedText = "";
  let hideTimer = null;
  // Tracks what's currently shown in the popup, so switching the language dropdown can re-run the same lookup/translation in the new language
  let currentRerun = null;

  // ---------- Popup DOM ----------
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
    // Changing language inside the popup: save it as the new default immediately + re-run the current lookup/translation in the new language
    langSel.addEventListener("change", () => {
      const lang = langSel.value;
      chrome.storage.sync.set({ targetLang: lang });
      if (currentRerun) currentRerun(lang);
    });

    popupEl.querySelector(".ht-popup-close").addEventListener("click", hidePopup);
    // Interactions inside the popup shouldn't trigger the outer close/lookup logic
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

  // ---------- Sentence translation rendering (drag-select) ----------
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
  // Interaction 1: drag-select a span of text -> full-sentence translation
  // (only fires on a real drag; a double-click does not count)
  // ==========================================================================
  let pressX = 0;
  let pressY = 0;
  let movedDuringPress = false;

  document.addEventListener("mousedown", (e) => {
    pressX = e.clientX;
    pressY = e.clientY;
    movedDuringPress = false;
    // Clicking outside the popup closes it
    if (popupEl && !popupEl.contains(e.target)) hidePopup();
  });

  document.addEventListener("mousemove", (e) => {
    if (Math.abs(e.clientX - pressX) > 4 || Math.abs(e.clientY - pressY) > 4) {
      movedDuringPress = true;
    }
  });

  document.addEventListener("mouseup", (e) => {
    clearTimeout(hideTimer);
    // Only a real drag (mouse moved) triggers sentence translation; single/double clicks
    // are handled elsewhere, so double-clicking a word won't also pop up a translation.
    if (!movedDuringPress) return;
    hideTimer = setTimeout(() => handleSelection(e), 30);
  });

  function handleSelection() {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";

    // Empty selection (a plain click) is handled by the click -> word dictionary logic below
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
  // Interaction 2: double-click an English word -> dictionary lookup
  // Double-click, not single-click: single-click is used everywhere by web apps
  // (e.g. Google Docs' File/Edit toolbar), so single-click lookup would cover them up;
  // double-clicking a word is the natural "look this up" gesture and rarely conflicts.
  // ==========================================================================
  document.addEventListener("dblclick", (e) => {
    if (popupEl && popupEl.contains(e.target)) return;

    // Don't interfere when double-clicking links/buttons/inputs etc.; preserve their normal behavior
    if (e.target.closest &&
        e.target.closest("a, button, input, textarea, select, [contenteditable], [role='button']")) {
      return;
    }

    chrome.storage.sync.get(["enabled"], (cfg) => {
      if (cfg.enabled === false) return;
      const found = getWordAtPoint(e.clientX, e.clientY);
      if (!found || !found.word) return;
      lastSelectedText = ""; // Clear the translation dedup cache so the double-click selection doesn't affect it
      showPopupAt(found.rect.left, found.rect.bottom + 8);
      requestWordLookup(found.word);
    });
  });

  // Get the word under the mouse position and its screen rect
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
    // If the caret lands right after a word (next char isn't a word char), step back into the word
    if (i >= text.length || !isWordChar(text[i])) {
      if (i > 0 && isWordChar(text[i - 1])) i -= 1;
    }
    if (i < 0 || i >= text.length || !isWordChar(text[i])) return null;

    let start = i;
    let end = i;
    while (start > 0 && isWordChar(text[start - 1])) start -= 1;
    while (end < text.length && isWordChar(text[end])) end += 1;

    const word = text.slice(start, end);
    if (!/[A-Za-z]/.test(word)) return null; // Don't look up pure punctuation

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
  // Scanned PDFs: area drag-select (placeholder, OCR to be wired up next)
  // ==========================================================================
  // Hold Alt and drag to select an area; the screenshot of that area is handed to OCR, then to full-sentence translation.
  let isDragging = false;
  let dragStart = null;
  let selectionBoxEl = null;

  document.addEventListener("mousedown", (e) => {
    if (!e.altKey) return; // Hold Alt to trigger drag-select mode, avoiding conflicts with normal text selection/word lookup
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
      // TODO: next step is to call Tesseract.js here to OCR the screenshot of this area,
      // then feed the recognized text into requestTranslation()
      selectionBoxEl.remove();
      selectionBoxEl = null;
    }
  });
})();
