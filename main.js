'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BaseWindow,
  WebContentsView,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  shell,
} = require('electron');
const updater = require('./updater');
const adblock = require('./adblock');

const CHROME_H = 80; // tab strip (36) + toolbar (44)
const BAR_H = 44; // optional bars under the toolbar: permission prompt, sign-in, find
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
    this.data = {
      bookmarks: [],
      history: [],
      permissions: {},
      downloads: [],
      session: null,
      settings: {},
      adblockAllowlist: [],
    };
    this.timer = null;
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // first run or unreadable file: start empty
    }
    this.data.settings = { restoreSession: true, adblock: true, ...this.data.settings };
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
  flush() {
    clearTimeout(this.timer);
    // Private-window downloads live in memory only.
    const data = { ...this.data, downloads: this.data.downloads.filter((d) => !d.private) };
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(data));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (err) {
      console.error('Failed to save store:', err);
    }
  }
}

let store;

// Every browser window. A window is:
//   { id, win, chromeView, tabs, activeId, private, ses, closedTabs,
//     permissions (private only, in memory), allowlist (private only, in memory) }
// A tab is { id, w, view, wc, favicon, faviconSrc, prompts, auth, find, fullscreen, blocked, openerId }.
const windows = [];
let lastFocused = null;
let nextWindowId = 1;
let nextTabId = 1;
let nextPrivateSession = 1;
let quitting = false;
let sessionFrozen = false; // set once the last normal window closed, so the snapshot survives

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
const isWeb = (u) => /^https?:\/\//i.test(u);

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

// "www.example.com" and "example.com" are the same site for site-level switches.
function siteOf(url) {
  try {
    const u = new URL(url);
    return isWeb(u.href) ? u.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- windows & tabs

const allTabs = () => windows.flatMap((w) => w.tabs);
const tabOfWc = (wc) => (wc ? allTabs().find((t) => t.wc === wc) : null);
const getTab = (w, id) => w.tabs.find((t) => t.id === id);
const activeTab = (w) => (w ? getTab(w, w.activeId) : null);
const liveWindow = (w) => w && !w.win.isDestroyed();

// The window menu commands and shortcuts act on.
function focusedWindow() {
  return windows.find((w) => liveWindow(w) && w.win.isFocused()) || (liveWindow(lastFocused) ? lastFocused : windows[0]);
}

function canGo(wc, dir) {
  const nav = wc.navigationHistory;
  return dir === 'back' ? nav.canGoBack() : nav.canGoForward();
}

function sendTabs(w) {
  if (!liveWindow(w) || w.chromeView.webContents.isDestroyed()) return;
  const current = activeTab(w);
  const currentUrl = current ? current.wc.getURL() : '';
  const prompt = current && current.prompts[0];
  const auth = current && current.auth[0];
  const site = siteOf(currentUrl);
  w.chromeView.webContents.send('tabs:update', {
    activeId: w.activeId,
    private: w.private,
    bookmarked: store.data.bookmarks.some((b) => b.url === currentUrl),
    canBookmark: isWeb(currentUrl),
    prompt: prompt ? { id: prompt.id, text: `${new URL(prompt.origin).host} wants to ${promptText(prompt.keys)}` } : null,
    auth: auth ? { id: auth.id, host: auth.host, realm: auth.realm, insecure: auth.insecure } : null,
    find: current ? current.find : null,
    downloads: downloadSummary(w),
    update: updater.getState(),
    shield: {
      available: !!site && store.data.settings.adblock,
      site,
      on: !!site && blockingOnFor(w, site),
      blocked: current ? current.blocked : 0,
    },
    tabs: w.tabs.map((t) => {
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

const sendAll = () => windows.forEach(sendTabs);

function chromeHeight(w) {
  const tab = activeTab(w);
  if (!tab) return CHROME_H;
  if (tab.fullscreen) return 0;
  const bars = [tab.prompts.length, tab.auth.length, tab.find.open].filter(Boolean).length;
  return CHROME_H + bars * BAR_H;
}

function layout(w) {
  if (!liveWindow(w)) return;
  const [width, height] = w.win.getContentSize();
  const top = chromeHeight(w);
  w.chromeView.setVisible(top > 0);
  w.chromeView.setBounds({ x: 0, y: 0, width, height: top || CHROME_H });
  for (const t of w.tabs) {
    t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }
}

// options.private: a private window with its own throwaway session
// options.session: { tabs: [history...], active } to restore
function createWindow({ private: isPrivate = false, session: saved = null } = {}) {
  const ses = isPrivate ? createPrivateSession() : session.defaultSession;
  const win = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 320,
    title: isPrivate ? 'Browser — Private' : 'Browser',
    backgroundColor: isPrivate ? '#25153f' : undefined,
  });
  const chromeView = new WebContentsView({
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const w = {
    id: nextWindowId++,
    win,
    chromeView,
    tabs: [],
    activeId: null,
    private: isPrivate,
    ses,
    closedTabs: [], // most recent last
    permissions: {}, // private windows only
    allowlist: new Set(), // private windows only: sites with ad blocking switched off
  };
  windows.push(w);
  lastFocused = w;
  win.contentView.addChildView(chromeView);

  const cwc = chromeView.webContents;
  cwc.setWindowOpenHandler(() => ({ action: 'deny' }));
  cwc.on('will-navigate', (e) => e.preventDefault());
  cwc.on('context-menu', (_e, params) => showChromeMenu(w, params));
  cwc.loadURL(UI_URL);
  cwc.once('did-finish-load', () => sendTabs(w));

  win.on('focus', () => {
    lastFocused = w;
  });
  win.on('resize', () => layout(w));
  // Leaving window fullscreen (green button, F11) also ends a page's video fullscreen.
  win.on('leave-full-screen', () => exitFullscreen(activeTab(w)));
  win.on('close', () => onWindowClose(w));
  win.on('closed', () => onWindowClosed(w));

  layout(w);
  if (saved && saved.tabs.length) {
    for (const h of saved.tabs) createTab(w, h.entries[h.index].url, { background: true, history: h });
    selectTab(w, w.tabs[Math.min(saved.active, w.tabs.length - 1)].id);
  } else {
    createTab(w, internalURL('newtab'));
  }
  if (!isPrivate) sessionFrozen = false;
  return w;
}

function onWindowClose(w) {
  if (w.private || quitting || sessionFrozen) return;
  // Closing the last normal window keeps its tabs for next launch (like quitting);
  // closing one of several drops it from the saved session.
  const othersOpen = windows.some((o) => o !== w && !o.private && liveWindow(o));
  saveSession(othersOpen ? w : null);
  if (!othersOpen) {
    sessionFrozen = true;
    store.flush();
  }
}

function onWindowClosed(w) {
  windows.splice(windows.indexOf(w), 1);
  if (lastFocused === w) lastFocused = windows[windows.length - 1] || null;
  // Views don't take their pages down with the window; close them explicitly.
  for (const t of w.tabs) {
    dismissPrompts(t);
    cancelAuth(t);
    if (!t.wc.isDestroyed()) t.wc.close();
  }
  if (!w.chromeView.webContents.isDestroyed()) w.chromeView.webContents.close();
  if (w.private) {
    // Nothing from a private window outlives it.
    w.ses.clearStorageData().catch(() => {});
    w.ses.clearCache().catch(() => {});
    w.ses.clearAuthCache().catch(() => {});
    if (!windows.some((o) => o.private)) {
      store.data.downloads = store.data.downloads.filter((d) => !d.private || d.state === 'progressing');
      sendAll();
    }
  }
}

function createPrivateSession() {
  // No "persist:" prefix: the session lives in memory only. A fresh partition per window
  // means two private windows don't share cookies either.
  const ses = session.fromPartition(`private-${nextPrivateSession++}`, { cache: false });
  configureSession(ses);
  ses.protocol.handle(SCHEME, serveInternal);
  return ses;
}

function configureSession(ses) {
  // Present as plain Chrome: sites such as Google sign-in reject the Electron token.
  ses.setUserAgent(
    app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(` ${app.getName()}/${app.getVersion()}`, ''),
  );
  ses.setPermissionRequestHandler(onPermissionRequest);
  ses.setPermissionCheckHandler(onPermissionCheck);
  ses.on('will-download', onWillDownload);
  adblock.attach(ses);
}

// options.background: open without switching to it
// options.after: place right after this tab (links opened from a page)
// options.history: { entries, index } to restore back/forward history instead of loading url
function createTab(w, url, { background = false, after = null, history = null } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      session: w.ses,
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  const wc = view.webContents;
  const tab = {
    id: nextTabId++,
    w,
    view,
    wc,
    favicon: '', // data: URL shown in the tab strip
    faviconSrc: '', // the page's icon URL being fetched
    prompts: [], // pending permission requests
    auth: [], // pending HTTP sign-in requests
    find: { open: false, text: '', active: 0, matches: 0 },
    fullscreen: false,
    blocked: 0, // ads/trackers blocked on the current page
    openerId: after ? after.id : null,
  };
  const afterIdx = after ? w.tabs.indexOf(after) : -1;
  if (afterIdx === -1) w.tabs.push(tab);
  else w.tabs.splice(afterIdx + 1 + openerRunLength(w, after, afterIdx), 0, tab);
  view.setVisible(false);
  w.win.contentView.addChildView(view);

  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (!isBlockedNavigation(wc.getURL(), target)) {
      const resolved = resolveInput(target);
      if (resolved) createTab(w, resolved, { after: tab, background: disposition === 'background-tab' });
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
    sendTabs(w);
  });
  wc.on('page-favicon-updated', (_e, favicons) => loadFavicon(tab, favicons[0]));
  wc.on('did-start-loading', () => sendTabs(w));
  wc.on('did-stop-loading', () => sendTabs(w));
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) tab.blocked = 0;
  });
  wc.on('did-navigate', (_e, u) => {
    tab.favicon = tab.faviconSrc = '';
    dismissPrompts(tab); // a prompt must never carry over to a different page
    cancelAuth(tab);
    tab.find.active = tab.find.matches = 0;
    recordHistory(tab, u);
    saveSession();
    sendTabs(w);
  });
  wc.on('did-navigate-in-page', (_e, u, isMainFrame) => {
    if (!isMainFrame) return;
    recordHistory(tab, u);
    saveSession();
    sendTabs(w);
  });
  wc.on('found-in-page', (_e, result) => {
    tab.find.active = result.activeMatchOrdinal;
    tab.find.matches = result.matches;
    sendTabs(w);
  });
  wc.on('enter-html-full-screen', () => {
    tab.fullscreen = true;
    if (!w.win.isFullScreen()) w.win.setFullScreen(true);
    layout(w);
  });
  wc.on('leave-html-full-screen', () => {
    tab.fullscreen = false;
    if (w.win.isFullScreen()) w.win.setFullScreen(false);
    layout(w);
  });
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */ || isInternalScheme(failedUrl)) return;
    wc.loadURL(internalURL('error', { url: failedUrl, desc })).catch(() => {});
  });

  layout(w);
  if (history && history.entries.length) {
    wc.navigationHistory.restore(history).catch(() => wc.loadURL(url).catch(() => {}));
  } else {
    wc.loadURL(url).catch(() => {});
  }
  if (background) sendTabs(w);
  else selectTab(w, tab.id);
  saveSession();
  return tab;
}

// Links opened from the same tab line up after each other, like other browsers.
function openerRunLength(w, opener, openerIdx) {
  let n = 0;
  while (w.tabs[openerIdx + 1 + n] && w.tabs[openerIdx + 1 + n].openerId === opener.id) n++;
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
  sendTabs(tab.w);
  if (!url || !isWeb(url)) return;
  try {
    const res = await tab.wc.session.fetch(url, { credentials: 'omit' });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !type.startsWith('image/')) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > FAVICON_MAX_BYTES || tab.faviconSrc !== url || tab.wc.isDestroyed()) return;
    tab.favicon = `data:${type};base64,${buf.toString('base64')}`;
    sendTabs(tab.w);
  } catch {
    // no icon is fine
  }
}

function selectTab(w, id) {
  const tab = getTab(w, id);
  if (!tab) return;
  if (w.activeId !== id) exitFullscreen(activeTab(w));
  w.activeId = id;
  for (const t of w.tabs) t.view.setVisible(t.id === id);
  layout(w);
  tab.wc.focus();
  sendTabs(w);
  saveSession();
}

function closeTab(w, id) {
  const idx = w.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = w.tabs.splice(idx, 1);
  rememberClosedTab(w, tab, idx);
  dismissPrompts(tab);
  cancelAuth(tab);
  exitFullscreen(tab);
  w.win.contentView.removeChildView(tab.view);
  tab.wc.close();
  if (w.tabs.length === 0) {
    w.win.close();
    return;
  }
  if (id === w.activeId) selectTab(w, w.tabs[Math.min(idx, w.tabs.length - 1)].id);
  else sendTabs(w);
  saveSession();
}

function cycleTab(w, step) {
  const idx = w.tabs.findIndex((t) => t.id === w.activeId);
  if (idx === -1) return;
  selectTab(w, w.tabs[(idx + step + w.tabs.length) % w.tabs.length].id);
}

function toggleBookmark(w) {
  const tab = activeTab(w);
  if (!tab) return;
  const url = tab.wc.getURL();
  if (!isWeb(url)) return;
  const list = store.data.bookmarks;
  const idx = list.findIndex((b) => b.url === url);
  if (idx >= 0) list.splice(idx, 1);
  else list.unshift({ url, title: tab.wc.getTitle() || url, added: Date.now() });
  store.save();
  sendAll();
}

function focusAddress(w) {
  w.chromeView.webContents.focus();
  w.chromeView.webContents.send('focus-address');
}

function zoom(w, delta) {
  const tab = activeTab(w);
  if (!tab) return;
  tab.wc.setZoomLevel(delta === 0 ? 0 : tab.wc.getZoomLevel() + delta);
}

function exitFullscreen(tab) {
  if (!tab || !tab.fullscreen) return;
  tab.fullscreen = false;
  tab.wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
  if (liveWindow(tab.w) && tab.w.win.isFullScreen()) tab.w.win.setFullScreen(false);
  layout(tab.w);
}

// ---------------------------------------------------------------- history

function recordHistory(tab, url) {
  if (tab.w.private || !isWeb(url)) return;
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
  if (tab.w.private) return;
  const url = tab.wc.getURL();
  const entry = store.data.history.slice(0, 20).find((e) => e.url === url);
  if (entry) {
    entry.title = tab.wc.getTitle() || url;
    store.save();
  }
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

// Saves every open normal window (private windows are never saved).
function saveSession(exclude = null) {
  if (!store || quitting || sessionFrozen) return;
  const saved = [];
  for (const w of windows) {
    if (w.private || w === exclude || !liveWindow(w)) continue;
    const tabs = [];
    let active = 0;
    for (const t of w.tabs) {
      const h = tabHistory(t);
      if (!h) continue;
      if (t.id === w.activeId) active = tabs.length;
      tabs.push(h);
    }
    if (tabs.length) saved.push({ tabs, active });
  }
  store.data.session = { windows: saved };
  store.save();
}

function savedWindows() {
  const s = store.data.session;
  if (!s) return [];
  if (Array.isArray(s.windows)) return s.windows;
  return s.tabs && s.tabs.length ? [{ tabs: s.tabs, active: s.active }] : []; // v0.3 format
}

function rememberClosedTab(w, tab, index) {
  const history = tabHistory(tab);
  if (!history) return;
  w.closedTabs.push({ history, index });
  if (w.closedTabs.length > 25) w.closedTabs.shift();
}

function reopenClosedTab(w) {
  const closed = w.closedTabs.pop();
  if (!closed) return;
  const tab = createTab(w, closed.history.entries[closed.history.index].url, { history: closed.history });
  // put it back where it was
  w.tabs.splice(w.tabs.indexOf(tab), 1);
  w.tabs.splice(Math.min(closed.index, w.tabs.length), 0, tab);
  sendTabs(w);
  saveSession();
}

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

// Private windows remember decisions only until they close.
const permissionStore = (w) => (w && w.private ? w.permissions : store.data.permissions);
const decisionFor = (w, origin, key) => (permissionStore(w)[origin] || {})[key];
const windowOfSession = (ses) => windows.find((w) => w.ses === ses) || null;

let nextPromptId = 1;

function onPermissionRequest(wc, permission, callback, details) {
  if (ALWAYS_ALLOWED.has(permission)) return callback(true);
  if (!PROMPTABLE.has(permission)) return callback(false);

  const tab = tabOfWc(wc);
  const origin = originOf(details.requestingUrl || wc.getURL());
  if (!tab || !origin) return callback(false);

  const keys = permissionKeys(permission, details.mediaTypes);
  const decisions = keys.map((k) => decisionFor(tab.w, origin, k));
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
  if (tab.id === tab.w.activeId) {
    layout(tab.w);
    sendTabs(tab.w);
  }
}

function onPermissionCheck(wc, permission, requestingOrigin, details) {
  if (ALWAYS_ALLOWED.has(permission)) return true;
  if (!PROMPTABLE.has(permission)) return false;
  const origin = originOf(requestingOrigin);
  if (!origin) return false;
  const tab = tabOfWc(wc);
  const w = tab ? tab.w : null;
  if (!w && wc && wc.session !== session.defaultSession) return false; // unknown private context
  const keys = permission === 'media' ? mediaKeys([details.mediaType || '']) : [permission];
  return keys.length > 0 && keys.every((k) => decisionFor(w, origin, k) === 'allow');
}

// decision: 'allow' | 'block' (both remembered for the site) | 'dismiss' (deny this time only)
function resolvePrompt(w, promptId, decision) {
  for (const tab of w.tabs) {
    const idx = tab.prompts.findIndex((p) => p.id === promptId);
    if (idx === -1) continue;
    const [p] = tab.prompts.splice(idx, 1);
    if (decision === 'allow' || decision === 'block') {
      const perms = permissionStore(w);
      const site = (perms[p.origin] ||= {});
      for (const k of p.keys) site[k] = decision;
      if (!w.private) store.save();
    }
    for (const cb of p.callbacks) cb(decision === 'allow');
    layout(w);
    sendTabs(w);
    return;
  }
}

function dismissPrompts(tab) {
  if (tab.prompts.length === 0) return;
  for (const p of tab.prompts.splice(0)) for (const cb of p.callbacks) cb(false);
  if (tab.id === tab.w.activeId) layout(tab.w);
}

// ---------------------------------------------------------------- HTTP sign-in

let nextAuthId = 1;

function onLogin(event, wc, details, authInfo, callback) {
  const tab = tabOfWc(wc);
  event.preventDefault();
  if (!tab || authInfo.isProxy) return callback(); // cancels; proxy sign-in isn't supported yet
  tab.auth.push({
    id: nextAuthId++,
    host: authInfo.port && ![80, 443].includes(authInfo.port) ? `${authInfo.host}:${authInfo.port}` : authInfo.host,
    realm: authInfo.realm || '',
    insecure: !/^https:/i.test(details.url),
    callback,
  });
  const w = tab.w;
  if (tab.id === w.activeId) {
    layout(w);
    sendTabs(w);
    w.chromeView.webContents.focus();
    w.chromeView.webContents.send('focus-auth');
  }
}

// username === null cancels the request
function resolveAuth(w, authId, username, password) {
  for (const tab of w.tabs) {
    const idx = tab.auth.findIndex((a) => a.id === authId);
    if (idx === -1) continue;
    const [req] = tab.auth.splice(idx, 1);
    if (username === null) req.callback();
    else req.callback(String(username), String(password || ''));
    layout(w);
    sendTabs(w);
    if (tab.id === w.activeId) tab.wc.focus();
    return;
  }
}

function cancelAuth(tab) {
  if (tab.auth.length === 0) return;
  for (const req of tab.auth.splice(0)) req.callback();
  if (tab.id === tab.w.activeId) layout(tab.w);
}

// ---------------------------------------------------------------- ad blocking

function blockingOnFor(w, site) {
  if (!store.data.settings.adblock || !site) return false;
  if (store.data.adblockAllowlist.includes(site)) return false;
  return !(w.private && w.allowlist.has(site));
}

function shouldBlock(webContentsId) {
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === webContentsId);
  return !!tab && blockingOnFor(tab.w, siteOf(tab.wc.getURL()));
}

let blockedNotifyTimer = null;

function onBlocked(webContentsId) {
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === webContentsId);
  if (!tab) return;
  tab.blocked++;
  if (tab.id !== tab.w.activeId || blockedNotifyTimer) return;
  blockedNotifyTimer = setTimeout(() => {
    blockedNotifyTimer = null;
    sendTabs(tab.w);
  }, 300);
}

// Turns blocking off/on for the active tab's site, then reloads so the change applies.
function toggleSiteBlocking(w) {
  const tab = activeTab(w);
  const site = tab && siteOf(tab.wc.getURL());
  if (!site || !store.data.settings.adblock) return;
  const turnOff = blockingOnFor(w, site);
  if (w.private) {
    if (turnOff) w.allowlist.add(site);
    else w.allowlist.delete(site);
    // a site switched off in normal browsing can't be switched back on from a private window
  } else {
    const list = store.data.adblockAllowlist;
    if (turnOff) list.push(site);
    else store.data.adblockAllowlist = list.filter((s) => s !== site);
    store.save();
  }
  tab.wc.reload();
  sendAll();
}

// ---------------------------------------------------------------- context menu

function trimLabel(text, max = 30) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function showPageMenu(tab, params) {
  const { wc, w } = tab;
  const groups = [];

  if (params.linkURL && isWeb(params.linkURL)) {
    groups.push([
      { label: 'Open Link in New Tab', click: () => createTab(w, params.linkURL, { after: tab, background: true }) },
      { label: 'Open Link in New Window', click: () => openInNewWindow(params.linkURL, w.private) },
      ...(w.private
        ? []
        : [{ label: 'Open Link in Private Window', click: () => openInNewWindow(params.linkURL, true) }]),
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
    ]);
  }
  if (params.mediaType === 'image' && params.srcURL) {
    const image = [
      { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) },
    ];
    if (isWeb(params.srcURL)) {
      image.unshift({ label: 'Open Image in New Tab', click: () => createTab(w, params.srcURL, { after: tab, background: true }) });
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
        click: () => createTab(w, SEARCH_URL + encodeURIComponent(params.selectionText.trim()), { after: tab }),
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
        ? [{ label: 'View Page Source', click: () => createTab(w, `view-source:${wc.getURL()}`, { after: tab }) }]
        : []),
    ]);
  }
  groups.push([{ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) }]);

  const template = groups.flatMap((g, i) => (i ? [{ type: 'separator' }, ...g] : g));
  Menu.buildFromTemplate(template).popup({ window: w.win });
}

// The toolbar's own text fields (address bar, find, sign-in) get a plain edit menu.
function showChromeMenu(w, params) {
  if (!params.isEditable) return;
  const wc = w.chromeView.webContents;
  const f = params.editFlags;
  Menu.buildFromTemplate([
    { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
    { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
    { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
    { label: 'Select All', enabled: f.canSelectAll, click: () => wc.selectAll() },
  ]).popup({ window: w.win });
}

function openInNewWindow(url, isPrivate) {
  const w = createWindow({ private: isPrivate });
  const first = w.tabs[0];
  first.wc.loadURL(url).catch(() => {});
}

function printTab(tab) {
  if (tab && !tab.wc.isDestroyed()) tab.wc.print({}, () => {});
}

// ---------------------------------------------------------------- find in page

function openFind(w) {
  const tab = activeTab(w);
  if (!tab || tab.fullscreen) return;
  tab.find.open = true;
  layout(w);
  sendTabs(w);
  w.chromeView.webContents.focus();
  w.chromeView.webContents.send('focus-find');
}

function closeFind(tab) {
  if (!tab || !tab.find.open) return;
  tab.wc.stopFindInPage('keepSelection');
  tab.find = { open: false, text: '', active: 0, matches: 0 };
  layout(tab.w);
  sendTabs(tab.w);
  if (tab.id === tab.w.activeId) tab.wc.focus();
}

// newSession: the text changed, so start over; otherwise step to the next/previous match.
function findInTab(tab, text, { forward = true, newSession = false } = {}) {
  if (!tab) return;
  tab.find.text = text;
  if (!text) {
    tab.wc.stopFindInPage('clearSelection');
    tab.find.active = tab.find.matches = 0;
    sendTabs(tab.w);
    return;
  }
  tab.wc.findInPage(text, { forward, findNext: newSession });
}

function findStep(w, forward) {
  const tab = activeTab(w);
  if (!tab) return;
  if (tab.find.open && tab.find.text) findInTab(tab, tab.find.text, { forward });
  else openFind(w);
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

// Normal windows only see normal downloads; private windows see both.
const visibleDownloads = (w) => store.data.downloads.filter((d) => !d.private || (w && w.private));

function downloadSummary(w) {
  const active = visibleDownloads(w).filter((d) => d.state === 'progressing');
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
    for (const w of windows) {
      if (!liveWindow(w)) continue;
      const { active, progress } = downloadSummary(w);
      w.win.setProgressBar(active ? (progress >= 0 ? progress : 2) : -1);
    }
    sendAll();
  };
  if (immediate) {
    clearTimeout(downloadNotifyTimer);
    flush();
  } else if (!downloadNotifyTimer) {
    downloadNotifyTimer = setTimeout(flush, 250);
  }
}

function onWillDownload(_e, item, wc) {
  const savePath = uniqueDownloadPath(item.getFilename() || 'download');
  reservedPaths.add(savePath);
  item.setSavePath(savePath);

  const w = windowOfSession(wc ? wc.session : null);
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
    private: !!(w && w.private),
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

function openInternalPage(w, name) {
  const url = internalURL(name);
  const existing = w.tabs.find((t) => t.wc.getURL() === url);
  if (existing) selectTab(w, existing.id);
  else createTab(w, url);
}

// ---------------------------------------------------------------- ipc

// Each guard returns the caller's context (window or tab) or null to reject the call.
const fromChrome = (e) => windows.find((w) => w.chromeView.webContents === e.sender) || null;
const fromInternal = (e) => {
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame || !internalName(e.senderFrame.url)) return null;
  return tabOfWc(e.sender);
};

function handle(channel, guard, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    const ctx = guard(e);
    if (!ctx) throw new Error(`Unauthorized: ${channel}`);
    return fn(ctx, ...args);
  });
}

function setupIpc() {
  // nav:go comes from the toolbar (navigates the active tab) or an internal page (navigates itself).
  ipcMain.handle('nav:go', (e, text) => {
    const tab = fromInternal(e) || activeTab(fromChrome(e));
    if (!tab) throw new Error('Unauthorized: nav:go');
    const url = resolveInput(text);
    if (url) tab.wc.loadURL(url).catch(() => {});
  });

  handle('tab:new', fromChrome, (w) => {
    createTab(w, internalURL('newtab'));
  });
  handle('tab:close', fromChrome, (w, id) => closeTab(w, id));
  handle('tab:select', fromChrome, (w, id) => selectTab(w, id));
  handle('nav:back', fromChrome, (w) => activeTab(w)?.wc.navigationHistory.goBack());
  handle('nav:forward', fromChrome, (w) => activeTab(w)?.wc.navigationHistory.goForward());
  handle('nav:reload', fromChrome, (w) => {
    const t = activeTab(w);
    if (!t) return;
    if (t.wc.isLoading()) t.wc.stop();
    else t.wc.reload();
  });
  handle('bookmark:toggle', fromChrome, (w) => toggleBookmark(w));
  handle('permission:respond', fromChrome, (w, promptId, decision) => {
    if (['allow', 'block', 'dismiss'].includes(decision)) resolvePrompt(w, promptId, decision);
  });
  handle('auth:respond', fromChrome, (w, authId, username, password) =>
    resolveAuth(w, authId, username === null ? null : String(username), password));
  handle('find:query', fromChrome, (w, text, opts) => findInTab(activeTab(w), String(text || ''), opts || {}));
  handle('find:close', fromChrome, (w) => closeFind(activeTab(w)));
  handle('downloads:open', fromChrome, (w) => openInternalPage(w, 'downloads'));
  handle('update:install', fromChrome, () => restartToUpdate());
  handle('adblock:toggle-site', fromChrome, (w) => toggleSiteBlocking(w));

  handle('data:downloads', fromInternal, (tab) => visibleDownloads(tab.w));
  const ownDownload = (tab, id) => visibleDownloads(tab.w).find((d) => d.id === id);
  handle('download:open', fromInternal, (tab, id) => {
    const d = ownDownload(tab, id);
    if (d && d.state === 'completed') return shell.openPath(d.path);
  });
  handle('download:show', fromInternal, (tab, id) => {
    const d = ownDownload(tab, id);
    if (d) shell.showItemInFolder(d.path);
  });
  handle('download:cancel', fromInternal, (tab, id) => ownDownload(tab, id) && liveDownloads.get(id)?.cancel());
  handle('download:pause', fromInternal, (tab, id) => {
    const item = ownDownload(tab, id) && liveDownloads.get(id);
    if (!item) return;
    if (item.isPaused()) item.resume();
    else item.pause();
  });
  handle('download:clear', fromInternal, (tab) => {
    store.data.downloads = store.data.downloads.filter(
      (d) => d.state === 'progressing' || (d.private && !tab.w.private),
    );
    store.save();
    notifyDownloads(true);
  });

  handle('data:settings', fromInternal, () => ({
    ...store.data.settings,
    adblockAllowlist: store.data.adblockAllowlist,
  }));
  handle('data:settings-set', fromInternal, (_tab, key, value) => {
    if (!['restoreSession', 'adblock'].includes(key) || typeof value !== 'boolean') return;
    store.data.settings[key] = value;
    store.save();
    sendAll();
  });
  handle('data:adblock-allow-remove', fromInternal, (_tab, site) => {
    store.data.adblockAllowlist = store.data.adblockAllowlist.filter((s) => s !== site);
    store.save();
    sendAll();
  });

  handle('data:permissions', fromInternal, (tab) => permissionStore(tab.w));
  handle('data:permission-reset', fromInternal, (tab, origin) => {
    delete permissionStore(tab.w)[origin];
    if (!tab.w.private) store.save();
  });

  handle('data:history', fromInternal, () => store.data.history);
  handle('data:history-clear', fromInternal, () => {
    store.data.history = [];
    store.save();
  });
  handle('data:bookmarks', fromInternal, () => store.data.bookmarks);
  handle('data:bookmark-remove', fromInternal, (_tab, url) => {
    store.data.bookmarks = store.data.bookmarks.filter((b) => b.url !== url);
    store.save();
    sendAll();
  });
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  // Menu commands act on the focused browser window, opening one if none is open.
  const inWindow = (fn) => () => {
    const w = focusedWindow() || createWindow();
    fn(w);
  };
  const open = (name) => inWindow((w) => openInternalPage(w, name));

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
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: inWindow((w) => createTab(w, internalURL('newtab'))) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow({ private: true }) },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: inWindow((w) => closeTab(w, w.activeId)) },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: inWindow((w) => w.win.close()) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: inWindow(reopenClosedTab) },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: inWindow(focusAddress) },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: inWindow((w) => printTab(activeTab(w))) },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: open('settings') },
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
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: inWindow(openFind) },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: inWindow((w) => findStep(w, true)) },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: inWindow((w) => findStep(w, false)) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: inWindow((w) => activeTab(w)?.wc.reload()) },
        {
          label: 'Hard Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: inWindow((w) => activeTab(w)?.wc.reloadIgnoringCache()),
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: inWindow((w) => zoom(w, 0.5)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: inWindow((w) => zoom(w, -0.5)) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: inWindow((w) => zoom(w, 0)) },
        { type: 'separator' },
        {
          label: 'Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'F12',
          click: inWindow((w) => activeTab(w)?.wc.toggleDevTools()),
        },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: inWindow((w) => activeTab(w)?.wc.navigationHistory.goBack()),
        },
        {
          label: 'Forward',
          accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: inWindow((w) => activeTab(w)?.wc.navigationHistory.goForward()),
        },
        { type: 'separator' },
        { label: 'Show History', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: open('history') },
        { label: 'Show Downloads', accelerator: isMac ? 'Alt+Cmd+L' : 'Ctrl+J', click: open('downloads') },
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: inWindow(toggleBookmark) },
        { label: 'Show Bookmarks', accelerator: 'CmdOrCtrl+Shift+O', click: open('bookmarks') },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: inWindow((w) => cycleTab(w, 1)) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: inWindow((w) => cycleTab(w, -1)) },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
          label: n === 9 ? 'Last Tab' : `Tab ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: inWindow((w) => {
            const t = n === 9 ? w.tabs[w.tabs.length - 1] : w.tabs[n - 1];
            if (t) selectTab(w, t.id);
          }),
        })),
      ],
    },
    ...(isMac ? [{ role: 'windowMenu' }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- app

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
// BROWSER_PROFILE_DIR points any build (including a packaged one) at a throwaway profile for testing.
if (process.env.BROWSER_PROFILE_DIR) app.setPath('userData', path.resolve(process.env.BROWSER_PROFILE_DIR));
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Browser Dev'));

// Every renderer is sandboxed, including any created by Electron internals.
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);

// One running copy: opening the app again focuses an existing window.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on('second-instance', () => {
  const w = focusedWindow();
  if (!w) return void createWindow();
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
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

  adblock.init({
    cacheFile: path.join(app.getPath('userData'), 'adblock-engine.bin'),
    shouldBlock,
    onBlocked,
  });
  configureSession(session.defaultSession);
  app.on('login', onLogin);

  setupIpc();
  buildMenu();
  const restore = store.data.settings.restoreSession ? savedWindows() : [];
  if (restore.length) for (const s of restore) createWindow({ session: s });
  else createWindow();
  updater.start(sendAll);
});

// ---------------------------------------------------------------- updates

function restartToUpdate() {
  if (updater.install(true)) app.quit();
}

async function checkForUpdatesManually() {
  const parent = focusedWindow()?.win;
  const state = await updater.check();
  const version = app.getVersion();
  if (state.status === 'ready') {
    const { response } = await dialog.showMessageBox(parent, {
      message: `Browser ${state.version} is ready to install.`,
      detail: `You have ${version}. Browser will restart to finish updating.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    });
    if (response === 0) restartToUpdate();
  } else if (state.status === 'none') {
    dialog.showMessageBox(parent, { message: "You're up to date.", detail: `Browser ${version} is the latest version.` });
  } else if (state.status === 'checking' || state.status === 'downloading') {
    dialog.showMessageBox(parent, { message: 'An update is already being downloaded.' });
  } else {
    dialog.showMessageBox(parent, { type: 'warning', message: "Couldn't check for updates.", detail: state.error || '' });
  }
}

app.on('before-quit', () => {
  if (store) {
    saveSession(); // all windows are still open here, so this captures every one of them
    quitting = true;
    store.flush();
  }
  updater.install(false); // a downloaded update is applied whenever the app quits
});
app.on('window-all-closed', () => app.quit());
