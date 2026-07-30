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

    const gloss = data.targetGloss
      ? '<div class="ht-dict-gloss">' +
        '<span class="ht-dict-gloss-lang">' +
        escapeHtml(data.targetLang || "") +
        "</span>" +
        escapeHtml(data.targetGloss) +
        "</div>"
      : "";

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

  global.HTDict = { buildDictionaryHTML: buildDictionaryHTML, escapeHtml: escapeHtml };
})(typeof window !== "undefined" ? window : self);
