// lib/dict-render.js
// Shared dictionary popup renderer.
// Loaded by BOTH content.js (regular web pages) and viewer.js (PDF viewer)
// so the dictionary popup looks and behaves identically in both places.
// To change how a dictionary entry is displayed, edit ONLY this file.
//
// Registered as a global (window.HTDict) because content scripts run as
// classic scripts, so we avoid ES modules here.
(function (global) {
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 用友好的语言名（去掉括号里的原文名）显示，例如 "KO" -> "Korean"
  function langLabel(code) {
    if (!code) return "";
    for (let i = 0; i < LANGUAGES.length; i++) {
      if (LANGUAGES[i].code === code) {
        return LANGUAGES[i].label.replace(/\s*\(.*\)\s*$/, "");
      }
    }
    return code;
  }

  // data shape (produced by background.js LOOKUP_WORD):
  // {
  //   word: "run",
  //   phonetic: "/rʌn/" | null,
  //   targetGloss: "跑" | null,          // meaning in the user's target language
  //   targetLang: "ZH",
  //   meanings: [
  //     { partOfSpeech: "verb",
  //       definitions: [ { definition: "...", example: "..." | null }, ... ] },
  //     ...
  //   ]
  // }
  function buildDictionaryHTML(data) {
    const head =
      '<div class="ht-dict-head">' +
      '<span class="ht-dict-word">' + escapeHtml(data.word) + "</span>" +
      (data.phonetic
        ? '<span class="ht-dict-phonetic">' + escapeHtml(data.phonetic) + "</span>"
        : "") +
      "</div>";

    let gloss;
    if (data.targetGloss) {
      gloss =
        '<div class="ht-dict-gloss">' +
        '<span class="ht-dict-gloss-lang">' +
        escapeHtml(langLabel(data.targetLang)) +
        "</span>" +
        escapeHtml(data.targetGloss) +
        "</div>";
    } else if (data.glossStatus === "no-key") {
      gloss =
        '<div class="ht-dict-gloss-hint">Set a DeepL API key in Settings to also see the ' +
        escapeHtml(langLabel(data.targetLang)) +
        " meaning.</div>";
    } else if (data.glossStatus === "error") {
      gloss =
        '<div class="ht-dict-gloss-hint">' +
        escapeHtml(langLabel(data.targetLang)) +
        " meaning unavailable right now (translation service error).</div>";
    } else {
      gloss = "";
    }

    let senses;
    if (data.meanings && data.meanings.length) {
      senses = data.meanings
        .map(function (m) {
          const defs = (m.definitions || [])
            .map(function (d) {
              return (
                '<li class="ht-dict-def">' +
                '<span class="ht-dict-def-text">' +
                escapeHtml(d.definition) +
                "</span>" +
                (d.example
                  ? '<span class="ht-dict-example">“' +
                    escapeHtml(d.example) +
                    "”</span>"
                  : "") +
                "</li>"
              );
            })
            .join("");
          return (
            '<div class="ht-dict-pos-block">' +
            (m.partOfSpeech
              ? '<div class="ht-dict-pos">' + escapeHtml(m.partOfSpeech) + "</div>"
              : "") +
            '<ol class="ht-dict-defs">' +
            defs +
            "</ol>" +
            "</div>"
          );
        })
        .join("");
    } else {
      senses = '<div class="ht-dict-empty">No dictionary definition found.</div>';
    }

    return head + gloss + senses;
  }

  // ---------- 目标语言列表（单一数据源） ----------
  // 代码必须是 DeepL 的 target_lang 取值（翻译和词典的目标语一行义都走 DeepL）。
  // popup / options / 页内弹窗都从这里取，改语言只改这一处。
  var LANGUAGES = [
    { code: "EN-US", label: "English (US)" },
    { code: "EN-GB", label: "English (UK)" },
    { code: "ZH", label: "Chinese (中文)" },
    { code: "JA", label: "Japanese (日本語)" },
    { code: "KO", label: "Korean (한국어)" },
    { code: "ES", label: "Spanish (Español)" },
    { code: "FR", label: "French (Français)" },
    { code: "DE", label: "German (Deutsch)" },
    { code: "IT", label: "Italian (Italiano)" },
    { code: "PT-BR", label: "Portuguese (BR)" },
    { code: "RU", label: "Russian (Русский)" },
    { code: "NL", label: "Dutch (Nederlands)" },
  ];

  // 用 LANGUAGES 填充一个 <select>，并（可选）选中 current 对应的项。
  function fillLangSelect(selectEl, current) {
    if (!selectEl) return;
    selectEl.innerHTML = LANGUAGES.map(function (l) {
      return '<option value="' + escapeHtml(l.code) + '">' + escapeHtml(l.label) + "</option>";
    }).join("");
    if (current) selectEl.value = current;
  }

  global.HTDict = {
    buildDictionaryHTML: buildDictionaryHTML,
    escapeHtml: escapeHtml,
    LANGUAGES: LANGUAGES,
    fillLangSelect: fillLangSelect,
  };
})(typeof window !== "undefined" ? window : self);
