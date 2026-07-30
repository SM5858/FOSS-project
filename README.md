# Highlight & Translate

A Chrome extension: select text to instantly get a floating translation popup. Also supports word-level selection on scanned PDFs via OCR.

## Project Structure

```
highlight-translate-extension/
├── manifest.json        # Manifest V3 config
├── content.js            # Regular web pages: selection listener + floating popup rendering
├── content.css           # Popup styling (also reused by viewer.html)
├── background.js         # Service worker: calls DeepL translation API + intercepts PDF navigation, redirects to viewer.html
├── viewer.html/.js/.css  # Custom PDF viewer page: pdf.js rendering + Tesseract OCR + word-box drag/click hit-testing
├── popup.html / .js      # Toolbar popup: enable/disable extension, switch target language
├── options.html / .js    # Settings page: enter API Key, choose Free/Pro
├── lib/pdfjs/             # Locally bundled pdf.js (MV3 disallows loading remote executable code)
├── lib/tesseract/         # Locally bundled Tesseract.js runtime + wasm core
└── icons/                 # Extension icons (placeholder, can be replaced)
```

## PDF Handling Architecture (important)

We no longer try to inject into Chrome's built-in PDF viewer's special origin (that was a fragile, undocumented trick that behaves inconsistently across Chrome versions). Instead we use a more standard approach:

```
User opens a .pdf link
        ↓
background.js detects it via webNavigation, redirects to viewer.html?file=<original PDF URL>
        ↓
viewer.js uses local pdf.js to render each page to a canvas (native pixel size, no CSS scaling)
        ↓
When a page scrolls into view, local Tesseract.js runs OCR on that same canvas (lazy-loaded, to avoid blocking everything at once)
        ↓
Produces a word-box array: { text, bbox:{x0,y0,x1,y1}, pageIndex, lemma }
        ↓
A transparent overlay handles hit-testing:
  - Drag across multiple word-boxes → concatenate text → call DeepL for full-sentence translation (reuses the logic in background.js)
  - Click a single word-box → dictionary lookup placeholder (to be wired up once target language & dictionary data source are decided)
```

**This architecture handles scanned and regular PDFs the same way** — no branching logic, everything goes through "render to canvas + OCR." The upside: the coordinate system is naturally unified and there's only one code path. The tradeoff: a regular PDF's existing text layer isn't used directly, so OCR is a bit slower than reading the text layer — but that's a reasonable tradeoff for a course project.

## Local Installation

1. Open Chrome, go to `chrome://extensions`
2. Turn on "Developer mode" (top right)
3. Click "Load unpacked" and select this folder
4. Click the extension icon in the toolbar → "API Key Settings" → enter your DeepL API Key and save
   - Get a free key at https://www.deepl.com/pro-api (free tier: ~500,000 characters/month)
   - Free-tier keys usually end in `:fx` — remember to select "Free" on the settings page

## Currently Implemented

- ✅ Select text on regular web pages → floating popup appears automatically → calls DeepL for translation
- ✅ PDFs (scanned or regular, no distinction): PDF load is intercepted automatically → rendered in the custom viewer → OCR runs lazily per page → produces word-box array
- ✅ Drag across word-boxes in a PDF → concatenates text → DeepL full-sentence translation
- ✅ Click a single word-box in a PDF → dictionary lookup popup (currently placeholder text, pending a real dictionary data source)
- ✅ Target language and API Key are saved persistently (`chrome.storage.sync`)

## Known Limitations / Things to Verify Next

1. **PDF interception relies on the URL ending in `.pdf`** — this misses cases where a server returns a PDF without a `.pdf` extension in the URL (e.g. some online document systems). If broader coverage is needed, `declarativeNetRequest` matching by resource type is an option, but it's more complex to configure — we're starting with this simpler version to get the main flow working.
2. **Cross-origin PDF downloads**: `viewer.js` uses `fetch(fileUrl)` to download PDF bytes. In theory the `<all_urls>` host_permissions should bypass CORS restrictions, but this hasn't been tested against every possible site — worth testing with several real-world PDF links.
3. **Dictionary lookup is currently just placeholder text.** `simpleLemmaPlaceholder()` only lowercases the word right now — it's not real lemmatization. Once the target language and dictionary data source are decided, just replace `simpleLemmaPlaceholder()` and the placeholder text inside `showDictionaryPopup()` in `viewer.js` — no other interaction logic (drag, hit-testing, popup positioning) needs to change.
4. **Tesseract language data**: `getTesseractWorker()` currently doesn't specify a `langPath`, so the language pack downloads on demand from Tesseract.js's default CDN — the first OCR run may have a few seconds of delay. For fully offline operation, download `eng.traineddata.gz` ahead of time, place it in `lib/tesseract/lang-data/`, and point to it locally in the code.
5. **The DeepL API Key is stored in plaintext in `chrome.storage.sync`** — fine for development/coursework, not production-ready.

## Suggested Next Steps

- Wire up a real dictionary data source (WordNet as placeholder → bilingual dictionary), replacing `showDictionaryPopup()`
- Wire up a real lemmatization library (`wink-lemmatizer` / `compromise`), replacing `simpleLemmaPlaceholder()`
- Add a "copy translation" button to the popup
- Support camera photo input (`<input type="file" accept="image/*" capture>`), skipping pdf.js and feeding straight into Tesseract
