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
        sendResponse({ ok: false, error: err.message || "翻译失败" });
      });
    return true; // 表示会异步调用 sendResponse
  }
});

async function handleTranslate(text, targetLang) {
  const cfg = await chrome.storage.sync.get(["apiKey", "apiProvider", "isPro"]);

  if (!cfg.apiKey) {
    throw new Error("尚未设置API Key，请点击插件图标进入设置页面填写");
  }

  const provider = cfg.apiProvider || "deepl";
  if (provider === "deepl") {
    return translateWithDeepL(text, targetLang, cfg.apiKey, cfg.isPro);
  }

  throw new Error(`暂不支持的翻译供应商: ${provider}`);
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
    throw new Error(`DeepL API 错误 (${resp.status}): ${errText || "请检查API Key是否有效"}`);
  }

  const data = await resp.json();
  const translation = data && data.translations && data.translations[0];
  if (!translation) {
    throw new Error("DeepL 返回结果为空");
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
