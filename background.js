// background.js (Manifest V3 service worker)
// 职责：接收 content script 的翻译请求，调用云端翻译API，返回结果
// 目前默认接入 DeepL API，可在 translateWithDeepL 之外扩展其他供应商

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRANSLATE_TEXT") {
    handleTranslate(message.text, message.targetLang)
      .then((translatedText) => {
        sendResponse({ ok: true, translatedText });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message || "Translation failed" });
      });
    return true; // 表示会异步调用 sendResponse
  }

  // 单词点击 → 词典查询（英英释义 + 目标语言一行义）
  if (message.type === "LOOKUP_WORD") {
    handleLookupWord(message.word, message.targetLang)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "Lookup failed" }));
    return true;
  }
});

// ---------- 单词词典查询 ----------
// 数据源：Free Dictionary API（api.dictionaryapi.dev，免费、无需API Key）
// 提供音标、词性、多条释义与例句（英文）。
// 另外用已有的 DeepL 逻辑把词条翻成用户的目标语言，作为顶部的"一行义"。
async function handleLookupWord(rawWord, targetLang) {
  const word = normalizeWord(rawWord);
  if (!word) throw new Error("Invalid word");

  // 英英词典（结构化释义）
  const entry = await fetchDictionaryEntry(word);

  // 目标语言"一行义"：尽力而为，DeepL没配Key或失败都不影响英英释义展示
  let targetGloss = null;
  try {
    const cfg = await chrome.storage.sync.get(["apiKey", "isPro", "apiProvider"]);
    if (cfg.apiKey && (cfg.apiProvider || "deepl") === "deepl") {
      targetGloss = await translateWithDeepL(entry.word, targetLang, cfg.apiKey, cfg.isPro);
    }
  } catch (e) {
    // 忽略：一行义是可选增强
  }

  return { ...entry, targetGloss, targetLang: targetLang || "ZH" };
}

// 只保留字母/连字符/撇号，去掉首尾标点，转小写
function normalizeWord(raw) {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z'-]/g, "")
    .replace(/^[-']+|[-']+$/g, "");
}

// 词典API对屈折形式（reads / running / better）不总是命中，
// 这里做一个轻量的原形候选，命中即返回，避免引入完整的词形还原库。
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
  // 去重 + 过滤太短的
  return [...new Set(c)].filter((w) => w && w.length >= 2 && w !== word);
}

async function fetchDictionaryEntry(word) {
  const candidates = [word, ...lemmaCandidates(word)];

  for (const w of candidates) {
    const resp = await fetch(
      "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(w)
    );
    if (resp.ok) {
      const json = await resp.json();
      return parseDictionaryEntry(json, w);
    }
    if (resp.status !== 404) {
      // 非"未找到"的错误（限流/服务异常）直接抛出，不再试其他候选
      throw new Error(`Dictionary service error (${resp.status})`);
    }
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
        // 每个词性最多取3条，避免弹窗过长
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

// ---------- PDF拦截：跳转到自建的 pdf.js + OCR 查看页 ----------
// 说明：Chrome默认会用自己内置的PDF viewer打开.pdf链接（一个特殊的内置扩展origin，
// 很难稳定地从外部content script注入）。这里改用更常规的做法：
// 监听导航，一旦发现目标是PDF，就把这个tab重定向到我们自己打包的 viewer.html，
// 由 viewer.html 内部用 pdf.js 渲染 + Tesseract.js 做OCR，取得统一坐标系的word-box。
//
// 已知限制：这里用URL路径是否以 .pdf 结尾做判断，覆盖不了"服务器返回PDF但URL没有.pdf后缀"
// 的情况（比如某些在线文档系统）。如果需要覆盖更多场景，后续可以改用
// declarativeNetRequest 按 resourceType 匹配，但那个方式配置更复杂，先用这个简单版本。
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return; // 只处理主frame，忽略iframe

  const url = details.url;
  const isOwnViewer = url.startsWith(chrome.runtime.getURL("viewer.html"));
  if (isOwnViewer) return; // 避免自己跳转自己，造成死循环

  const looksLikePdf = /\.pdf(\?|#|$)/i.test(url);
  if (!looksLikePdf) return;

  const viewerUrl =
    chrome.runtime.getURL("viewer.html") + "?file=" + encodeURIComponent(url);
  chrome.tabs.update(details.tabId, { url: viewerUrl });
});

// 插件安装时设置默认配置
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
