'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app, ipcMain } = require('electron');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');

// Pre-serialised engine shipped with the app (~7 MB: EasyList, EasyPrivacy,
// uBlock Origin filters, Peter Lowe's list, etc — ~300 000 rules).
const BUNDLED_BIN = path.join(__dirname, 'resources', 'adblock-engine.bin');

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
    this._ipcRegistered = false;
  }

  async init() {
    const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');

    // 1. Deserialise userData cache (hot path after first launch).
    if (fs.existsSync(cachePath)) {
      try {
        const buf = await fsp.readFile(cachePath);
        this.engine = ElectronBlocker.deserialize(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        );
        this.ready = true;
        console.log(`[bubl/adblock] loaded from cache (${(buf.length / 1e6).toFixed(1)} MB)`);
      } catch (e) {
        console.warn('[bubl/adblock] cache unreadable, using bundled binary', e.message);
      }
    }

    // 2. Deserialise binary bundled with the app (works fully offline).
    if (!this.ready && fs.existsSync(BUNDLED_BIN)) {
      try {
        const buf = await fsp.readFile(BUNDLED_BIN);
        this.engine = ElectronBlocker.deserialize(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        );
        this.ready = true;
        console.log(`[bubl/adblock] loaded from bundled binary (${(buf.length / 1e6).toFixed(1)} MB)`);
        fsp.copyFile(BUNDLED_BIN, cachePath).catch(() => {});
      } catch (e) {
        console.warn('[bubl/adblock] bundled binary unreadable, fetching from network', e.message);
      }
    }

    // 3. Last resort: fetch from network.
    if (!this.ready) {
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

    // Register global IPC handlers for cosmetic + scriptlet injection.
    // These are called by @ghostery/adblocker-electron-preload from every tab.
    this._registerCosmeticIpc();
  }

  // ── Cosmetic filtering (DOM / CSS layer) ────────────────────────────────
  //
  // The ghostery preload script (required from tabPreload.js) calls:
  //   ipcRenderer.invoke('@ghostery/adblocker/inject-cosmetic-filters', url, msg)
  // where msg is undefined on the first call for a page, then carries
  // { ids, classes, hrefs } on DOM-mutation updates.
  //
  // Instead of returning CSS to the renderer, we inject directly from here
  // via insertCSS / executeJavaScript — no round-trip data, no sandbox issues.

  _registerCosmeticIpc() {
    if (this._ipcRegistered) return;
    this._ipcRegistered = true;

    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', async (event, url, msg) => {
      if (!this.enabled || !this.ready || !this.engine) return;
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;
        if (this.whitelist.has(hostname)) return;

        // Simple eTLD+1: last two labels. Good enough for filter matching.
        const parts = hostname.split('.');
        const domain = parts.slice(-2).join('.');

        const isFirstRun = msg === undefined;
        const { active, styles, scripts } = this.engine.getCosmeticsFilters({
          domain,
          hostname,
          url,
          classes: msg?.classes,
          hrefs: msg?.hrefs,
          ids: msg?.ids,
          getBaseRules: isFirstRun,
          getInjectionRules: isFirstRun,
          getExtendedRules: false,
          getRulesFromHostname: isFirstRun,
          getRulesFromDOM: !isFirstRun,
        });

        if (!active) return;

        // cssOrigin: 'user' gives user-agent priority (beats page CSS).
        if (styles.length > 0) {
          event.sender.insertCSS(styles, { cssOrigin: 'user' });
        }
        // Scriptlets run in the page world and break anti-adblock detectors.
        for (const script of scripts) {
          try { event.sender.executeJavaScript(script, true); } catch {}
        }
      } catch {}
    });

    // Preload queries this before setting up MutationObserver.
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => true);
  }

  // ── Session attachment ──────────────────────────────────────────────────
  //
  // Called once per session (normal + each incognito partition) before any
  // navigation, so nothing slips through on first load.

  enableForSession(ses, _isIncognito = false) {
    if (this._sessions.has(ses)) return;
    this._sessions.add(ses);

    // CSP header modification: adds directives blocking inline-script ad loaders
    // and other $csp-rule targets. Only touches mainFrame/subFrame responses.
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!this.enabled || !this.ready || !this.engine) return callback({});
      try {
        if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
          return callback({});
        }
        const hostname = new URL(details.url).hostname;
        if (this.whitelist.has(hostname)) return callback({});

        // Skip CSP modification for YouTube: we inject our own JS via the debugger
        // (which bypasses CSP) and tightening their CSP risks breaking the player.
        if (hostname.endsWith('youtube.com') || hostname.endsWith('youtu.be')) {
          return callback({});
        }

        let request;
        try { request = fromElectronDetails(details); } catch { return callback({}); }

        const cspDirectives = this.engine.getCSPDirectives(request);
        if (!cspDirectives) return callback({});

        const headers = { ...details.responseHeaders };
        const CSP = 'content-security-policy';
        const existingKey = Object.keys(headers).find(k => k.toLowerCase() === CSP);
        const existing = existingKey ? (headers[existingKey][0] || '') : '';
        if (existingKey) delete headers[existingKey];
        headers[CSP] = [existing ? `${existing}; ${cspDirectives}` : cspDirectives];
        callback({ responseHeaders: headers });
      } catch {
        callback({});
      }
    });

    // Network-level blocking + footprint tracking.
    // Handler is attached immediately; blocking activates once `this.ready` flips.
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        this.onRequestSeen(details.webContentsId, new URL(details.url).hostname);
      } catch {}

      if (!this.enabled || !this.ready || !this.engine) return callback({});

      const url = details.url;
      if (url.startsWith('file://') || url.startsWith('devtools://') ||
          url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
        return callback({});
      }

      const host = this.hostnameResolver(details.webContentsId);
      if (host && this.whitelist.has(host)) return callback({});

      let request;
      try { request = fromElectronDetails(details); } catch { return callback({}); }

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
