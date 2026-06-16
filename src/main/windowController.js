'use strict';

const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, WebContentsView, session, shell } = require('electron');
const registry = require('./registry');
const { resolveInput, hostnameOf } = require('./util');
const { History } = require('./history');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

let incognitoCounter = 0;

/**
 * Owns a single top-level browser window and all of its tabs.
 *
 * The window's own web contents render the chrome UI (sidebar, address bar,
 * overlays). Each tab is a separate WebContentsView layered on top of the
 * chrome inside the content rectangle the renderer reports. This is the
 * BrowserView-style architecture the spec calls for — no nested <webview>.
 */
class WindowController {
  /**
   * @param {object} services  Shared singletons (searchEngines, bookmarks,
   *   adblock, settings, sharedHistory) and an `onClosed` callback.
   */
  constructor(services, { incognito = false } = {}) {
    this.services = services;
    this.incognito = incognito;
    this.tabs = [];
    this.activeTabId = null;
    this.contentBounds = { x: 0, y: 0, width: 0, height: 0 };
    this.contentVisible = true;
    this.destroyed = false;

    // Session: normal windows share a persistent partition; each incognito
    // window gets a fresh in-memory partition (no "persist:" prefix).
    if (incognito) {
      this.partition = `bubl-incognito-${++incognitoCounter}`;
      this.session = session.fromPartition(this.partition);
      this.history = new History({ persistent: false });
    } else {
      this.partition = 'persist:bubl';
      this.session = session.fromPartition(this.partition);
      this.history = services.sharedHistory;
    }

    // Attach the ad blocker to this session's request pipeline.
    this.services.adblock.enableForSession(this.session);

    this._createWindow();
  }

  _createWindow() {
    this.win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      frame: false,
      transparent: false,
      backgroundColor: this.incognito ? '#1a1030' : '#0d0d18',
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
    this.win.on('enter-full-screen', () => this._send('window:state', { fullscreen: true }));
    this.win.on('leave-full-screen', () => this._send('window:state', { fullscreen: false }));

    // Once the chrome UI is loaded, send it the initial config and open a tab.
    this.win.webContents.once('did-finish-load', () => {
      this._send('init', {
        incognito: this.incognito,
        theme: this.services.settings.get('theme', 'dark'),
        adblockEnabled: this.services.adblock.enabled,
        searchEngines: this.services.searchEngines.list(),
        bookmarks: this.services.bookmarks.list()
      });
      this._send('window:state', { maximized: this.win.isMaximized() });
      if (this.tabs.length === 0) this.newTab('');
    });
  }

  // ---- Tab management ----------------------------------------------------

  newTab(url = '', { activate = true } = {}) {
    if (this.destroyed) return null;
    const id = crypto.randomUUID();

    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'preload', 'tabPreload.js')
      }
    });
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(18);

    const tab = {
      id,
      view,
      title: 'New Tab',
      url: '',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isStartPage: true
    };
    this.tabs.push(tab);
    registry.register(view.webContents.id, this, tab);
    this._wireTab(tab);

    this.win.contentView.addChildView(view);
    view.setVisible(false);

    if (activate) this.activateTab(id);
    this._emitTabs();

    if (url) {
      this.navigate(id, url);
    }
    return tab;
  }

  _wireTab(tab) {
    const wc = tab.view.webContents;

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this._emitTabs();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons && favicons[0] ? favicons[0] : null;
      this._emitTabs();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.services.adblock.resetTab(wc.id);
      this._emitTabs();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this._updateNav(tab);
      this._emitTabs();
    });
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
      if (url && url !== 'about:blank') {
        this.history.add(url, wc.getTitle());
      }
    });

    // Open target=_blank / window.open in a new Bubl tab instead of a popup.
    wc.setWindowOpenHandler(({ url }) => {
      this.newTab(url, { activate: true });
      return { action: 'deny' };
    });

    // Keep external protocols (mailto:, etc.) out of the web view.
    wc.on('will-navigate', (e, url) => {
      if (/^(mailto|tel):/i.test(url)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
  }

  _updateNav(tab) {
    const wc = tab.view.webContents;
    tab.canGoBack = wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack();
    tab.canGoForward = wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward();
  }

  activateTab(id) {
    const tab = this._tab(id);
    if (!tab) return;
    this.activeTabId = id;
    for (const t of this.tabs) {
      t.view.setVisible(t.id === id && this.contentVisible && !t.isStartPage);
    }
    this._layoutActiveView();
    this._emitTabs();
    // Refresh the blocked counter for the newly active tab.
    this._send('adblock:count', {
      tabId: id,
      count: this.services.adblock.getCount(tab.view.webContents.id)
    });
  }

  closeTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];

    registry.unregister(tab.view.webContents.id);
    this.services.adblock.forgetTab(tab.view.webContents.id);
    try {
      this.win.contentView.removeChildView(tab.view);
    } catch {}
    try {
      tab.view.webContents.close();
    } catch {}

    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      // Last tab closed: open a fresh start tab rather than an empty window.
      this.newTab('');
      return;
    }
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
    for (const id of orderedIds) {
      if (map.has(id)) {
        next.push(map.get(id));
        map.delete(id);
      }
    }
    // Append any tabs not present in the supplied order (safety).
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
    if (this.activeTabId === id) {
      tab.view.setVisible(this.contentVisible);
      this._layoutActiveView();
    }
    tab.view.webContents.loadURL(target);
  }

  goBack(id) {
    const wc = this._wc(id);
    if (!wc) return;
    if (wc.navigationHistory) wc.navigationHistory.goBack();
    else wc.goBack();
  }

  goForward(id) {
    const wc = this._wc(id);
    if (!wc) return;
    if (wc.navigationHistory) wc.navigationHistory.goForward();
    else wc.goForward();
  }

  reload(id) {
    const wc = this._wc(id);
    if (wc) wc.reload();
  }

  stop(id) {
    const wc = this._wc(id);
    if (wc) wc.stop();
  }

  /** "Home" returns the tab to the start page (renderer overlay). */
  goHome(id) {
    const tab = this._tab(id);
    if (!tab) return;
    tab.isStartPage = true;
    tab.url = '';
    tab.title = 'New Tab';
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
    if (!tab) return;
    tab.view.setBounds(this.contentBounds);
  }

  // ---- Window controls ---------------------------------------------------

  minimize() { this.win.minimize(); }
  toggleMaximize() {
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
  }
  close() { this.win.close(); }

  // ---- Helpers -----------------------------------------------------------

  _tab(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }
  _wc(id) {
    const t = this._tab(id);
    return t ? t.view.webContents : null;
  }

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

  _emitTabs() {
    this._send('tabs:update', { tabs: this.serializeTabs(), activeTabId: this.activeTabId });
  }

  _send(channel, payload) {
    if (this.destroyed || !this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  /** Routed from the adblocker when a tab's blocked counter changes. */
  notifyBlocked(webContentsId, count) {
    const tab = this.tabs.find((t) => t.view.webContents.id === webContentsId);
    if (tab) this._send('adblock:count', { tabId: tab.id, count });
  }

  /** Resolve a tab's current top-frame hostname for per-site whitelisting. */
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
    if (this.incognito) {
      // Discard the ephemeral session so nothing lingers.
      this.session.clearStorageData().catch(() => {});
    }
    if (this.services.onClosed) this.services.onClosed(this);
  }
}

module.exports = { WindowController };
