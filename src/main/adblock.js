'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');

/**
 * Network-level ad/tracker blocker.
 *
 * The spec mandates blocking through `session.webRequest.onBeforeRequest`, so
 * rather than delegating to `enableBlockingInSession` we own the request
 * handler ourselves. This gives full control over:
 *   - a global on/off toggle,
 *   - per-site whitelisting,
 *   - and an accurate per-tab blocked counter.
 *
 * Filter matching itself is delegated to Ghostery's engine (EasyList,
 * EasyPrivacy, Peter Lowe's list and uBlock's own lists via the prebuilt
 * "ads and tracking" bundle) — no hand-rolled regex.
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('adblock engine load timed out')), ms))
  ]);
}

class AdBlocker {
  constructor() {
    this.engine = null;
    this.ready = false;
    this.enabled = true;
    /** Hostnames where blocking is disabled (per-site toggle). */
    this.whitelist = new Set();
    /** webContentsId -> blocked count for the current page load. */
    this.tabCounts = new Map();
    /** Resolve a webContentsId to its current top-frame hostname. */
    this.hostnameResolver = () => '';
    /** Notified (webContentsId, count) whenever a tab's counter changes. */
    this.onCountChanged = () => {};
    /** Notified (webContentsId, hostname) for every request seen, blocked or not. */
    this.onRequestSeen = () => {};
    this._totalBlocked = 0;
  }

  async init() {
    const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
    const bundledPath = path.join(__dirname, 'resources', 'adblock-engine.bin');

    // Step 1: Try to load from userData cache (fastest, offline-capable).
    if (fs.existsSync(cachePath)) {
      try {
        const raw = await fsp.readFile(cachePath);
        this.engine = ElectronBlocker.deserialize(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
        this.ready = true;
        console.log('[bubl] adblock engine loaded from cache (%d bytes)', raw.length);
        // Refresh in background without blocking startup.
        this._refreshEngine(cachePath);
        return;
      } catch (err) {
        console.warn('[bubl] cache corrupt, falling back to bundled', err.message);
      }
    }

    // Step 2: No valid cache — seed from the copy bundled inside the app.
    if (fs.existsSync(bundledPath)) {
      try {
        const raw = await fsp.readFile(bundledPath);
        this.engine = ElectronBlocker.deserialize(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
        this.ready = true;
        console.log('[bubl] adblock engine loaded from bundled binary');
        // Copy to userData so the next launch is a cache hit.
        fsp.copyFile(bundledPath, cachePath).catch(() => {});
        this._refreshEngine(cachePath);
        return;
      } catch (err) {
        console.warn('[bubl] bundled engine unreadable, fetching fresh', err.message);
      }
    }

    // Step 3: Last resort — fetch from the network.
    await this._refreshEngine(cachePath);
  }

  async _refreshEngine(cachePath) {
    try {
      const engine = await withTimeout(
        ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
          path: cachePath,
          read: fsp.readFile,
          write: fsp.writeFile
        }),
        30000
      );
      this.engine = engine;
      this.ready = true;
      console.log('[bubl] adblock engine updated from network lists');
    } catch (err) {
      if (!this.engine) {
        // Nothing worked at all.
        console.error('[bubl] adblock completely unavailable', err.message);
        this.engine = ElectronBlocker.empty();
        this.ready = true;
      } else {
        console.warn('[bubl] background refresh failed, keeping existing engine', err.message);
      }
    }
  }

  setEnabled(value) {
    this.enabled = !!value;
  }

  isSiteWhitelisted(hostname) {
    return hostname ? this.whitelist.has(hostname) : false;
  }

  setSiteEnabled(hostname, enabled) {
    if (!hostname) return;
    if (enabled) this.whitelist.delete(hostname);
    else this.whitelist.add(hostname);
  }

  resetTab(webContentsId) {
    if (this.tabCounts.get(webContentsId)) {
      this.tabCounts.set(webContentsId, 0);
      this.onCountChanged(webContentsId, 0);
    } else {
      this.tabCounts.set(webContentsId, 0);
    }
  }

  forgetTab(webContentsId) {
    this.tabCounts.delete(webContentsId);
  }

  getCount(webContentsId) {
    return this.tabCounts.get(webContentsId) || 0;
  }

  getTotalBlocked() {
    return this._totalBlocked;
  }

  /**
   * Attach the blocker's request handler to a session. Safe to call for both
   * the normal and incognito partitions.
   *
   * The handler is registered immediately even if the engine isn't loaded yet;
   * requests pass through until `this.ready` is true, then blocking starts
   * automatically without needing to re-register.
   */
  enableForSession(session) {
    // Track sessions so we can log; never double-register.
    if (!this._sessions) this._sessions = new Set();
    if (this._sessions.has(session)) return;
    this._sessions.add(session);

    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        this.onRequestSeen(details.webContentsId, new URL(details.url).hostname);
      } catch {}

      if (!this.enabled || !this.ready || !this.engine) {
        return callback({});
      }

      // Per-site toggle: skip blocking entirely for whitelisted top frames.
      const host = this.hostnameResolver(details.webContentsId);
      if (host && this.whitelist.has(host)) {
        return callback({});
      }

      let request;
      try {
        request = fromElectronDetails(details);
      } catch (err) {
        return callback({});
      }

      const { match, redirect } = this.engine.match(request);

      if (redirect) {
        return callback({ redirectURL: redirect.dataUrl });
      }
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
