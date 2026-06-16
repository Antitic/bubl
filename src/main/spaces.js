'use strict';

const crypto = require('crypto');

const DEFAULT_SPACES = [{ id: 'default', name: 'Main', color: '#ff5a45' }];

/** Global, persisted list of workspaces ("spaces") tabs can be grouped into. */
class Spaces {
  constructor(store) {
    this.store = store;
    this.list_ = store.get('spaces', DEFAULT_SPACES);
    if (!Array.isArray(this.list_) || !this.list_.length) this.list_ = DEFAULT_SPACES.slice();
  }

  list() { return this.list_; }

  add(name, color) {
    const space = { id: crypto.randomUUID(), name: (name || 'New Space').slice(0, 40), color: color || randomColor() };
    this.list_.push(space);
    this._save();
    return space;
  }

  rename(id, name) {
    const s = this.list_.find((x) => x.id === id);
    if (s && name) s.name = name.slice(0, 40);
    this._save();
    return this.list_;
  }

  /** Removes a space (keeping at least one). Returns the id tabs should fall back to. */
  remove(id) {
    if (this.list_.length <= 1) return { list: this.list_, fallbackId: this.list_[0].id };
    const idx = this.list_.findIndex((x) => x.id === id);
    if (idx === -1) return { list: this.list_, fallbackId: this.list_[0].id };
    this.list_.splice(idx, 1);
    this._save();
    return { list: this.list_, fallbackId: this.list_[0].id };
  }

  _save() { this.store.set('spaces', this.list_); }
}

function randomColor() {
  const palette = ['#ff5a45', '#18e0ff', '#ff2db5', '#6fcf8e', '#b48cff', '#ffcc66', '#4fe0a8', '#ff8a3d'];
  return palette[Math.floor(Math.random() * palette.length)];
}

module.exports = { Spaces, DEFAULT_SPACES };
