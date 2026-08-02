// background.js (Manifest V3 service worker)
// Responsibility: receive translation requests from content scripts, call the cloud translation API, return results
// Currently defaults to the DeepL API; other providers can be added alongside translateWithDeepL

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRANSLATE_TEXT") {
    handleTranslate(message.text, message.targetLang)
      .then((translatedText) => {
        sendResponse({ ok: true, translatedText });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message || "Translation failed" });
      });
    return true; // indicates sendResponse will be called asynchronously
  }

  // Word click -> dictionary lookup (English definitions + one-line target-language gloss)
  if (message.type === "LOOKUP_WORD") {
    handleLookupWord(message.word, message.targetLang)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "Lookup failed" }));
    return true;
  }
});

// ---------- Word dictionary lookup ----------
// Data source: Free Dictionary API (api.dictionaryapi.dev, free, no API Key required)
// Provides phonetics, part of speech, multiple definitions, and examples (in English).
// Also uses the existing DeepL logic to translate the word into the user's target language, shown as the "one-line gloss" at the top.
async function handleLookupWord(rawWord, targetLang) {
  const word = normalizeWord(rawWord);
  if (!word) throw new Error("Invalid word");

  // English-English dictionary (structured definitions)
  const entry = await fetchDictionaryEntry(word);

  // Target-language "one-line gloss": best-effort only; missing DeepL key or failure doesn't affect the English definitions shown
  let targetGloss = null;
  try {
    const cfg = await chrome.storage.sync.get(["apiKey", "isPro", "apiProvider"]);
    if (cfg.apiKey && (cfg.apiProvider || "deepl") === "deepl") {
      targetGloss = await translateWithDeepL(entry.word, targetLang, cfg.apiKey, cfg.isPro);
    }
  } catch (e) {
    // Ignored: the one-line gloss is an optional enhancement
  }

  return { ...entry, targetGloss, targetLang: targetLang || "ZH" };
}

// Keep only letters/hyphens/apostrophes, strip leading/trailing punctuation, lowercase; also strip possessives.
// dog's -> dog, dogs' -> dogs, James's -> james
function normalizeWord(raw) {
  let w = (raw || "").toLowerCase().replace(/[^a-z'-]/g, "");
  w = w.replace(/'s$/, ""); // possessive 's
  w = w.replace(/^[-']+|[-']+$/g, ""); // strip leading/trailing ' and -
  return w;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The free dictionary API (dictionaryapi.dev) occasionally returns transient errors like 502/503,
// which usually succeed on retry. Here we retry a few times with backoff on 5xx and network errors;
// 200 and 404 are both "definitive results" and return immediately without retrying.
async function fetchDictWithRetry(word, attempts = 3) {
  const url =
    "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word);
  let resp = null;
  for (let i = 0; i < attempts; i++) {
    try {
      resp = await fetch(url);
    } catch (e) {
      resp = null; // network error -> retry
    }
    if (resp && (resp.ok || resp.status === 404)) return resp;
    if (i < attempts - 1) await delay(300 * (i + 1)); // 300ms, 600ms backoff
  }
  return resp; // the last response after retries are exhausted (may be 5xx), or null
}

// The dictionary API doesn't always match inflected forms (reads / running / better),
// so we generate a few lightweight base-form candidates and return on the first hit, avoiding a full lemmatization library.
function lemmaCandidates(word) {
  const c = [];
  if (word.endsWith("ies") && word.length > 4) c.push(word.slice(0, -3) + "y");
  if (word.endsWith("es") && word.length > 3) c.push(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) c.push(word.slice(0, -1));
  if (word.endsWith("ed") && word.length > 3) {
    c.push(word.slice(0, -1)); // used -> use
    c.push(word.slice(0, -2)); // walked -> walk
  }
  if (word.endsWith("ing") && word.length > 4) {
    c.push(word.slice(0, -3)); // walking -> walk
    c.push(word.slice(0, -3) + "e"); // making -> make
  }
  if (word.endsWith("est") && word.length > 4) c.push(word.slice(0, -3));
  if (word.endsWith("er") && word.length > 3) c.push(word.slice(0, -2));
  // Dedupe + filter out ones that are too short
  return [...new Set(c)].filter((w) => w && w.length >= 2 && w !== word);
}

async function fetchDictionaryEntry(word) {
  const candidates = [word, ...lemmaCandidates(word)];
  let sawServerError = false;

  for (const w of candidates) {
    const resp = await fetchDictWithRetry(w);
    if (resp && resp.ok) {
      const json = await resp.json();
      return parseDictionaryEntry(json, w);
    }
    // 5xx (still failing after retries) or a network error: note it and try the next candidate
    if (!resp || resp.status >= 500) sawServerError = true;
    // 404: this candidate genuinely doesn't exist, try the next one
  }

  // Only report "no definition" once every candidate comes back 404;
  // if a server error occurred along the way, suggest retrying later instead (to avoid misreporting a transient failure as "word doesn't exist").
  if (sawServerError) {
    throw new Error("Dictionary service is temporarily unavailable. Please try again.");
  }
  throw new Error(`No definition found for “${word}”`);
}

function parseDictionaryEntry(json, fallbackWord) {
  const entries = Array.isArray(json) ? json : [];
  const first = entries[0] || {};
  const word = first.word || fallbackWord;

  let phonetic = first.phonetic || null;
  if (!phonetic && Array.isArray(first.phonetics)) {
    const p = first.phonetics.find((x) => x && x.text);
    phonetic = p ? p.text : null;
  }

  const meanings = [];
  for (const e of entries) {
    for (const m of e.meanings || []) {
      meanings.push({
        partOfSpeech: m.partOfSpeech || "",
        // Keep at most 3 definitions per part of speech, to avoid an overly long popup
        definitions: (m.definitions || []).slice(0, 3).map((d) => ({
          definition: d.definition || "",
          example: d.example || null,
        })),
      });
    }
  }

  return { word, phonetic, meanings };
}

async function handleTranslate(text, targetLang) {
  const cfg = await chrome.storage.sync.get(["apiKey", "apiProvider", "isPro"]);

  if (!cfg.apiKey) {
    throw new Error("No API Key set. Click the extension icon to open Settings and add one.");
  }

  const provider = cfg.apiProvider || "deepl";
  if (provider === "deepl") {
    return translateWithDeepL(text, targetLang, cfg.apiKey, cfg.isPro);
  }

  throw new Error(`Unsupported translation provider: ${provider}`);
}

async function translateWithDeepL(text, targetLang, apiKey, isPro) {
  const base = isPro
    ? "https://api.deepl.com/v2/translate"
    : "https://api-free.deepl.com/v2/translate";

  const resp = await fetch(base, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `DeepL-Auth-Key ${apiKey}`,
    },
    body: new URLSearchParams({
      text,
      target_lang: targetLang,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`DeepL API error (${resp.status}): ${errText || "check that your API Key is valid"}`);
  }

  const data = await resp.json();
  const translation = data && data.translations && data.translations[0];
  if (!translation) {
    throw new Error("DeepL returned an empty result");
  }
  return translation.text;
}

// ---------- PDF interception: redirect to our own pdf.js + OCR viewer page ----------
// Note: by default Chrome opens .pdf links with its own built-in PDF viewer (a special built-in extension origin,
// which is hard to reliably inject into from an external content script). Instead we use a more standard approach:
// Listen for navigation, and once the target looks like a PDF, redirect that tab to our own bundled viewer.html,
// where viewer.html renders with pdf.js + runs OCR with Tesseract.js to get a word-box array in a unified coordinate system.
//
// Known limitation: this checks whether the URL path ends in .pdf, which misses "server returns a PDF but the URL has no .pdf extension"
// cases (e.g. some online document systems). If broader coverage is needed later, this could switch to
// declarativeNetRequest matching by resourceType, but that's more complex to configure — starting with this simpler version.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return; // only handle the main frame, ignore iframes

  const url = details.url;
  const isOwnViewer = url.startsWith(chrome.runtime.getURL("viewer.html"));
  if (isOwnViewer) return; // avoid redirecting to ourselves, which would create an infinite loop

  const looksLikePdf = /\.pdf(\?|#|$)/i.test(url);
  if (!looksLikePdf) return;

  const viewerUrl =
    chrome.runtime.getURL("viewer.html") + "?file=" + encodeURIComponent(url);
  chrome.tabs.update(details.tabId, { url: viewerUrl });
});

// Set default settings when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["targetLang", "enabled", "apiProvider"], (cfg) => {
    const defaults = {};
    if (!cfg.targetLang) defaults.targetLang = "ZH";
    if (cfg.enabled === undefined) defaults.enabled = true;
    if (!cfg.apiProvider) defaults.apiProvider = "deepl";
    if (Object.keys(defaults).length > 0) {
      chrome.storage.sync.set(defaults);
    }
  });
});
