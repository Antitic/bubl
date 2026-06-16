'use strict';

/* global bubl */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  tabs: [],
  activeTabId: null,
  incognito: false,
  theme: 'dark',
  engines: { engines: [], defaultId: 'duckduckgo' },
  bookmarks: [],
  suggestItems: [],
  suggestIndex: -1,
  blockCounts: {}, // tabId -> count
  totalBlocked: 0
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const activeTab = () => state.tabs.find((t) => t.id === state.activeTabId) || null;

// ---------------------------------------------------------------------------
// Init / events from main
// ---------------------------------------------------------------------------
bubl.on('init', (payload) => {
  state.incognito = payload.incognito;
  state.theme = payload.theme || 'dark';
  state.engines = payload.searchEngines || state.engines;
  state.bookmarks = payload.bookmarks || [];
  applyTheme(state.theme);
  $('#settings-adblock').checked = !!payload.adblockEnabled;
  if (state.incognito) {
    $('#incognito-badge').hidden = false;
    document.documentElement.classList.add('incognito');
  }
  updateAddressPlaceholder();
});

bubl.on('tabs:update', ({ tabs, activeTabId }) => {
  state.tabs = tabs;
  state.activeTabId = activeTabId;
  renderTabs();
  syncActiveTabUi();
  updateContentVisibility();
});

bubl.on('window:state', ({ maximized }) => {
  if (maximized != null) $('#win-max').textContent = maximized ? '❐' : '▢';
});

bubl.on('adblock:count', ({ tabId, count }) => {
  state.blockCounts[tabId] = count;
  if (tabId === state.activeTabId) {
    $('#block-count').textContent = count;
    $('#pop-count').textContent = count;
  }
});

bubl.on('shortcut', ({ action }) => {
  if (action === 'focus-address') focusAddress();
  else if (action === 'history') toggleOverlay('history');
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  bubl.setSetting('theme', next);
}
$('#btn-theme').addEventListener('click', toggleTheme);
$('#settings-theme').addEventListener('click', toggleTheme);

// ---------------------------------------------------------------------------
// Tab list rendering + drag & drop
// ---------------------------------------------------------------------------
function renderTabs() {
  const list = $('#tablist');
  list.innerHTML = '';
  for (const tab of state.tabs) {
    const node = el('div', 'tab' + (tab.active ? ' active' : ''));
    node.dataset.id = tab.id;
    node.setAttribute('draggable', 'true');
    node.setAttribute('role', 'listitem');

    // Favicon / spinner
    if (tab.loading) {
      node.appendChild(el('div', 'tab-spinner'));
    } else {
      const fav = el('div', 'tab-favicon');
      if (tab.favicon) {
        const img = el('img');
        img.src = tab.favicon;
        img.onerror = () => { fav.textContent = '🌐'; };
        fav.appendChild(img);
      } else {
        fav.textContent = tab.isStartPage ? '✦' : '🌐';
      }
      node.appendChild(fav);
    }

    const title = el('div', 'tab-title');
    title.textContent = tab.title || 'New Tab';
    node.appendChild(title);

    const close = el('button', 'tab-close');
    close.textContent = '✕';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => { e.stopPropagation(); bubl.closeTab(tab.id); });
    node.appendChild(close);

    node.addEventListener('click', () => bubl.activateTab(tab.id));
    node.addEventListener('auxclick', (e) => { if (e.button === 1) bubl.closeTab(tab.id); });
    wireDrag(node);
    list.appendChild(node);
  }
}

let dragId = null;
function wireDrag(node) {
  node.addEventListener('dragstart', (e) => {
    dragId = node.dataset.id;
    node.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => {
    dragId = null;
    node.classList.remove('dragging');
    document.querySelectorAll('.tab.drop-target').forEach((n) => n.classList.remove('drop-target'));
  });
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.querySelectorAll('.tab.drop-target').forEach((n) => n.classList.remove('drop-target'));
    if (node.dataset.id !== dragId) node.classList.add('drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop-target');
    if (!dragId || dragId === node.dataset.id) return;
    const ids = state.tabs.map((t) => t.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(node.dataset.id);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    bubl.reorderTabs(ids);
  });
}

$('#new-tab-btn').addEventListener('click', () => bubl.newTab(''));

// ---------------------------------------------------------------------------
// Active tab UI sync (address bar, nav buttons, star)
// ---------------------------------------------------------------------------
function syncActiveTabUi() {
  const tab = activeTab();
  $('#btn-back').disabled = !tab || !tab.canGoBack;
  $('#btn-forward').disabled = !tab || !tab.canGoForward;
  $('#btn-reload').textContent = tab && tab.loading ? '✕' : '⟳';

  const addr = $('#address');
  if (document.activeElement !== addr) {
    addr.value = tab && !tab.isStartPage ? tab.url : '';
  }
  updateAddressPlaceholder();

  // Security indicator
  const sec = $('#security-ico');
  if (tab && tab.url.startsWith('https://')) sec.textContent = '🔒';
  else if (tab && tab.url.startsWith('http://')) sec.textContent = '⚠';
  else sec.textContent = '✦';

  // Bookmark star
  $('#btn-star').textContent = tab && tab.bookmarked ? '★' : '☆';
  $('#btn-star').classList.toggle('active', !!(tab && tab.bookmarked));

  // Blocked count
  const count = state.blockCounts[state.activeTabId] || 0;
  $('#block-count').textContent = count;
}

function updateAddressPlaceholder() {
  const def = state.engines.engines.find((e) => e.id === state.engines.defaultId);
  $('#address').placeholder = `Search with ${def ? def.name : 'DuckDuckGo'} or enter address`;
}

// ---------------------------------------------------------------------------
// Navigation buttons
// ---------------------------------------------------------------------------
$('#btn-back').addEventListener('click', () => state.activeTabId && bubl.back(state.activeTabId));
$('#btn-forward').addEventListener('click', () => state.activeTabId && bubl.forward(state.activeTabId));
$('#btn-reload').addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  if (tab.loading) bubl.stop(tab.id); else bubl.reload(tab.id);
});
$('#btn-home').addEventListener('click', () => state.activeTabId && bubl.home(state.activeTabId));

// ---------------------------------------------------------------------------
// Address bar + suggestions
// ---------------------------------------------------------------------------
const addressInput = $('#address');
let suggestSeq = 0;

function focusAddress() {
  addressInput.focus();
  addressInput.select();
}

addressInput.addEventListener('focus', () => { if (addressInput.value) showSuggestions(addressInput.value); });
addressInput.addEventListener('input', () => showSuggestions(addressInput.value));
addressInput.addEventListener('keydown', onAddressKey);
addressInput.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

function onAddressKey(e) {
  const box = $('#suggestions');
  const visible = !box.hidden && state.suggestItems.length;
  if (e.key === 'ArrowDown' && visible) {
    e.preventDefault();
    state.suggestIndex = Math.min(state.suggestIndex + 1, state.suggestItems.length - 1);
    highlightSuggestion();
  } else if (e.key === 'ArrowUp' && visible) {
    e.preventDefault();
    state.suggestIndex = Math.max(state.suggestIndex - 1, -1);
    highlightSuggestion();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    let value = addressInput.value;
    if (state.suggestIndex >= 0 && state.suggestItems[state.suggestIndex]) {
      value = state.suggestItems[state.suggestIndex].value;
    }
    commitAddress(value);
  } else if (e.key === 'Escape') {
    hideSuggestions();
    addressInput.blur();
  }
}

function commitAddress(value) {
  if (!value || !value.trim()) return;
  hideSuggestions();
  let id = state.activeTabId;
  if (!id) { bubl.newTab(value); return; }
  bubl.navigate(id, value);
  addressInput.blur();
}

async function showSuggestions(query) {
  const q = (query || '').trim();
  const seq = ++suggestSeq;
  if (!q) return hideSuggestions();

  const items = [];
  // 1. "Go to / search" primary action
  items.push({ type: 'primary', value: q, title: q });

  // 2. Local history matches
  const hist = await bubl.historySuggest(q);
  if (seq !== suggestSeq) return;
  for (const h of hist) items.push({ type: 'history', value: h.url, title: h.title || h.url, url: h.url });

  // 3. Remote search suggestions (best-effort)
  const remote = await bubl.remoteSuggest(q);
  if (seq !== suggestSeq) return;
  for (const phrase of remote) {
    if (items.some((i) => i.title.toLowerCase() === phrase.toLowerCase())) continue;
    items.push({ type: 'search', value: phrase, title: phrase });
  }

  state.suggestItems = items.slice(0, 10);
  state.suggestIndex = -1;
  renderSuggestions();
}

function renderSuggestions() {
  const box = $('#suggestions');
  box.innerHTML = '';
  if (!state.suggestItems.length) { box.hidden = true; return; }
  state.suggestItems.forEach((item, i) => {
    const node = el('div', 'suggest-item');
    node.dataset.index = i;
    const ico = el('span', 's-ico');
    ico.textContent = item.type === 'history' ? '🕘' : item.type === 'search' ? '🔍' : '➜';
    node.appendChild(ico);
    const title = el('span', 's-title');
    title.textContent = item.title;
    node.appendChild(title);
    if (item.url) {
      const url = el('span', 's-url');
      url.textContent = item.url;
      node.appendChild(url);
    }
    node.addEventListener('mousedown', (e) => { e.preventDefault(); commitAddress(item.value); });
    box.appendChild(node);
  });
  box.hidden = false;
}

function highlightSuggestion() {
  document.querySelectorAll('.suggest-item').forEach((n) => {
    n.classList.toggle('active', Number(n.dataset.index) === state.suggestIndex);
  });
  if (state.suggestIndex >= 0) {
    addressInput.value = state.suggestItems[state.suggestIndex].value;
  }
}

function hideSuggestions() {
  $('#suggestions').hidden = true;
  state.suggestItems = [];
  state.suggestIndex = -1;
}

// ---------------------------------------------------------------------------
// Bookmark star
// ---------------------------------------------------------------------------
$('#btn-star').addEventListener('click', async () => {
  const tab = activeTab();
  if (!tab || tab.isStartPage || !tab.url) return;
  const res = await bubl.bookmarksToggle(tab.url, tab.title);
  state.bookmarks = res.list;
});

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------
$('#win-min').addEventListener('click', () => bubl.minimize());
$('#win-max').addEventListener('click', () => bubl.maximize());
$('#win-close').addEventListener('click', () => bubl.closeWindow());
$('#btn-incognito').addEventListener('click', () => bubl.openIncognito());

// ---------------------------------------------------------------------------
// Overlays (start / history / bookmarks / settings)
// ---------------------------------------------------------------------------
const overlays = {
  history: $('#overlay-history'),
  bookmarks: $('#overlay-bookmarks'),
  settings: $('#overlay-settings')
};
let openOverlay = null;

function toggleOverlay(name) {
  if (openOverlay === name) return closeOverlay();
  openOverlay = name;
  for (const [key, node] of Object.entries(overlays)) node.hidden = key !== name;
  if (name === 'history') loadHistory();
  if (name === 'bookmarks') loadBookmarks();
  if (name === 'settings') loadSettings();
  updateContentVisibility();
}
function closeOverlay() {
  openOverlay = null;
  for (const node of Object.values(overlays)) node.hidden = true;
  updateContentVisibility();
}

$('#btn-history').addEventListener('click', () => toggleOverlay('history'));
$('#btn-bookmarks').addEventListener('click', () => toggleOverlay('bookmarks'));
$('#btn-settings').addEventListener('click', () => toggleOverlay('settings'));
document.querySelectorAll('[data-close-overlay]').forEach((b) => b.addEventListener('click', closeOverlay));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openOverlay) closeOverlay(); });

/**
 * Decide whether the active tab's web content should be visible, or whether a
 * renderer overlay (start page / panel) covers it.
 */
function updateContentVisibility() {
  const tab = activeTab();
  const startVisible = !openOverlay && tab && tab.isStartPage;
  $('#overlay-start').hidden = !startVisible;
  const contentVisible = !openOverlay && !startVisible;
  bubl.setContentVisible(contentVisible);
  if (startVisible) renderStartShortcuts();
}

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------
$('#start-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    const id = state.activeTabId;
    if (id) bubl.navigate(id, e.target.value.trim());
    e.target.value = '';
  }
});

function renderStartShortcuts() {
  const wrap = $('#start-shortcuts');
  wrap.innerHTML = '';
  const items = state.bookmarks.slice(0, 8);
  for (const b of items) {
    const tile = el('div', 'shortcut-tile');
    const ico = el('div', 'st-ico');
    ico.textContent = (hostname(b.url)[0] || '?').toUpperCase();
    const label = el('div', 'st-label');
    label.textContent = b.title || hostname(b.url);
    tile.appendChild(ico);
    tile.appendChild(label);
    tile.addEventListener('click', () => bubl.navigate(state.activeTabId, b.url));
    wrap.appendChild(tile);
  }
}

// ---------------------------------------------------------------------------
// History overlay
// ---------------------------------------------------------------------------
$('#history-search').addEventListener('input', (e) => loadHistory(e.target.value));
$('#history-clear').addEventListener('click', async () => {
  await bubl.historyClear();
  loadHistory($('#history-search').value);
});

async function loadHistory(query = '') {
  const entries = await bubl.historyList(query);
  const list = $('#history-list');
  list.innerHTML = '';
  if (!entries.length) {
    const note = el('div', 'empty-note');
    note.textContent = query ? 'No matching history.' : 'No history yet.';
    list.appendChild(note);
    return;
  }
  for (const entry of entries) {
    list.appendChild(historyRow(entry));
  }
}

function historyRow(entry) {
  const row = el('div', 'entry');
  const fav = el('div', 'e-fav'); fav.textContent = '🕘';
  const main = el('div', 'e-main');
  const t = el('div', 'e-title'); t.textContent = entry.title || entry.url;
  const u = el('div', 'e-url'); u.textContent = entry.url;
  main.appendChild(t); main.appendChild(u);
  main.addEventListener('click', () => { bubl.navigate(state.activeTabId, entry.url); closeOverlay(); });
  const time = el('div', 'e-time'); time.textContent = formatTime(entry.time);
  const del = el('button', 'e-del'); del.textContent = '🗑';
  del.title = 'Remove';
  del.addEventListener('click', async () => {
    await bubl.historyRemove(entry.id);
    row.remove();
  });
  row.append(fav, main, time, del);
  return row;
}

// ---------------------------------------------------------------------------
// Bookmarks overlay
// ---------------------------------------------------------------------------
async function loadBookmarks() {
  state.bookmarks = await bubl.bookmarksList();
  const list = $('#bookmarks-list');
  list.innerHTML = '';
  if (!state.bookmarks.length) {
    const note = el('div', 'empty-note');
    note.textContent = 'No bookmarks yet. Tap the ☆ in the address bar to add one.';
    list.appendChild(note);
    return;
  }
  for (const b of state.bookmarks) {
    const row = el('div', 'entry');
    const fav = el('div', 'e-fav'); fav.textContent = '★';
    const main = el('div', 'e-main');
    const t = el('div', 'e-title'); t.textContent = b.title || b.url;
    const u = el('div', 'e-url'); u.textContent = b.url;
    main.appendChild(t); main.appendChild(u);
    main.addEventListener('click', () => { bubl.navigate(state.activeTabId, b.url); closeOverlay(); });
    const del = el('button', 'e-del'); del.textContent = '🗑';
    del.addEventListener('click', async () => {
      state.bookmarks = await bubl.bookmarksRemove(b.id);
      row.remove();
    });
    row.append(fav, main, del);
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Settings overlay
// ---------------------------------------------------------------------------
async function loadSettings() {
  const state2 = await bubl.adblockState();
  $('#settings-adblock').checked = state2.enabled;
  state.engines = await bubl.enginesList();
  renderEngines();
}

$('#settings-adblock').addEventListener('change', (e) => bubl.adblockToggle(e.target.checked));

function renderEngines() {
  const wrap = $('#engines-list');
  wrap.innerHTML = '';
  for (const eng of state.engines.engines) {
    const item = el('div', 'engine-item' + (eng.id === state.engines.defaultId ? ' default' : ''));
    const name = el('div', 'eng-name'); name.textContent = eng.name;
    item.appendChild(name);
    if (eng.id !== state.engines.defaultId) {
      const setDef = el('button', 'pill-btn'); setDef.textContent = 'Set default';
      setDef.addEventListener('click', async () => {
        state.engines = await bubl.enginesSetDefault(eng.id);
        renderEngines(); updateAddressPlaceholder();
      });
      item.appendChild(setDef);
    }
    const rm = el('button', 'pill-btn'); rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      state.engines = await bubl.enginesRemove(eng.id);
      renderEngines(); updateAddressPlaceholder();
    });
    item.appendChild(rm);
    wrap.appendChild(item);
  }
}

$('#engine-add-btn').addEventListener('click', async () => {
  const name = $('#engine-name').value.trim();
  const url = $('#engine-url').value.trim();
  if (!name || !url.includes('%s')) {
    flash($('#engine-url'));
    return;
  }
  state.engines = await bubl.enginesAdd({ name, url });
  $('#engine-name').value = '';
  $('#engine-url').value = '';
  renderEngines(); updateAddressPlaceholder();
});

function flash(node) {
  node.style.boxShadow = '0 0 0 2px #ff3b5c';
  setTimeout(() => { node.style.boxShadow = ''; }, 800);
}

// ---------------------------------------------------------------------------
// Ad blocker popover
// ---------------------------------------------------------------------------
const shieldPop = $('#shield-pop');
$('#btn-shield').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!shieldPop.hidden) { shieldPop.hidden = true; return; }
  const st = await bubl.adblockState();
  $('#pop-count').textContent = state.blockCounts[state.activeTabId] || 0;
  $('#pop-total').textContent = st.total;
  $('#pop-global').checked = st.enabled;
  $('#pop-site').checked = st.siteEnabled;
  $('#pop-site-label').textContent = st.siteHost ? `Enabled on ${st.siteHost}` : 'Enabled on this site';
  $('#pop-site').disabled = !st.siteHost;
  shieldPop.dataset.host = st.siteHost || '';
  shieldPop.hidden = false;
});
$('#pop-global').addEventListener('change', (e) => {
  bubl.adblockToggle(e.target.checked);
  $('#settings-adblock').checked = e.target.checked;
});
$('#pop-site').addEventListener('change', (e) => {
  const host = shieldPop.dataset.host;
  if (host) bubl.adblockToggleSite(host, e.target.checked);
});
document.addEventListener('click', (e) => {
  if (!shieldPop.hidden && !shieldPop.contains(e.target) && e.target.id !== 'btn-shield') {
    shieldPop.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Content bounds reporting (keeps the WebContentsView aligned to the anchor)
// ---------------------------------------------------------------------------
const anchor = $('#webcontent-anchor');
function reportBounds() {
  const r = anchor.getBoundingClientRect();
  bubl.setContentBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
const ro = new ResizeObserver(reportBounds);
ro.observe(document.body);
window.addEventListener('resize', reportBounds);
window.addEventListener('load', reportBounds);
setTimeout(reportBounds, 100);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function formatTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
