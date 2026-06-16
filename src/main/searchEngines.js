'use strict';

const { Store } = require('./store');

/**
 * Built-in search engines. DuckDuckGo is the default, in keeping with Bubl's
 * privacy-first philosophy. `%s` is replaced with the URL-encoded query.
 */
const DEFAULT_ENGINES = [
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', suggest: '' },
  { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', suggest: '' },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', suggest: '' }
];

class SearchEngines {
  constructor() {
    this.store = new Store('search-engines', {
      engines: DEFAULT_ENGINES,
      defaultId: 'duckduckgo'
    });
  }

  list() {
    return {
      engines: this.store.get('engines', DEFAULT_ENGINES),
      defaultId: this.store.get('defaultId', 'duckduckgo')
    };
  }

  getDefault() {
    const { engines, defaultId } = this.list();
    return engines.find((e) => e.id === defaultId) || engines[0];
  }

  add(engine) {
    const engines = this.store.get('engines', []);
    const id = engine.id || engine.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const next = engines.filter((e) => e.id !== id);
    next.push({ id, name: engine.name, url: engine.url, suggest: engine.suggest || '' });
    this.store.set('engines', next);
    return this.list();
  }

  remove(id) {
    let engines = this.store.get('engines', []);
    engines = engines.filter((e) => e.id !== id);
    if (engines.length === 0) engines = DEFAULT_ENGINES.slice();
    this.store.set('engines', engines);
    if (this.store.get('defaultId') === id) {
      this.store.set('defaultId', engines[0].id);
    }
    return this.list();
  }

  setDefault(id) {
    const engines = this.store.get('engines', []);
    if (engines.some((e) => e.id === id)) {
      this.store.set('defaultId', id);
    }
    return this.list();
  }

  /** Build a search URL for a query string using the default engine. */
  searchUrl(query) {
    const engine = this.getDefault();
    return engine.url.replace('%s', encodeURIComponent(query));
  }

  /** Suggestion endpoint URL for the default engine, or null if unsupported. */
  suggestUrl(query) {
    const engine = this.getDefault();
    if (!engine.suggest) return null;
    return engine.suggest.replace('%s', encodeURIComponent(query));
  }
}

module.exports = { SearchEngines, DEFAULT_ENGINES };
