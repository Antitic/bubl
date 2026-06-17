'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');

// Pre-serialised engine shipped with the app (~7 MB: EasyList, EasyPrivacy,
// uBlock Origin filters, Peter Lowe's list, etc — ~300 000 rules).
const BUNDLED_BIN = path.join(__dirname, 'resources', 'adblock-engine.bin');

/**
 * Network-level ad/tracker blocker.
 *
 * Electron does NOT support the chrome.webRequest API for loaded extensions,
 * so running uBlock Origin as an extension cannot actually block anything.
 * Instead we drive Ghostery's adblocker engine (the same filter format as
 * uBlock Origin) ourselves through session.webRequest.onBeforeRequest — which
 * works reliably in the main process.
 *
 * The request handler is registered immediately, even before the engine
 * finishes loading, so nothing slips through; blocking activates the moment
 * `this.ready` flips true.
 */
class UBlockManager {
  constructor() {
    this.engine = null;
    this.ready = false;
    this.enabled = true;
    this.whitelist = new Set();
    this.tabCounts = new Map();
    this._totalBlocked = 0;
    this.hostnameResolver = () => '';
    this.onCountChanged = () => {};
    this.onRequestSeen = () => {};
    this._sessions = new Set();
  }

  async init() {
    const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');

    // 1. Deserialise the userData cache (hot path after first launch).
    if (fs.existsSync(cachePath)) {
      try {
        const buf = await fsp.readFile(cachePath);
        this.engine = ElectronBlocker.deserialize(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        );
        this.ready = true;
        console.log(`[bubl/adblock] loaded from cache (${(buf.length / 1e6).toFixed(1)} MB)`);
        return;
      } catch (e) {
        console.warn('[bubl/adblock] cache unreadable, using bundled binary', e.message);
      }
    }

    // 2. Deserialise the binary bundled with the app (works fully offline).
    if (fs.existsSync(BUNDLED_BIN)) {
      try {
        const buf = await fsp.readFile(BUNDLED_BIN);
        this.engine = ElectronBlocker.deserialize(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        );
        this.ready = true;
        console.log(`[bubl/adblock] loaded from bundled binary (${(buf.length / 1e6).toFixed(1)} MB)`);
        fsp.copyFile(BUNDLED_BIN, cachePath).catch(() => {});
        return;
      } catch (e) {
        console.warn('[bubl/adblock] bundled binary unreadable, fetching from network', e.message);
      }
    }

    // 3. Last resort: fetch the lists from the network.
    try {
      this.engine = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: cachePath, read: fsp.readFile, write: fsp.writeFile
      });
      this.ready = true;
      console.log('[bubl/adblock] engine fetched from network');
    } catch (e) {
      console.error('[bubl/adblock] could not load any filters:', e.message);
      this.engine = ElectronBlocker.empty();
      this.ready = true;
    }
  }

  /**
   * Register a blocking handler on a session. Safe to call before init()
   * resolves — the handler no-ops until `this.ready` is true. The same
   * handler also feeds the network-footprint tracker.
   */
  enableForSession(ses, _isIncognito = false) {
    if (this._sessions.has(ses)) return;
    this._sessions.add(ses);

    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      // Footprint tracking: record every domain a tab contacts.
      try {
        this.onRequestSeen(details.webContentsId, new URL(details.url).hostname);
      } catch {}

      if (!this.enabled || !this.ready || !this.engine) return callback({});

      const url = details.url;
      if (url.startsWith('file://') || url.startsWith('devtools://') ||
          url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
        return callback({});
      }

      // Per-site toggle: skip blocking for whitelisted top-frame hosts.
      const host = this.hostnameResolver(details.webContentsId);
      if (host && this.whitelist.has(host)) return callback({});

      let request;
      try { request = fromElectronDetails(details); }
      catch { return callback({}); }

      const { match, redirect } = this.engine.match(request);
      if (redirect) return callback({ redirectURL: redirect.dataUrl });
      if (match) {
        this._increment(details.webContentsId);
        return callback({ cancel: true });
      }
      return callback({});
    });
  }

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
