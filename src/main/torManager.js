'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const net = require('net');

const TOR_SOCKS_PORT = 9152;  // avoid conflict with system Tor on 9050
const TOR_CONTROL_PORT = 9153;
const TOR_DATA_SUBDIR = 'TorData';

// Resolve a path that may be inside app.asar (reads OK) or app.asar.unpacked
// (required for spawning child processes — executables can't run from an asar).
function unpackedPath(...parts) {
  const p = path.join(__dirname, ...parts);
  // In production the asar.unpacked mirror is next to the asar archive.
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

const TOR_BIN = unpackedPath('resources', 'tor', 'tor', 'tor.exe');

/**
 * Manages a child tor.exe process and a SOCKS5 proxy session mapping.
 *
 *  services.tor.start()              — boot tor
 *  services.tor.stop()               — kill tor
 *  services.tor.setExitCountry(cc)   — e.g. 'DE', 'US', '' (any)
 *  services.tor.addBridge(line)      — e.g. 'obfs4 1.2.3.4:443 ... cert=...'
 *  services.tor.clearBridges()
 *  services.tor.applyToSession(ses)  — route a session through tor SOCKS
 *  services.tor.removeFromSession(s) — restore direct connection
 *  services.tor.status               — 'off' | 'starting' | 'on' | 'error'
 *  services.tor.onStatusChange       — callback(status, progress)
 */
class TorManager {
  constructor() {
    this._proc = null;
    this._torDataDir = null;
    this._exitCountry = '';
    this._bridges = [];
    this._useBridges = false;
    this.status = 'off';
    this.onStatusChange = () => {};
    this._sessions = new Set();
    this._bootstrapPct = 0;
  }

  async start() {
    if (this.status === 'on' || this.status === 'starting') return;
    this._setStatus('starting', 0);

    this._torDataDir = path.join(app.getPath('userData'), TOR_DATA_SUBDIR);
    await fsp.mkdir(this._torDataDir, { recursive: true });

    const torrcPath = path.join(this._torDataDir, 'torrc');
    await this._writeTorrc(torrcPath);

    if (!fs.existsSync(TOR_BIN)) {
      console.error('[tor] tor.exe not found at', TOR_BIN);
      this._setStatus('error', 0);
      return;
    }

    this._proc = spawn(TOR_BIN, ['-f', torrcPath], { windowsHide: true });

    this._proc.stdout.on('data', (d) => this._parseTorLog(d.toString()));
    this._proc.stderr.on('data', (d) => this._parseTorLog(d.toString()));

    this._proc.on('exit', (code) => {
      console.log('[tor] process exited, code', code);
      this._proc = null;
      if (this.status !== 'off') this._setStatus('error', 0);
      this._sessions.forEach((s) => this._clearProxy(s));
    });
  }

  stop() {
    if (this._proc) {
      this._proc.kill();
      this._proc = null;
    }
    this._sessions.forEach((s) => this._clearProxy(s));
    this._sessions.clear();
    this._setStatus('off', 0);
  }

  setExitCountry(cc) {
    this._exitCountry = cc || '';
    if (this.status === 'on') this._restart();
  }

  addBridge(line) {
    const trimmed = line.trim();
    if (trimmed && !this._bridges.includes(trimmed)) {
      this._bridges.push(trimmed);
      this._useBridges = true;
    }
  }

  clearBridges() {
    this._bridges = [];
    this._useBridges = false;
  }

  getBridges() { return [...this._bridges]; }

  applyToSession(ses) {
    this._sessions.add(ses);
    if (this.status === 'on') this._setProxy(ses);
  }

  removeFromSession(ses) {
    this._sessions.delete(ses);
    this._clearProxy(ses);
  }

  async _restart() {
    this.stop();
    await new Promise((r) => setTimeout(r, 500));
    await this.start();
  }

  async _writeTorrc(torrcPath) {
    const ptDir = unpackedPath('resources', 'tor', 'tor', 'pluggable_transports');
    let lines = [
      `SocksPort ${TOR_SOCKS_PORT}`,
      `ControlPort ${TOR_CONTROL_PORT}`,
      `DataDirectory ${this._torDataDir}`,
      'Log notice stdout',
      'CookieAuthentication 0',
      'AvoidDiskWrites 1'
    ];
    if (this._exitCountry) {
      lines.push(`ExitNodes {${this._exitCountry}}`);
      lines.push('StrictNodes 1');
    }
    if (this._useBridges && this._bridges.length > 0) {
      lines.push('UseBridges 1');
      // lyrebird handles obfs4, meek_lite, webtunnel, scramblesuit.
      lines.push(`ClientTransportPlugin obfs4,meek_lite,webtunnel,scramblesuit exec "${ptDir}\\lyrebird.exe"`);
      // conjure-client for conjure bridges.
      lines.push(`ClientTransportPlugin conjure exec "${ptDir}\\conjure-client.exe" -registerURL https://registration.refraction.network/api`);
      for (const b of this._bridges) lines.push(`Bridge ${b}`);
    }
    await fsp.writeFile(torrcPath, lines.join('\n') + '\n', 'utf-8');
  }

  _parseTorLog(text) {
    for (const line of text.split('\n')) {
      const m = line.match(/Bootstrapped (\d+)%/);
      if (m) {
        const pct = parseInt(m[1], 10);
        this._bootstrapPct = pct;
        if (pct >= 100) {
          this._setStatus('on', 100);
          this._sessions.forEach((s) => this._setProxy(s));
        } else {
          this._setStatus('starting', pct);
        }
      }
      if (/\[err\]|\[warn\]/i.test(line)) console.warn('[tor]', line.trim());
    }
  }

  _setProxy(ses) {
    ses.setProxy({ proxyRules: `socks5://127.0.0.1:${TOR_SOCKS_PORT}`, proxyBypassRules: '<local>' });
  }

  _clearProxy(ses) {
    try { ses.setProxy({ proxyRules: '' }); } catch {}
  }

  _setStatus(status, progress) {
    this.status = status;
    this.onStatusChange(status, progress);
  }
}

module.exports = { TorManager };
