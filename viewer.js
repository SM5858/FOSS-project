// viewer.js
// 职责：
//  1. 用 pdf.js 把PDF每一页渲染到 canvas（原生像素尺寸，不做CSS缩放，保证坐标系统一）
//  2. 用 Tesseract.js 对同一个 canvas 做 OCR，产出 word-box 数组：
//     { text, bbox: {x0,y0,x1,y1}, pageIndex, lemma }  —— 这是和队友约定的数据契约
//  3. 透明覆盖层做拖拽命中检测（多个word-box拼接 → 调用DeepL整句翻译）
//     和单击命中检测（单个word-box → 词典查询占位，等目标语言确定后接入）

import * as pdfjsLib from "./lib/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "lib/pdfjs/pdf.worker.mjs"
);

const RENDER_SCALE = 2.0; // 高分辨率渲染，OCR质量依赖这个（见README的"gotcha 2"）

const statusText = document.getElementById("statusText");
const progressFill = document.getElementById("progressFill");
const pageContainer = document.getElementById("pageContainer");

// 每页的状态：{ canvas, overlayEl, wordBoxes, ocrDone, ocrRunning }
const pagesState = [];

let tesseractWorker = null; // 全部页面共享同一个worker，避免重复初始化开销

function setStatus(text) {
  statusText.textContent = text;
}

function setProgress(ratio) {
  progressFill.style.width = Math.round(ratio * 100) + "%";
}

// ---------- 入口 ----------
async function main() {
  const params = new URLSearchParams(location.search);
  const fileUrl = params.get("file");
  if (!fileUrl) {
    setStatus("No PDF address provided (missing 'file' parameter).");
    return;
  }

  setStatus("Downloading PDF…");
  let pdfBytes;
  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    pdfBytes = await resp.arrayBuffer();
  } catch (err) {
    setStatus(`PDF download failed: ${err.message}. This may be due to cross-origin restrictions or a broken link.`);
    return;
  }

  setStatus("Parsing PDF…");
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdfDoc = await loadingTask.promise;

  setStatus(`Rendering ${pdfDoc.numPages} page(s)…`);
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    await renderPage(pdfDoc, i);
    setProgress(i / pdfDoc.numPages);
  }

  setStatus(`${pdfDoc.numPages} page(s) · Text is recognized automatically as you scroll (first time may be slow).`);
  observeLazyOcr();
}

// ---------- 渲染单页到 canvas ----------
async function renderPage(pdfDoc, pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  // 关键：不设置 canvas 的 CSS width/height，让它以原生像素尺寸显示。
  // 这样 Tesseract 返回的 bbox 坐标和屏幕上覆盖层的坐标完全一致，
  // 不需要额外换算缩放比例（这正是队友方案里强调的"统一坐标系"）。

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  const wrap = document.createElement("div");
  wrap.className = "pdf-page-wrap";
  wrap.style.width = viewport.width + "px";
  wrap.style.height = viewport.height + "px";
  wrap.dataset.pageIndex = String(pageNumber - 1);

  const overlay = document.createElement("div");
  overlay.className = "pdf-page-overlay";

  const badge = document.createElement("div");
  badge.className = "ht-page-loading-badge";
  badge.textContent = "Waiting for OCR…";

  wrap.appendChild(canvas);
  wrap.appendChild(overlay);
  wrap.appendChild(badge);
  pageContainer.appendChild(wrap);

  const state = {
    pageIndex: pageNumber - 1,
    canvas,
    overlayEl: overlay,
    badgeEl: badge,
    wordBoxes: [],
    ocrDone: false,
    ocrRunning: false,
  };
  pagesState[pageNumber - 1] = state;

  attachInteraction(state);
}

// ---------- 懒加载OCR：页面滚动进视口才识别，避免一次性卡死 ----------
function observeLazyOcr() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageIndex = Number(entry.target.dataset.pageIndex);
        runOcrForPage(pageIndex);
      }
    },
    { rootMargin: "600px 0px" } // 提前一点触发，减少用户等待感
  );

  document.querySelectorAll(".pdf-page-wrap").forEach((el) => io.observe(el));
}

async function getTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;

  tesseractWorker = await Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("lib/tesseract/tesseract-core-simd-lstm.wasm.js"),
    // MV3必需：默认Tesseract会把worker包进一个blob URL再importScripts(workerPath)，
    // 但blob worker是opaque origin，无法加载 chrome-extension:// 资源，导致
    // "Failed to execute 'importScripts'... worker.min.js failed to load"。
    // 关掉blob包装，直接 new Worker(chrome-extension://.../worker.min.js) 作为扩展自身worker，
    // 这样才能正常 importScripts 到 corePath 等本地资源。
    workerBlobURL: false,
    // langPath 未指定：语言包(eng.traineddata)会从 Tesseract.js 默认CDN按需下载并由浏览器缓存。
    // 语言包是纯数据文件（非可执行代码），不属于MV3禁止的"远程代码执行"，但如果要完全离线，
    // 后续可以把 eng.traineddata.gz 下载后放进 lib/tesseract/lang-data/ 并在这里指定本地 langPath。
    logger: () => {}, // 如需调试进度可以在这里打印 m.progress
  });
  return tesseractWorker;
}

async function runOcrForPage(pageIndex) {
  const state = pagesState[pageIndex];
  if (!state || state.ocrDone || state.ocrRunning) return;
  state.ocrRunning = true;
  state.badgeEl.textContent = "Recognizing…";

  try {
    const worker = await getTesseractWorker();
    // Tesseract v5+ 默认只返回 text，必须显式开启 blocks 输出才能拿到词级 bbox。
    // 不开的话 data.words 为空，页面上就没有可点击的单词框。
    const { data } = await worker.recognize(state.canvas, {}, { blocks: true });

    // 从 blocks -> paragraphs -> lines -> words 收集词（每个词自带 bbox 和 text），
    // 映射成我们和队友约定的数据契约。
    state.wordBoxes = collectWords(data)
      .filter((w) => w.text && w.text.trim().length > 0 && w.bbox)
      .map((w) => ({
        text: w.text,
        bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
        pageIndex,
        lemma: simpleLemmaPlaceholder(w.text),
      }));

    mergeHyphenatedWords(state.wordBoxes);

    state.ocrDone = true;
    state.badgeEl.remove();
  } catch (err) {
    state.badgeEl.textContent = "OCR failed";
    console.error("OCR failed on page", pageIndex, err);
  } finally {
    state.ocrRunning = false;
  }
}

// 从 Tesseract 的 blocks 结构里把所有词展平出来。
// v5+ 已移除扁平的 data.words，只能走 blocks -> paragraphs -> lines -> words；
// 但若某个版本仍提供 data.words，也优先使用，向后兼容。
function collectWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) out.push(w);
      }
    }
  }
  return out;
}

// 检测双栏（多栏）排版：用单词覆盖的"密度直方图"找页面中央的低谷（栏间距/gutter）。
// 用密度低谷而不是"完全空白"，这样即使页脚页码/扫描噪点横跨中缝也不会误判。
// 返回该 gutter 中心 x 作为分栏线；单栏页面返回 null。
function detectColumnSplitX(wordBoxes) {
  if (wordBoxes.length < 25) return null; // 词太少，不太可能是真正的多栏
  let minX = Infinity;
  let maxX = -Infinity;
  for (const wb of wordBoxes) {
    if (wb.bbox.x0 < minX) minX = wb.bbox.x0;
    if (wb.bbox.x1 > maxX) maxX = wb.bbox.x1;
  }
  const pageW = maxX - minX;
  if (pageW <= 0) return null;

  const BINS = 200; // 细分辨率，才能抓到很窄的栏间距（书籍扫描常只有 ~2% 页宽）
  const binW = pageW / BINS;
  const hist = new Array(BINS).fill(0);
  for (const wb of wordBoxes) {
    let b0 = Math.max(0, Math.floor((wb.bbox.x0 - minX) / binW));
    let b1 = Math.min(BINS - 1, Math.floor((wb.bbox.x1 - minX) / binW));
    for (let b = b0; b <= b1; b++) hist[b]++;
  }

  let peak = 0;
  for (let b = 0; b < BINS; b++) if (hist[b] > peak) peak = hist[b];
  if (peak < 5) return null; // 每栏至少要有若干行才算数

  // 中间 20%~80% 找覆盖最少的 bin（最深的谷底）。栏间距虽窄，但整列高度都空，
  // 覆盖接近 0；而单词间的空隙每行位置不同，叠加后并不空。所以找"最深"而非"最宽"。
  const lo = Math.floor(BINS * 0.2);
  const hi = Math.ceil(BINS * 0.8);
  let valleyBin = lo;
  for (let b = lo; b < hi; b++) if (hist[b] < hist[valleyBin]) valleyBin = b;

  // 谷底必须足够深：正文栏里任何 x 都被大多数行覆盖，只有真正的栏间距才接近空
  const deepThresh = peak * 0.2;
  if (hist[valleyBin] > deepThresh) return null;

  // 把谷底扩展成连续的低密度带，取中心作为分栏线
  let a = valleyBin;
  while (a > 0 && hist[a - 1] <= deepThresh) a--;
  let c = valleyBin;
  while (c < BINS - 1 && hist[c + 1] <= deepThresh) c++;

  // 左右两侧都要有高密度正文栏，才是真正的双栏（否则可能只是页面右侧空白）
  let leftHigh = false;
  let rightHigh = false;
  for (let b = 0; b < a; b++) if (hist[b] >= peak * 0.5) { leftHigh = true; break; }
  for (let b = c + 1; b < BINS; b++) if (hist[b] >= peak * 0.5) { rightHigh = true; break; }
  if (!leftHigh || !rightHigh) return null;

  return minX + ((a + c + 1) / 2) * binW;
}

// 处理跨行连字符断词：por-（行末） + trayed（下一行行首） -> portrayed
// 不靠数组相邻（那样双栏会把右栏行末接到左栏下一行），而是用几何方式找后半：
//   同一栏 + 紧邻的下一行 + 该行最靠左（行首）的词。
// 给两半都打上合并后的完整词 joinedWord，点击任意一半都能查到整词。
function mergeHyphenatedWords(wordBoxes) {
  const splitX = detectColumnSplitX(wordBoxes);
  const columnOf = (wb) =>
    splitX === null ? 0 : (wb.bbox.x0 + wb.bbox.x1) / 2 < splitX ? 0 : 1;

  for (const cur of wordBoxes) {
    if (!cur.text.endsWith("-") || cur.text.length < 2) continue;
    const lineH = cur.bbox.y1 - cur.bbox.y0;
    const curCol = columnOf(cur);

    let best = null;
    for (const w of wordBoxes) {
      if (w === cur) continue;
      if (columnOf(w) !== curCol) continue; // 必须同一栏
      const dy = w.bbox.y0 - cur.bbox.y0;
      if (dy <= lineH * 0.5) continue; // 同行或更高，跳过
      if (w.bbox.y0 - cur.bbox.y1 > lineH * 1.5) continue; // 太远，不是紧邻下一行
      if (!/^[A-Za-z]/.test(w.text)) continue; // 后半应以字母开头
      if (!best || w.bbox.x0 < best.bbox.x0) best = w; // 取最靠左（行首）
    }

    if (best) {
      const joined = cur.text.slice(0, -1) + best.text;
      cur.joinedWord = joined;
      best.joinedWord = joined;
    }
  }
}

// 占位的词形还原：目前只是转小写。真正的 lemmatization（wink-lemmatizer / compromise）
// 由队友接入词典查询功能时替换这里，函数签名不用变，调用方不受影响。
function simpleLemmaPlaceholder(text) {
  return text.toLowerCase().replace(/[^a-z']/g, "");
}

// ---------- 拖拽 / 单击 命中检测 ----------
function attachInteraction(state) {
  const { overlayEl } = state;
  let dragStart = null;
  let dragRectEl = null;
  let didDrag = false;

  overlayEl.addEventListener("mousedown", (e) => {
    dragStart = { x: e.offsetX, y: e.offsetY };
    didDrag = false;
    dragRectEl = document.createElement("div");
    dragRectEl.className = "ht-drag-rect";
    overlayEl.appendChild(dragRectEl);
  });

  overlayEl.addEventListener("mousemove", (e) => {
    if (!dragStart) return;
    const x = Math.min(dragStart.x, e.offsetX);
    const y = Math.min(dragStart.y, e.offsetY);
    const w = Math.abs(e.offsetX - dragStart.x);
    const h = Math.abs(e.offsetY - dragStart.y);
    if (w > 3 || h > 3) didDrag = true;
    Object.assign(dragRectEl.style, {
      left: x + "px",
      top: y + "px",
      width: w + "px",
      height: h + "px",
    });
  });

  overlayEl.addEventListener("mouseup", (e) => {
    if (!dragStart) return;
    const rect = {
      x0: Math.min(dragStart.x, e.offsetX),
      y0: Math.min(dragStart.y, e.offsetY),
      x1: Math.max(dragStart.x, e.offsetX),
      y1: Math.max(dragStart.y, e.offsetY),
    };
    if (dragRectEl) dragRectEl.remove();
    dragRectEl = null;

    if (!state.ocrDone) {
      dragStart = null;
      return; // 这一页还没识别完，先不响应
    }

    if (didDrag) {
      handleDragSelect(state, rect);
    } else {
      handleWordClick(state, { x: e.offsetX, y: e.offsetY });
    }
    dragStart = null;
  });
}

function boxIntersects(box, rect) {
  return !(
    box.x1 < rect.x0 ||
    box.x0 > rect.x1 ||
    box.y1 < rect.y0 ||
    box.y0 > rect.y1
  );
}

function boxContainsPoint(box, point) {
  return (
    point.x >= box.x0 && point.x <= box.x1 && point.y >= box.y0 && point.y <= box.y1
  );
}

// 拖拽多个word-box → 拼接文本 → 走整句翻译（复用background.js里已有的DeepL逻辑）
function handleDragSelect(state, rect) {
  const hit = state.wordBoxes
    .filter((wb) => boxIntersects(wb.bbox, rect))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  if (hit.length === 0) return;

  // 拼接文本时，跨行连字符断词直接接上去（去掉 "-"、不加空格）
  let text = "";
  for (let i = 0; i < hit.length; i++) {
    const t = hit[i].text;
    if (t.endsWith("-") && i < hit.length - 1) {
      text += t.slice(0, -1);
    } else {
      text += t + " ";
    }
  }
  text = text.trim();

  const lastBox = hit[hit.length - 1].bbox;
  showTranslatePopup(text, lastBox.x1, lastBox.y1 + 8, state.overlayEl);
}

// 单击一个word-box → 词典查询（跨行断词用合并后的完整词）
function handleWordClick(state, point) {
  const hit = state.wordBoxes.find((wb) => boxContainsPoint(wb.bbox, point));
  if (!hit) return;
  const word = hit.joinedWord || hit.text;
  showDictionaryPopup({ text: word }, point.x, point.y + 8, state.overlayEl);
}

// ---------- 悬浮窗（拖拽 -> 整句翻译） ----------
function showTranslatePopup(text, x, y, parentEl) {
  const popup = getOrCreatePopup(parentEl, "ht-translate-popup");
  showPopup(popup, x, y);

  const run = (targetLang) => {
    popup._htRerun = (lang) => run(lang);
    popup.querySelector(".ht-popup-lang").textContent = "Translate";
    popup.querySelector(".ht-lang-select").value = targetLang;
    popup.querySelector(".ht-popup-body").innerHTML = `
      <div class="ht-popup-original"></div>
      <div class="ht-popup-divider"></div>
      <div class="ht-popup-result">Translating…</div>
    `;
    popup.querySelector(".ht-popup-original").textContent = text;

    chrome.runtime.sendMessage(
      { type: "TRANSLATE_TEXT", text, targetLang },
      (response) => {
        const resultEl = popup.querySelector(".ht-popup-result");
        if (!resultEl) return;
        if (chrome.runtime.lastError || !response || !response.ok) {
          resultEl.textContent =
            (response && response.error) || "Translation failed. Check your API Key in Settings.";
          resultEl.classList.add("ht-popup-error");
          return;
        }
        resultEl.textContent = response.translatedText;
      }
    );
  };

  chrome.storage.sync.get(["targetLang"], (cfg) => run(cfg.targetLang || "ZH"));
}

// ---------- 悬浮窗（单击单词 -> 词典查询） ----------
// 用统一的 background LOOKUP_WORD + 共享渲染器 window.HTDict，
// 与普通网页(content.js)的词典弹窗保持一致。
function showDictionaryPopup(wordBox, x, y, parentEl) {
  const popup = getOrCreatePopup(parentEl, "ht-translate-popup");
  showPopup(popup, x, y);

  const run = (targetLang) => {
    popup._htRerun = (lang) => run(lang);
    popup.querySelector(".ht-popup-lang").textContent = "Dictionary";
    popup.querySelector(".ht-lang-select").value = targetLang;
    setPopupMessage(popup, `Looking up “${wordBox.text}”…`, false);

    chrome.runtime.sendMessage(
      { type: "LOOKUP_WORD", word: wordBox.text, targetLang },
      (response) => {
        if (chrome.runtime.lastError || !response) {
          setPopupMessage(popup, "Lookup failed. Check your network.", true);
          return;
        }
        if (response.ok) {
          popup.querySelector(".ht-popup-body").innerHTML =
            window.HTDict.buildDictionaryHTML(response);
        } else {
          setPopupMessage(popup, response.error || "No definition found", true);
        }
      }
    );
  };

  chrome.storage.sync.get(["targetLang"], (cfg) => run(cfg.targetLang || "ZH"));
}

function showPopup(popup, x, y) {
  popup.classList.remove("ht-hidden");
  popup.style.left = x + "px";
  popup.style.top = y + "px";
}

function setPopupMessage(popup, message, isError) {
  popup.querySelector(".ht-popup-body").innerHTML =
    `<div class="ht-popup-result${isError ? " ht-popup-error" : ""}"></div>`;
  popup.querySelector(".ht-popup-result").textContent = message;
}

function getOrCreatePopup(parentEl, className) {
  let popup = parentEl.querySelector(`.${className}`);
  if (popup) return popup;

  popup = document.createElement("div");
  popup.className = `${className}`;
  popup.style.position = "absolute";
  popup.innerHTML = `
    <div class="ht-popup-header">
      <span class="ht-popup-lang"></span>
      <div class="ht-popup-header-right">
        <select class="ht-lang-select" title="Target language"></select>
        <button class="ht-popup-close" title="Close">×</button>
      </div>
    </div>
    <div class="ht-popup-body"></div>
  `;
  parentEl.appendChild(popup);

  window.HTDict.fillLangSelect(popup.querySelector(".ht-lang-select"), null);
  // 在弹窗里换语言：保存为默认值 + 用新语言重跑当前查询/翻译（每个弹窗记住自己的重跑闭包）
  popup.querySelector(".ht-lang-select").addEventListener("change", (e) => {
    const lang = e.target.value;
    chrome.storage.sync.set({ targetLang: lang });
    if (popup._htRerun) popup._htRerun(lang);
  });

  popup.querySelector(".ht-popup-close").addEventListener("click", () => {
    popup.classList.add("ht-hidden");
  });
  popup.addEventListener("mousedown", (e) => e.stopPropagation());
  return popup;
}

main();
