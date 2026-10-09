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
};

const list = document.getElementById('list');
const adblock = document.getElementById('adblock');
const allowlist = document.getElementById('allowlist');
const engine = document.getElementById('engine');

async function loadSettings() {
  const s = await browserAPI.getSettings();
  for (const r of document.querySelectorAll('input[name="startup"]')) r.checked = r.value === s.startupMode;
  document.getElementById('startup-pages-box').hidden = s.startupMode !== 'pages';
  document.getElementById('startup-pages').value = (s.startupPages || []).join('\n');
  document.getElementById('show-home').checked = s.showHomeButton;
  document.getElementById('confirm-close').checked = s.confirmClose;
  document.getElementById('gpc').checked = s.gpc;
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
  document.getElementById('dns-custom').value = s.dnsCustom || '';
  document.getElementById('dns-custom').hidden = s.dns !== 'custom';
  document.getElementById('home-page').value = s.homePage || '';
  if (!engine.options.length) {
    for (const e of s.searchEngines) engine.append(new Option(e.name, e.id));
  }
  engine.value = s.searchEngine;
  document.getElementById('tpc').checked = s.blockThirdPartyCookies;
  document.getElementById('tpc-restart').hidden = s.blockThirdPartyCookies === s.thirdPartyCookiesBlockedNow;
  document.getElementById('download-dir').textContent = s.downloadDirShown;
  document.getElementById('ask-download').checked = s.askDownloadLocation;
  adblock.checked = s.adblock;
  allowlist.textContent = '';
  if (s.adblockAllowlist.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'None.';
    allowlist.append(empty);
  }
  for (const site of s.adblockAllowlist) {
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
    allowlist.append(row);
  }
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

  // exceptions: one row per site, one Allow/Block/Ask select per saved permission
  const origins = Object.keys(sites).sort();
  list.textContent = '';
  if (origins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No exceptions yet.';
    list.append(empty);
  }
  for (const origin of origins) {
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
    list.append(row);
  }
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
      ? 'Browser is your default browser.'
      : 'Browser is not your default browser.';
  btn.hidden = !supported || isDefault;
}

document.getElementById('default-set').addEventListener('click', async () => {
  await browserAPI.setDefaultBrowser();
  setTimeout(refreshDefault, 1500); // macOS asks for confirmation first
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

// ---- Third-party cookies (applied when the browser starts)

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
document.getElementById('show-home').addEventListener('change', (e) => browserAPI.setSetting('showHomeButton', e.target.checked));
document.getElementById('home-page').addEventListener('change', (e) => {
  let v = e.target.value.trim();
  if (v && !/^[a-z]+:\/\//i.test(v)) v = `https://${v}`;
  e.target.value = v;
  browserAPI.setSetting('homePage', v);
});
document.getElementById('confirm-close').addEventListener('change', (e) => browserAPI.setSetting('confirmClose', e.target.checked));

// ---- Privacy: GPC and secure DNS
document.getElementById('gpc').addEventListener('change', (e) => browserAPI.setSetting('gpc', e.target.checked));
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

// ---- Search: shows only the sections (an h2 and what follows it) that mention the words
(() => {
  const main = document.querySelector('main');
  const sections = [];
  let current = null;
  for (const node of [...main.children]) {
    if (node.id === 'settings-search' || node.tagName === 'H1') continue;
    if (node.tagName === 'H2') {
      current = { heading: node, nodes: [node] };
      sections.push(current);
    } else if (current) {
      current.nodes.push(node);
    }
  }
  const text = (s) => s.nodes.map((n) => n.textContent + ' ' + [...n.querySelectorAll('option')].map((o) => o.textContent).join(' ')).join(' ').toLowerCase();
  document.getElementById('settings-search').addEventListener('input', (e) => {
    const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const s of sections) {
      const show = words.every((w) => text(s).includes(w));
      for (const n of s.nodes) n.classList.toggle('filtered-out', !show);
    }
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
