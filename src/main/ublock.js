'use strict';

const path = require('path');
const { session: electronSession } = require('electron');

// Extensions must be loaded from a real filesystem path, not from inside an
// asar archive. electron-builder puts asarUnpack'd files in app.asar.unpacked/.
function unpackedPath(...parts) {
  const p = path.join(__dirname, ...parts);
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

const UBO_PATH = unpackedPath('resources', 'ublock', 'uBlock0.chromium');

/**
 * Loads uBlock Origin as a real Chrome extension into the persistent session.
 *
 * uBO handles all request blocking internally via its MV2 webRequest hooks —
 * no custom onBeforeRequest handler needed. We keep a thin network-observer
 * on the same session solely to maintain per-tab blocked counters.
 */
class UBlockManager {
  constructor() {
    this.ready = false;
    this.enabled = true;
    this.whitelist = new Set();
    this.tabCounts = new Map();
    this._totalBlocked = 0;
    this.hostnameResolver = () => '';
    this.onCountChanged = () => {};
    this.onRequestSeen = () => {};
    this._sessions = new Set();
    this._extension = null;
  }

  /**
   * Load uBlock Origin into the default persistent session.
   * Must be called after app.whenReady() resolves.
   */
  async init() {
    try {
      const ses = electronSession.fromPartition('persist:bubl');
      this._extension = await ses.loadExtension(UBO_PATH, { allowFileAccess: true });
      this.ready = true;
      console.log('[bubl/ublock] uBlock Origin loaded, id:', this._extension.id);
    } catch (e) {
      console.error('[bubl/ublock] failed to load uBlock Origin:', e.message);
    }
  }

  /**
   * Attach a thin observer to a session for per-tab domain tracking and
   * blocked-counter increments. The actual blocking is done by uBO.
   *
   * For incognito sessions, uBO isn't loaded (extensions don't run in
   * incognito by default) so we enable our own lightweight block list.
   */
  enableForSession(ses, isIncognito = false) {
    if (this._sessions.has(ses)) return;
    this._sessions.add(ses);

    if (isIncognito) {
      // Load uBO in incognito too — Electron allows this via allowFileAccess.
      ses.loadExtension(UBO_PATH, { allowFileAccess: true }).catch((e) => {
        console.warn('[bubl/ublock] incognito extension load failed:', e.message);
      });
    }

    // Domain tracker (for network footprint panel).
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        this.onRequestSeen(details.webContentsId, new URL(details.url).hostname);
      } catch {}
      callback({});
    });
  }

  // ── Stub API kept for backwards compatibility with IPC handlers ──

  setEnabled(value) { this.enabled = !!value; }

  isSiteWhitelisted(hostname) { return hostname ? this.whitelist.has(hostname) : false; }

  setSiteEnabled(hostname, enabled) {
    if (!hostname) return;
    if (enabled) this.whitelist.delete(hostname);
    else this.whitelist.add(hostname);
  }

  resetTab(webContentsId) {
    this.tabCounts.set(webContentsId, 0);
    this.onCountChanged(webContentsId, 0);
  }

  forgetTab(webContentsId) { this.tabCounts.delete(webContentsId); }

  getCount(webContentsId) { return this.tabCounts.get(webContentsId) || 0; }

  getTotalBlocked() { return this._totalBlocked; }

  _increment(webContentsId) {
    if (webContentsId == null) return;
    const next = (this.tabCounts.get(webContentsId) || 0) + 1;
    this.tabCounts.set(webContentsId, next);
    this._totalBlocked += 1;
    this.onCountChanged(webContentsId, next);
  }
}

module.exports = { UBlockManager };
