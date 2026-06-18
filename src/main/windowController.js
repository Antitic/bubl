'use strict';

const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, WebContentsView, session, shell } = require('electron');
const registry = require('./registry');
const { resolveInput, hostnameOf } = require('./util');
const { History } = require('./history');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const TAB_PRELOAD = path.join(__dirname, '..', 'preload', 'tabPreload.js');

const THEMES = new Set(['pop', 'midnight']);
function normalizeTheme(theme) { return THEMES.has(theme) ? theme : 'pop'; }

// Injected via Page.addScriptToEvaluateOnNewDocument BEFORE any YouTube script
// runs. Intercepts ytInitialPlayerResponse (inline data) and fetch calls to the
// player API, stripping adPlacements / adSlots / playerAds from both so the
// player never receives ad configuration and plays video without ads.
const YOUTUBE_PREFETCH_SCRIPT = `(function(){
  if(!location.hostname.endsWith('youtube.com'))return;
  var AD=['adPlacements','adSlots','playerAds','adBreaks','adMessages','auxiliaryUi'];
  function prune(o){
    if(!o||typeof o!=='object')return;
    AD.forEach(function(k){delete o[k];});
    try{if(o.playerConfig&&o.playerConfig.adConfig)o.playerConfig.adConfig={};}catch(e){}
  }
  // Catch ytInitialPlayerResponse = {...} written by the inline <script> tag
  var _v;
  Object.defineProperty(window,'ytInitialPlayerResponse',{
    get:function(){return _v;},
    set:function(v){prune(v);_v=v;},
    configurable:true,enumerable:true
  });
  // Strip ads from /youtubei/v1/player API responses (SPA navigations)
  var _f=window.fetch;
  window.fetch=function(input,init){
    var url=(typeof input==='string'?input:(input&&input.url))||'';
    var p=_f.apply(this,arguments);
    if(!url.includes('/youtubei/v1/player'))return p;
    return p.then(function(r){
      return r.clone().json().then(function(d){
        prune(d);
        return new Response(JSON.stringify(d),{status:r.status,statusText:r.statusText,headers:r.headers});
      }).catch(function(){return r;});
    });
  };
})();`;

let incognitoCounter = 0;

const READER_ON_JS = `(function(){
  if (document.getElementById('__bubl_reader')) return;
  var src = document.querySelector('article') || document.querySelector('main') || document.body;
  var html = src.innerHTML;
  var overlay = document.createElement('div');
  overlay.id = '__bubl_reader';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#f6f1e7;color:#26211b;padding:48px 0;';
  var inner = document.createElement('div');
  inner.style.cssText = 'max-width:680px;margin:0 auto;font-family:Georgia,"Times New Roman",serif;font-size:19px;line-height:1.7;padding:0 24px;';
  inner.innerHTML = html;
  inner.querySelectorAll('script,style,nav,header,footer,iframe,button,form').forEach(function(el){ el.remove(); });
  overlay.appendChild(inner);
  document.documentElement.appendChild(overlay);
  document.body.style.overflow = 'hidden';
})();`;

const READER_OFF_JS = `(function(){
  var el = document.getElementById('__bubl_reader');
  if (el) el.remove();
  document.body.style.overflow = '';
})();`;

/**
 * Owns a single top-level browser window and all of its tabs.
 *
 * The window's own web contents render the chrome UI (sidebar, slim toolbar,
 * floating command bar). Each tab is a separate WebContentsView layered over
 * the chrome inside the content rectangle the renderer reports — the
 * BrowserView-style architecture the spec calls for (no nested <webview>).
 *
 * Restored tabs are created lazily: only the active tab loads its URL up
 * front; the rest load on first activation. This keeps reopening a session
 * with many tabs fast.
 */
class WindowController {
  constructor(services, { incognito = false, appMode = false, restore = null } = {}) {
    this.services = services;
    this.incognito = incognito;
    this.appMode = appMode;
    this.tabs = [];
    this.activeTabId = null;
    this.activeSpaceId = 'default';
    /** Remembers the last active tab id per space, to restore on switch. */
    this.lastTabBySpace = {};
    this.contentBounds = { x: 0, y: 0, width: 0, height: 0 };
    this.contentVisible = true;
    this.destroyed = false;
    this._restore = restore;

    if (incognito) {
      this.partition = `bubl-incognito-${++incognitoCounter}`;
      this.session = session.fromPartition(this.partition);
      this.history = new History({ persistent: false });
    } else {
      this.partition = 'persist:bubl';
      this.session = session.fromPartition(this.partition);
      this.history = services.sharedHistory;
    }

    this.services.adblock.enableForSession(this.session, incognito);
    this._createWindow();
  }

  _createWindow() {
    this.win = new BrowserWindow({
      width: this.appMode ? 480 : 1320,
      height: this.appMode ? 760 : 860,
      minWidth: this.appMode ? 360 : 760,
      minHeight: this.appMode ? 420 : 500,
      frame: false,
      // Transparent so the very-rounded window corners read through; the inner
      // surfaces are opaque, so this stays cheap to composite.
      transparent: true,
      backgroundColor: '#00000000',
      roundedCorners: true,
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    this.win.loadFile(path.join(RENDERER_DIR, 'index.html'));

    this.win.on('closed', () => this._onClosed());
    this.win.on('resize', () => this._layoutActiveView());
    this.win.on('maximize', () => this._sendEdge());
    this.win.on('unmaximize', () => this._sendEdge());
    this.win.on('enter-full-screen', () => this._sendEdge());
    this.win.on('leave-full-screen', () => this._sendEdge());

    this.win.webContents.once('did-finish-load', () => {
      this._send('init', {
        incognito: this.incognito,
        appMode: this.appMode,
        theme: normalizeTheme(this.services.settings.get('theme', 'pop')),
        adblockEnabled: this.services.adblock.enabled,
        searchEngines: this.services.searchEngines.list(),
        bookmarks: this.services.bookmarks.list(),
        radiusFactor: this.services.settings.get('radiusFactor', 1),
        sidebarPinned: this.services.settings.get('sidebarPinned', false)
      });
      this._sendEdge();
      if (this.tabs.length === 0) this._openInitialTabs();
    });
  }

  /** Tell the renderer whether to square off the window corners (edge-to-edge). */
  _sendEdge() {
    const edge = this.win.isMaximized() || this.win.isFullScreen();
    this._send('window:state', { maximized: this.win.isMaximized(), edge });
  }

  /**
   * Move OS-level keyboard focus from the active tab's WebContentsView back to
   * the chrome window. Without this the command bar opens but typing goes to
   * the (now hidden) page, so the user has to click the bar first.
   */
  focusChrome() {
    if (this.destroyed || !this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
    this.win.webContents.focus();
  }

  /**
   * Re-attach an app-mode (detached) window's tab back into the main browser
   * window as a new tab, then close this standalone window.
   */
  reattachToMain() {
    const tab = this._tab(this.activeTabId);
    const url = tab ? (tab.pendingUrl || tab.url) : '';
    // Find an existing non-app, non-incognito window to host the tab.
    let target = this.services.windows.find(
      (c) => c !== this && !c.appMode && !c.incognito && !c.destroyed
    );
    if (!target) {
      // No regular window open — promote a fresh one.
      target = this.services.openWindow({ incognito: false });
    }
    if (url) {
      // The target window may still be loading its chrome; defer the new tab
      // until its renderer is ready.
      if (target.win && target.win.webContents.isLoading()) {
        target.win.webContents.once('did-finish-load', () => target.newTab(url));
      } else {
        target.newTab(url);
      }
    }
    if (target.win) { target.win.show(); target.win.focus(); }
    this.close();
  }


  /** Pop a tab out into a standalone, sidebar-less "app" window. */
  detachTab(id) {
    const tab = this._tab(id);
    if (!tab || tab.isStartPage || !tab.url) return;
    this.services.openWindow({
      appMode: true,
      restore: { tabs: [{ url: tab.pendingUrl || tab.url, title: tab.title, favicon: tab.favicon }], activeIndex: 0 }
    });
    this.closeTab(id);
  }

  _openInitialTabs() {
    const r = this._restore;
    if (r && Array.isArray(r.tabs) && r.tabs.length) {
      for (const t of r.tabs) {
        const tab = this.newTab(t.url || '', {
          activate: false,
          lazy: true,
          title: t.title,
          favicon: t.favicon,
          startPage: !t.url
        });
        if (tab && t.essential) tab.essential = true;
        if (tab && t.spaceId) tab.spaceId = t.spaceId;
      }
      const idx = Math.min(Math.max(r.activeIndex || 0, 0), this.tabs.length - 1);
      this.activateTab(this.tabs[idx].id);
    } else {
      this.newTab('');
    }
    this._restore = null;
  }

  // ---- Tab management ----------------------------------------------------

  newTab(url = '', { activate = true, lazy = false, title = null, favicon = null, startPage = null } = {}) {
    if (this.destroyed) return null;
    const id = crypto.randomUUID();
    const isStart = startPage != null ? startPage : !url;

    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: TAB_PRELOAD,
        backgroundThrottling: true
      }
    });
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(16);
    view.setBackgroundColor('#ffffff');

    const tab = {
      id,
      view,
      title: isStart ? 'New Tab' : (title || url || 'New Tab'),
      url: isStart ? '' : url,
      favicon: favicon || null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isStartPage: isStart,
      pendingUrl: !isStart && lazy ? url : null,
      spaceId: this.activeSpaceId || 'default',
      essential: false,
      readerOn: false,
      domains: new Set()
    };
    this.tabs.push(tab);
    registry.register(view.webContents.id, this, tab);
    this._wireTab(tab);

    this.win.contentView.addChildView(view);
    view.setVisible(false);

    if (activate) this.activateTab(id);
    this._emitTabs();

    if (!isStart && !lazy && url) this.navigate(id, url);
    return tab;
  }

  _wireTab(tab) {
    const wc = tab.view.webContents;

    // Attach Chrome DevTools Protocol debugger to inject the YouTube ad
    // killer BEFORE any page script runs, on every new document.
    // executeJavaScript from main bypasses CSP but fires at DOMContentLoaded;
    // Page.addScriptToEvaluateOnNewDocument fires at document-start (earlier).
    try {
      wc.debugger.attach('1.3');
      wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: YOUTUBE_PREFETCH_SCRIPT
      }).catch(() => {});
    } catch {}

    wc.on('page-title-updated', (_e, title) => { tab.title = title; this._emitTabs(); });
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons && favicons[0] ? favicons[0] : null;
      this._emitTabs();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      tab.readerOn = false;
      tab.domains = new Set();
      this.services.adblock.resetTab(wc.id);
      this._emitTabs();
    });
    wc.on('did-stop-loading', () => { tab.loading = false; this._updateNav(tab); this._emitTabs(); });

    const onNavigate = () => {
      tab.url = wc.getURL();
      tab.isStartPage = false;
      this._updateNav(tab);
      this._emitTabs();
      // Re-inject YouTube ad killer on SPA navigations (video changes).
      if (/youtube\.com/i.test(tab.url)) this._injectYouTubeAdKiller(wc);
    };
    wc.on('did-navigate', onNavigate);
    wc.on('did-navigate-in-page', onNavigate);

    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      if (url && url !== 'about:blank') this.history.add(url, wc.getTitle());
      if (this.services.settings.get('smoothScroll', false)) this._applySmoothScroll(tab, true);
      if (/youtube\.com/i.test(url)) this._injectYouTubeAdKiller(wc);
    });

    wc.setWindowOpenHandler(({ url }) => {
      this.newTab(url, { activate: true });
      return { action: 'deny' };
    });

    wc.on('will-navigate', (e, url) => {
      if (/^(mailto|tel):/i.test(url)) { e.preventDefault(); shell.openExternal(url); }
    });

    // Back/forward via mouse side-buttons and OS gestures (Windows), and via
    // the two-finger trackpad swipe on macOS.
    wc.on('app-command', (_e, cmd) => {
      if (cmd === 'browser-backward') this.goBack(tab.id);
      else if (cmd === 'browser-forward') this.goForward(tab.id);
    });
    wc.on('swipe', (_e, direction) => {
      if (direction === 'left') this.goBack(tab.id);
      else if (direction === 'right') this.goForward(tab.id);
    });
  }

  _injectYouTubeAdKiller(wc) {
    // CSS: hide any ad UI that slips through (server-side ads, UI overlays).
    // ytd-enforcement-message-view-model is the "disable your ad blocker" wall.
    wc.insertCSS(`
      .ad-showing .ytp-ad-module,
      .ytp-ad-player-overlay,
      .ytp-ad-overlay-container,
      .ytp-ad-text-overlay,
      .ytp-ad-skip-button-container,
      #masthead-ad,
      ytd-banner-promo-renderer,
      ytd-statement-banner-renderer,
      ytd-display-ad-renderer,
      ytd-in-feed-ad-layout-renderer,
      ytd-promoted-sparkles-web-renderer,
      ytd-promoted-video-renderer,
      ytd-search-pyv-renderer,
      ytd-ad-slot-renderer,
      .ytd-merch-shelf-renderer,
      #player-ads,
      .ytp-ce-element,
      ytd-enforcement-message-view-model,
      .yt-mealbar-promo-renderer { display: none !important; }
    `).catch(() => {});

    // JS: runs via executeJavaScript which bypasses CSP (main-process privilege).
    // Handles any video ad that still reaches the player despite the fetch
    // interception (e.g. server-side stitched ads), auto-skips / fast-forwards,
    // and removes the "ad blocker not allowed" overlay if it appears.
    wc.executeJavaScript(`
      (function () {
        if (window.__bublYt) return;
        window.__bublYt = true;

        function tick() {
          // Click skip button the instant it appears.
          var skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button');
          if (skip) { skip.click(); return; }

          // Fast-forward any unskippable in-stream ad.
          var player = document.querySelector('#movie_player');
          var video  = document.querySelector('video.html5-main-video');
          if (player && video && player.classList.contains('ad-showing') && !video.paused) {
            video.muted = true;
            if (isFinite(video.duration)) video.currentTime = video.duration;
            else video.playbackRate = 16;
          }

          // Remove "ad blocker not allowed" enforcement overlay and resume.
          var msg = document.querySelector('ytd-enforcement-message-view-model');
          if (msg) {
            var wrap = msg.closest('.yt-playback-error-supported-renderers, ytd-player-error-message-renderer');
            if (wrap) wrap.remove(); else msg.remove();
            if (video && video.paused) video.play().catch(function () {});
          }
        }

        setInterval(tick, 250);
        var target = document.body || document.documentElement;
        new MutationObserver(tick).observe(target, { childList: true, subtree: true });
      })();
    `).catch(() => {});
  }

  _updateNav(tab) {
    const wc = tab.view.webContents;
    const nav = wc.navigationHistory;
    tab.canGoBack = nav ? nav.canGoBack() : wc.canGoBack();
    tab.canGoForward = nav ? nav.canGoForward() : wc.canGoForward();
  }

  activateTab(id) {
    const tab = this._tab(id);
    if (!tab) return;
    this.activeTabId = id;
    // Keep the active space in sync with the active tab and remember this tab
    // as the space's most-recent, so re-entering the space returns to it.
    this.activeSpaceId = tab.spaceId || 'default';
    this.lastTabBySpace[this.activeSpaceId] = id;

    // Lazy-load a restored tab the first time it is shown.
    if (tab.pendingUrl) {
      const target = tab.pendingUrl;
      tab.pendingUrl = null;
      tab.view.webContents.loadURL(target).catch(() => {});
    }

    for (const t of this.tabs) {
      t.view.setVisible(t.id === id && this.contentVisible && !t.isStartPage);
    }
    this._layoutActiveView();
    this._emitTabs();
    this._send('adblock:count', { tabId: id, count: this.services.adblock.getCount(tab.view.webContents.id) });
  }

  closeTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];

    registry.unregister(tab.view.webContents.id);
    this.services.adblock.forgetTab(tab.view.webContents.id);
    try { this.win.contentView.removeChildView(tab.view); } catch {}
    try { tab.view.webContents.close(); } catch {}

    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) { this.newTab(''); return; }
    if (this.activeTabId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activateTab(next.id);
    } else {
      this._emitTabs();
    }
  }

  reorderTabs(orderedIds) {
    const map = new Map(this.tabs.map((t) => [t.id, t]));
    const next = [];
    for (const id of orderedIds) if (map.has(id)) { next.push(map.get(id)); map.delete(id); }
    for (const t of map.values()) next.push(t);
    this.tabs = next;
    this._emitTabs();
  }

  // ---- Spaces --------------------------------------------------------------

  setActiveSpace(spaceId) {
    this.activeSpaceId = spaceId;

    // Return to the tab we were last on in this space, if it still exists and
    // still belongs here; otherwise fall back to the first tab, or a fresh one.
    let target = null;
    const remembered = this.lastTabBySpace[spaceId];
    if (remembered) {
      const t = this._tab(remembered);
      if (t && (t.spaceId || 'default') === spaceId) target = remembered;
    }
    if (!target) {
      const first = this.tabs.find((t) => (t.spaceId || 'default') === spaceId);
      if (first) target = first.id;
    }

    if (target) this.activateTab(target);
    else this.newTab('');
    this._emitTabs();
  }

  setTabSpace(id, spaceId) {
    const tab = this._tab(id);
    if (!tab) return;
    tab.spaceId = spaceId;
    this._emitTabs();
  }

  /** Toggle a tab's "essential" status (Zen-style pinned tile, shown across
      all spaces). Essential tabs can't be empty start pages. */
  toggleEssential(id) {
    const tab = this._tab(id);
    if (!tab || tab.isStartPage) return;
    tab.essential = !tab.essential;
    this._emitTabs();
  }

  /** Reassigns any tabs left in a removed space to the fallback space. */
  reassignSpace(oldId, newId) {
    for (const t of this.tabs) if (t.spaceId === oldId) t.spaceId = newId;
    if (this.activeSpaceId === oldId) this.activeSpaceId = newId;
    this._emitTabs();
  }

  // ---- Reading mode ----------------------------------------------------

  toggleReader(id) {
    const tab = this._tab(id);
    if (!tab) return;
    const wc = tab.view.webContents;
    tab.readerOn = !tab.readerOn;
    const js = tab.readerOn ? READER_ON_JS : READER_OFF_JS;
    wc.executeJavaScript(js).catch(() => {});
    this._emitTabs();
  }

  // ---- Network footprint -------------------------------------------------

  trackDomain(tabId, hostname) {
    const tab = this._tab(tabId);
    if (tab && hostname) tab.domains.add(hostname);
  }

  networkFootprint(id) {
    const tab = this._tab(id);
    return tab ? Array.from(tab.domains) : [];
  }

  // ---- Smooth scroll -------------------------------------------------------

  setSmoothScroll(enabled) {
    for (const t of this.tabs) this._applySmoothScroll(t, enabled);
  }

  async _applySmoothScroll(tab, enabled) {
    const wc = tab.view.webContents;
    try {
      if (enabled) {
        tab._smoothScrollKey = await wc.insertCSS('html { scroll-behavior: smooth; }');
      } else if (tab._smoothScrollKey) {
        await wc.removeInsertedCSS(tab._smoothScrollKey);
        tab._smoothScrollKey = null;
      }
    } catch {}
  }

  // ---- Navigation --------------------------------------------------------

  navigate(id, input) {
    const tab = this._tab(id);
    if (!tab) return;
    const target = resolveInput(input, this.services.searchEngines);
    if (!target) return;
    tab.isStartPage = false;
    tab.pendingUrl = null;
    if (this.activeTabId === id) { tab.view.setVisible(this.contentVisible); this._layoutActiveView(); }
    tab.view.webContents.loadURL(target).catch(() => {});
  }

  goBack(id) { const wc = this._wc(id); if (wc) (wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack()); }
  goForward(id) { const wc = this._wc(id); if (wc) (wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward()); }
  reload(id) { const wc = this._wc(id); if (wc) wc.reload(); }
  stop(id) { const wc = this._wc(id); if (wc) wc.stop(); }

  goHome(id) {
    const tab = this._tab(id);
    if (!tab) return;
    tab.isStartPage = true;
    tab.url = '';
    tab.title = 'New Tab';
    tab.pendingUrl = null;
    tab.view.setVisible(false);
    this._emitTabs();
  }

  // ---- Layout / visibility ----------------------------------------------

  setContentBounds(rect) {
    this.contentBounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
    this._layoutActiveView();
  }

  setContentVisible(visible) {
    this.contentVisible = !!visible;
    const tab = this._tab(this.activeTabId);
    if (tab) tab.view.setVisible(this.contentVisible && !tab.isStartPage);
  }

  _layoutActiveView() {
    const tab = this._tab(this.activeTabId);
    if (tab) tab.view.setBounds(this.contentBounds);
  }

  // ---- Window controls ---------------------------------------------------

  minimize() { this.win.minimize(); }
  toggleMaximize() { this.win.isMaximized() ? this.win.unmaximize() : this.win.maximize(); }
  close() { this.win.close(); }

  // ---- Helpers -----------------------------------------------------------

  _tab(id) { return this.tabs.find((t) => t.id === id) || null; }
  _wc(id) { const t = this._tab(id); return t ? t.view.webContents : null; }

  serializeTabs() {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.isStartPage ? 'New Tab' : t.title,
      url: t.url,
      favicon: t.favicon,
      loading: t.loading,
      canGoBack: t.canGoBack,
      canGoForward: t.canGoForward,
      isStartPage: t.isStartPage,
      active: t.id === this.activeTabId,
      bookmarked: t.url ? this.services.bookmarks.has(t.url) : false,
      spaceId: t.spaceId || 'default',
      essential: !!t.essential,
      readerOn: !!t.readerOn
    }));
  }

  /** Snapshot of open tabs for session restore (normal windows only). */
  serializeSession() {
    return {
      tabs: this.tabs.map((t) => ({
        url: t.pendingUrl || t.url || '',
        title: t.title,
        favicon: t.favicon,
        essential: !!t.essential,
        spaceId: t.spaceId || 'default'
      })),
      activeIndex: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeTabId))
    };
  }

  _emitTabs() {
    // Coalesce bursts (title + favicon + navigate often fire back-to-back, and
    // SPA sites fire did-navigate-in-page rapidly) into one IPC per frame.
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      if (this.destroyed) return;
      this._send('tabs:update', { tabs: this.serializeTabs(), activeTabId: this.activeTabId, activeSpaceId: this.activeSpaceId });
      if (!this.incognito && this.services.onSessionChanged) this.services.onSessionChanged();
    }, 12);
  }

  _send(channel, payload) {
    if (this.destroyed || !this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  notifyBlocked(webContentsId, count) {
    const tab = this.tabs.find((t) => t.view.webContents.id === webContentsId);
    if (tab) this._send('adblock:count', { tabId: tab.id, count });
  }

  hostnameForWebContents(webContentsId) {
    const tab = this.tabs.find((t) => t.view.webContents.id === webContentsId);
    return tab ? hostnameOf(tab.url) : '';
  }

  _onClosed() {
    this.destroyed = true;
    for (const t of this.tabs) {
      registry.unregister(t.view.webContents.id);
      this.services.adblock.forgetTab(t.view.webContents.id);
    }
    this.tabs = [];
    if (this.incognito) this.session.clearStorageData().catch(() => {});
    if (this.services.onClosed) this.services.onClosed(this);
  }
}

module.exports = { WindowController };
