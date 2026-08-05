// viewer.js
// Responsibilities:
//  1. Use pdf.js to render each PDF page to a canvas (native pixel size, no CSS scaling, to keep the coordinate system unified)
//  2. Run Tesseract.js OCR on that same canvas to produce a word-box array:
//     { text, bbox: {x0,y0,x1,y1}, pageIndex, lemma } — this is the data contract agreed with the team
//  3. A transparent overlay does drag hit-testing (concatenate multiple word-boxes -> call DeepL for full-sentence translation)
//     and click hit-testing (a single word-box -> dictionary lookup, wired up once the target language is decided)

import * as pdfjsLib from "./lib/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "lib/pdfjs/pdf.worker.mjs"
);

const RENDER_SCALE = 2.0; // High-resolution rendering, OCR quality depends on this (see README's "gotcha 2")

const statusText = document.getElementById("statusText");
const progressFill = document.getElementById("progressFill");
const pageContainer = document.getElementById("pageContainer");

// Per-page state: { canvas, overlayEl, wordBoxes, ocrDone, ocrRunning }
const pagesState = [];

let tesseractWorker = null; // Shared across all pages to avoid re-initialization overhead

function setStatus(text) {
  statusText.textContent = text;
}

function setProgress(ratio) {
  progressFill.style.width = Math.round(ratio * 100) + "%";
}

// ---------- Entry point ----------
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

// ---------- Render a single page to canvas ----------
async function renderPage(pdfDoc, pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  // Key point: don't set the canvas's CSS width/height, so it displays at its native pixel size.
  // This way the bbox coordinates Tesseract returns exactly match the overlay's on-screen coordinates,
  // with no extra scale-factor conversion needed (this is exactly the "unified coordinate system" the team emphasized).

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

// ---------- Lazy OCR: only recognize a page once it scrolls into view, to avoid blocking everything at once ----------
function observeLazyOcr() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageIndex = Number(entry.target.dataset.pageIndex);
        runOcrForPage(pageIndex);
      }
    },
    { rootMargin: "600px 0px" } // trigger a bit early to reduce perceived wait time
  );

  document.querySelectorAll(".pdf-page-wrap").forEach((el) => io.observe(el));
}

async function getTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;

  tesseractWorker = await Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("lib/tesseract/tesseract-core-simd-lstm.wasm.js"),
    // Required for MV3: by default Tesseract wraps the worker in a blob URL and then importScripts(workerPath),
    // but a blob worker has an opaque origin and can't load chrome-extension:// resources, causing
    // "Failed to execute 'importScripts'... worker.min.js failed to load"。
    // Disabling the blob wrapper and using new Worker(chrome-extension://.../worker.min.js) directly as the extension's own worker
    // is what lets importScripts correctly load corePath and other local resources.
    workerBlobURL: false,
    // langPath not specified: the language pack (eng.traineddata) will be downloaded on demand from Tesseract.js's default CDN and cached by the browser.
    // The language pack is a pure data file (not executable code), so it's not the "remote code execution" MV3 prohibits — but for fully offline operation,
    // eng.traineddata.gz could be downloaded ahead of time, placed in lib/tesseract/lang-data/, and pointed to via a local langPath here.
    logger: () => {}, // print m.progress here if you need to debug progress
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
    // Tesseract v5+ only returns text by default; blocks output must be explicitly enabled to get word-level bbox.
    // Without it, data.words is empty and there are no clickable word boxes on the page.
    const { data } = await worker.recognize(state.canvas, {}, { blocks: true });

    // Collect words by walking blocks -> paragraphs -> lines -> words (each word carries its own bbox and text),
    // then map them to the data contract agreed with the team.
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

// Flatten all words out of Tesseract's blocks structure.
// v5+ removed the flat data.words, so we have to go through blocks -> paragraphs -> lines -> words;
// but if some version still provides data.words, prefer that for backward compatibility.
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

// Detect two-column (multi-column) layouts: use a "density histogram" of word coverage to find the valley in the middle of the page (the column gutter).
// Using a density valley rather than requiring "completely blank" avoids misfiring when footer page numbers/scan noise cross the gutter.
// Returns the x-coordinate of the gutter's center as the column divider; returns null for single-column pages.
function detectColumnSplitX(wordBoxes) {
  if (wordBoxes.length < 25) return null; // too few words, unlikely to be genuinely multi-column
  let minX = Infinity;
  let maxX = -Infinity;
  for (const wb of wordBoxes) {
    if (wb.bbox.x0 < minX) minX = wb.bbox.x0;
    if (wb.bbox.x1 > maxX) maxX = wb.bbox.x1;
  }
  const pageW = maxX - minX;
  if (pageW <= 0) return null;

  const BINS = 200; // fine resolution needed to catch narrow gutters (book scans are often only ~2% of page width)
  const binW = pageW / BINS;
  const hist = new Array(BINS).fill(0);
  for (const wb of wordBoxes) {
    let b0 = Math.max(0, Math.floor((wb.bbox.x0 - minX) / binW));
    let b1 = Math.min(BINS - 1, Math.floor((wb.bbox.x1 - minX) / binW));
    for (let b = b0; b <= b1; b++) hist[b]++;
  }

  let peak = 0;
  for (let b = 0; b < BINS; b++) if (hist[b] > peak) peak = hist[b];
  if (peak < 5) return null; // each column needs at least a handful of lines to count

  // Search the middle 20%-80% for the bin with the least coverage (the deepest valley). The gutter is narrow, but it's empty for the entire column height,
  // so its coverage is near 0 — whereas gaps between words shift position line to line and don't stay empty when stacked. So we look for the "deepest" valley, not the "widest".
  const lo = Math.floor(BINS * 0.2);
  const hi = Math.ceil(BINS * 0.8);
  let valleyBin = lo;
  for (let b = lo; b < hi; b++) if (hist[b] < hist[valleyBin]) valleyBin = b;

  // The valley must be deep enough: any x inside a real text column is covered by most lines — only a genuine gutter comes close to empty
  const deepThresh = peak * 0.2;
  if (hist[valleyBin] > deepThresh) return null;

  // Expand the valley into a contiguous low-density band and use its center as the column divider
  let a = valleyBin;
  while (a > 0 && hist[a - 1] <= deepThresh) a--;
  let c = valleyBin;
  while (c < BINS - 1 && hist[c + 1] <= deepThresh) c++;

  // Both sides need a high-density text column for this to be a genuine two-column layout (otherwise it might just be blank space on one side)
  let leftHigh = false;
  let rightHigh = false;
  for (let b = 0; b < a; b++) if (hist[b] >= peak * 0.5) { leftHigh = true; break; }
  for (let b = c + 1; b < BINS; b++) if (hist[b] >= peak * 0.5) { rightHigh = true; break; }
  if (!leftHigh || !rightHigh) return null;

  return minX + ((a + c + 1) / 2) * binW;
}

// Handle hyphenated words broken across lines: por- (end of line) + trayed (start of next line) -> portrayed
// Doesn't rely on array adjacency (that would wrongly join the end of the right column to the start of the left column's next line in a two-column layout); instead it finds the second half geometrically:
//   same column + the immediately following line + the leftmost (first) word on that line.
// Both halves get tagged with the merged full word (joinedWord), so clicking either half looks up the whole word.
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
      if (columnOf(w) !== curCol) continue; // must be the same column
      const dy = w.bbox.y0 - cur.bbox.y0;
      if (dy <= lineH * 0.5) continue; // same line or above, skip
      if (w.bbox.y0 - cur.bbox.y1 > lineH * 1.5) continue; // too far away, not the immediately following line
      if (!/^[A-Za-z]/.test(w.text)) continue; // the second half should start with a letter
      if (!best || w.bbox.x0 < best.bbox.x0) best = w; // pick the leftmost (start of line)
    }

    if (best) {
      const joined = cur.text.slice(0, -1) + best.text;
      cur.joinedWord = joined;
      best.joinedWord = joined;
    }
  }
}

// Placeholder lemmatization: currently just lowercases the word. Real lemmatization (wink-lemmatizer / compromise)
// should replace this once the dictionary lookup feature is wired up; the function signature doesn't need to change, so callers are unaffected.
function simpleLemmaPlaceholder(text) {
  return text.toLowerCase().replace(/[^a-z']/g, "");
}

// ---------- Drag / click hit-testing ----------
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
      return; // this page hasn't finished recognizing yet, so don't respond
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

// Drag across multiple word-boxes -> concatenate text -> full-sentence translation (reuses the existing DeepL logic in background.js)
function handleDragSelect(state, rect) {
  const hit = state.wordBoxes
    .filter((wb) => boxIntersects(wb.bbox, rect))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  if (hit.length === 0) return;

  // When concatenating text, hyphenated line-break words are joined directly (drop the "-", no added space)
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

// Click a single word-box -> dictionary lookup (hyphenated line-breaks use the merged full word)
function handleWordClick(state, point) {
  const hit = state.wordBoxes.find((wb) => boxContainsPoint(wb.bbox, point));
  if (!hit) return;
  const word = hit.joinedWord || hit.text;
  showDictionaryPopup({ text: word }, point.x, point.y + 8, state.overlayEl);
}

// ---------- Popup (drag -> full-sentence translation) ----------
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

// ---------- Popup (click a word -> dictionary lookup) ----------
// Uses the shared background LOOKUP_WORD handler + the shared window.HTDict renderer,
// keeping it consistent with the dictionary popup on regular web pages (content.js).
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
  // Changing language inside the popup: save it as the new default + re-run the current lookup/translation in the new language (each popup remembers its own re-run closure)
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
