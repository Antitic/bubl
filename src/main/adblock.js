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
    this._totalBlocked = 0;
  }

  async init() {
    const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
    try {
      this.engine = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: cachePath,
        read: fsp.readFile,
        write: fsp.writeFile
      });
      this.ready = true;
      console.log('[bubl] adblock engine ready');
    } catch (err) {
      // Offline / first run without network: fall back to an empty engine so
      // the browser still works; lists can be fetched later.
      console.error('[bubl] failed to load adblock lists, running without filters', err);
      try {
        this.engine = ElectronBlocker.empty();
        this.ready = true;
      } catch (e) {
        this.ready = false;
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
   */
  enableForSession(session) {
    if (!this.engine) return;

    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!this.enabled || !this.ready) {
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
