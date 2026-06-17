'use strict';

/* global bubl */

// ---------------------------------------------------------------------------
// Duck-with-sunglasses logo (shared SVG, drawn once into brand + start page)
// ---------------------------------------------------------------------------
const DUCK_SVG = `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect x="18" y="62" width="80" height="48" rx="6" fill="var(--accent, #c2533a)"/>
  <rect x="22" y="24" width="72" height="56" rx="8" fill="var(--duck-body, #FFD740)"/>
  <rect x="78" y="48" width="28" height="14" rx="3" fill="var(--duck-beak, #FF7A1A)"/>
  <rect x="78" y="56" width="28" height="8" rx="2" fill="var(--duck-beak-dark, #E85D04)"/>
  <rect x="24" y="38" width="56" height="18" rx="4" fill="#16121f"/>
  <rect x="32" y="42" width="10" height="10" rx="2" fill="var(--accent, #c2533a)"/>
  <rect x="58" y="42" width="10" height="10" rx="2" fill="var(--accent-2, var(--accent, #ff2db5))"/>
  <rect x="44" y="18" width="8" height="14" rx="2" fill="var(--duck-body, #FFD740)"/>
  <rect x="52" y="14" width="8" height="16" rx="2" fill="var(--duck-body, #FFD740)"/>
</svg>`;
document.getElementById('brand-duck').innerHTML = DUCK_SVG;
document.getElementById('start-duck').innerHTML = DUCK_SVG;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  tabs: [],
  activeTabId: null,
  incognito: false,
  appMode: false,
  theme: 'terracotta',
  engines: { engines: [], defaultId: 'duckduckgo' },
  bookmarks: [],
  blockCounts: {},
  cmd: { open: false, mode: 'new', items: [], index: -1, seq: 0 },
  spaces: [],
  activeSpaceId: 'default',
  sidebarPinned: false
};
const THEME_ORDER = ['terracotta', 'ocean', 'forest', 'neon'];

const $ = (s) => document.querySelector(s);
const el = (t, c) => { const n = document.createElement(t); if (c) n.className = c; return n; };
const activeTab = () => state.tabs.find((t) => t.id === state.activeTabId) || null;

// ---------------------------------------------------------------------------
// Events from main
// ---------------------------------------------------------------------------
bubl.on('init', (p) => {
  state.incognito = p.incognito;
  state.appMode = !!p.appMode;
  state.theme = p.theme || 'terracotta';
  state.engines = p.searchEngines || state.engines;
  state.bookmarks = p.bookmarks || [];
  applyTheme(state.theme);
  $('#settings-adblock').checked = !!p.adblockEnabled;
  if (state.incognito) $('#incognito-badge').hidden = false;
  if (state.appMode) {
    document.body.classList.add('app-mode');
    $('#app-controls').hidden = false;
    $('#app-drag').hidden = false;
  }
  document.documentElement.style.setProperty('--radius-factor', p.radiusFactor || 1);
  state.sidebarPinned = !!p.sidebarPinned;
  $('#btn-pin-sidebar').classList.toggle('active', state.sidebarPinned);
  document.body.classList.toggle('sidebar-expanded', state.sidebarPinned);
  if (!state.incognito && !state.appMode) loadSpaces();
});

bubl.on('tabs:update', ({ tabs, activeTabId, activeSpaceId }) => {
  state.tabs = tabs;
  state.activeTabId = activeTabId;
  if (activeSpaceId) state.activeSpaceId = activeSpaceId;
  renderTabs();
  renderSpaces();
  syncActiveTabUi();
  updateContentVisibility();
});

bubl.on('window:state', ({ maximized, edge }) => {
  if (maximized != null) $('#win-max').title = maximized ? 'Restore' : 'Maximize';
  document.body.classList.toggle('edge', !!edge);
});

bubl.on('adblock:count', ({ tabId, count }) => {
  const prev = state.blockCounts[tabId] || 0;
  state.blockCounts[tabId] = count;
  if (tabId === state.activeTabId) {
    $('#block-count').textContent = count;
    $('#pop-count').textContent = count;
    if (count > prev) pulseShield();
  }
});

// Very visual feedback whenever the active tab blocks something new.
let shieldPulseTimer = null;
function pulseShield() {
  const btn = $('#btn-shield');
  btn.classList.remove('blocking');
  // Force reflow so the animation restarts even on rapid consecutive blocks.
  void btn.offsetWidth;
  btn.classList.add('blocking');
  clearTimeout(shieldPulseTimer);
  shieldPulseTimer = setTimeout(() => btn.classList.remove('blocking'), 650);
}

bubl.on('shortcut', ({ action }) => {
  if (action === 'new-tab-bar') openCmd('new');
  else if (action === 'focus-address') openCmd('current');
  else if (action === 'history') toggleOverlay('history');
  else if (action && action.startsWith('space-')) {
    const idx = Number(action.slice(6)) - 1;
    const space = state.spaces[idx];
    if (space) switchSpace(space.id);
  }
});

// ---------------------------------------------------------------------------
// Theme — two switchable presets: Neon Dark / Duotone Ink
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  // Settings saved by older builds used 'light'/'dark', which no longer
  // exist as CSS themes — falling back keeps the window from rendering blank.
  if (!THEME_ORDER.includes(theme)) theme = 'terracotta';
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-swatch').forEach((b) => b.classList.toggle('active', b.dataset.themeOption === theme));
}
function setTheme(theme) { applyTheme(theme); bubl.setSetting('theme', theme); }
function toggleTheme() { setTheme(THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length]); }
$('#btn-theme').addEventListener('click', toggleTheme);
document.querySelectorAll('.theme-swatch').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeOption)));

// ---------------------------------------------------------------------------
// Sidebar — thin icon rail that expands into the full labeled view on hover
// ---------------------------------------------------------------------------
const sidebarEl = $('#sidebar');
sidebarEl.addEventListener('mouseenter', () => document.body.classList.add('sidebar-expanded'));
sidebarEl.addEventListener('mouseleave', () => { if (!state.sidebarPinned) document.body.classList.remove('sidebar-expanded'); });
$('#btn-pin-sidebar').addEventListener('click', () => {
  state.sidebarPinned = !state.sidebarPinned;
  $('#btn-pin-sidebar').classList.toggle('active', state.sidebarPinned);
  document.body.classList.toggle('sidebar-expanded', state.sidebarPinned);
  bubl.setSetting('sidebarPinned', state.sidebarPinned);
});

// ---------------------------------------------------------------------------
// Workspaces / Spaces
// ---------------------------------------------------------------------------
async function loadSpaces() {
  state.spaces = await bubl.spacesList();
  renderSpaces();
}

function renderSpaces() {
  const bar = $('#spaces-bar');
  bar.innerHTML = '';
  state.spaces.forEach((sp) => {
    const chip = el('button', 'space-chip' + (sp.id === state.activeSpaceId ? ' active' : ''));
    chip.style.setProperty('--space-color', sp.color);
    const dot = el('span', 'space-dot');
    const name = el('span', 'space-name'); name.textContent = sp.name;
    chip.append(dot, name);
    chip.title = sp.name;
    chip.addEventListener('click', () => switchSpace(sp.id));
    chip.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const next = prompt('Rename space', sp.name);
      if (next && next.trim()) { state.spaces = await bubl.spacesRename(sp.id, next.trim()); renderSpaces(); }
    });
    if (state.spaces.length > 1) {
      const del = el('button', 'space-del'); del.textContent = '✕'; del.title = 'Delete space';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        state.spaces = await bubl.spacesRemove(sp.id);
        renderSpaces();
      });
      chip.appendChild(del);
    }
    bar.appendChild(chip);
  });
  const add = el('button', 'space-add');
  add.textContent = '+';
  add.title = 'New space';
  add.addEventListener('click', async () => {
    const sp = await bubl.spacesAdd('New Space');
    state.spaces = await bubl.spacesList();
    renderSpaces();
    switchSpace(sp.id);
  });
  bar.appendChild(add);
}

async function switchSpace(id) {
  state.activeSpaceId = id;
  await bubl.spacesSetActive(id);
  renderSpaces();
  renderTabs();
  const inSpace = state.tabs.find((t) => (t.spaceId || 'default') === id);
  if (inSpace) bubl.activateTab(inSpace.id);
  else bubl.newTab('');
}

// ---------------------------------------------------------------------------
// Tab list — keyed reconciliation (no full rebuild, no favicon reload flicker)
// ---------------------------------------------------------------------------
const tabNodes = new Map(); // id -> { node, els, data }

function renderTabs() {
  const list = $('#tablist');
  const seen = new Set();
  // Empty start-page tabs are not listed — the "+ New Tab" button already
  // represents that state, so showing a "New Tab" entry would be a duplicate.
  const visible = state.tabs.filter((t) => !t.isStartPage && (t.spaceId || 'default') === state.activeSpaceId);

  visible.forEach((tab, i) => {
    seen.add(tab.id);
    let rec = tabNodes.get(tab.id);
    if (!rec) rec = createTabNode(tab);
    updateTabNode(rec, tab);
    // Ensure DOM order matches state order.
    const expected = list.children[i];
    if (expected !== rec.node) list.insertBefore(rec.node, expected || null);
  });

  for (const [id, rec] of tabNodes) {
    if (!seen.has(id)) { rec.node.remove(); tabNodes.delete(id); }
  }
}

function createTabNode(tab) {
  const node = el('div', 'tab');
  node.dataset.id = tab.id;
  node.setAttribute('draggable', 'true');
  const fav = el('div', 'tab-favicon');
  const title = el('div', 'tab-title');
  const detach = el('button', 'tab-detach');
  detach.textContent = '⤢';
  detach.title = 'Open as floating app window';
  const close = el('button', 'tab-close');
  close.textContent = '✕';
  close.title = 'Close tab';
  node.append(fav, title, detach, close);

  detach.addEventListener('click', (e) => { e.stopPropagation(); bubl.detachTab(node.dataset.id); });
  close.addEventListener('click', (e) => { e.stopPropagation(); bubl.closeTab(tab.id); });
  node.addEventListener('click', () => {
    if (state.activeTabId === node.dataset.id) openCmd('current');
    else bubl.activateTab(node.dataset.id);
  });
  node.addEventListener('auxclick', (e) => { if (e.button === 1) bubl.closeTab(node.dataset.id); });
  wireDrag(node);

  const rec = { node, fav, title, close, data: {} };
  tabNodes.set(tab.id, rec);
  return rec;
}

function updateTabNode(rec, tab) {
  const d = rec.data;
  rec.node.classList.toggle('active', tab.active);

  if (d.loading !== tab.loading || d.favicon !== tab.favicon || d.isStartPage !== tab.isStartPage) {
    rec.fav.innerHTML = '';
    if (tab.loading) {
      rec.fav.className = 'tab-spinner';
    } else {
      rec.fav.className = 'tab-favicon';
      if (tab.favicon) {
        const img = el('img'); img.src = tab.favicon; img.onerror = () => { rec.fav.textContent = '🌐'; };
        rec.fav.appendChild(img);
      } else {
        rec.fav.textContent = tab.isStartPage ? '✦' : '🌐';
      }
    }
  }
  if (d.title !== tab.title) rec.title.textContent = tab.title || 'New Tab';
  rec.data = { loading: tab.loading, favicon: tab.favicon, isStartPage: tab.isStartPage, title: tab.title };
}

let dragId = null;
function wireDrag(node) {
  node.addEventListener('dragstart', (e) => { dragId = node.dataset.id; node.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  node.addEventListener('dragend', () => { dragId = null; node.classList.remove('dragging'); document.querySelectorAll('.tab.drop-target').forEach((n) => n.classList.remove('drop-target')); });
  node.addEventListener('dragover', (e) => { e.preventDefault(); document.querySelectorAll('.tab.drop-target').forEach((n) => n.classList.remove('drop-target')); if (node.dataset.id !== dragId) node.classList.add('drop-target'); });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault(); node.classList.remove('drop-target');
    if (!dragId || dragId === node.dataset.id) return;
    const ids = state.tabs.map((t) => t.id);
    const from = ids.indexOf(dragId), to = ids.indexOf(node.dataset.id);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    bubl.reorderTabs(ids);
  });
}

$('#new-tab-btn').addEventListener('click', () => openCmd('new'));

// ---------------------------------------------------------------------------
// Active-tab UI sync (nav buttons, address chip, star, security, count)
// ---------------------------------------------------------------------------
function syncActiveTabUi() {
  const tab = activeTab();
  $('#btn-back').disabled = !tab || !tab.canGoBack;
  $('#btn-forward').disabled = !tab || !tab.canGoForward;
  $('#btn-reload').textContent = tab && tab.loading ? '✕' : '⟳';

  const sec = $('#security-ico');
  const txt = $('#addr-text');
  if (tab && !tab.isStartPage && tab.url) {
    sec.textContent = tab.url.startsWith('https://') ? '🔒' : (tab.url.startsWith('http://') ? '⚠' : '✦');
    txt.textContent = prettyUrl(tab.url);
    txt.classList.remove('placeholder');
  } else {
    sec.textContent = '✦';
    txt.textContent = 'Search or enter address';
    txt.classList.add('placeholder');
  }

  $('#btn-star').textContent = tab && tab.bookmarked ? '★' : '☆';
  $('#block-count').textContent = state.blockCounts[state.activeTabId] || 0;
  $('#btn-reader').classList.toggle('active', !!(tab && tab.readerOn));
}

// ---------------------------------------------------------------------------
// Navigation buttons + window controls
// ---------------------------------------------------------------------------
$('#btn-back').addEventListener('click', () => state.activeTabId && bubl.back(state.activeTabId));
$('#btn-forward').addEventListener('click', () => state.activeTabId && bubl.forward(state.activeTabId));
$('#btn-reload').addEventListener('click', () => { const t = activeTab(); if (!t) return; t.loading ? bubl.stop(t.id) : bubl.reload(t.id); });
$('#btn-home').addEventListener('click', () => state.activeTabId && bubl.home(state.activeTabId));
$('#win-min').addEventListener('click', () => bubl.minimize());
$('#win-max').addEventListener('click', () => bubl.maximize());
$('#win-close').addEventListener('click', () => bubl.closeWindow());
$('#app-min').addEventListener('click', () => bubl.minimize());
$('#app-close').addEventListener('click', () => bubl.closeWindow());
$('#btn-incognito').addEventListener('click', () => bubl.openIncognito());
$('#btn-reader').addEventListener('click', () => { const t = activeTab(); if (t && !t.isStartPage) bubl.toggleReader(t.id); });
$('#addr-chip').addEventListener('click', () => openCmd('current'));
$('#start-cta').addEventListener('click', () => openCmd('current'));

// ---------------------------------------------------------------------------
// Floating command / search bar (Zen-style)
// ---------------------------------------------------------------------------
const cmdOverlay = $('#cmd-overlay');
const cmdInput = $('#cmd-input');

function openCmd(mode) {
  closeOverlay();
  state.cmd.open = true;
  state.cmd.mode = mode;
  state.cmd.index = -1;
  const tab = activeTab();
  const prefill = mode === 'current' && tab && !tab.isStartPage ? tab.url : '';
  cmdInput.value = prefill;
  $('#cmd-ico').textContent = mode === 'new' ? '✨' : '🔍';
  cmdInput.placeholder = mode === 'new' ? 'Open a new tab — search or enter an address'
                                        : 'Search the web or enter an address';
  $('#cmd-suggest').innerHTML = '';
  cmdOverlay.hidden = false;
  // The active tab's WebContentsView is a native layer above the HTML, so it
  // would cover the command bar. Hide it while the bar is open (this is the
  // fix for the bar "sometimes not appearing" over a loaded page).
  updateContentVisibility();
  cmdInput.focus(); cmdInput.select();
  requestAnimationFrame(() => { cmdInput.focus(); cmdInput.select(); });
  if (prefill) showCmdSuggest(prefill);
}

function closeCmd() {
  state.cmd.open = false;
  cmdOverlay.hidden = true;
  state.cmd.items = [];
  updateContentVisibility();
}

function submitCmd(value) {
  const v = (value != null ? value : cmdInput.value).trim();
  if (!v) return closeCmd();
  if (state.cmd.mode === 'new') bubl.newTab(v);
  else if (state.activeTabId) bubl.navigate(state.activeTabId, v);
  closeCmd();
}

cmdOverlay.addEventListener('mousedown', (e) => { if (e.target === cmdOverlay) closeCmd(); });
cmdInput.addEventListener('input', () => showCmdSuggest(cmdInput.value));
cmdInput.addEventListener('keydown', (e) => {
  const items = state.cmd.items;
  if (e.key === 'Escape') { e.preventDefault(); closeCmd(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const sel = state.cmd.index >= 0 ? items[state.cmd.index] : null;
    submitCmd(sel ? sel.value : cmdInput.value);
  } else if (e.key === 'ArrowDown' && items.length) {
    e.preventDefault(); state.cmd.index = Math.min(state.cmd.index + 1, items.length - 1); highlightCmd();
  } else if (e.key === 'ArrowUp' && items.length) {
    e.preventDefault(); state.cmd.index = Math.max(state.cmd.index - 1, -1); highlightCmd();
  }
});

async function showCmdSuggest(query) {
  const q = (query || '').trim();
  const seq = ++state.cmd.seq;
  if (!q) { state.cmd.items = []; renderCmdSuggest(); return; }

  const items = [{ type: 'go', value: q, title: q }];
  const hist = await bubl.historySuggest(q);
  if (seq !== state.cmd.seq) return;
  for (const h of hist) items.push({ type: 'history', value: h.url, title: h.title || h.url, url: h.url });

  const remote = await bubl.remoteSuggest(q);
  if (seq !== state.cmd.seq) return;
  for (const phrase of remote) {
    if (items.some((i) => i.title.toLowerCase() === phrase.toLowerCase())) continue;
    items.push({ type: 'search', value: phrase, title: phrase });
  }
  state.cmd.items = items.slice(0, 9);
  state.cmd.index = -1;
  renderCmdSuggest();
}

function renderCmdSuggest() {
  const box = $('#cmd-suggest');
  box.innerHTML = '';
  state.cmd.items.forEach((item, i) => {
    const node = el('div', 'suggest-item');
    node.dataset.index = i;
    const ico = el('span', 's-ico');
    ico.textContent = item.type === 'history' ? '⏱' : item.type === 'search' ? '🔍' : '➜';
    const title = el('span', 's-title'); title.textContent = item.title;
    node.append(ico, title);
    if (item.url) { const u = el('span', 's-url'); u.textContent = item.url; node.appendChild(u); }
    node.addEventListener('mousedown', (e) => { e.preventDefault(); submitCmd(item.value); });
    box.appendChild(node);
  });
}

function highlightCmd() {
  document.querySelectorAll('#cmd-suggest .suggest-item').forEach((n) =>
    n.classList.toggle('active', Number(n.dataset.index) === state.cmd.index));
  if (state.cmd.index >= 0) cmdInput.value = state.cmd.items[state.cmd.index].value;
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
// Overlays
// ---------------------------------------------------------------------------
const overlays = { history: $('#overlay-history'), bookmarks: $('#overlay-bookmarks'), settings: $('#overlay-settings') };
let openOverlayName = null;

function toggleOverlay(name) {
  if (openOverlayName === name) return closeOverlay();
  closeCmd();
  openOverlayName = name;
  for (const [k, n] of Object.entries(overlays)) n.hidden = k !== name;
  if (name === 'history') loadHistory();
  if (name === 'bookmarks') loadBookmarks();
  if (name === 'settings') loadSettings();
  updateContentVisibility();
}
function closeOverlay() {
  openOverlayName = null;
  for (const n of Object.values(overlays)) n.hidden = true;
  updateContentVisibility();
}
$('#btn-history').addEventListener('click', () => toggleOverlay('history'));
$('#btn-bookmarks').addEventListener('click', () => toggleOverlay('bookmarks'));
$('#btn-settings').addEventListener('click', () => toggleOverlay('settings'));
document.querySelectorAll('[data-close-overlay]').forEach((b) => b.addEventListener('click', closeOverlay));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openOverlayName) closeOverlay(); });

let lastContentVisible = null;
function updateContentVisibility() {
  const tab = activeTab();
  const startVisible = !openOverlayName && !state.cmd.open && tab && tab.isStartPage;
  $('#overlay-start').hidden = !startVisible;
  const visible = !openOverlayName && !state.cmd.open && !startVisible;
  if (visible !== lastContentVisible) { lastContentVisible = visible; bubl.setContentVisible(visible); }
  if (startVisible) renderStartShortcuts();
}

// ---------------------------------------------------------------------------
// Start page shortcuts
// ---------------------------------------------------------------------------
function updateStartStats() {
  const s = $('#stat-tabs'); if (s) s.textContent = state.tabs.length;
  const b = $('#stat-blocked'); if (b) {
    let total = 0; for (const k in state.blockCounts) total += state.blockCounts[k] || 0;
    b.textContent = total;
  }
  const sp = $('#stat-spaces'); if (sp) sp.textContent = state.spaces.length || 1;
}

function renderStartShortcuts() {
  updateStartStats();
  const wrap = $('#start-shortcuts');
  wrap.innerHTML = '';
  for (const b of state.bookmarks.slice(0, 8)) {
    const tile = el('div', 'shortcut-tile');
    const ico = el('div', 'st-ico'); ico.textContent = (hostname(b.url)[0] || '?').toUpperCase();
    const label = el('div', 'st-label'); label.textContent = b.title || hostname(b.url);
    tile.append(ico, label);
    tile.addEventListener('click', () => bubl.navigate(state.activeTabId, b.url));
    wrap.appendChild(tile);
  }
}

// ---------------------------------------------------------------------------
// History overlay
// ---------------------------------------------------------------------------
$('#history-search').addEventListener('input', (e) => loadHistory(e.target.value));
$('#history-clear').addEventListener('click', async () => { await bubl.historyClear(); loadHistory($('#history-search').value); });

async function loadHistory(query = '') {
  const entries = await bubl.historyList(query);
  const list = $('#history-list');
  list.innerHTML = '';
  if (!entries.length) { const n = el('div', 'empty-note'); n.textContent = query ? 'No matching history.' : 'No history yet.'; list.appendChild(n); return; }
  for (const entry of entries) list.appendChild(historyRow(entry));
}
function historyRow(entry) {
  const row = el('div', 'entry');
  const fav = el('div', 'e-fav'); fav.textContent = '⏱';
  const main = el('div', 'e-main');
  const t = el('div', 'e-title'); t.textContent = entry.title || entry.url;
  const u = el('div', 'e-url'); u.textContent = entry.url;
  main.append(t, u);
  main.addEventListener('click', () => { bubl.navigate(state.activeTabId, entry.url); closeOverlay(); });
  const time = el('div', 'e-time'); time.textContent = formatTime(entry.time);
  const del = el('button', 'e-del'); del.textContent = '🗑'; del.title = 'Remove';
  del.addEventListener('click', async () => { await bubl.historyRemove(entry.id); row.remove(); });
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
  if (!state.bookmarks.length) { const n = el('div', 'empty-note'); n.textContent = 'No bookmarks yet. Tap ☆ to add one.'; list.appendChild(n); return; }
  for (const b of state.bookmarks) {
    const row = el('div', 'entry');
    const fav = el('div', 'e-fav'); fav.textContent = '★';
    const main = el('div', 'e-main');
    const t = el('div', 'e-title'); t.textContent = b.title || b.url;
    const u = el('div', 'e-url'); u.textContent = b.url;
    main.append(t, u);
    main.addEventListener('click', () => { bubl.navigate(state.activeTabId, b.url); closeOverlay(); });
    const del = el('button', 'e-del'); del.textContent = '🗑';
    del.addEventListener('click', async () => { state.bookmarks = await bubl.bookmarksRemove(b.id); row.remove(); });
    row.append(fav, main, del);
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Settings overlay
// ---------------------------------------------------------------------------
async function loadSettings() {
  const st = await bubl.adblockState();
  $('#settings-adblock').checked = st.enabled;
  state.engines = await bubl.enginesList();
  renderEngines();
  $('#settings-radius').value = await bubl.getSetting('radiusFactor') || 1;
  $('#settings-smoothscroll').checked = !!(await bubl.getSetting('smoothScroll'));
}
$('#settings-adblock').addEventListener('change', (e) => bubl.adblockToggle(e.target.checked));
$('#settings-radius').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--radius-factor', e.target.value);
  bubl.setSetting('radiusFactor', Number(e.target.value));
});
$('#settings-smoothscroll').addEventListener('change', (e) => bubl.setSetting('smoothScroll', e.target.checked));

function renderEngines() {
  const wrap = $('#engines-list');
  wrap.innerHTML = '';
  for (const eng of state.engines.engines) {
    const item = el('div', 'engine-item' + (eng.id === state.engines.defaultId ? ' default' : ''));
    const name = el('div', 'eng-name'); name.textContent = eng.name;
    item.appendChild(name);
    if (eng.id !== state.engines.defaultId) {
      const setDef = el('button', 'pill-btn'); setDef.textContent = 'Set default';
      setDef.addEventListener('click', async () => { state.engines = await bubl.enginesSetDefault(eng.id); renderEngines(); });
      item.appendChild(setDef);
    }
    const rm = el('button', 'pill-btn'); rm.textContent = 'Remove';
    rm.addEventListener('click', async () => { state.engines = await bubl.enginesRemove(eng.id); renderEngines(); });
    item.appendChild(rm);
    wrap.appendChild(item);
  }
}
$('#engine-add-btn').addEventListener('click', async () => {
  const name = $('#engine-name').value.trim(), url = $('#engine-url').value.trim();
  if (!name || !url.includes('%s')) { flash($('#engine-url')); return; }
  state.engines = await bubl.enginesAdd({ name, url });
  $('#engine-name').value = ''; $('#engine-url').value = '';
  renderEngines();
});
function flash(node) { node.style.boxShadow = '0 0 0 2px #ff2d8f'; setTimeout(() => { node.style.boxShadow = ''; }, 800); }

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
$('#pop-global').addEventListener('change', (e) => { bubl.adblockToggle(e.target.checked); $('#settings-adblock').checked = e.target.checked; });
$('#pop-site').addEventListener('change', (e) => { const h = shieldPop.dataset.host; if (h) bubl.adblockToggleSite(h, e.target.checked); });
document.addEventListener('click', (e) => { if (!shieldPop.hidden && !shieldPop.contains(e.target) && e.target.closest('#btn-shield') === null) shieldPop.hidden = true; });

// ---------------------------------------------------------------------------
// Network footprint popover
// ---------------------------------------------------------------------------
const footprintPop = $('#footprint-pop');
$('#btn-footprint').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!footprintPop.hidden) { footprintPop.hidden = true; return; }
  const tab = activeTab();
  const domains = tab ? await bubl.networkFootprint(tab.id) : [];
  const list = $('#footprint-list');
  list.innerHTML = '';
  if (!domains.length) {
    const n = el('div', 'empty-note'); n.textContent = 'No requests recorded yet.'; list.appendChild(n);
  } else {
    domains.sort().forEach((d) => { const row = el('div', 'footprint-row'); row.textContent = d; list.appendChild(row); });
  }
  footprintPop.hidden = false;
});
document.addEventListener('click', (e) => { if (!footprintPop.hidden && !footprintPop.contains(e.target) && e.target.closest('#btn-footprint') === null) footprintPop.hidden = true; });

// ---------------------------------------------------------------------------
// Content bounds reporting (throttled via rAF; only sent when it changes)
// ---------------------------------------------------------------------------
const anchor = $('#webcontent-anchor');
let lastBounds = '';
let boundsQueued = false;
function reportBounds() {
  boundsQueued = false;
  const r = anchor.getBoundingClientRect();
  const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
  if (key === lastBounds) return;
  lastBounds = key;
  bubl.setContentBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
function queueBounds() { if (!boundsQueued) { boundsQueued = true; requestAnimationFrame(reportBounds); } }
new ResizeObserver(queueBounds).observe(anchor);
window.addEventListener('resize', queueBounds);
window.addEventListener('load', reportBounds);
setTimeout(reportBounds, 80);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hostname(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }
function prettyUrl(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : ''); }
  catch { return url; }
}
function formatTime(ts) {
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
