# Bubl 🫧

A modern, privacy-respecting **portable web browser** for Windows 10/11, built on
Electron. Inspired by Firefox's privacy philosophy, wrapped in an ultra-modern
**Pop-candy liquid-glass** interface with vertical, Arc-style tabs — and a duck
in sunglasses for a mascot. 🦆🕶️

![Bubl](assets/icon.png)

## Highlights

- **Vertical tabs (Arc-style)** in a floating left sidebar — create, close,
  drag-to-reorder, favicons, live loading spinners, active-tab glow.
- **Floating command/search bar (Zen-style)** — `Ctrl+T` (or the *New Tab*
  button) opens a floating search bar instead of an empty tab; it only creates a
  tab once you submit. Click the active tab or press `Ctrl+L` to edit the
  current address in the same bar. History + live remote autocomplete; non-URL
  input runs a search with your default engine.
- **Session restore** — tabs are remembered and restored on relaunch (lazily
  loaded for speed). Profile data lives in a portable `BublData/` folder next to
  the executable, so you can close and reopen with your tabs, history and
  bookmarks intact.
- **Configurable search engines** — add / remove / set default.
  **DuckDuckGo is the default**; Google, Bing, Brave Search and Startpage are
  preconfigured.
- **Clearable history** — searchable page with per-entry delete and *Clear all*.
  Never recorded in incognito.
- **Incognito windows** with a fully isolated, in-memory session and a clear
  visual badge.
- **Powerful ad blocker** — network-level interception via
  `session.webRequest.onBeforeRequest`, powered by Ghostery's engine with the
  EasyList + EasyPrivacy (+ uBlock/Peter Lowe) prebuilt lists. Per-tab blocked
  counter, global toggle, and per-site toggle.
- **Navigation**: back / forward / reload / home + loading indicator.
- **Bookmarks**: one-tap star, quick-access panel, start-page shortcuts.
- **Keyboard shortcuts**: `Ctrl+T`, `Ctrl+W`, `Ctrl+L`, `Ctrl+Shift+N`,
  `Ctrl+R`, `Ctrl+H`.
- **Pop-candy liquid-glass design**: ultra-saturated candy gradients, real
  glass bubble buttons (translucent, blurred, with hover glow), a slim toolbar
  with just the controls, floating panels, frameless window with custom candy
  controls, a duck-in-sunglasses logo, and a **dark / light theme toggle**.
  Tuned for performance (no expensive animated blur, throttled layout, in-place
  tab updates).

## Architecture

```
src/
  main/                 Electron main process
    main.js             App lifecycle, IPC, menu/shortcuts, suggestions
    windowController.js  One window + its tabs (one WebContentsView per tab)
    adblock.js          Ghostery engine + onBeforeRequest interception
    history.js          History store (ephemeral in incognito)
    bookmarks.js        Bookmarks store
    searchEngines.js    Engine list + default (DuckDuckGo)
    settings.js         (via store.js)
    store.js            Tiny JSON persistence in userData
    registry.js         webContents -> tab lookup (for adblock routing)
    util.js             URL-vs-search resolution
  preload/
    preload.js          contextBridge API (window.bubl) for the chrome UI
    tabPreload.js       Intentionally minimal preload for web content
  renderer/             Chrome UI (the only HTML Bubl ships)
    index.html  styles.css  app.js
```

Each tab is a separate **`WebContentsView`** layered over the chrome UI inside
the rectangle the renderer reports — no nested `<webview>` tags. Normal windows
share a persistent `persist:bubl` session; each incognito window gets a fresh
in-memory partition that is wiped on close.

## Develop & run

```bash
winget install --id OpenJS.NodeJS.LTS -e   # Node.js LTS (Windows)
npm install
npm start                                   # launch Bubl
```

## Build the portable Windows app

```bash
npm run build        # electron-builder: portable .exe + unpacked dir
# Output in ./dist  ->  Bubl-Portable-<version>.exe  (single-file, no install)
```

The `portable` target produces a self-contained executable that unpacks to a
`Bubl` folder at runtime — no installation, no external dependencies beyond the
embedded runtime. (WebView2 is already present on Windows 10/11.)

## Privacy notes

- DuckDuckGo by default; no telemetry.
- Ad/tracker blocking on by default.
- Incognito sessions persist nothing to disk — no cookies, cache, or history.

## License

MIT
