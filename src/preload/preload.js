'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Secure bridge between the chrome UI renderer and the main process.
 * Only the explicit API below is exposed; no Node primitives leak through.
 */
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const api = {
  // Tabs
  newTab: (url) => invoke('tab:new', url),
  closeTab: (id) => invoke('tab:close', id),
  activateTab: (id) => invoke('tab:activate', id),
  reorderTabs: (ids) => invoke('tab:reorder', ids),
  navigate: (id, input) => invoke('tab:navigate', { id, input }),
  back: (id) => invoke('tab:back', id),
  forward: (id) => invoke('tab:forward', id),
  reload: (id) => invoke('tab:reload', id),
  stop: (id) => invoke('tab:stop', id),
  home: (id) => invoke('tab:home', id),
  detachTab: (id) => invoke('tab:detach', id),
  reattachTab: () => invoke('tab:reattach'),
  setTabSpace: (id, spaceId) => invoke('tab:setSpace', { id, spaceId }),
  toggleEssential: (id) => invoke('tab:toggleEssential', id),
  toggleReader: (id) => invoke('tab:toggleReader', id),
  reopenClosedTab: () => invoke('tab:reopenClosed'),
  networkFootprint: (id) => invoke('network:footprint', id),

  // Spaces
  spacesList: () => invoke('spaces:list'),
  spacesAdd: (name, color) => invoke('spaces:add', { name, color }),
  spacesRename: (id, name) => invoke('spaces:rename', { id, name }),
  spacesRemove: (id) => invoke('spaces:remove', id),
  spacesSetActive: (id) => invoke('spaces:setActive', id),

  // Content layout
  setContentBounds: (rect) => invoke('content:bounds', rect),
  setContentVisible: (v) => invoke('content:visible', v),

  // Window controls
  minimize: () => invoke('window:minimize'),
  maximize: () => invoke('window:maximize'),
  closeWindow: () => invoke('window:close'),
  openIncognito: () => invoke('window:incognito'),

  // History
  historyList: (query) => invoke('history:list', query),
  historySuggest: (query) => invoke('history:suggest', query),
  historyRemove: (id) => invoke('history:remove', id),
  historyClear: () => invoke('history:clear'),

  // Remote search suggestions
  remoteSuggest: (query) => invoke('suggest:remote', query),

  // Search engines
  enginesList: () => invoke('engines:list'),
  enginesAdd: (engine) => invoke('engines:add', engine),
  enginesRemove: (id) => invoke('engines:remove', id),
  enginesSetDefault: (id) => invoke('engines:setDefault', id),

  // Bookmarks
  bookmarksList: () => invoke('bookmarks:list'),
  bookmarksAdd: (url, title) => invoke('bookmarks:add', { url, title }),
  bookmarksRemove: (idOrUrl) => invoke('bookmarks:remove', idOrUrl),
  bookmarksToggle: (url, title) => invoke('bookmarks:toggle', { url, title }),

  // Settings
  getSetting: (key) => invoke('settings:get', key),
  setSetting: (key, value) => invoke('settings:set', { key, value }),

  // Adblock
  adblockState: () => invoke('adblock:state'),
  adblockToggle: (enabled) => invoke('adblock:toggle', enabled),
  adblockToggleSite: (host, enabled) => invoke('adblock:toggleSite', { host, enabled }),

  // Tor
  torStatus: () => invoke('tor:status'),
  torStart: () => invoke('tor:start'),
  torStop: () => invoke('tor:stop'),
  torSetExit: (cc) => invoke('tor:setExit', cc),
  torAddBridge: (line) => invoke('tor:addBridge', line),
  torClearBridges: () => invoke('tor:clearBridges'),
  torPresetBridges: (type) => invoke('tor:presetBridges', type),

  // Events from main -> renderer
  on: (channel, handler) => {
    const allowed = ['init', 'tabs:update', 'window:state', 'adblock:count', 'shortcut', 'tor:status'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
};

contextBridge.exposeInMainWorld('bubl', api);
