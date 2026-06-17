'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');

// Pre-serialised engine shipped with the app (generated at build time).
// At ~7 MB it contains EasyList, EasyPrivacy, uBlock Origin filters,
// Peter Lowe's list and uBlock Origin Annoyances — ~300 000 rules total.
const BUNDLED_BIN = path.join(__dirname, 'resources', 'adblock-engine.bin');

/**
 * Network-level ad/tracker blocker.
 *
 * Uses @ghostery/adblocker-electron (same filter engine as uBlock Origin) with
 * the bundled engine binary for instant startup — no network required on first
 * launch. The engine refreshes its filter lists silently in the background so
 * subsequent launches stay up to date.
 *
 * The session.webRequest handler is registered immediately (before the engine
 * finishes loading) so no requests escape during startup. Blocking activates
 * automatically once `this.ready` flips to true.
 */
class AdBlocker {
  constructor() {
    this.engine = null;
    this.ready = false;
    this.enabled = true;
    this.whitelist = new Set();
    this.tabCounts = new Map();
    this.hostnameResolver = () => '';
    this.onCountChanged = () => {};
    this.onRequestSeen = () => {};
    this._totalBlocked = 0;
    this._sessions = new Set();
  }

  async init() {
    const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');

    // ── 1. Deserialise from userData cache (hot path after first launch). ──
    if (fs.existsSync(cachePath)) {
      try {
        const buf = await fsp.readFile(cachePath);
        this.engine = ElectronBlocker.deserialize(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        );
        this.ready = true;
        console.log(`[bubl/adblock] loaded from cache (${(buf.length / 1e6).toFixed(1)} MB)`);
        // Refresh lists silently without blocking the UI.
        this._scheduleRefresh(cachePath);
        return;
      } catch (e) {
        console.warn('[bubl/adblock] cache unreadable, falling back to bundled binary', e.message);
      }
    }

    // ── 2. Seed from the binary bundled with the app (works offline). ──
    if (fs.existsSync(BUNDLED_BIN)) {
      try {
        const buf = await fsp.readFile(BUNDLED_BIN);
        this.engine = ElectronBlocker.deserialize(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        );
        this.ready = true;
        console.log(`[bubl/adblock] loaded from bundled binary (${(buf.length / 1e6).toFixed(1)} MB)`);
        // Copy to userData so the next launch uses it as a cache.
        fsp.copyFile(BUNDLED_BIN, cachePath).catch(() => {});
        this._scheduleRefresh(cachePath);
        return;
      } catch (e) {
        console.warn('[bubl/adblock] bundled binary unreadable, fetching from network', e.message);
      }
    }

    // ── 3. Last resort: fetch filter lists from the network. ──
    await this._refreshEngine(cachePath, /* setReady */ true);
  }

  _scheduleRefresh(cachePath) {
    // Delay the network refresh so the browser window opens first.
    setTimeout(() => this._refreshEngine(cachePath, false), 5000);
  }

  async _refreshEngine(cachePath, setReady) {
    try {
      const engine = await Promise.race([
        ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
          path: cachePath,
          read: fsp.readFile,
          write: fsp.writeFile
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 30000)
        )
      ]);
      this.engine = engine;
      if (setReady) this.ready = true;
      console.log('[bubl/adblock] engine refreshed from network');
    } catch (e) {
      if (setReady && !this.engine) {
        // Total failure — use an empty engine so the browser still loads.
        console.error('[bubl/adblock] could not load any filters:', e.message);
        this.engine = ElectronBlocker.empty();
        this.ready = true;
      } else {
        console.warn('[bubl/adblock] background refresh failed (keeping current engine):', e.message);
      }
    }
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

  /**
   * Register a blocking handler on an Electron session.
   *
   * Safe to call before init() finishes: the handler checks this.ready so
   * requests pass through harmlessly until the engine is loaded, then
   * blocking activates automatically — no re-registration needed.
   */
  enableForSession(session) {
    if (this._sessions.has(session)) return;
    this._sessions.add(session);

    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      // Track every domain a tab contacts (for network-footprint panel).
      try {
        this.onRequestSeen(details.webContentsId, new URL(details.url).hostname);
      } catch {}

      if (!this.enabled || !this.ready || !this.engine) return callback({});

      // Skip internal bubl/devtools pages.
      const url = details.url;
      if (url.startsWith('file://') || url.startsWith('devtools://') ||
          url.startsWith('chrome-extension://') || url.startsWith('chrome://')) {
        return callback({});
      }

      // Per-site toggle: skip blocking for whitelisted top-frame hosts.
      const host = this.hostnameResolver(details.webContentsId);
      if (host && this.whitelist.has(host)) return callback({});

      let request;
      try {
        request = fromElectronDetails(details);
      } catch {
        return callback({});
      }

      const { match, redirect } = this.engine.match(request);

      if (redirect) return callback({ redirectURL: redirect.dataUrl });
      if (match) {
        this._increment(details.webContentsId);
        return callback({ cancel: true });
      }
      return callback({});
    });
  }

  _increment(webContentsId) {
    if (webContentsId == null) return;
    const next = (this.tabCounts.get(webContentsId) || 0) + 1;
    this.tabCounts.set(webContentsId, next);
    this._totalBlocked += 1;
    this.onCountChanged(webContentsId, next);
  }
}

module.exports = { AdBlocker };
