# 划词悬浮翻译 (Highlight & Translate)

Chrome 浏览器插件：选中文本即弹出悬浮翻译窗，支持扫描版PDF区域取词翻译（OCR部分待接入）。

## 目录结构

```
highlight-translate-extension/
├── manifest.json        # Manifest V3 配置
├── content.js            # 普通网页：划词监听 + 悬浮窗渲染
├── content.css           # 悬浮窗样式（viewer.html 也复用这份）
├── background.js         # Service Worker：调用DeepL翻译API + 拦截PDF导航跳转到viewer.html
├── viewer.html/.js/.css  # 自建PDF查看页：pdf.js渲染 + Tesseract OCR + word-box拖拽/点击命中检测
├── popup.html / .js      # 工具栏弹出：开关插件、切换目标语言
├── options.html / .js    # 设置页：填写API Key、选择Free/Pro
├── lib/pdfjs/             # 本地打包的 pdf.js（MV3不允许远程加载可执行代码）
├── lib/tesseract/         # 本地打包的 Tesseract.js 运行时 + wasm核心
└── icons/                 # 插件图标（占位图，可替换）
```

## PDF 处理架构（重要）

不再尝试注入Chrome内置PDF阅读器的特殊origin（那是偏门技巧，不同Chrome版本表现不稳定）。改用更常规的做法：

```
用户打开一个 .pdf 链接
        ↓
background.js 用 webNavigation 监听到，重定向到 viewer.html?file=<原始PDF地址>
        ↓
viewer.js 用本地pdf.js把每一页渲染到 canvas（原生像素尺寸，不做CSS缩放）
        ↓
页面滚动到视口时，用本地Tesseract.js对同一个canvas做OCR（懒加载，避免一次性卡死）
        ↓
得到 word-box 数组：{ text, bbox:{x0,y0,x1,y1}, pageIndex, lemma }
        ↓
透明覆盖层做命中检测：
  - 拖拽跨多个word-box → 拼接文本 → 调用DeepL整句翻译（复用background.js里的逻辑）
  - 单击一个word-box → 词典查询占位（等目标语言和词典数据源确定后接入）
```

**这个架构统一处理扫描版和普通版PDF**——不区分两者，一律走"渲染成canvas + OCR"，好处是坐标系天然统一、代码只有一条路径；代价是普通PDF本来的文字层没被直接利用，OCR会比直接读文字层慢一些，但对课程项目而言这是合理的取舍。

## 本地安装步骤

1. 打开 Chrome，访问 `chrome://extensions`
2. 打开右上角"开发者模式"
3. 点击"加载已解压的扩展程序"，选择本文件夹
4. 点击浏览器工具栏的插件图标 → "API Key 设置" → 填入 DeepL API Key 并保存
   - 免费Key在 https://www.deepl.com/pro-api 注册获取，免费额度每月约50万字符
   - 免费版Key结尾通常带 `:fx`，记得在设置页选择 "Free"

## 当前已实现

- ✅ 普通网页划词 → 自动弹出悬浮窗 → 调用 DeepL 翻译
- ✅ PDF（不区分是否扫描版）：自动拦截PDF加载 → 自建viewer渲染 → 滚动到某页时懒加载OCR → word-box数组
- ✅ PDF中拖拽跨word-box选中 → 拼接文本 → DeepL整句翻译
- ✅ PDF中单击word-box → 词典查询悬浮窗（内容目前是占位文本，等真正的词典数据源接入）
- ✅ 目标语言、API Key 的设置与持久化（`chrome.storage.sync`）

## 已知限制 / 需要你们接下来验证的点

1. **PDF拦截依赖URL以 `.pdf` 结尾判断**，覆盖不了"服务器返回PDF但链接没有.pdf后缀"的情况（比如某些在线文档系统），如果需要覆盖更多场景，可以改用 `declarativeNetRequest` 按资源类型匹配，但配置更复杂，目前先用这个简单版本跑通主流程。
2. **跨域PDF下载**：viewer.js 里用 `fetch(fileUrl)` 下载PDF字节，如果目标网站的PDF有严格的CORS限制，理论上因为插件有 `<all_urls>` host_permissions应该能绕过，但没有覆盖所有奇怪站点的情况，建议多找几个真实网站的PDF链接测试。
3. **词典查询目前只是占位文本**，`simpleLemmaPlaceholder()` 目前只是转小写，不是真正的词形还原，队友确定目标语言和词典数据源后，直接替换 `viewer.js` 里的 `simpleLemmaPlaceholder()` 和 `showDictionaryPopup()` 里的占位文本即可，其余交互逻辑（拖拽、命中检测、悬浮窗定位）不需要改。
4. **Tesseract语言包**：目前 `getTesseractWorker()` 里没有指定 `langPath`，语言包会按需从Tesseract.js默认CDN下载，首次OCR可能有几秒延迟。如果要完全离线运行，可以把 `eng.traineddata.gz` 下载后放进 `lib/tesseract/lang-data/` 并在代码里指定本地路径。
5. **DeepL API Key 明文存在 `chrome.storage.sync`**，仅适合开发/课程项目阶段。

## 下一步建议

- 接入真正的词典数据源（WordNet占位 → 双语词典），替换 `showDictionaryPopup()`
- 接入真正的lemmatization库（`wink-lemmatizer` / `compromise`），替换 `simpleLemmaPlaceholder()`
- 悬浮窗增加"复制译文"按钮
- 支持相机拍照输入（`<input type="file" accept="image/*" capture>`），跳过pdf.js直接进Tesseract
