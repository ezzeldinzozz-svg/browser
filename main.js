'use strict';

const path = require('path');
const fs = require('fs');
const { app, BaseWindow, WebContentsView, clipboard, dialog, ipcMain, Menu, protocol, session, shell } = require('electron');
const updater = require('./updater');

const CHROME_H = 80; // tab strip (36) + toolbar (44)
const BAR_H = 44; // optional bars under the toolbar: permission prompt, find
const UI_DIR = path.join(__dirname, 'ui');
const PAGES_DIR = path.join(__dirname, 'pages');
const PRELOAD = path.join(__dirname, 'preload.js');
// The browser's own pages live at browser://<name>/ and are served from pages/<name>.html.
// The toolbar is browser://ui/. Only these origins may call the privileged IPC API.
const SCHEME = 'browser';
const INTERNAL = new Set(['newtab', 'history', 'bookmarks', 'downloads', 'settings', 'error']);
const UI_URL = `${SCHEME}://ui/`;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const FAVICON_MAX_BYTES = 256 * 1024;
const SESSION_ENTRY_LIMIT = 50; // back/forward entries kept per tab
const SEARCH_URL = 'https://duckduckgo.com/?q=';
const HISTORY_LIMIT = 5000;
const DOWNLOADS_LIMIT = 200;

// Granted silently; harmless or needed for basic page behaviour.
const ALWAYS_ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
// Asked about once per site; anything not listed here is denied.
const PERM_LABELS = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'see text and images you copy',
  midi: 'use your MIDI devices',
  midiSysex: 'fully control your MIDI devices',
  openExternal: 'open an app on your computer',
};
const PROMPTABLE = new Set(['media', ...Object.keys(PERM_LABELS)]);

const isMac = process.platform === 'darwin';

// ---------------------------------------------------------------- storage

class Store {
  constructor(file) {
    this.file = file;
    this.data = { bookmarks: [], history: [], permissions: {}, downloads: [], session: null, settings: {} };
    this.timer = null;
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // first run or unreadable file: start empty
    }
    this.data.settings = { restoreSession: true, ...this.data.settings };
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (err) {
      console.error('Failed to save store:', err);
    }
  }
}

let store;
let win;
let chromeView;
const tabs = [];
let activeId = null;
let nextId = 1;

// ---------------------------------------------------------------- urls

function internalURL(name, query) {
  const u = new URL(`${SCHEME}://${name}/`);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.href;
}

// An internal page that a tab may show (the toolbar UI is not one of them).
function internalName(u) {
  try {
    const url = new URL(u);
    return url.protocol === `${SCHEME}:` && INTERNAL.has(url.host) ? url.host : null;
  } catch {
    return null;
  }
}

const isInternalScheme = (u) => String(u).toLowerCase().startsWith(`${SCHEME}:`);

function displayUrl(u) {
  const name = internalName(u);
  if (name === 'newtab') return '';
  if (name === 'error') return new URL(u).searchParams.get('url') || '';
  if (name) return `${SCHEME}://${name}`;
  return u;
}

function resolveInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const internal = text.match(/^browser:\/\/(\w+)\/?$/i);
  if (internal) return INTERNAL.has(internal[1].toLowerCase()) ? internalURL(internal[1].toLowerCase()) : null;
  if (/^(https?|file):\/\//i.test(text)) return text;
  if (!/\s/.test(text)) {
    if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#].*)?$/i.test(text)) return 'http://' + text;
    if (/^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  }
  return SEARCH_URL + encodeURIComponent(text);
}

// ---------------------------------------------------------------- tabs

const getTab = (id) => tabs.find((t) => t.id === id);
const activeTab = () => getTab(activeId);

function canGo(wc, dir) {
  const nav = wc.navigationHistory;
  if (dir === 'back') return nav ? nav.canGoBack() : wc.canGoBack();
  return nav ? nav.canGoForward() : wc.canGoForward();
}

function isBookmarkable(url) {
  return /^https?:\/\//i.test(url);
}

function sendTabs() {
  if (!chromeView || chromeView.webContents.isDestroyed()) return;
  const current = activeTab();
  const currentUrl = current ? current.wc.getURL() : '';
  const prompt = current && current.prompts[0];
  chromeView.webContents.send('tabs:update', {
    activeId,
    bookmarked: store.data.bookmarks.some((b) => b.url === currentUrl),
    canBookmark: isBookmarkable(currentUrl),
    prompt: prompt ? { id: prompt.id, text: `${new URL(prompt.origin).host} wants to ${promptText(prompt.keys)}` } : null,
    find: current ? current.find : null,
    downloads: downloadSummary(),
    update: updater.getState(),
    auth: current && current.auth[0]
      ? (({ id, host, realm, insecure }) => ({ id, host, realm, insecure }))(current.auth[0])
      : null,
    tabs: tabs.map((t) => {
      const url = t.wc.getURL();
      return {
        id: t.id,
        title: t.wc.getTitle() || displayUrl(url) || 'New Tab',
        url: displayUrl(url),
        loading: t.wc.isLoading(),
        favicon: t.favicon,
        canGoBack: canGo(t.wc, 'back'),
        canGoForward: canGo(t.wc, 'forward'),
      };
    }),
  });
}

function chromeHeight() {
  const tab = activeTab();
  if (!tab) return CHROME_H;
  if (tab.fullscreen) return 0;
  const bars = [tab.prompts.length, tab.auth.length, tab.find.open].filter(Boolean).length;
  return CHROME_H + bars * BAR_H;
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const top = chromeHeight();
  chromeView.setVisible(top > 0);
  chromeView.setBounds({ x: 0, y: 0, width, height: top || CHROME_H });
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }}

// ---------------------------------------------------------------- permissions

function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

function mediaKeys(types) {
  const keys = [];
  if (types.includes('video')) keys.push('camera');
  if (types.includes('audio')) keys.push('microphone');
  return keys;
}

function permissionKeys(permission, mediaTypes) {
  if (permission !== 'media') return [permission];
  const keys = mediaKeys(mediaTypes || []);
  return keys.length ? keys : ['camera', 'microphone'];
}

function promptText(keys) {
  if (keys.includes('camera') && keys.includes('microphone')) {
    const rest = keys.filter((k) => k !== 'camera' && k !== 'microphone').map((k) => PERM_LABELS[k]);
    return ['use your camera and microphone', ...rest].join(' and ');
  }
  return keys.map((k) => PERM_LABELS[k]).join(' and ');
}

const decisionFor = (origin, key) => (store.data.permissions[origin] || {})[key];

let nextPromptId = 1;

function onPermissionRequest(wc, permission, callback, details) {
  if (ALWAYS_ALLOWED.has(permission)) return callback(true);
  if (!PROMPTABLE.has(permission)) return callback(false);

  const tab = tabs.find((t) => t.wc === wc);
  const origin = originOf(details.requestingUrl || wc.getURL());
  if (!tab || !origin) return callback(false);

  const keys = permissionKeys(permission, details.mediaTypes);
  const decisions = keys.map((k) => decisionFor(origin, k));
  if (decisions.includes('block')) return callback(false);
  const pending = keys.filter((_k, i) => decisions[i] !== 'allow');
  if (pending.length === 0) return callback(true);

  // Pages often ask repeatedly; fold duplicates into one prompt.
  const same = tab.prompts.find((p) => p.origin === origin && p.keys.join() === pending.join());
  if (same) {
    same.callbacks.push(callback);
    return;
  }
  tab.prompts.push({ id: nextPromptId++, origin, keys: pending, callbacks: [callback] });
  if (tab.id === activeId) {
    layout();
    sendTabs();
  }
}

function onPermissionCheck(_wc, permission, requestingOrigin, details) {
  if (ALWAYS_ALLOWED.has(permission)) return true;
  if (!PROMPTABLE.has(permission)) return false;
  const origin = originOf(requestingOrigin);
  if (!origin) return false;
  const keys = permission === 'media' ? mediaKeys([details.mediaType || '']) : [permission];
  return keys.length > 0 && keys.every((k) => decisionFor(origin, k) === 'allow');
}

// decision: 'allow' | 'block' (both remembered for the site) | 'dismiss' (deny this time only)
function resolvePrompt(promptId, decision) {
  for (const tab of tabs) {
    const idx = tab.prompts.findIndex((p) => p.id === promptId);
    if (idx === -1) continue;
    const [p] = tab.prompts.splice(idx, 1);
    if (decision === 'allow' || decision === 'block') {
      const site = (store.data.permissions[p.origin] ||= {});
      for (const k of p.keys) site[k] = decision;
      store.save();
    }
    for (const cb of p.callbacks) cb(decision === 'allow');
    layout();
    sendTabs();
    return;
  }
}

function dismissPrompts(tab) {
  if (tab.prompts.length === 0) return;
  for (const p of tab.prompts.splice(0)) for (const cb of p.callbacks) cb(false);
  if (tab.id === activeId) layout();
}

// ---------------------------------------------------------------- session

// A tab's back/forward history, trimmed for storage. Error pages restore as their original URL.
function tabHistory(tab) {
  if (tab.wc.isDestroyed()) return null;
  const nav = tab.wc.navigationHistory;
  let entries = nav.getAllEntries().map((e) => {
    const name = internalName(e.url);
    if (name === 'error') return { url: new URL(e.url).searchParams.get('url') || '', title: e.title };
    return { url: e.url, title: e.title };
  });
  let index = nav.getActiveIndex();
  const start = Math.max(0, entries.length - SESSION_ENTRY_LIMIT);
  entries = entries.slice(start);
  index -= start;
  const keep = entries.map((e) => /^(https?:|browser:)/i.test(e.url));
  if (!keep[index]) return null;
  index -= keep.slice(0, index).filter((k) => !k).length;
  entries = entries.filter((_e, i) => keep[i]);
  return entries.length ? { entries, index } : null;
}

function saveSession() {
  if (!store || !win || win.isDestroyed()) return;
  const saved = [];
  let active = 0;
  for (const t of tabs) {
    const h = tabHistory(t);
    if (!h) continue;
    if (t.id === activeId) active = saved.length;
    saved.push(h);
  }
  store.data.session = { tabs: saved, active };
  store.save();
}

function restoreSession() {
  const session = store.data.session;
  if (!store.data.settings.restoreSession || !session || !session.tabs.length) return false;
  for (const h of session.tabs) {
    createTab(h.entries[h.index].url, { background: true, history: h });
  }
  selectTab(tabs[Math.min(session.active, tabs.length - 1)].id);
  return true;
}

const closedTabs = []; // most recent last

function rememberClosedTab(tab, index) {
  const history = tabHistory(tab);
  if (!history) return;
  closedTabs.push({ history, index });
  if (closedTabs.length > 25) closedTabs.shift();
}

function reopenClosedTab() {
  const closed = closedTabs.pop();
  if (!closed) return;
  const tab = createTab(closed.history.entries[closed.history.index].url, { history: closed.history });
  // put it back where it was
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.splice(Math.min(closed.index, tabs.length), 0, tab);
  sendTabs();
  saveSession();
}

// ---------------------------------------------------------------- HTTP sign-in

let nextAuthId = 1;

function onLogin(event, wc, details, authInfo, callback) {
  const tab = wc && tabs.find((t) => t.wc === wc);
  event.preventDefault();
  if (!tab || authInfo.isProxy) return callback(); // cancels; proxy sign-in isn't supported yet
  tab.auth.push({
    id: nextAuthId++,
    host: authInfo.port && ![80, 443].includes(authInfo.port) ? `${authInfo.host}:${authInfo.port}` : authInfo.host,
    realm: authInfo.realm || '',
    insecure: !/^https:/i.test(details.url),
    callback,
  });
  if (tab.id === activeId) {
    layout();
    sendTabs();
    chromeView.webContents.focus();
    chromeView.webContents.send('focus-auth');
  }
}

// username === null cancels the request
function resolveAuth(authId, username, password) {
  for (const tab of tabs) {
    const idx = tab.auth.findIndex((a) => a.id === authId);
    if (idx === -1) continue;
    const [req] = tab.auth.splice(idx, 1);
    if (username === null) req.callback();
    else req.callback(String(username), String(password || ''));
    layout();
    sendTabs();
    if (tab.id === activeId) tab.wc.focus();
    return;
  }
}

function cancelAuth(tab) {
  if (tab.auth.length === 0) return;
  for (const req of tab.auth.splice(0)) req.callback();
  if (tab.id === activeId) layout();
}

// ---------------------------------------------------------------- context menu

function trimLabel(text, max = 30) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function showPageMenu(tab, params) {
  const wc = tab.wc;
  const groups = [];
  const isWeb = (u) => /^https?:\/\//i.test(u);

  if (params.linkURL && isWeb(params.linkURL)) {
    groups.push([
      { label: 'Open Link in New Tab', click: () => createTab(params.linkURL, { after: tab, background: true }) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
    ]);
  }
  if (params.mediaType === 'image' && params.srcURL) {
    const image = [
      { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) },
    ];
    if (isWeb(params.srcURL)) {
      image.unshift({ label: 'Open Image in New Tab', click: () => createTab(params.srcURL, { after: tab, background: true }) });
      image.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
    }
    groups.push(image);
  }
  if (params.isEditable) {
    if (params.misspelledWord) {
      const fixes = params.dictionarySuggestions.slice(0, 5).map((s) => ({ label: s, click: () => wc.replaceMisspelling(s) }));
      groups.push([
        ...(fixes.length ? fixes : [{ label: 'No Guesses Found', enabled: false }]),
        { label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      ]);
    }
    const f = params.editFlags;
    groups.push([
      { label: 'Undo', enabled: f.canUndo, click: () => wc.undo() },
      { label: 'Redo', enabled: f.canRedo, click: () => wc.redo() },
    ]);
    groups.push([
      { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
      { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
      { label: 'Select All', enabled: f.canSelectAll, click: () => wc.selectAll() },
    ]);
  } else if (params.selectionText.trim()) {
    groups.push([
      { label: 'Copy', click: () => wc.copy() },
      {
        label: `Search for “${trimLabel(params.selectionText)}”`,
        click: () => createTab(SEARCH_URL + encodeURIComponent(params.selectionText.trim()), { after: tab }),
      },
    ]);
  }
  if (groups.length === 0) {
    groups.push([
      { label: 'Back', enabled: canGo(wc, 'back'), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: canGo(wc, 'forward'), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
    ]);
    groups.push([
      { label: 'Print…', click: () => printTab(tab) },
      ...(isWeb(wc.getURL())
        ? [{ label: 'View Page Source', click: () => createTab(`view-source:${wc.getURL()}`, { after: tab }) }]
        : []),
    ]);
  }
  groups.push([{ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) }]);

  const template = groups.flatMap((g, i) => (i ? [{ type: 'separator' }, ...g] : g));
  Menu.buildFromTemplate(template).popup({ window: win });
}

// The toolbar's own text fields (address bar, find, sign-in) get a plain edit menu.
function showChromeMenu(params) {
  if (!params.isEditable) return;
  const wc = chromeView.webContents;
  const f = params.editFlags;
  Menu.buildFromTemplate([
    { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
    { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
    { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
    { label: 'Select All', enabled: f.canSelectAll, click: () => wc.selectAll() },
  ]).popup({ window: win });
}

function printTab(tab) {
  if (tab && !tab.wc.isDestroyed()) tab.wc.print({}, () => {});
}

// ---------------------------------------------------------------- find in page

function openFind() {
  const tab = activeTab();
  if (!tab || tab.fullscreen) return;
  tab.find.open = true;
  layout();
  sendTabs();
  chromeView.webContents.focus();
  chromeView.webContents.send('focus-find');
}

function closeFind(tab) {
  if (!tab || !tab.find.open) return;
  tab.wc.stopFindInPage('keepSelection');
  tab.find = { open: false, text: '', active: 0, matches: 0 };
  layout();
  sendTabs();
  if (tab.id === activeId) tab.wc.focus();
}

// newSession: the text changed, so start over; otherwise step to the next/previous match.
function findInTab(tab, text, { forward = true, newSession = false } = {}) {
  if (!tab) return;
  tab.find.text = text;
  if (!text) {
    tab.wc.stopFindInPage('clearSelection');
    tab.find.active = tab.find.matches = 0;
    sendTabs();
    return;
  }
  tab.wc.findInPage(text, { forward, findNext: newSession });
}

function findStep(forward) {
  const tab = activeTab();
  if (!tab) return;
  if (tab.find.open && tab.find.text) findInTab(tab, tab.find.text, { forward });
  else openFind();
}

// ---------------------------------------------------------------- downloads

const liveDownloads = new Map(); // record id -> DownloadItem
const reservedPaths = new Set();
let nextDownloadId = 1;
let downloadNotifyTimer = null;

function uniqueDownloadPath(name) {
  const dir = app.getPath('downloads');
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate) || reservedPaths.has(candidate); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

function downloadSummary() {
  const active = store.data.downloads.filter((d) => d.state === 'progressing');
  const total = active.reduce((n, d) => n + d.total, 0);
  const received = active.reduce((n, d) => n + d.received, 0);
  return {
    active: active.length,
    // -1 when any size is unknown, so the UI shows an indeterminate state
    progress: active.length && active.every((d) => d.total > 0) ? received / total : -1,
  };
}

function notifyDownloads(immediate) {
  const flush = () => {
    downloadNotifyTimer = null;
    const { active, progress } = downloadSummary();
    if (win && !win.isDestroyed()) win.setProgressBar(active ? (progress >= 0 ? progress : 2) : -1);
    sendTabs();
  };
  if (immediate) {
    clearTimeout(downloadNotifyTimer);
    flush();
  } else if (!downloadNotifyTimer) {
    downloadNotifyTimer = setTimeout(flush, 250);
  }
}

function onWillDownload(_e, item) {
  const savePath = uniqueDownloadPath(item.getFilename() || 'download');
  reservedPaths.add(savePath);
  item.setSavePath(savePath);

  const rec = {
    id: nextDownloadId++,
    url: item.getURL(),
    filename: path.basename(savePath),
    path: savePath,
    state: 'progressing',
    paused: false,
    received: 0,
    total: item.getTotalBytes(),
    time: Date.now(),
  };
  const list = store.data.downloads;
  list.unshift(rec);
  if (list.length > DOWNLOADS_LIMIT) list.length = DOWNLOADS_LIMIT;
  liveDownloads.set(rec.id, item);

  item.on('updated', (_ev, state) => {
    rec.received = item.getReceivedBytes();
    rec.total = item.getTotalBytes();
    rec.paused = item.isPaused();
    rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
    notifyDownloads();
  });
  item.once('done', (_ev, state) => {
    rec.state = state; // 'completed' | 'cancelled' | 'interrupted'
    rec.received = item.getReceivedBytes();
    rec.paused = false;
    liveDownloads.delete(rec.id);
    reservedPaths.delete(savePath);
    store.save();
    notifyDownloads(true);
  });

  store.save();
  notifyDownloads(true);
}

function openDownloadsPage() {
  const url = internalURL('downloads');
  const existing = tabs.find((t) => t.wc.getURL() === url);
  if (existing) selectTab(existing.id);
  else createTab(url);
}

const findDownload = (id) => store.data.downloads.find((d) => d.id === id);

// ---------------------------------------------------------------- fullscreen

function exitFullscreen(tab) {
  if (!tab || !tab.fullscreen) return;
  tab.fullscreen = false;
  tab.wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
  if (win.isFullScreen()) win.setFullScreen(false);
  layout();
}

function recordHistory(tab, url) {
  if (!/^https?:\/\//i.test(url)) return;
  const h = store.data.history;
  if (h[0] && h[0].url === url) {
    h[0].time = Date.now();
  } else {
    h.unshift({ url, title: tab.wc.getTitle() || url, time: Date.now() });
    if (h.length > HISTORY_LIMIT) h.length = HISTORY_LIMIT;
  }
  store.save();
}

function updateHistoryTitle(tab) {
  const url = tab.wc.getURL();
  const entry = store.data.history.slice(0, 20).find((e) => e.url === url);
  if (entry) {
    entry.title = tab.wc.getTitle() || url;
    store.save();
  }
}

// options.background: open without switching to it
// options.after: place right after this tab (links opened from a page)
// options.history: { entries, index } to restore back/forward history instead of loading url
function createTab(url, { background = false, after = null, history = null } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  const wc = view.webContents;
  const tab = {
    id: nextId++,
    view,
    wc,
    favicon: '', // data: URL shown in the tab strip
    faviconSrc: '', // the page's icon URL being fetched
    prompts: [],
    fullscreen: false,
    find: { open: false, text: '', active: 0, matches: 0 },
    auth: [], // pending HTTP sign-in requests
  };
  const afterIdx = after ? tabs.indexOf(after) : -1;
  if (afterIdx === -1) tabs.push(tab);
  else tabs.splice(afterIdx + 1 + openerRunLength(after, afterIdx), 0, tab);
  tab.openerId = after ? after.id : null;
  view.setVisible(false);
  win.contentView.addChildView(view);

  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (!isBlockedNavigation(wc.getURL(), target)) {
      const resolved = resolveInput(target);
      if (resolved) createTab(resolved, { after: tab, background: disposition === 'background-tab' });
    }
    return { action: 'deny' };
  });
  wc.on('context-menu', (_e, params) => showPageMenu(tab, params));
  // Websites (in any frame, or via redirect) may never load the browser's own pages.
  const guard = (e) => {
    if (isBlockedNavigation(wc.getURL(), e.url)) e.preventDefault();
  };
  wc.on('will-frame-navigate', guard);
  wc.on('will-redirect', guard);

  wc.on('page-title-updated', () => {
    updateHistoryTitle(tab);
    sendTabs();
  });
  wc.on('page-favicon-updated', (_e, favicons) => loadFavicon(tab, favicons[0]));
  wc.on('did-start-loading', sendTabs);
  wc.on('did-stop-loading', sendTabs);
  wc.on('did-navigate', (_e, u) => {
    tab.favicon = tab.faviconSrc = '';
    dismissPrompts(tab); // a prompt must never carry over to a different page
    cancelAuth(tab);
    tab.find.active = tab.find.matches = 0;
    recordHistory(tab, u);
    saveSession();
    sendTabs();
  });
  wc.on('found-in-page', (_e, result) => {
    tab.find.active = result.activeMatchOrdinal;
    tab.find.matches = result.matches;
    sendTabs();
  });
  wc.on('enter-html-full-screen', () => {
    tab.fullscreen = true;
    if (!win.isFullScreen()) win.setFullScreen(true);
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    tab.fullscreen = false;
    if (win.isFullScreen()) win.setFullScreen(false);
    layout();
  });
  wc.on('did-navigate-in-page', (_e, u, isMainFrame) => {
    if (!isMainFrame) return;
    recordHistory(tab, u);
    saveSession();
    sendTabs();
  });
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */ || isInternalScheme(failedUrl)) return;
    wc.loadURL(internalURL('error', { url: failedUrl, desc })).catch(() => {});
  });

  layout();
  if (history && history.entries.length) {
    wc.navigationHistory.restore(history).catch(() => wc.loadURL(url).catch(() => {}));
  } else {
    wc.loadURL(url).catch(() => {});
  }
  if (background) sendTabs();
  else selectTab(tab.id);
  saveSession();
  return tab;
}

// Links opened from the same tab line up after each other, like other browsers.
function openerRunLength(opener, openerIdx) {
  let n = 0;
  while (tabs[openerIdx + 1 + n] && tabs[openerIdx + 1 + n].openerId === opener.id) n++;
  return n;
}

function isBlockedNavigation(fromUrl, toUrl) {
  if (!isInternalScheme(toUrl)) return false;
  return !internalName(fromUrl); // only internal pages may link to other internal pages
}

// The toolbar never loads remote images: the tab's own session fetches the icon
// and hands the toolbar a size-limited data: URL.
async function loadFavicon(tab, url) {
  tab.faviconSrc = url || '';
  tab.favicon = '';
  sendTabs();
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    const res = await tab.wc.session.fetch(url, { credentials: 'omit' });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !type.startsWith('image/')) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > FAVICON_MAX_BYTES || tab.faviconSrc !== url || tab.wc.isDestroyed()) return;
    tab.favicon = `data:${type};base64,${buf.toString('base64')}`;
    sendTabs();
  } catch {
    // no icon is fine
  }
}

function selectTab(id) {
  const tab = getTab(id);
  if (!tab) return;
  if (activeId !== id) exitFullscreen(activeTab());
  activeId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  layout();
  tab.wc.focus();
  sendTabs();
  saveSession();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  rememberClosedTab(tab, idx);
  dismissPrompts(tab);
  cancelAuth(tab);
  exitFullscreen(tab);
  win.contentView.removeChildView(tab.view);
  tab.wc.close();
  if (tabs.length === 0) {
    win.close();
    return;
  }
  if (id === activeId) selectTab(tabs[Math.min(idx, tabs.length - 1)].id);
  else sendTabs();
  saveSession();
}

function cycleTab(step) {
  const idx = tabs.findIndex((t) => t.id === activeId);
  if (idx === -1) return;
  selectTab(tabs[(idx + step + tabs.length) % tabs.length].id);
}

function toggleBookmark() {
  const tab = activeTab();
  if (!tab) return;
  const url = tab.wc.getURL();
  if (!isBookmarkable(url)) return;
  const list = store.data.bookmarks;
  const idx = list.findIndex((b) => b.url === url);
  if (idx >= 0) list.splice(idx, 1);
  else list.unshift({ url, title: tab.wc.getTitle() || url, added: Date.now() });
  store.save();
  sendTabs();
}

function focusAddress() {
  chromeView.webContents.focus();
  chromeView.webContents.send('focus-address');
}

function zoom(delta) {
  const tab = activeTab();
  if (!tab) return;
  tab.wc.setZoomLevel(delta === 0 ? 0 : tab.wc.getZoomLevel() + delta);
}

// ---------------------------------------------------------------- ipc

const fromChrome = (e) => chromeView && e.sender === chromeView.webContents;
const fromInternal = (e) =>
  !!e.senderFrame &&
  e.senderFrame === e.sender.mainFrame &&
  !!internalName(e.senderFrame.url) &&
  tabs.some((t) => t.wc === e.sender);

function handle(channel, guard, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!guard(e)) throw new Error(`Unauthorized: ${channel}`);
    return fn(e, ...args);
  });
}

function setupIpc() {
  const trusted = (e) => fromChrome(e) || fromInternal(e);

  handle('tab:new', fromChrome, () => {
    createTab(internalURL('newtab'));
  });
  handle('tab:close', fromChrome, (_e, id) => closeTab(id));
  handle('tab:select', fromChrome, (_e, id) => selectTab(id));

  handle('nav:go', trusted, (e, text) => {
    const url = resolveInput(text);
    if (!url) return;
    const target = tabs.find((t) => t.wc === e.sender) || activeTab();
    if (target) target.wc.loadURL(url).catch(() => {});
  });
  handle('nav:back', fromChrome, () => {
    const t = activeTab();
    if (t) t.wc.navigationHistory.goBack();
  });
  handle('nav:forward', fromChrome, () => {
    const t = activeTab();
    if (t) t.wc.navigationHistory.goForward();
  });
  handle('nav:reload', fromChrome, () => {
    const t = activeTab();
    if (!t) return;
    if (t.wc.isLoading()) t.wc.stop();
    else t.wc.reload();
  });
  handle('bookmark:toggle', fromChrome, () => toggleBookmark());
  handle('permission:respond', fromChrome, (_e, promptId, decision) => {
    if (['allow', 'block', 'dismiss'].includes(decision)) resolvePrompt(promptId, decision);
  });

  handle('find:query', fromChrome, (_e, text, opts) => findInTab(activeTab(), String(text || ''), opts || {}));
  handle('find:close', fromChrome, () => closeFind(activeTab()));
  handle('downloads:open', fromChrome, () => openDownloadsPage());
  handle('update:install', fromChrome, () => restartToUpdate());
  handle('auth:respond', fromChrome, (_e, authId, username, password) =>
    resolveAuth(authId, username === null ? null : String(username), password));

  handle('data:downloads', fromInternal, () => store.data.downloads);
  handle('download:open', fromInternal, (_e, id) => {
    const d = findDownload(id);
    if (d && d.state === 'completed') return shell.openPath(d.path);
  });
  handle('download:show', fromInternal, (_e, id) => {
    const d = findDownload(id);
    if (d) shell.showItemInFolder(d.path);
  });
  handle('download:cancel', fromInternal, (_e, id) => liveDownloads.get(id)?.cancel());
  handle('download:pause', fromInternal, (_e, id) => {
    const item = liveDownloads.get(id);
    if (!item) return;
    if (item.isPaused()) item.resume();
    else item.pause();
  });
  handle('download:clear', fromInternal, () => {
    store.data.downloads = store.data.downloads.filter((d) => d.state === 'progressing');
    store.save();
    notifyDownloads(true);
  });

  handle('data:settings', fromInternal, () => store.data.settings);
  handle('data:settings-set', fromInternal, (_e, key, value) => {
    if (key === 'restoreSession' && typeof value === 'boolean') {
      store.data.settings.restoreSession = value;
      store.save();
    }
  });

  handle('data:permissions', fromInternal, () => store.data.permissions);
  handle('data:permission-reset', fromInternal, (_e, origin) => {
    delete store.data.permissions[origin];
    store.save();
  });

  handle('data:history', fromInternal, () => store.data.history);
  handle('data:history-clear', fromInternal, () => {
    store.data.history = [];
    store.save();
  });
  handle('data:bookmarks', fromInternal, () => store.data.bookmarks);
  handle('data:bookmark-remove', fromInternal, (_e, url) => {
    store.data.bookmarks = store.data.bookmarks.filter((b) => b.url !== url);
    store.save();
    sendTabs();
  });
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const newTab = () => createTab(internalURL('newtab'));
  const open = (name) => createTab(internalURL(name));
  const goBack = () => activeTab()?.wc.navigationHistory.goBack();
  const goForward = () => activeTab()?.wc.navigationHistory.goForward();

  const template = [
    ...(isMac
      ? [
          {
            role: 'appMenu',
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: checkForUpdatesManually },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: newTab },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: reopenClosedTab },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: focusAddress },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => printTab(activeTab()) },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => open('settings') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: openFind },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => findStep(true) },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => findStep(false) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => activeTab()?.wc.reload() },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => activeTab()?.wc.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'F12', click: () => activeTab()?.wc.toggleDevTools() },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: goBack },
        { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: goForward },
        { type: 'separator' },
        { label: 'Show History', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: () => open('history') },
        { label: 'Show Downloads', accelerator: isMac ? 'Alt+Cmd+L' : 'Ctrl+J', click: openDownloadsPage },
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: toggleBookmark },
        { label: 'Show Bookmarks', accelerator: 'CmdOrCtrl+Shift+O', click: () => open('bookmarks') },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
          label: n === 9 ? 'Last Tab' : `Tab ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => {
            const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
            if (t) selectTab(t.id);
          },
        })),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- app

function createWindow() {
  win = new BaseWindow({ width: 1280, height: 800, minWidth: 480, minHeight: 320, title: 'Browser' });

  chromeView = new WebContentsView({
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(chromeView);
  const cwc = chromeView.webContents;
  cwc.setWindowOpenHandler(() => ({ action: 'deny' }));
  cwc.on('will-navigate', (e) => e.preventDefault());
  cwc.on('context-menu', (_e, params) => showChromeMenu(params));
  cwc.loadURL(UI_URL);
  cwc.once('did-finish-load', sendTabs);

  win.on('resize', layout);
  // Leaving window fullscreen (green button, F11) also ends a page's video fullscreen.
  win.on('leave-full-screen', () => exitFullscreen(activeTab()));
  // Tabs still exist here (they're torn down afterwards), so this is the final session snapshot.
  win.on('close', () => {
    saveSession();
    store.flush();
  });
  win.on('closed', () => app.quit());

  layout();
  if (!restoreSession()) createTab(internalURL('newtab'));
}

// Serves browser://ui/* from ui/ and browser://<page>/* from pages/ (index = <page>.html).
async function serveInternal(request) {
  const { host, pathname } = new URL(request.url);
  let dir;
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (host === 'ui') {
    dir = UI_DIR;
    rel ||= 'index.html';
  } else if (INTERNAL.has(host)) {
    dir = PAGES_DIR;
    rel ||= `${host}.html`;
  } else {
    return new Response('Not found', { status: 404 });
  }
  const file = path.resolve(dir, rel);
  const type = MIME[path.extname(file)];
  if (!file.startsWith(dir + path.sep) || !type) return new Response('Not found', { status: 404 });
  try {
    return new Response(await fs.promises.readFile(file), { headers: { 'content-type': type } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// Development runs (npm start) keep their own profile so testing never touches the
// installed app's bookmarks, history or settings. Must run before anything reads userData.
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Browser Dev'));

// Every renderer is sandboxed, including any created by Electron internals.
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);

// One running copy: opening the app again focuses the existing window.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  protocol.handle(SCHEME, serveInternal);
  store = new Store(path.join(app.getPath('userData'), 'browser-data.json'));
  // Downloads still running when the app last quit can't be resumed.
  for (const d of store.data.downloads) if (d.state === 'progressing') d.state = 'interrupted';
  nextDownloadId = store.data.downloads.reduce((max, d) => Math.max(max, d.id), 0) + 1;

  const ses = session.defaultSession;
  // Present as plain Chrome: sites such as Google sign-in reject the Electron token.
  ses.setUserAgent(
    app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(` ${app.getName()}/${app.getVersion()}`, ''),
  );
  ses.setPermissionRequestHandler(onPermissionRequest);
  ses.setPermissionCheckHandler(onPermissionCheck);
  ses.on('will-download', onWillDownload);
  app.on('login', onLogin);

  setupIpc();
  buildMenu();
  createWindow();
  updater.start(() => sendTabs());
});

// ---------------------------------------------------------------- updates

function restartToUpdate() {
  if (updater.install(true)) app.quit();
}

async function checkForUpdatesManually() {
  const state = await updater.check();
  const version = app.getVersion();
  if (state.status === 'ready') {
    const { response } = await dialog.showMessageBox(win, {
      message: `Browser ${state.version} is ready to install.`,
      detail: `You have ${version}. Browser will restart to finish updating.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    });
    if (response === 0) restartToUpdate();
  } else if (state.status === 'none') {
    dialog.showMessageBox(win, { message: "You're up to date.", detail: `Browser ${version} is the latest version.` });
  } else if (state.status === 'checking' || state.status === 'downloading') {
    dialog.showMessageBox(win, { message: 'An update is already being downloaded.' });
  } else {
    dialog.showMessageBox(win, { type: 'warning', message: "Couldn't check for updates.", detail: state.error || '' });
  }
}

app.on('before-quit', () => {
  if (store) store.flush();
  updater.install(false); // a downloaded update is applied whenever the app quits
});
app.on('window-all-closed', () => app.quit());
