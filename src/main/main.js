'use strict';

const path = require('path');
const { app, ipcMain, Menu, BrowserWindow, net } = require('electron');

const { WindowController } = require('./windowController');
const { SearchEngines } = require('./searchEngines');
const { Bookmarks } = require('./bookmarks');
const { History } = require('./history');
const { AdBlocker } = require('./adblock');
const { Store } = require('./store');
const registry = require('./registry');

// True-portable data: when launched from the portable .exe, keep all profile
// data in a "BublData" folder next to the executable so the whole thing can be
// moved/closed/reopened with tabs, history and bookmarks intact.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'BublData'));
}

// One Chromium instance per data dir.
if (!app.requestSingleInstanceLock()) app.quit();

// Single shared services container, injected into every window.
const services = {
  searchEngines: null,
  bookmarks: null,
  sharedHistory: null,
  adblock: null,
  settings: null,
  sessionStore: null,
  windows: [],
  onClosed: null,
  onSessionChanged: null
};

let sessionSaveTimer = null;
function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    // App windows (detached tabs) and incognito are not part of the session.
    const windows = services.windows
      .filter((c) => !c.incognito && !c.appMode)
      .map((c) => c.serializeSession());
    services.sessionStore.set('windows', windows);
  }, 700);
}

function focusedController() {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return services.windows[0] || null;
  return services.windows.find((c) => c.win === win) || services.windows[0] || null;
}

function createWindow({ incognito = false, appMode = false, restore = null } = {}) {
  const controller = new WindowController(services, { incognito, appMode, restore });
  services.windows.push(controller);
  return controller;
}

// --------------------------------------------------------------------------
// App lifecycle
// --------------------------------------------------------------------------

app.whenReady().then(async () => {
  services.settings = new Store('settings', {
    theme: 'duotone',
    adblockEnabled: true
  });
  services.searchEngines = new SearchEngines();
  services.bookmarks = new Bookmarks();
  services.sharedHistory = new History({ persistent: true });
  services.sessionStore = new Store('session', { windows: [] });
  services.onSessionChanged = scheduleSessionSave;
  services.adblock = new AdBlocker();
  services.adblock.setEnabled(services.settings.get('adblockEnabled', true));

  // Route blocked-counter changes to the owning window's renderer.
  services.adblock.onCountChanged = (webContentsId, count) => {
    const entry = registry.get(webContentsId);
    if (entry) entry.controller.notifyBlocked(webContentsId, count);
  };
  // Resolve a request's initiating tab hostname for per-site whitelisting.
  services.adblock.hostnameResolver = (webContentsId) => {
    const entry = registry.get(webContentsId);
    return entry ? entry.controller.hostnameForWebContents(webContentsId) : '';
  };

  services.onClosed = (controller) => {
    services.windows = services.windows.filter((c) => c !== controller);
  };
  // Lets a controller spawn a detached "app" window for one of its tabs.
  services.openWindow = (opts) => createWindow(opts);

  buildMenu();
  registerIpc();

  // Load filter lists in the background; the first window opens immediately.
  services.adblock.init();

  // Restore the previous session's windows/tabs, or open a fresh window.
  const saved = services.sessionStore.get('windows', []);
  if (Array.isArray(saved) && saved.length) {
    for (const w of saved) createWindow({ incognito: false, restore: w });
  } else {
    createWindow({ incognito: false });
  }

  app.on('activate', () => {
    if (services.windows.length === 0) createWindow({ incognito: false });
  });
});

app.on('second-instance', () => {
  const c = services.windows[0];
  if (c && c.win) { if (c.win.isMinimized()) c.win.restore(); c.win.focus(); }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --------------------------------------------------------------------------
// Keyboard shortcuts (via an invisible application menu so accelerators fire
// regardless of whether focus is in the chrome UI or a tab's web content).
// --------------------------------------------------------------------------

function buildMenu() {
  const sendShortcut = (action) => {
    const c = focusedController();
    if (c) c._send('shortcut', { action });
  };

  const template = [
    {
      label: 'Bubl',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendShortcut('new-tab-bar')
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => { const c = focusedController(); if (c && c.activeTabId) c.closeTab(c.activeTabId); }
        },
        {
          label: 'New Incognito Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow({ incognito: true })
        },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => { const c = focusedController(); if (c && c.activeTabId) c.reload(c.activeTabId); }
        },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => sendShortcut('focus-address')
        },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+H',
          click: () => sendShortcut('history')
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            const c = focusedController();
            if (c && c.activeTabId) {
              const wc = c._wc(c.activeTabId);
              if (wc) wc.toggleDevTools();
            }
          }
        },
        { type: 'separator' },
        { role: 'quit', accelerator: 'CmdOrCtrl+Q' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------------------
// IPC
// --------------------------------------------------------------------------

function controllerFromEvent(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return services.windows.find((c) => c.win === win) || null;
}

function registerIpc() {
  // ---- Tabs ----
  ipcMain.handle('tab:new', (e, url) => { const c = controllerFromEvent(e); c && c.newTab(url || ''); });
  ipcMain.handle('tab:close', (e, id) => { const c = controllerFromEvent(e); c && c.closeTab(id); });
  ipcMain.handle('tab:activate', (e, id) => { const c = controllerFromEvent(e); c && c.activateTab(id); });
  ipcMain.handle('tab:reorder', (e, ids) => { const c = controllerFromEvent(e); c && c.reorderTabs(ids); });
  ipcMain.handle('tab:navigate', (e, { id, input }) => { const c = controllerFromEvent(e); c && c.navigate(id, input); });
  ipcMain.handle('tab:back', (e, id) => { const c = controllerFromEvent(e); c && c.goBack(id); });
  ipcMain.handle('tab:forward', (e, id) => { const c = controllerFromEvent(e); c && c.goForward(id); });
  ipcMain.handle('tab:reload', (e, id) => { const c = controllerFromEvent(e); c && c.reload(id); });
  ipcMain.handle('tab:stop', (e, id) => { const c = controllerFromEvent(e); c && c.stop(id); });
  ipcMain.handle('tab:home', (e, id) => { const c = controllerFromEvent(e); c && c.goHome(id); });
  ipcMain.handle('tab:detach', (e, id) => { const c = controllerFromEvent(e); c && c.detachTab(id); });

  // One-way trackpad-swipe navigation from a tab's preload.
  ipcMain.on('tab:gesture', (e, dir) => {
    const entry = registry.get(e.sender.id);
    if (!entry) return;
    if (dir === 'back') entry.controller.goBack(entry.tab.id);
    else if (dir === 'forward') entry.controller.goForward(entry.tab.id);
  });

  // ---- Content layout / visibility ----
  ipcMain.handle('content:bounds', (e, rect) => { const c = controllerFromEvent(e); c && c.setContentBounds(rect); });
  ipcMain.handle('content:visible', (e, v) => { const c = controllerFromEvent(e); c && c.setContentVisible(v); });

  // ---- Window controls ----
  ipcMain.handle('window:minimize', (e) => { const c = controllerFromEvent(e); c && c.minimize(); });
  ipcMain.handle('window:maximize', (e) => { const c = controllerFromEvent(e); c && c.toggleMaximize(); });
  ipcMain.handle('window:close', (e) => { const c = controllerFromEvent(e); c && c.close(); });
  ipcMain.handle('window:incognito', () => createWindow({ incognito: true }));

  // ---- History ----
  ipcMain.handle('history:list', (e, query) => { const c = controllerFromEvent(e); return c ? c.history.list(query) : []; });
  ipcMain.handle('history:suggest', (e, query) => { const c = controllerFromEvent(e); return c ? c.history.suggest(query) : []; });
  ipcMain.handle('history:remove', (e, id) => { const c = controllerFromEvent(e); c && c.history.remove(id); return c ? c.history.list() : []; });
  ipcMain.handle('history:clear', (e) => { const c = controllerFromEvent(e); c && c.history.clear(); return []; });

  // ---- Search suggestions (remote autocomplete) ----
  ipcMain.handle('suggest:remote', async (e, query) => fetchSuggestions(query));

  // ---- Search engines ----
  ipcMain.handle('engines:list', () => services.searchEngines.list());
  ipcMain.handle('engines:add', (e, engine) => services.searchEngines.add(engine));
  ipcMain.handle('engines:remove', (e, id) => services.searchEngines.remove(id));
  ipcMain.handle('engines:setDefault', (e, id) => services.searchEngines.setDefault(id));

  // ---- Bookmarks ----
  ipcMain.handle('bookmarks:list', () => services.bookmarks.list());
  ipcMain.handle('bookmarks:add', (e, { url, title }) => services.bookmarks.add(url, title));
  ipcMain.handle('bookmarks:remove', (e, idOrUrl) => services.bookmarks.remove(idOrUrl));
  ipcMain.handle('bookmarks:toggle', (e, { url, title }) => {
    const state = services.bookmarks.toggle(url, title);
    const c = controllerFromEvent(e);
    if (c) c._emitTabs();
    return { bookmarked: state, list: services.bookmarks.list() };
  });

  // ---- Settings / theme ----
  ipcMain.handle('settings:get', (e, key) => services.settings.get(key));
  ipcMain.handle('settings:set', (e, { key, value }) => services.settings.set(key, value));

  // ---- Adblock ----
  ipcMain.handle('adblock:state', (e) => {
    const c = controllerFromEvent(e);
    const tab = c ? c._tab(c.activeTabId) : null;
    const host = tab ? require('./util').hostnameOf(tab.url) : '';
    return {
      enabled: services.adblock.enabled,
      total: services.adblock.getTotalBlocked(),
      siteHost: host,
      siteEnabled: host ? !services.adblock.isSiteWhitelisted(host) : true
    };
  });
  ipcMain.handle('adblock:toggle', (e, enabled) => {
    services.adblock.setEnabled(enabled);
    services.settings.set('adblockEnabled', !!enabled);
    // Reload active tabs so the change takes effect immediately.
    for (const c of services.windows) {
      const t = c._tab(c.activeTabId);
      if (t && !t.isStartPage) c.reload(t.id);
    }
    return services.adblock.enabled;
  });
  ipcMain.handle('adblock:toggleSite', (e, { host, enabled }) => {
    services.adblock.setSiteEnabled(host, enabled);
    const c = controllerFromEvent(e);
    if (c && c.activeTabId) c.reload(c.activeTabId);
    return { host, enabled };
  });
}

/**
 * Fetch search suggestions from the default engine's suggest endpoint using
 * Electron's `net` module (respects proxy settings). Returns a string array.
 * Failures degrade gracefully to an empty list.
 */
function fetchSuggestions(query) {
  const url = services.searchEngines.suggestUrl(query);
  if (!url) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      const timer = setTimeout(() => { request.abort(); resolve([]); }, 3000);
      request.on('response', (response) => {
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          clearTimeout(timer);
          resolve(parseSuggestions(body));
        });
      });
      request.on('error', () => { clearTimeout(timer); resolve([]); });
      request.end();
    } catch {
      resolve([]);
    }
  });
}

/** Parse the OpenSearch-style suggestion JSON used by DuckDuckGo/Google. */
function parseSuggestions(body) {
  try {
    const data = JSON.parse(body);
    // DuckDuckGo list format: [{ phrase: "..." }, ...]
    if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
      return data.map((d) => d.phrase).filter(Boolean).slice(0, 8);
    }
    // OpenSearch format: [query, [suggestions], ...]
    if (Array.isArray(data) && Array.isArray(data[1])) {
      return data[1].slice(0, 8);
    }
  } catch {}
  return [];
}
