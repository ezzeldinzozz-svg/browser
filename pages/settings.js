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
const restore = document.getElementById('restore');
const adblock = document.getElementById('adblock');
const allowlist = document.getElementById('allowlist');
const engine = document.getElementById('engine');

async function loadSettings() {
  const s = await browserAPI.getSettings();
  restore.checked = s.restoreSession;
  if (!engine.options.length) {
    for (const e of s.searchEngines) engine.append(new Option(e.name, e.id));
  }
  engine.value = s.searchEngine;
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

restore.addEventListener('change', () => browserAPI.setSetting('restoreSession', restore.checked));
adblock.addEventListener('change', () => browserAPI.setSetting('adblock', adblock.checked));
engine.addEventListener('change', () => browserAPI.setSetting('searchEngine', engine.value));
loadSettings();

async function load() {
  const sites = await browserAPI.getPermissions();
  const origins = Object.keys(sites).sort();
  list.textContent = '';
  if (origins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No site permissions saved yet.';
    list.append(empty);
    return;
  }
  for (const origin of origins) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'main';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = origin;
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = Object.entries(sites[origin])
      .map(([k, v]) => `${NAMES[k] || k}: ${v === 'allow' ? 'Allowed' : 'Blocked'}`)
      .join(' · ');
    main.append(t, u);

    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.addEventListener('click', async () => {
      await browserAPI.resetPermissions(origin);
      load();
    });

    row.append(main, reset);
    list.append(row);
  }
}
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
