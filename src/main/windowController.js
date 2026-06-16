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

let incognitoCounter = 0;

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
  constructor(services, { incognito = false, restore = null } = {}) {
    this.services = services;
    this.incognito = incognito;
    this.tabs = [];
    this.activeTabId = null;
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

    this.services.adblock.enableForSession(this.session);
    this._createWindow();
  }

  _createWindow() {
    this.win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 760,
      minHeight: 500,
      frame: false,
      backgroundColor: this.incognito ? '#1a0b2e' : '#1b0b2a',
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
    this.win.on('maximize', () => this._send('window:state', { maximized: true }));
    this.win.on('unmaximize', () => this._send('window:state', { maximized: false }));

    this.win.webContents.once('did-finish-load', () => {
      this._send('init', {
        incognito: this.incognito,
        theme: this.services.settings.get('theme', 'dark'),
        adblockEnabled: this.services.adblock.enabled,
        searchEngines: this.services.searchEngines.list(),
        bookmarks: this.services.bookmarks.list()
      });
      this._send('window:state', { maximized: this.win.isMaximized() });
      if (this.tabs.length === 0) this._openInitialTabs();
    });
  }

  _openInitialTabs() {
    const r = this._restore;
    if (r && Array.isArray(r.tabs) && r.tabs.length) {
      for (const t of r.tabs) {
        this.newTab(t.url || '', {
          activate: false,
          lazy: true,
          title: t.title,
          favicon: t.favicon,
          startPage: !t.url
        });
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
        sandbox: true,
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
      pendingUrl: !isStart && lazy ? url : null
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

    wc.on('page-title-updated', (_e, title) => { tab.title = title; this._emitTabs(); });
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons && favicons[0] ? favicons[0] : null;
      this._emitTabs();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.services.adblock.resetTab(wc.id);
      this._emitTabs();
    });
    wc.on('did-stop-loading', () => { tab.loading = false; this._updateNav(tab); this._emitTabs(); });

    const onNavigate = () => {
      tab.url = wc.getURL();
      tab.isStartPage = false;
      this._updateNav(tab);
      this._emitTabs();
    };
    wc.on('did-navigate', onNavigate);
    wc.on('did-navigate-in-page', onNavigate);

    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      if (url && url !== 'about:blank') this.history.add(url, wc.getTitle());
    });

    wc.setWindowOpenHandler(({ url }) => {
      this.newTab(url, { activate: true });
      return { action: 'deny' };
    });

    wc.on('will-navigate', (e, url) => {
      if (/^(mailto|tel):/i.test(url)) { e.preventDefault(); shell.openExternal(url); }
    });
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
      bookmarked: t.url ? this.services.bookmarks.has(t.url) : false
    }));
  }

  /** Snapshot of open tabs for session restore (normal windows only). */
  serializeSession() {
    return {
      tabs: this.tabs.map((t) => ({
        url: t.pendingUrl || t.url || '',
        title: t.title,
        favicon: t.favicon
      })),
      activeIndex: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeTabId))
    };
  }

  _emitTabs() {
    this._send('tabs:update', { tabs: this.serializeTabs(), activeTabId: this.activeTabId });
    if (!this.incognito && this.services.onSessionChanged) this.services.onSessionChanged();
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
