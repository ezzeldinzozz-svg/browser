'use strict';

const NAMES = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard',
  midi: 'MIDI devices',
  midiSysex: 'MIDI full control',
  openExternal: 'Open apps',
  'automatic-downloads': 'Automatic downloads',
  autoplay: 'Autoplay',
};

const ACCENT_SWATCHES = [
  ['violet', 'Violet', '#9b6cff'],
  ['blue', 'Blue', '#4f8cff'],
  ['emerald', 'Emerald', '#2ecc8f'],
  ['amber', 'Amber', '#f5a524'],
  ['rose', 'Rose', '#f76a8a'],
  ['cyan', 'Cyan', '#36c2d6'],
];

const TOOLBAR_ICONS = {
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  shield: '<path d="M12 3l7.5 3v5.8c0 4.7-3.2 8.8-7.5 10.2-4.3-1.4-7.5-5.5-7.5-10.2V6z"/>',
  reader: '<path d="M5 6h14M5 10h14M5 14h9M5 18h12"/>',
  media: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/>',
  screenshot: '<path d="M4 8h3l2-2h6l2 2h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"/><circle cx="12" cy="13.5" r="3.2"/>',
  translate: '<path d="M4 5h10M9 3v2M6 5c0 4.5 2.5 8 6.5 9.5M11.5 5C10.5 9 8 12.5 4 14.5"/><path d="M13 19l4-9 4 9M14.3 16h5.4"/>',
  readAloud: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6M18.8 6.5a8 8 0 0 1 0 11"/>',
  bookmarks: '<path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1z"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  downloads: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  profile: '<circle cx="12" cy="8.5" r="3.8"/><path d="M5 20c0-3.8 3.1-6.5 7-6.5s7 2.7 7 6.5"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

const list = document.getElementById('list');
const adblock = document.getElementById('adblock');
const allowlist = document.getElementById('allowlist');
const engine = document.getElementById('engine');

// ---- Reusable pagination helper for settings lists

const listPageState = {};

function renderPaginatedList(container, items, pageSize, renderRow, emptyText, key = container.id) {
  container.textContent = '';
  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  let page = listPageState[key] || 1;
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  listPageState[key] = page;

  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  for (const item of slice) {
    container.append(renderRow(item));
  }

  if (totalPages > 1) {
    const pager = document.createElement('div');
    pager.className = 'list-pager';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = '← Previous';
    prev.disabled = page <= 1;
    prev.addEventListener('click', () => {
      listPageState[key] = page - 1;
      renderPaginatedList(container, items, pageSize, renderRow, emptyText, key);
    });

    const pagesWrap = document.createElement('div');
    pagesWrap.className = 'pager-pages';
    for (let p = 1; p <= totalPages; p++) {
      if (totalPages > 7 && p !== 1 && p !== totalPages && Math.abs(p - page) > 1) {
        if (p === 2 || p === totalPages - 1) {
          const dots = document.createElement('span');
          dots.className = 'pager-info';
          dots.textContent = '…';
          pagesWrap.append(dots);
        }
        continue;
      }
      const numBtn = document.createElement('button');
      numBtn.type = 'button';
      numBtn.className = 'pager-num' + (p === page ? ' active' : '');
      numBtn.textContent = String(p);
      numBtn.addEventListener('click', () => {
        listPageState[key] = p;
        renderPaginatedList(container, items, pageSize, renderRow, emptyText, key);
      });
      pagesWrap.append(numBtn);
    }

    const info = document.createElement('span');
    info.className = 'pager-info';
    info.textContent = `Page ${page} of ${totalPages} · ${items.length} items`;

    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = 'Next →';
    next.disabled = page >= totalPages;
    next.addEventListener('click', () => {
      listPageState[key] = page + 1;
      renderPaginatedList(container, items, pageSize, renderRow, emptyText, key);
    });

    pager.append(prev, pagesWrap, info, next);
    container.append(pager);
  }
}

// ---- Category Tabs & Tab Footer Pagination

const TAB_ORDER = ['general', 'appearance', 'privacy', 'sites', 'profiles', 'system'];
const TAB_TITLES = {
  general: 'General & Search',
  appearance: 'Appearance & Toolbar',
  privacy: 'Privacy & Security',
  sites: 'Sites & Permissions',
  profiles: 'Profiles & Autofill',
  system: 'Apps, System & About',
};
let activeTabId = 'general';

function selectSettingsTab(tabId, { scrollTop = true } = {}) {
  if (!TAB_ORDER.includes(tabId)) tabId = 'general';
  activeTabId = tabId;
  const searchInput = document.getElementById('settings-search');
  if (searchInput && searchInput.value.trim()) {
    searchInput.value = '';
    clearSearchFilter();
  }
  for (const btn of document.querySelectorAll('.settings-tab')) {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const panel of document.querySelectorAll('.settings-panel')) {
    const active = panel.dataset.tab === tabId;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
  updateTabPager();
  if (scrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateTabPager() {
  const idx = TAB_ORDER.indexOf(activeTabId);
  const prevBtn = document.getElementById('tab-prev');
  const nextBtn = document.getElementById('tab-next');
  const dotsBox = document.getElementById('tab-dots');
  if (!prevBtn || !nextBtn || !dotsBox) return;

  if (idx > 0) {
    prevBtn.disabled = false;
    prevBtn.textContent = `← ${TAB_TITLES[TAB_ORDER[idx - 1]]}`;
  } else {
    prevBtn.disabled = true;
    prevBtn.textContent = '← Previous';
  }
  if (idx < TAB_ORDER.length - 1) {
    nextBtn.disabled = false;
    nextBtn.textContent = `${TAB_TITLES[TAB_ORDER[idx + 1]]} →`;
  } else {
    nextBtn.disabled = true;
    nextBtn.textContent = 'Next →';
  }

  dotsBox.textContent = '';
  TAB_ORDER.forEach((id, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'tab-dot' + (id === activeTabId ? ' active' : '');
    dot.title = `${i + 1}. ${TAB_TITLES[id]}`;
    dot.setAttribute('aria-label', TAB_TITLES[id]);
    dot.textContent = String(i + 1);
    dot.addEventListener('click', () => selectSettingsTab(id));
    dotsBox.append(dot);
  });
}

for (const btn of document.querySelectorAll('.settings-tab')) {
  btn.addEventListener('click', () => selectSettingsTab(btn.dataset.tab));
}
document.getElementById('tab-prev').addEventListener('click', () => {
  const idx = TAB_ORDER.indexOf(activeTabId);
  if (idx > 0) selectSettingsTab(TAB_ORDER[idx - 1]);
});
document.getElementById('tab-next').addEventListener('click', () => {
  const idx = TAB_ORDER.indexOf(activeTabId);
  if (idx < TAB_ORDER.length - 1) selectSettingsTab(TAB_ORDER[idx + 1]);
});

function handleHashNavigation() {
  const h = (location.hash || '').replace(/^#/, '');
  if (!h) return updateTabPager();
  if (h === 'clear') {
    selectSettingsTab('privacy', { scrollTop: false });
    setTimeout(() => document.getElementById('clear')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  } else if (h === 'profiles') {
    selectSettingsTab('profiles', { scrollTop: false });
  } else if (TAB_ORDER.includes(h)) {
    selectSettingsTab(h, { scrollTop: false });
  } else {
    const target = document.getElementById(h);
    const panel = target && target.closest('.settings-panel');
    if (panel && panel.dataset.tab) {
      selectSettingsTab(panel.dataset.tab, { scrollTop: false });
      setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  }
}
window.addEventListener('hashchange', handleHashNavigation);
handleHashNavigation();

// ---- Settings loading & rendering

let latestToolbarButtons = {};
let latestToolbarDefs = [];

async function loadSettings() {
  const s = await browserAPI.getSettings();
  document.documentElement.dataset.accent = s.accentColor || 'violet';
  for (const r of document.querySelectorAll('input[name="startup"]')) r.checked = r.value === s.startupMode;
  document.getElementById('startup-pages-box').hidden = s.startupMode !== 'pages';
  document.getElementById('startup-pages').value = (s.startupPages || []).join('\n');
  document.getElementById('show-home').checked = !!(s.toolbarButtons ? s.toolbarButtons.home : s.showHomeButton);
  document.getElementById('show-bookmarks-bar').checked = s.showBookmarksBar !== false;
  document.getElementById('theme').value = s.theme || 'system';
  document.getElementById('compact-mode').checked = !!s.compactMode;
  document.getElementById('vertical-tabs').checked = !!s.verticalTabs;
  document.getElementById('vertical-tabs-collapsed').checked = !!s.verticalTabsCollapsed;
  document.getElementById('vertical-tabs-hover').checked = s.verticalTabsExpandOnHover !== false;
  document.getElementById('vertical-newtab-under').checked = s.verticalNewTabUnderTabs !== false;
  document.getElementById('reject-cookies').checked = s.rejectCookies !== false;
  document.getElementById('fingerprinting-protection').checked = s.fingerprintingProtection !== false;
  renderAccentSwatches(s.accentColor || 'violet');
  latestToolbarButtons = s.toolbarButtons || {};
  latestToolbarDefs = s.toolbarButtonDefs || [];
  renderToolbarButtons(latestToolbarDefs, latestToolbarButtons);
  renderProtocolHandlers(s.protocolHandlers || {});
  renderInstalledApps(s.installedApps || []);
  document.getElementById('strip-tracking').checked = s.stripTracking !== false;
  document.getElementById('energy-saver').checked = s.energySaver !== false;
  document.getElementById('history-keep').value = String(s.historyKeepDays || 0);
  for (const k of ['history', 'downloads', 'cookies', 'cache']) document.getElementById(`quit-${k}`).checked = !!(s.clearOnQuit && s.clearOnQuit[k]);
  const uiSelect = document.getElementById('ui-language');
  if (uiSelect.options.length === 1) for (const l of s.uiLanguages) uiSelect.append(new Option(l.name, l.id));
  uiSelect.value = s.uiLanguage || 'auto';
  document.getElementById('confirm-close').checked = s.confirmClose;
  document.getElementById('gpc').checked = s.gpc;
  document.getElementById('search-suggestions').checked = s.searchSuggestions;
  document.getElementById('https-only').checked = s.httpsOnly;
  document.getElementById('memory-saver').checked = s.memorySaver;
  document.getElementById('memory-saver-minutes').value = String(s.memorySaverMinutes);
  document.getElementById('languages').value = s.languages.join(', ');
  document.getElementById('languages-hint').textContent = s.languages.length
    ? 'Sites can use these to pick a language. Leave empty to use your system languages.'
    : `Using your system languages: ${s.systemLanguages.join(', ')}. Type a list to change it.`;
  document.getElementById('spellcheck').checked = s.spellcheck;
  document.getElementById('autoplay').value = s.autoplay;
  const zoomSelect = document.getElementById('default-zoom');
  if (!zoomSelect.options.length) for (const z of [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]) zoomSelect.append(new Option(`${z}%`, String(z)));
  zoomSelect.value = String(s.defaultZoom);
  document.getElementById('dns').value = s.dns;
  document.getElementById('proxy-mode').value = s.proxyMode || 'system';
  document.getElementById('proxy-server').value = s.proxyServer || '';
  document.getElementById('proxy-bypass').value = s.proxyBypass || '';
  document.getElementById('proxy-pac-url').value = s.proxyPac || '';
  document.getElementById('proxy-manual').hidden = s.proxyMode !== 'manual';
  document.getElementById('proxy-pac').hidden = s.proxyMode !== 'pac';
  document.getElementById('dns-custom').value = s.dnsCustom || '';
  document.getElementById('dns-custom').hidden = s.dns !== 'custom';
  document.getElementById('home-page').value = s.homePage || '';
  engine.textContent = '';
  for (const e of s.searchEngines) engine.append(new Option(e.name, e.id));
  engine.value = s.searchEngine;
  renderEngines(s.searchEngines);
  document.getElementById('tpc').checked = s.blockThirdPartyCookies;
  document.getElementById('tpc-restart').hidden = s.blockThirdPartyCookies === s.thirdPartyCookiesBlockedNow;
  document.getElementById('download-dir').textContent = s.downloadDirShown;
  document.getElementById('ask-download').checked = s.askDownloadLocation;
  adblock.checked = s.adblock;
  renderPaginatedList(
    allowlist,
    s.adblockAllowlist || [],
    8,
    (site) => {
      const row = document.createElement('div');
      row.className = 'row';
      const main = document.createElement('div');
      main.className = 'main t';
      main.textContent = site;
      const remove = document.createElement('button');
      remove.textContent = 'Turn blocking back on';
      remove.addEventListener('click', async () => {
        await browserAPI.removeAdblockException(site);
        loadSettings();
      });
      row.append(main, remove);
      return row;
    },
    'None.',
  );
}

function renderToolbarButtons(defs, state) {
  const grid = document.getElementById('toolbar-buttons-grid');
  if (!grid) return;
  grid.textContent = '';
  for (const d of defs) {
    const isOn = !!state[d.id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'toolbar-btn-card' + (isOn ? ' on' : '');
    card.setAttribute('aria-pressed', String(isOn));

    const iconWrap = document.createElement('span');
    iconWrap.className = 'toolbar-btn-ico';
    iconWrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${TOOLBAR_ICONS[d.id] || ''}</svg>`;

    const meta = document.createElement('span');
    meta.className = 'toolbar-btn-meta';
    const title = document.createElement('span');
    title.className = 'toolbar-btn-name';
    title.textContent = d.label;
    const badge = document.createElement('span');
    badge.className = 'toolbar-btn-state';
    badge.textContent = isOn ? 'Shown in toolbar' : 'Hidden';
    meta.append(title, badge);

    card.append(iconWrap, meta);
    card.addEventListener('click', async () => {
      const next = { ...latestToolbarButtons, [d.id]: !isOn };
      latestToolbarButtons = next;
      if (d.id === 'home') document.getElementById('show-home').checked = !!next.home;
      await browserAPI.setSetting('toolbarButtons', next);
      renderToolbarButtons(latestToolbarDefs, latestToolbarButtons);
    });
    grid.append(card);
  }
}

document.getElementById('toolbar-reset').addEventListener('click', async () => {
  const defaults = {};
  for (const d of latestToolbarDefs) defaults[d.id] = !!d.defaultOn;
  latestToolbarButtons = defaults;
  document.getElementById('show-home').checked = !!defaults.home;
  await browserAPI.setSetting('toolbarButtons', defaults);
  renderToolbarButtons(latestToolbarDefs, latestToolbarButtons);
});

function renderAccentSwatches(current) {
  const box = document.getElementById('accent-swatches');
  box.textContent = '';
  for (const [id, label, hex] of ACCENT_SWATCHES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'accent-swatch' + (id === current ? ' sel' : '');
    btn.style.background = hex;
    btn.title = label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-checked', String(id === current));
    btn.addEventListener('click', async () => {
      document.documentElement.dataset.accent = id;
      await browserAPI.setSetting('accentColor', id);
      renderAccentSwatches(id);
    });
    box.append(btn);
  }
}

function renderProtocolHandlers(handlers) {
  const box = document.getElementById('protocol-handlers');
  box.textContent = '';
  const entries = Object.entries(handlers);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No protocol handlers registered.';
    box.append(empty);
    return;
  }
  for (const [scheme, h] of entries) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    main.className = 'main';
    const t = document.createElement('div');
    t.className = 't';
    const code = document.createElement('code');
    code.textContent = `${scheme}:`;
    t.append(code, ` → ${h.site || h.url}`);
    main.append(t);
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      renderProtocolHandlers(await browserAPI.removeProtocolHandler(scheme));
    });
    row.append(main, remove);
    box.append(row);
  }
}

function renderInstalledApps(apps) {
  const box = document.getElementById('installed-apps');
  renderPaginatedList(
    box,
    apps || [],
    6,
    (a) => {
      const row = document.createElement('div');
      row.className = 'row';
      const main = document.createElement('div');
      main.className = 'main';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = a.name || a.title || a.url;
      const u = document.createElement('div');
      u.className = 'u';
      u.textContent = a.url;
      main.append(t, u);
      const open = document.createElement('button');
      open.textContent = 'Open';
      open.addEventListener('click', () => browserAPI.openInstalledApp(a.id));
      const remove = document.createElement('button');
      remove.textContent = 'Uninstall';
      remove.addEventListener('click', async () => {
        renderInstalledApps(await browserAPI.removeInstalledApp(a.id));
      });
      row.append(main, open, remove);
      return row;
    },
    'No installed web apps.',
  );
}

adblock.addEventListener('change', () => browserAPI.setSetting('adblock', adblock.checked));
engine.addEventListener('change', () => browserAPI.setSetting('searchEngine', engine.value));
loadSettings();

let permissionNames = NAMES;

async function load() {
  const [sites, defaults] = await Promise.all([browserAPI.getPermissions(), browserAPI.getPermissionDefaults()]);
  permissionNames = { ...NAMES, ...defaults.names };

  // per-type defaults
  const grid = document.getElementById('perm-defaults');
  grid.textContent = '';
  for (const d of defaults.keys) {
    const label = document.createElement('label');
    label.textContent = d.name;
    const select = document.createElement('select');
    select.append(new Option('Ask', 'ask'), new Option('Block', 'block'));
    select.value = d.value;
    select.addEventListener('change', () => browserAPI.setPermissionDefault(d.key, select.value));
    label.append(select);
    grid.append(label);
  }
  const addKey = document.getElementById('perm-add-key');
  if (!addKey.options.length) for (const d of defaults.keys) addKey.append(new Option(d.name, d.key));

  // exceptions: one row per site, paginated
  const origins = Object.keys(sites).sort();
  renderPaginatedList(
    list,
    origins,
    6,
    (origin) => {
      const row = document.createElement('div');
      row.className = 'row perm-row';
      const main = document.createElement('div');
      main.className = 'main';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = origin;
      main.append(t);
      const perms = document.createElement('div');
      perms.className = 'perm-list';
      for (const [key, value] of Object.entries(sites[origin])) {
        const label = document.createElement('label');
        label.textContent = permissionNames[key] || key;
        const select = document.createElement('select');
        select.append(new Option('Allow', 'allow'), new Option('Block', 'block'), new Option('Ask (remove)', 'ask'));
        select.value = value;
        select.addEventListener('change', async () => {
          await browserAPI.setSitePermissionFromSettings(origin, key, select.value);
          load();
        });
        label.append(select);
        perms.append(label);
      }
      main.append(perms);

      const reset = document.createElement('button');
      reset.textContent = 'Remove all';
      reset.addEventListener('click', async () => {
        await browserAPI.resetPermissions(origin);
        load();
      });
      row.append(main, reset);
      return row;
    },
    'No exceptions yet.',
  );
}

document.getElementById('perm-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const site = document.getElementById('perm-add-site');
  const ok = await browserAPI.setSitePermissionFromSettings(
    site.value.trim(),
    document.getElementById('perm-add-key').value,
    document.getElementById('perm-add-value').value,
  );
  if (ok) site.value = '';
  else site.setCustomValidity('Enter a site like example.com');
  site.reportValidity();
  setTimeout(() => site.setCustomValidity(''), 1500);
  load();
});

load();

// ---- About / updates

const aboutStatus = document.getElementById('about-status');
const aboutAction = document.getElementById('about-action');
let aboutState = null;

function when(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return new Date(ts).toLocaleString();
}

function renderAbout({ version, update }) {
  aboutState = update;
  document.getElementById('about-version').textContent = `Version ${version}`;
  const checked = update.checkedAt ? ` · Last checked ${when(update.checkedAt)}` : '';
  const percent = update.progress >= 0 ? `${Math.floor(update.progress * 100)}%` : '';
  const text = {
    idle: 'Checks for updates automatically',
    checking: 'Checking for updates…',
    downloading: `Downloading version ${update.version}… ${percent}`,
    ready: `Version ${update.version} is ready. Restart to finish updating.`,
    none: `You're up to date${checked}`,
    error: `Couldn't check for updates: ${update.error || 'unknown error'}${checked}`,
    unsupported: update.error || "Automatic updates aren't available here.",
  }[update.status] || '';
  aboutStatus.textContent = text;
  aboutAction.hidden = update.status === 'unsupported';
  aboutAction.disabled = update.status === 'checking' || update.status === 'downloading';
  aboutAction.textContent = update.status === 'ready' ? 'Restart to update' : 'Check for updates';
  aboutAction.classList.toggle('primary', update.status === 'ready');
}

async function refreshAbout() {
  renderAbout(await browserAPI.getAbout());
}

aboutAction.addEventListener('click', async () => {
  if (aboutState && aboutState.status === 'ready') return browserAPI.installUpdateFromSettings();
  const pending = browserAPI.checkForUpdates();
  refreshAbout();
  await pending;
  refreshAbout();
});

refreshAbout();
setInterval(refreshAbout, 1000);

// ---- Clear browsing data

document.getElementById('clear-go').addEventListener('click', async () => {
  const done = document.getElementById('clear-done');
  const checked = (id) => document.getElementById(id).checked;
  done.textContent = 'Clearing…';
  await browserAPI.clearBrowsingData({
    range: document.getElementById('clear-range').value,
    history: checked('clear-history'),
    downloads: checked('clear-downloads'),
    cookies: checked('clear-cookies'),
    cache: checked('clear-cache'),
  });
  done.textContent = 'Done.';
});

// ---- Default browser

async function refreshDefault() {
  const { supported, isDefault } = await browserAPI.getDefaultBrowser();
  const status = document.getElementById('default-status');
  const btn = document.getElementById('default-set');
  status.textContent = !supported
    ? 'Only the installed app can be the default browser.'
    : isDefault
      ? 'Operecs is your default browser.'
      : 'Operecs is not your default browser.';
  btn.hidden = !supported || isDefault;
}

document.getElementById('default-set').addEventListener('click', async () => {
  await browserAPI.setDefaultBrowser();
  setTimeout(refreshDefault, 1500);
});
refreshDefault();
window.addEventListener('focus', refreshDefault);

// ---- Downloads

document.getElementById('download-dir-change').addEventListener('click', async () => {
  const dir = await browserAPI.chooseDownloadFolder();
  if (dir) document.getElementById('download-dir').textContent = dir;
});
document.getElementById('ask-download').addEventListener('change', (e) =>
  browserAPI.setSetting('askDownloadLocation', e.target.checked),
);

// ---- Third-party cookies

document.getElementById('tpc').addEventListener('change', async (e) => {
  await browserAPI.setSetting('blockThirdPartyCookies', e.target.checked);
  loadSettings();
});
document.getElementById('tpc-restart-now').addEventListener('click', () => browserAPI.relaunch());

// ---- On startup / home

for (const r of document.querySelectorAll('input[name="startup"]')) {
  r.addEventListener('change', async () => {
    await browserAPI.setSetting('startup', r.value);
    loadSettings();
  });
}

async function saveStartupPages() {
  const urls = document
    .getElementById('startup-pages')
    .value.split('\n')
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`));
  await browserAPI.setSetting('startupPages', urls);
  document.getElementById('startup-pages-saved').textContent = 'Saved.';
}
document.getElementById('startup-pages').addEventListener('change', saveStartupPages);
document.getElementById('startup-use-current').addEventListener('click', async () => {
  document.getElementById('startup-pages').value = (await browserAPI.currentPagesForStartup()).join('\n');
  saveStartupPages();
});
document.getElementById('show-home').addEventListener('change', async (e) => {
  await browserAPI.setSetting('showHomeButton', e.target.checked);
  latestToolbarButtons = { ...latestToolbarButtons, home: e.target.checked };
  renderToolbarButtons(latestToolbarDefs, latestToolbarButtons);
});
document.getElementById('show-bookmarks-bar').addEventListener('change', (e) =>
  browserAPI.setSetting('showBookmarksBar', e.target.checked),
);
document.getElementById('theme').addEventListener('change', (e) => browserAPI.setSetting('theme', e.target.value));
document.getElementById('home-page').addEventListener('change', (e) => {
  let v = e.target.value.trim();
  if (v && !/^[a-z]+:\/\//i.test(v)) v = `https://${v}`;
  e.target.value = v;
  browserAPI.setSetting('homePage', v);
});
document.getElementById('confirm-close').addEventListener('change', (e) => browserAPI.setSetting('confirmClose', e.target.checked));

// ---- Privacy: GPC and secure DNS
document.getElementById('gpc').addEventListener('change', (e) => browserAPI.setSetting('gpc', e.target.checked));
document.getElementById('search-suggestions').addEventListener('change', (e) => browserAPI.setSetting('searchSuggestions', e.target.checked));
document.getElementById('dns').addEventListener('change', async (e) => {
  const custom = document.getElementById('dns-custom');
  custom.hidden = e.target.value !== 'custom';
  if (e.target.value !== 'custom' || /^https:\/\//i.test(custom.value)) await browserAPI.setSetting('dns', e.target.value);
  if (e.target.value === 'custom') custom.focus();
});
document.getElementById('dns-custom').addEventListener('change', async (e) => {
  const value = e.target.value.trim();
  if (!/^https:\/\/\S+$/i.test(value)) {
    e.target.setCustomValidity('Enter an https:// DNS-over-HTTPS address');
    e.target.reportValidity();
    return;
  }
  e.target.setCustomValidity('');
  await browserAPI.setSetting('dnsCustom', value);
  await browserAPI.setSetting('dns', 'custom');
});

// ---- Sites: autoplay and default zoom
document.getElementById('autoplay').addEventListener('change', (e) => browserAPI.setSetting('autoplay', e.target.value));
document.getElementById('default-zoom').addEventListener('change', (e) => browserAPI.setSetting('defaultZoom', Number(e.target.value)));

// ---- Reset
document.getElementById('reset-settings').addEventListener('click', async (e) => {
  if (e.target.dataset.confirm !== '1') {
    e.target.dataset.confirm = '1';
    e.target.textContent = 'Click again to reset every setting';
    return;
  }
  await browserAPI.resetSettings();
  location.reload();
});

// ---- Cross-tab Search Filtering
function clearSearchFilter() {
  document.getElementById('settings-search-empty').hidden = true;
  document.getElementById('settings-tab-pager').hidden = false;
  for (const card of document.querySelectorAll('.settings-card')) {
    card.classList.remove('filtered-out');
  }
  for (const panel of document.querySelectorAll('.settings-panel')) {
    const active = panel.dataset.tab === activeTabId;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
}

(() => {
  const cards = [...document.querySelectorAll('.settings-card')].filter((c) => c.id !== 'settings-search-empty');
  const cardText = (c) =>
    (c.textContent + ' ' + [...c.querySelectorAll('option, input')].map((el) => el.textContent || el.placeholder || '').join(' ')).toLowerCase();

  document.getElementById('settings-search').addEventListener('input', (e) => {
    const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      clearSearchFilter();
      return;
    }
    document.getElementById('settings-tab-pager').hidden = true;
    let totalShown = 0;
    for (const panel of document.querySelectorAll('.settings-panel')) {
      const panelCards = [...panel.querySelectorAll('.settings-card')];
      let panelMatches = 0;
      for (const card of panelCards) {
        const match = words.every((w) => cardText(card).includes(w));
        card.classList.toggle('filtered-out', !match);
        if (match) {
          panelMatches++;
          totalShown++;
        }
      }
      panel.hidden = panelMatches === 0;
    }
    document.getElementById('settings-search-empty').hidden = totalShown > 0;
  });
})();

// ---- HTTPS-Only, memory saver, languages
document.getElementById('https-only').addEventListener('change', (e) => browserAPI.setSetting('httpsOnly', e.target.checked));
document.getElementById('memory-saver').addEventListener('change', (e) => browserAPI.setSetting('memorySaver', e.target.checked));
document.getElementById('memory-saver-minutes').addEventListener('change', (e) => browserAPI.setSetting('memorySaverMinutes', Number(e.target.value)));
document.getElementById('spellcheck').addEventListener('change', (e) => browserAPI.setSetting('spellcheck', e.target.checked));
document.getElementById('languages').addEventListener('change', async (e) => {
  const list = e.target.value.split(/[,\s]+/).map((l) => l.trim()).filter(Boolean);
  const valid = list.every((l) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l));
  e.target.setCustomValidity(valid ? '' : 'Use language codes like en-US, fr or ar');
  e.target.reportValidity();
  if (valid) {
    await browserAPI.setSetting('languages', list);
    loadSettings();
  }
});

// ---- cookies and site data (paginated)
let siteData = null;
const siteDataBox = document.getElementById('sitedata');
const siteDataSearch = document.getElementById('sitedata-search');

function renderSiteData() {
  if (!siteData) {
    siteDataBox.textContent = '';
    return;
  }
  const q = siteDataSearch.value.trim().toLowerCase();
  const shown = siteData.filter((d) => !q || d.site.includes(q) || d.hosts.some((h) => h.includes(q)));
  document.getElementById('sitedata-all').hidden = siteData.length === 0;
  renderPaginatedList(
    siteDataBox,
    shown,
    10,
    (d) => {
      const row = document.createElement('div');
      row.className = 'row';
      const main = document.createElement('div');
      main.className = 'main t';
      main.textContent = d.site;
      const meta = document.createElement('span');
      meta.className = 'hint';
      meta.textContent = ` ${d.cookies} cookie${d.cookies === 1 ? '' : 's'}`;
      main.title = d.hosts.join('\n');
      main.append(meta);
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        await browserAPI.removeSiteData(d.site);
        siteData = siteData.filter((x) => x !== d);
        renderSiteData();
      });
      row.append(main, remove);
      return row;
    },
    siteData.length ? 'No matching sites.' : 'No sites have stored cookies.',
  );
}

async function loadSiteData() {
  siteData = await browserAPI.getSiteData();
  document.getElementById('sitedata-load').textContent = 'Refresh';
  listPageState.sitedata = 1;
  renderSiteData();
}
document.getElementById('sitedata-load').addEventListener('click', loadSiteData);
siteDataSearch.addEventListener('input', () => {
  listPageState.sitedata = 1;
  if (siteData) renderSiteData();
  else loadSiteData();
});
document.getElementById('sitedata-all').addEventListener('click', async () => {
  if (!confirm('Remove cookies and site data for every site? This signs you out of all sites.')) return;
  await browserAPI.removeAllSiteData();
  loadSiteData();
});

// ---- search engines and keywords (paginated)
function renderEngines(engines) {
  const box = document.getElementById('engines');
  renderPaginatedList(
    box,
    engines || [],
    6,
    (e) => {
      const row = document.createElement('div');
      row.className = 'row';
      const main = document.createElement('div');
      main.className = 'main t';
      main.textContent = e.name;
      const kw = document.createElement('code');
      kw.textContent = e.keyword;
      kw.style.marginLeft = '8px';
      main.append(kw);
      main.title = e.url;
      row.append(main);
      if (e.custom) {
        const remove = document.createElement('button');
        remove.textContent = 'Remove';
        remove.addEventListener('click', async () => {
          await browserAPI.removeSearchEngine(e.keyword);
          loadSettings();
        });
        row.append(remove);
      }
      return row;
    },
    'No search engines configured.',
  );
}

document.getElementById('engine-add').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = document.getElementById('engine-name').value.trim();
  const keyword = document.getElementById('engine-keyword').value.trim();
  const url = document.getElementById('engine-url').value.trim();
  const result = await browserAPI.addSearchEngine(name, keyword, url);
  const error = document.getElementById('engine-error');
  error.hidden = result === 'ok';
  error.textContent = {
    invalid: 'Fill in a name, a keyword without spaces, and an http(s) address containing %s where the search words go.',
    'keyword-taken': `Another search engine already uses the keyword "${keyword}".`,
    'too-many': 'You can add up to 30 search engines.',
  }[result] || '';
  if (result === 'ok') {
    for (const id of ['engine-name', 'engine-keyword', 'engine-url']) document.getElementById(id).value = '';
    loadSettings();
  }
});

// ---- custom spellcheck dictionary (paginated)
async function loadDictionary() {
  const box = document.getElementById('dictionary');
  const words = await browserAPI.getDictionaryWords();
  renderPaginatedList(
    box,
    words || [],
    8,
    (word) => {
      const row = document.createElement('div');
      row.className = 'row';
      const main = document.createElement('div');
      main.className = 'main t';
      main.textContent = word;
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        await browserAPI.removeDictionaryWord(word);
        loadDictionary();
      });
      row.append(main, remove);
      return row;
    },
    'No words added yet.',
  );
}
loadDictionary();

// ---- proxy
const proxySaved = () => {
  const note = document.getElementById('proxy-saved');
  note.hidden = false;
  setTimeout(() => (note.hidden = true), 2500);
};
document.getElementById('proxy-mode').addEventListener('change', async (e) => {
  const mode = e.target.value;
  document.getElementById('proxy-manual').hidden = mode !== 'manual';
  document.getElementById('proxy-pac').hidden = mode !== 'pac';
  if (mode === 'system' || mode === 'direct') {
    await browserAPI.setSetting('proxyMode', mode);
    proxySaved();
  }
});
document.getElementById('proxy-manual').addEventListener('submit', async (e) => {
  e.preventDefault();
  await browserAPI.setSetting('proxyServer', document.getElementById('proxy-server').value.trim());
  await browserAPI.setSetting('proxyBypass', document.getElementById('proxy-bypass').value.trim());
  await browserAPI.setSetting('proxyMode', 'manual');
  proxySaved();
});
document.getElementById('proxy-pac').addEventListener('submit', async (e) => {
  e.preventDefault();
  await browserAPI.setSetting('proxyPac', document.getElementById('proxy-pac-url').value.trim());
  await browserAPI.setSetting('proxyMode', 'pac');
  proxySaved();
});

document.getElementById('export-all').addEventListener('click', async () => {
  const dir = await browserAPI.exportAllData();
  document.getElementById('export-result').textContent = dir ? `Saved to ${dir}` : '';
});

// ---- interface language (applies after a restart)
document.getElementById('ui-language').addEventListener('change', async (e) => {
  await browserAPI.setSetting('uiLanguage', e.target.value);
  document.getElementById('ui-language-restart').hidden = false;
});
document.getElementById('ui-language-restart-now').addEventListener('click', () => browserAPI.relaunch());

// ---- history retention and clear on quit
document.getElementById('history-keep').addEventListener('change', (e) => browserAPI.setSetting('historyKeepDays', Number(e.target.value)));
for (const k of ['history', 'downloads', 'cookies', 'cache']) {
  document.getElementById(`quit-${k}`).addEventListener('change', () => {
    const value = {};
    for (const x of ['history', 'downloads', 'cookies', 'cache']) value[x] = document.getElementById(`quit-${x}`).checked;
    browserAPI.setSetting('clearOnQuit', value);
  });
}

// ---- addresses (autofill, paginated)
const ADDRESS_KEYS = ['name', 'organization', 'street', 'street2', 'city', 'region', 'postal', 'country', 'email', 'phone'];
let editingAddress = null;
function renderAddresses(addrList) {
  const box = document.getElementById('addresses');
  renderPaginatedList(
    box,
    addrList || [],
    6,
    (a) => {
      const row = document.createElement('div');
      row.className = 'row';
      const main = document.createElement('div');
      main.className = 'main';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = a.name;
      const u = document.createElement('div');
      u.className = 'u';
      u.textContent = [a.street, a.city, a.country, a.email, a.phone].filter(Boolean).join(' · ');
      main.append(t, u);
      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openAddressForm(a));
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => renderAddresses(await browserAPI.removeAddress(a.id)));
      row.append(main, edit, remove);
      return row;
    },
    'No saved addresses.',
  );
}
function openAddressForm(a) {
  editingAddress = a ? a.id : null;
  for (const k of ADDRESS_KEYS) document.getElementById(`addr-${k}`).value = (a && a[k]) || '';
  document.getElementById('address-form').hidden = false;
  document.getElementById('addr-name').focus();
}
document.getElementById('address-add').addEventListener('click', () => openAddressForm(null));
document.getElementById('address-cancel').addEventListener('click', () => (document.getElementById('address-form').hidden = true));
document.getElementById('address-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = { id: editingAddress };
  for (const k of ADDRESS_KEYS) a[k] = document.getElementById(`addr-${k}`).value;
  if (!a.name.trim()) return document.getElementById('addr-name').focus();
  renderAddresses(await browserAPI.saveAddress(a));
  e.target.hidden = true;
});
browserAPI.getAddresses().then(renderAddresses);

// ---- profiles
function renderProfiles({ list: profList, current, colors }) {
  const box = document.getElementById('profile-list');
  box.textContent = '';
  for (const p of profList) {
    const row = document.createElement('div');
    row.className = 'row profile-row';
    const dot = document.createElement('button');
    dot.className = 'profile-dot';
    dot.style.background = p.color;
    dot.title = 'Change color';
    dot.setAttribute('aria-label', `Change color of ${p.name}`);
    dot.addEventListener('click', async () => {
      const next = colors[(colors.indexOf(p.color) + 1) % colors.length];
      renderProfiles(await browserAPI.updateProfile(p.id, { color: next }));
    });
    const name = document.createElement('input');
    name.value = p.name;
    name.setAttribute('aria-label', 'Profile name');
    name.className = 'profile-name';
    name.addEventListener('change', async () => renderProfiles(await browserAPI.updateProfile(p.id, { name: name.value })));
    const main = document.createElement('div');
    main.className = 'main';
    main.append(name);
    row.append(dot, main);
    if (p.id === current) {
      const here = document.createElement('span');
      here.className = 'hint';
      here.textContent = 'This window';
      row.append(here);
    } else {
      const open = document.createElement('button');
      open.textContent = 'Open';
      open.addEventListener('click', () => browserAPI.openProfile(p.id));
      row.append(open);
    }
    if (p.id !== 'main' && p.id !== current) {
      const remove = document.createElement('button');
      remove.textContent = 'Delete';
      remove.addEventListener('click', async () => renderProfiles(await browserAPI.removeProfile(p.id)));
      row.append(remove);
    }
    box.append(row);
  }
}
document.getElementById('profile-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('profile-name');
  if (!input.value.trim()) return input.focus();
  renderProfiles(await browserAPI.addProfile(input.value));
  input.value = '';
});
browserAPI.getProfiles().then(renderProfiles);

document.getElementById('strip-tracking').addEventListener('change', (e) => browserAPI.setSetting('stripTracking', e.target.checked));
document.getElementById('energy-saver').addEventListener('change', (e) => browserAPI.setSetting('energySaver', e.target.checked));
document.getElementById('compact-mode').addEventListener('change', (e) => browserAPI.setSetting('compactMode', e.target.checked));
document.getElementById('vertical-tabs').addEventListener('change', (e) => browserAPI.setSetting('verticalTabs', e.target.checked));
document.getElementById('vertical-tabs-collapsed').addEventListener('change', (e) => browserAPI.setSetting('verticalTabsCollapsed', e.target.checked));
document.getElementById('vertical-tabs-hover').addEventListener('change', (e) => browserAPI.setSetting('verticalTabsExpandOnHover', e.target.checked));
document.getElementById('vertical-newtab-under').addEventListener('change', (e) => browserAPI.setSetting('verticalNewTabUnderTabs', e.target.checked));
document.getElementById('reject-cookies').addEventListener('change', (e) => browserAPI.setSetting('rejectCookies', e.target.checked));
document.getElementById('fingerprinting-protection').addEventListener('change', (e) => browserAPI.setSetting('fingerprintingProtection', e.target.checked));
window.addEventListener('focus', loadSettings);

