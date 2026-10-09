'use strict';

document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  browserAPI.go(document.getElementById('q').value);
});

let settings = null;
const $ = (id) => document.getElementById(id);

// ---- background and sections (Customize panel)

const SWATCHES = ['#2a1f4d', '#13294b', '#0f3b33', '#4a1d2f', '#3d2b12', '#1d1d24', '#e9e3ff', '#f4ecd8'];

async function applyLook() {
  const look = settings.newtab;
  document.body.classList.remove('bg-color', 'bg-image');
  document.body.style.removeProperty('--newtab-bg');
  document.body.style.backgroundImage = '';
  if (look.background === 'color') {
    document.body.classList.add('bg-color');
    document.body.style.setProperty('--newtab-bg', look.color);
    // light swatches get dark text
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(look.color.slice(i, i + 2), 16));
    document.body.classList.toggle('bg-light', r * 0.299 + g * 0.587 + b * 0.114 > 160);
  } else if (look.background === 'image') {
    const image = await browserAPI.getNewtabImage();
    if (image) {
      document.body.classList.add('bg-image');
      document.body.style.backgroundImage = `linear-gradient(rgba(5, 2, 11, 0.25), rgba(5, 2, 11, 0.45)), url("${image}")`;
    }
  }
  $('tiles').hidden = !look.showTiles;
  $('bookmarks-section').hidden = !look.showBookmarks;
}

async function saveLook(change) {
  settings.newtab = { ...settings.newtab, ...change };
  await browserAPI.setSetting('newtab', settings.newtab);
  applyLook();
}

function buildCustomize() {
  const panel = $('customize-panel');
  const swatches = $('swatches');
  swatches.textContent = '';
  const none = document.createElement('button');
  none.className = 'swatch none';
  none.title = 'No background';
  none.setAttribute('aria-label', 'No background');
  none.addEventListener('click', () => saveLook({ background: 'none' }));
  swatches.append(none);
  for (const color of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = color;
    b.title = color;
    b.setAttribute('aria-label', `Background ${color}`);
    b.addEventListener('click', () => saveLook({ background: 'color', color }));
    swatches.append(b);
  }
  $('custom-color').value = settings.newtab.color;
  $('show-tiles').checked = settings.newtab.showTiles;
  $('show-bookmarks').checked = settings.newtab.showBookmarks;
  $('show-stats').checked = settings.privacyStats !== false;
  panel.hidden = false;
}

$('customize').addEventListener('click', () => ($('customize-panel').hidden ? buildCustomize() : ($('customize-panel').hidden = true)));
$('customize-close').addEventListener('click', () => ($('customize-panel').hidden = true));
$('custom-color').addEventListener('change', (e) => saveLook({ background: 'color', color: e.target.value }));
$('choose-image').addEventListener('click', async () => {
  if (await browserAPI.chooseNewtabImage()) {
    settings.newtab = { ...settings.newtab, background: 'image' };
    applyLook();
  }
});
$('show-tiles').addEventListener('change', (e) => saveLook({ showTiles: e.target.checked }));
$('show-bookmarks').addEventListener('change', (e) => saveLook({ showBookmarks: e.target.checked }));
$('show-stats').addEventListener('change', async (e) => {
  settings.privacyStats = e.target.checked;
  await browserAPI.setSetting('privacyStats', e.target.checked);
  loadStats();
});

// Ads and trackers blocked (all normal windows), since the count started.
async function loadStats() {
  const stats = await browserAPI.getPrivacyStats();
  const el = $('stats');
  el.hidden = !stats || !stats.blocked;
  if (!stats || !stats.blocked) return;
  const since = new Date(stats.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  el.textContent = `${stats.blocked.toLocaleString()} ads and trackers blocked since ${since}`;
}
loadStats();

// ---- shortcut tiles: most visited, pinned first; pin / edit / remove; add your own

function tileIcon(t) {
  if (t.icon && /^data:image\//.test(t.icon)) {
    const img = document.createElement('img');
    img.className = 'icon';
    img.src = t.icon;
    img.alt = '';
    return img;
  }
  const letter = document.createElement('span');
  letter.className = 'letter';
  letter.textContent = (t.site || t.title || '?').charAt(0).toUpperCase();
  return letter;
}

async function savePinned(list) {
  settings.pinnedTiles = list;
  await browserAPI.setSetting('pinnedTiles', list);
  loadTiles();
}

function openTileMenu(t, anchor) {
  closeTileMenu();
  const menu = document.createElement('div');
  menu.className = 'tile-menu';
  menu.id = 'tile-menu';
  const item = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      closeTileMenu();
      fn();
    });
    menu.append(b);
  };
  const pinned = settings.pinnedTiles || [];
  if (t.pinned) item('Unpin', () => savePinned(pinned.filter((p) => p.url !== t.url)));
  else item('Pin', () => savePinned([...pinned, { url: t.url, title: t.title }].slice(0, 8)));
  item('Edit…', () => editTile(t));
  item('Remove', async () => {
    if (t.pinned) await savePinned(pinned.filter((p) => p.url !== t.url));
    else {
      await browserAPI.hideTile(t.site);
      loadTiles();
    }
  });
  anchor.append(menu);
}
function closeTileMenu() {
  $('tile-menu')?.remove();
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tile-more, #tile-menu')) closeTileMenu();
});

// Edit (or add, when t is null): a small form in place of the tiles.
function editTile(t) {
  const form = $('tile-form');
  $('tile-form-title').textContent = t ? 'Edit shortcut' : 'Add shortcut';
  $('tile-name').value = t ? t.title : '';
  $('tile-url').value = t ? t.url : '';
  form.dataset.editing = t ? t.url : '';
  form.hidden = false;
  $('tile-name').focus();
}
$('tile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let url = $('tile-url').value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!/^https?:\/\/\S+$/i.test(url)) return $('tile-url').focus();
  const title = $('tile-name').value.trim() || url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  const editing = e.target.dataset.editing;
  const pinned = (settings.pinnedTiles || []).filter((p) => p.url !== editing && p.url !== url);
  await savePinned([...pinned, { url, title: title.slice(0, 80) }].slice(0, 8));
  e.target.hidden = true;
});
$('tile-cancel').addEventListener('click', () => ($('tile-form').hidden = true));

async function loadTiles() {
  const tiles = $('tiles');
  tiles.textContent = '';
  const list = await browserAPI.getTopSites();
  for (const t of list) {
    const a = document.createElement('a');
    a.className = 'tile' + (t.pinned ? ' pinned' : '');
    a.href = t.url;
    a.title = t.url;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.title;
    const more = document.createElement('button');
    more.className = 'tile-more';
    more.textContent = '⋯';
    more.title = 'Pin, edit or remove';
    more.setAttribute('aria-label', `Options for ${t.title}`);
    more.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTileMenu(t, a);
    });
    a.append(tileIcon(t), name, more);
    if (t.pinned) {
      const pin = document.createElement('span');
      pin.className = 'pin-mark';
      pin.title = 'Pinned';
      a.append(pin);
    }
    tiles.append(a);
  }
  if (list.length < 8) {
    const add = document.createElement('button');
    add.className = 'tile add';
    add.innerHTML = '<span class="letter">+</span>';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = 'Add shortcut';
    add.append(name);
    add.addEventListener('click', () => editTile(null));
    tiles.append(add);
  }
}

// ---- bookmarks

browserAPI.getBookmarks().then((list) => {
  // bookmarks only (folders are skipped), most recently added first
  list = list.filter((b) => b.type !== 'folder');
  $('bookmarks-heading').hidden = list.length === 0;
  const sites = $('sites');
  for (const b of list.slice(0, 12)) {
    const a = document.createElement('a');
    a.href = b.url;
    if (b.icon && /^data:image\//.test(b.icon)) {
      const img = document.createElement('img');
      img.src = b.icon;
      img.alt = '';
      a.append(img);
    }
    a.append(b.title || b.url);
    a.title = b.url;
    sites.append(a);
  }
});

browserAPI.getSettings().then((s) => {
  settings = s;
  $('q').placeholder = `Search ${s.searchEngineName} or enter address`;
  applyLook();
  loadTiles();
});
