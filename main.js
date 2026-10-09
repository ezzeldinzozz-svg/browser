'use strict';

const path = require('path');
const fs = require('fs');
const { app, BaseWindow, WebContentsView, ipcMain, Menu, protocol, session, shell } = require('electron');

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
    this.data = { bookmarks: [], history: [], permissions: {}, downloads: [] };
    this.timer = null;
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // first run or unreadable file: start empty
    }
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
  return CHROME_H + (tab.prompts.length ? BAR_H : 0) + (tab.find.open ? BAR_H : 0);
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

function createTab(url) {
  const view = new WebContentsView({
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
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
  };
  tabs.push(tab);
  view.setVisible(false);
  win.contentView.addChildView(view);

  wc.setWindowOpenHandler(({ url: target }) => {
    if (!isBlockedNavigation(wc.getURL(), target)) {
      const resolved = resolveInput(target);
      if (resolved) createTab(resolved);
    }
    return { action: 'deny' };
  });
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
    tab.find.active = tab.find.matches = 0;
    recordHistory(tab, u);
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
    sendTabs();
  });
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */ || isInternalScheme(failedUrl)) return;
    wc.loadURL(internalURL('error', { url: failedUrl, desc })).catch(() => {});
  });

  layout();
  wc.loadURL(url).catch(() => {});
  selectTab(tab.id);
  return tab;
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
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  dismissPrompts(tab);
  exitFullscreen(tab);
  win.contentView.removeChildView(tab.view);
  tab.wc.close();
  if (tabs.length === 0) {
    win.close();
    return;
  }
  if (id === activeId) selectTab(tabs[Math.min(idx, tabs.length - 1)].id);
  else sendTabs();
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
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: newTab },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: focusAddress },
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
  cwc.loadURL(UI_URL);
  cwc.once('did-finish-load', sendTabs);

  win.on('resize', layout);
  // Leaving window fullscreen (green button, F11) also ends a page's video fullscreen.
  win.on('leave-full-screen', () => exitFullscreen(activeTab()));
  win.on('closed', () => app.quit());

  layout();
  createTab(internalURL('newtab'));
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

  setupIpc();
  buildMenu();
  createWindow();
});

app.on('before-quit', () => store && store.flush());
app.on('window-all-closed', () => app.quit());
