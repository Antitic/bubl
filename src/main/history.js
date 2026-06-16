'use strict';

const crypto = require('crypto');
const { Store } = require('./store');

/**
 * Browsing history store. Each entry: { id, url, title, time }.
 *
 * Incognito windows pass `persistent: false` so nothing is ever written to
 * disk — the spec forbids recording history in incognito mode.
 */
class History {
  constructor({ persistent = true } = {}) {
    this.persistent = persistent;
    if (persistent) {
      this.store = new Store('history', { entries: [] });
    } else {
      this.memory = [];
    }
  }

  _entries() {
    return this.persistent ? this.store.get('entries', []) : this.memory;
  }

  _save(entries) {
    if (this.persistent) this.store.set('entries', entries);
    else this.memory = entries;
  }

  add(url, title) {
    if (!url || url.startsWith('bubl://') || url.startsWith('about:')) return;
    const entries = this._entries();
    const entry = {
      id: crypto.randomUUID(),
      url,
      title: title || url,
      time: Date.now()
    };
    // Collapse consecutive duplicate visits to the same URL.
    if (entries.length && entries[0].url === url) {
      entries[0] = { ...entries[0], title: entry.title, time: entry.time };
    } else {
      entries.unshift(entry);
    }
    if (entries.length > 10000) entries.length = 10000;
    this._save(entries);
  }

  /** Full list, optionally filtered by a case-insensitive query. */
  list(query = '') {
    const entries = this._entries();
    if (!query) return entries;
    const q = query.toLowerCase();
    return entries.filter(
      (e) => e.url.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q)
    );
  }

  /** Suggestions for the address bar: deduped by URL, newest first. */
  suggest(query, limit = 8) {
    if (!query) return [];
    const q = query.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const e of this._entries()) {
      if (e.url.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q)) {
        if (seen.has(e.url)) continue;
        seen.add(e.url);
        out.push({ url: e.url, title: e.title });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  remove(id) {
    this._save(this._entries().filter((e) => e.id !== id));
  }

  clear() {
    this._save([]);
  }
}

module.exports = { History };
