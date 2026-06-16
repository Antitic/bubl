'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Tiny synchronous JSON-backed key/value store.
 *
 * Persists to a single JSON file inside the user data directory. Writes are
 * debounced-free (immediate) but cheap because the data sets are small.
 * Incognito sessions never instantiate a Store — they keep state in memory and
 * discard it on close, so nothing is ever written to disk.
 */
class Store {
  /**
   * @param {string} name  File name (without extension) inside userData.
   * @param {object} defaults  Default values merged under existing data.
   */
  constructor(name, defaults = {}) {
    this.path = path.join(app.getPath('userData'), `${name}.json`);
    this.data = { ...defaults };
    try {
      const raw = fs.readFileSync(this.path, 'utf-8');
      this.data = { ...defaults, ...JSON.parse(raw) };
    } catch (err) {
      // Missing or corrupt file — fall back to defaults and (re)write.
      this._flush();
    }
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this._flush();
    return value;
  }

  /** Replace the whole store contents. */
  setAll(obj) {
    this.data = obj;
    this._flush();
  }

  all() {
    return this.data;
  }

  _flush() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[bubl] failed to persist store', this.path, err);
    }
  }
}

module.exports = { Store };
