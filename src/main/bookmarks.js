'use strict';

const crypto = require('crypto');
const { Store } = require('./store');

/** Bookmarks store. Each entry: { id, url, title, time }. */
class Bookmarks {
  constructor() {
    this.store = new Store('bookmarks', { entries: [] });
  }

  list() {
    return this.store.get('entries', []);
  }

  has(url) {
    return this.list().some((b) => b.url === url);
  }

  add(url, title) {
    if (!url) return this.list();
    const entries = this.list();
    if (entries.some((b) => b.url === url)) return entries;
    entries.unshift({ id: crypto.randomUUID(), url, title: title || url, time: Date.now() });
    this.store.set('entries', entries);
    return entries;
  }

  remove(idOrUrl) {
    const entries = this.list().filter((b) => b.id !== idOrUrl && b.url !== idOrUrl);
    this.store.set('entries', entries);
    return entries;
  }

  /** Toggle a bookmark by URL; returns the new bookmarked state. */
  toggle(url, title) {
    if (this.has(url)) {
      this.remove(url);
      return false;
    }
    this.add(url, title);
    return true;
  }
}

module.exports = { Bookmarks };
