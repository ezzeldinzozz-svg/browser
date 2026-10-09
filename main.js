'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  app,
  BaseWindow,
  WebContentsView,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
  webContents,
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
const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
};
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
      zoom: {}, // site -> zoom level (0 = 100%)
    };
    this.timer = null;
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // first run or unreadable file: start empty
    }
    this.data.settings = {
      restoreSession: true,
      adblock: true,
      searchEngine: 'duckduckgo',
      askDownloadLocation: false,
      downloadDir: null, // null = the OS Downloads folder
      ...this.data.settings,
    };
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
  return searchUrl(text);
}

function searchEngine() {
  return SEARCH_ENGINES[store.data.settings.searchEngine] || SEARCH_ENGINES.duckduckgo;
}

function searchUrl(query) {
  return searchEngine().url.replace('%s', encodeURIComponent(query));
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
    prompt: prompt
      ? {
          id: prompt.id,
          text: prompt.scheme
            ? `${new URL(prompt.origin).host} wants to open \u201c${prompt.scheme}:\u201d links in another app`
            : `${new URL(prompt.origin).host} wants to ${promptText(prompt.keys)}`,
        }
      : null,
    auth: auth ? { id: auth.id, host: auth.host, realm: auth.realm, insecure: auth.insecure } : null,
    find: current ? current.find : null,
    zoom: current ? Math.round(Math.pow(1.2, current.wc.getZoomLevel()) * 100) : 100,
    // lock icon in the address bar
    security: /^https:/i.test(currentUrl)
      ? 'secure'
      : /^http:/i.test(currentUrl)
        ? 'insecure'
        : internalName(currentUrl) && internalName(currentUrl) !== 'newtab'
          ? 'internal'
          : 'none',
    downloads: downloadSummary(w),
    update: updater.getState(),
    downloadWarning: (() => {
      const rec = store.data.downloads.find((d) => d.id === w.downloadWarnings[0]);
      return rec ? { id: rec.id, filename: rec.filename } : null;
    })(),
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
        pinned: t.pinned,
        audible: t.wc.isCurrentlyAudible(),
        muted: t.wc.isAudioMuted(),
      };
    }),
  });
}

const sendAll = () => windows.forEach(sendTabs);

function chromeHeight(w) {
  const tab = activeTab(w);
  if (!tab) return CHROME_H;
  if (tab.fullscreen) return 0;
  const bars = [w.downloadWarnings.length, tab.prompts.length, tab.auth.length, tab.find.open].filter(Boolean).length;
  return CHROME_H + bars * BAR_H;
}

const STATUS_H = 24;

// Shows (or hides, for '') the hovered link's URL in the bottom-left corner of the page.
function showStatus(w, url) {
  if (!liveWindow(w) || !w.statusView) return;
  w.statusText = url ? displayUrl(url) || url : '';
  w.statusView.webContents.send('status', w.statusText);
  if (w.statusText) w.win.contentView.addChildView(w.statusView); // keep it above the tab views
  layoutStatus(w);
}

function layoutStatus(w) {
  const [width, height] = w.win.getContentSize();
  const textWidth = Math.min(Math.round(width * 0.6), 7 * w.statusText.length + 28);
  w.statusView.setBounds({ x: 0, y: height - STATUS_H, width: Math.max(80, textWidth), height: STATUS_H });
  w.statusView.setVisible(!!w.statusText);
}

function layout(w) {
  if (!liveWindow(w)) return;
  const [width, height] = w.win.getContentSize();
  const top = chromeHeight(w);
  w.chromeView.setVisible(top > 0);
  // While a dropdown or popup is open the (transparent) toolbar view covers the whole window.
  w.chromeView.setBounds({ x: 0, y: 0, width, height: w.overlay && top ? height : top || CHROME_H });
  for (const t of w.tabs) {
    t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }
  if (w.statusView) layoutStatus(w);
}

// options.private: a private window with its own throwaway session
// options.session: { tabs: [history...], active } to restore
// options.ses: reuse this private session (a private tab moved to its own window)
// options.empty: start without a tab (one is about to be moved in)
function createWindow({ private: isPrivate = false, session: saved = null, ses: reuse = null, empty = false } = {}) {
  const ses = isPrivate ? reuse || createPrivateSession() : session.defaultSession;
  const win = new BaseWindow({
    ...restoredBounds(saved),
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
    overlay: false, // toolbar dropdown/popup open
    downloadWarnings: [], // ids of finished risky downloads awaiting Keep/Discard
    screenPick: null, // pending screen-sharing request
    statusView: null, // link-hover URL bubble
    statusText: '',
    permissions: {}, // private windows only
    allowlist: new Set(), // private windows only: sites with ad blocking switched off
  };
  windows.push(w);
  lastFocused = w;
  win.contentView.addChildView(chromeView);
  chromeView.setBackgroundColor('#00000000');

  const cwc = chromeView.webContents;
  cwc.setWindowOpenHandler(() => ({ action: 'deny' }));
  cwc.on('will-navigate', (e) => e.preventDefault());
  cwc.on('context-menu', (_e, params) => showChromeMenu(w, params));
  cwc.loadURL(UI_URL);
  cwc.once('did-finish-load', () => sendTabs(w));

  win.on('focus', () => {
    lastFocused = w;
  });
  win.on('resize', () => {
    layout(w);
    saveSessionSoon();
  });
  win.on('move', saveSessionSoon);
  if (saved && saved.maximized) win.maximize();
  // Leaving window fullscreen (green button, F11) also ends a page's video fullscreen.
  win.on('leave-full-screen', () => exitFullscreen(activeTab(w)));
  win.on('close', () => onWindowClose(w));
  win.on('closed', () => onWindowClosed(w));

  const statusView = new WebContentsView({
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  statusView.setBackgroundColor('#00000000');
  statusView.setVisible(false);
  statusView.webContents.loadURL(`${SCHEME}://ui/status.html`);
  statusView.webContents.on('will-navigate', (e) => e.preventDefault());
  w.statusView = statusView;
  win.contentView.addChildView(statusView);

  layout(w);
  if (saved && saved.tabs.length) {
    for (const h of saved.tabs) createTab(w, h.entries[h.index].url, { background: true, history: h });
    selectTab(w, w.tabs[Math.min(saved.active, w.tabs.length - 1)].id);
  } else if (!empty) {
    createTab(w, internalURL('newtab'));
  }
  if (!isPrivate) sessionFrozen = false;
  return w;
}

// Saved size/position, used only if it's still on a connected display.
function restoredBounds(saved) {
  const b = saved && saved.bounds;
  if (!b) return { width: 1280, height: 800 };
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y >= area.y - 10 && b.y < area.y + area.height - 100;
  return visible ? b : { width: b.width, height: b.height };
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
  if (!w.statusView.webContents.isDestroyed()) w.statusView.webContents.close();
  if (w.private && !windows.some((o) => o.ses === w.ses)) {
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

// Chromium verifies certificates as usual (callback(-3)); we only remember what it saw so the
// site info popup can show who issued the certificate and until when it's valid.
const certificates = new Map(); // hostname -> { issuer, subject, validExpiry, ok }

function onVerifyCertificate(request, callback) {
  const c = request.certificate;
  certificates.set(request.hostname, {
    issuer: c.issuerName,
    subject: c.subjectName,
    validExpiry: c.validExpiry * 1000,
    ok: request.verificationResult === 'net::OK',
  });
  if (certificates.size > 500) certificates.delete(certificates.keys().next().value);
  callback(-3);
}

function configureSession(ses) {
  ses.setCertificateVerifyProc(onVerifyCertificate);
  // Present as plain Chrome: sites such as Google sign-in reject the Electron token.
  ses.setUserAgent(
    app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(` ${app.getName()}/${app.getVersion()}`, ''),
  );
  ses.setPermissionRequestHandler(onPermissionRequest);
  ses.setPermissionCheckHandler(onPermissionCheck);
  ses.on('will-download', onWillDownload);
  // macOS 15+ shows its own screen/window picker; elsewhere our picker in the toolbar view.
  ses.setDisplayMediaRequestHandler(onDisplayMediaRequest, { useSystemPicker: true });
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
    pinned: !!(history && history.pinned),
    openerId: after ? after.id : null,
  };
  const afterIdx = after ? w.tabs.indexOf(after) : -1;
  if (afterIdx === -1) w.tabs.push(tab);
  else w.tabs.splice(afterIdx + 1 + openerRunLength(w, after, afterIdx), 0, tab);
  normalizeOrder(w);
  view.setVisible(false);
  w.win.contentView.addChildView(view);

  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (!isBlockedNavigation(wc.getURL(), target)) {
      const resolved = resolveInput(target);
      if (resolved) createTab(tab.w, resolved, { after: tab, background: disposition === 'background-tab' });
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
    sendTabs(tab.w);
  });
  wc.on('page-favicon-updated', (_e, favicons) => loadFavicon(tab, favicons[0]));
  wc.on('audio-state-changed', () => sendTabs(tab.w));
  wc.on('update-target-url', (_e, url) => {
    if (tab.id === tab.w.activeId) showStatus(tab.w, url);
  });
  wc.on('did-start-loading', () => sendTabs(tab.w));
  wc.on('did-stop-loading', () => sendTabs(tab.w));
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) tab.blocked = 0;
  });
  wc.on('did-navigate', (_e, u) => {
    applySiteZoom(tab);
    tab.favicon = tab.faviconSrc = '';
    dismissPrompts(tab); // a prompt must never carry over to a different page
    cancelAuth(tab);
    tab.find.active = tab.find.matches = 0;
    recordHistory(tab, u);
    saveSession();
    sendTabs(tab.w);
  });
  wc.on('did-navigate-in-page', (_e, u, isMainFrame) => {
    if (!isMainFrame) return;
    recordHistory(tab, u);
    saveSession();
    sendTabs(tab.w);
  });
  wc.on('found-in-page', (_e, result) => {
    tab.find.active = result.activeMatchOrdinal;
    tab.find.matches = result.matches;
    sendTabs(tab.w);
  });
  wc.on('enter-html-full-screen', () => {
    tab.fullscreen = true;
    if (!tab.w.win.isFullScreen()) tab.w.win.setFullScreen(true);
    layout(tab.w);
  });
  wc.on('leave-html-full-screen', () => {
    tab.fullscreen = false;
    if (tab.w.win.isFullScreen()) tab.w.win.setFullScreen(false);
    layout(tab.w);
  });
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    const url = tab.wc.getURL();
    tab.wc.loadURL(internalURL('error', { url: isInternalScheme(url) ? '' : url, desc: 'crashed' })).catch(() => {});
  });
  wc.on('unresponsive', async () => {
    if (tab.unresponsiveAsked) return;
    tab.unresponsiveAsked = true;
    const { response } = await dialog.showMessageBox(tab.w.win, {
      type: 'warning',
      message: 'Page unresponsive',
      detail: `${siteOf(wc.getURL()) || 'This page'} isn't responding. You can wait for it or close it.`,
      buttons: ['Wait', 'Exit Page'],
      defaultId: 0,
      cancelId: 0,
    });
    tab.unresponsiveAsked = false;
    if (response === 1 && !wc.isDestroyed()) wc.forcefullyCrashRenderer();
  });
  wc.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(tab.w.win, {
      type: 'question',
      message: 'Leave site?',
      detail: 'Changes you made may not be saved.',
      buttons: ['Leave', 'Stay'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) e.preventDefault(); // preventDefault ignores the page's beforeunload
  });
  wc.on('zoom-changed', (_e, direction) => zoom(tab.w, direction === 'in' ? 0.5 : -0.5, tab));
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

// Websites may not open the browser's own pages or local files. (Typing a file:// address,
// or opening a file from Finder, isn't a page-initiated navigation and still works.)
function isBlockedNavigation(fromUrl, toUrl) {
  if (/^file:/i.test(toUrl)) return !/^file:/i.test(fromUrl);
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
  if (w.activeId !== id) {
    exitFullscreen(activeTab(w));
    w.statusText = '';
  }
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

// Pinned tabs always come first; this keeps that true after any insert or move.
function normalizeOrder(w) {
  const pinned = w.tabs.filter((t) => t.pinned);
  if (pinned.length === 0) return;
  w.tabs = [...pinned, ...w.tabs.filter((t) => !t.pinned)];
}

function setPinned(tab, pinned) {
  const { w } = tab;
  if (tab.pinned === pinned) return;
  tab.pinned = pinned;
  w.tabs.splice(w.tabs.indexOf(tab), 1);
  const firstUnpinned = w.tabs.filter((t) => t.pinned).length;
  w.tabs.splice(firstUnpinned, 0, tab); // end of the pinned group, or start of the rest
  sendTabs(w);
  saveSession();
}

// Drag-and-drop reorder; a tab stays within its group (pinned or not).
function moveTab(w, id, toIndex) {
  const tab = getTab(w, id);
  if (!tab || !Number.isInteger(toIndex)) return;
  w.tabs.splice(w.tabs.indexOf(tab), 1);
  const pinnedCount = w.tabs.filter((t) => t.pinned).length;
  const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, w.tabs.length];
  w.tabs.splice(Math.min(max, Math.max(min, toIndex)), 0, tab);
  sendTabs(w);
  saveSession();
}

function duplicateTab(tab) {
  const history = tabHistory(tab);
  createTab(tab.w, tab.wc.getURL(), { after: tab, history: history ? { ...history, pinned: false } : null });
}

function toggleMute(tab) {
  tab.wc.setAudioMuted(!tab.wc.isAudioMuted());
  sendTabs(tab.w);
}

// Takes the tab out of its window without closing its page.
function detachTab(tab) {
  const { w } = tab;
  const idx = w.tabs.indexOf(tab);
  w.tabs.splice(idx, 1);
  dismissPrompts(tab);
  cancelAuth(tab);
  exitFullscreen(tab);
  w.win.contentView.removeChildView(tab.view);
  if (w.tabs.length === 0) w.win.close();
  else if (tab.id === w.activeId) selectTab(w, w.tabs[Math.min(idx, w.tabs.length - 1)].id);
  else sendTabs(w);
}

function moveTabToNewWindow(tab) {
  const from = tab.w;
  if (from.tabs.length < 2) return;
  const target = createWindow({ private: from.private, ses: from.private ? from.ses : null, empty: true });
  detachTab(tab);
  tab.w = target;
  tab.openerId = null;
  target.tabs.push(tab);
  normalizeOrder(target);
  target.win.contentView.addChildView(tab.view);
  layout(target);
  selectTab(target, tab.id);
}

function closeTabs(w, keep) {
  for (const t of w.tabs.filter((x) => !keep(x))) closeTab(w, t.id);
}

function showTabMenu(w, id) {
  const tab = getTab(w, id);
  if (!tab) return;
  const idx = w.tabs.indexOf(tab);
  const muted = tab.wc.isAudioMuted();
  Menu.buildFromTemplate([
    {
      label: 'New Tab to the Right',
      click: () => {
        const t = createTab(w, internalURL('newtab'));
        moveTab(w, t.id, w.tabs.indexOf(tab) + 1);
      },
    },
    { type: 'separator' },
    { label: 'Reload', click: () => tab.wc.reload() },
    { label: 'Duplicate', click: () => duplicateTab(tab) },
    { label: tab.pinned ? 'Unpin' : 'Pin', click: () => setPinned(tab, !tab.pinned) },
    { label: muted ? 'Unmute Tab' : 'Mute Tab', click: () => toggleMute(tab) },
    { type: 'separator' },
    { label: 'Move to New Window', enabled: w.tabs.length > 1, click: () => moveTabToNewWindow(tab) },
    { type: 'separator' },
    { label: 'Close', click: () => closeTab(w, tab.id) },
    { label: 'Close Other Tabs', enabled: w.tabs.length > 1, click: () => closeTabs(w, (t) => t === tab || t.pinned) },
    {
      label: 'Close Tabs to the Right',
      enabled: idx < w.tabs.length - 1,
      click: () => closeTabs(w, (t) => w.tabs.indexOf(t) <= w.tabs.indexOf(tab) || t.pinned),
    },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', enabled: w.closedTabs.length > 0, click: () => reopenClosedTab(w) },
  ]).popup({ window: w.win });
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

// Zoom is remembered per site (normal windows only) and applied whenever a tab opens that site.
function zoom(w, delta, tab = activeTab(w)) {
  if (!tab) return;
  const level = delta === 0 ? 0 : Math.max(-7, Math.min(9, tab.wc.getZoomLevel() + delta));
  tab.wc.setZoomLevel(level);
  const site = siteOf(tab.wc.getURL());
  if (site && !w.private) {
    if (level === 0) delete store.data.zoom[site];
    else store.data.zoom[site] = level;
    store.save();
  }
  sendTabs(w);
}

function applySiteZoom(tab) {
  const site = siteOf(tab.wc.getURL());
  const level = (site && !tab.w.private && store.data.zoom[site]) || 0;
  if (tab.wc.getZoomLevel() !== level) tab.wc.setZoomLevel(level);
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
  return entries.length ? { entries, index, pinned: tab.pinned } : null;
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
    if (tabs.length) {
      const bounds = w.win.isMaximized() || w.win.isFullScreen() ? w.win.getNormalBounds() : w.win.getBounds();
      saved.push({ tabs, active, bounds, maximized: w.win.isMaximized() });
    }
  }
  store.data.session = { windows: saved };
  store.save();
}

let saveSessionTimer = null;
function saveSessionSoon() {
  clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(() => saveSession(), 400);
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
  const scheme = permission === 'openExternal' && details.externalURL ? details.externalURL.split(':')[0] : null;
  tab.prompts.push({ id: nextPromptId++, origin, keys: pending, scheme, callbacks: [callback] });
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
  if (tab.w.screenPick && tab.w.screenPick.tab === tab) resolveScreenPick(tab.w, tab.w.screenPick.id, null);
  if (tab.prompts.length === 0) return;
  for (const p of tab.prompts.splice(0)) for (const cb of p.callbacks) cb(false);
  if (tab.id === tab.w.activeId) layout(tab.w);
}

// ---------------------------------------------------------------- screen sharing

let nextPickId = 1;

async function onDisplayMediaRequest(request, callback) {
  const wc = request.frame ? webContents.fromFrame(request.frame) : null;
  const tab = tabOfWc(wc);
  if (!tab || !request.videoRequested) return callback(null);
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  } catch {
    return callback(null);
  }
  const w = tab.w;
  if (!liveWindow(w)) return callback(null);
  if (w.screenPick) resolveScreenPick(w, w.screenPick.id, null); // one request at a time
  w.screenPick = { id: nextPickId++, tab, callback, sources: new Map(sources.map((s) => [s.id, s])) };
  selectTab(w, tab.id);
  w.chromeView.webContents.send('screen-picker', {
    id: w.screenPick.id,
    site: siteOf(request.securityOrigin) || request.securityOrigin,
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    })),
  });
  w.win.focus();
}

// sourceId null = cancel (the page's getDisplayMedia() rejects)
function resolveScreenPick(w, pickId, sourceId) {
  const pick = w.screenPick;
  if (!pick || pick.id !== pickId) return;
  w.screenPick = null;
  const source = sourceId ? pick.sources.get(sourceId) : null;
  try {
    pick.callback(source ? { video: source } : null);
  } catch {
    // the requesting frame went away
  }
  if (!w.chromeView.webContents.isDestroyed()) w.chromeView.webContents.send('screen-picker', null);
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
        label: `Search ${searchEngine().name} for “${trimLabel(params.selectionText)}”`,
        click: () => createTab(w, searchUrl(params.selectionText.trim()), { after: tab }),
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

function downloadDir() {
  const dir = store.data.settings.downloadDir;
  return dir && fs.existsSync(dir) ? dir : app.getPath('downloads');
}

function uniqueDownloadPath(name, dir = downloadDir()) {
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

// File types that can run code. They download under a temporary name and only get their real
// name once the user chooses Keep (like other browsers' "this file can harm your computer").
const RISKY_EXTENSIONS = new Set(
  ('exe msi msix appx bat cmd com scr pif cpl msc hta ps1 psm1 vbs vbe js jse wsf wsh reg lnk jar ' +
    'dmg pkg mpkg app command tool terminal workflow scpt sh bash zsh run bin appimage apk deb rpm')
    .split(' '),
);

function isRiskyFile(name) {
  return RISKY_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase());
}

// Marks a finished download as coming from the internet, so the OS checks it before it runs
// (macOS Gatekeeper via the quarantine attribute, Windows SmartScreen via Mark of the Web).
// Electron doesn't do this on its own.
function markAsDownloaded(filePath, url) {
  try {
    if (isMac) {
      const stamp = Math.floor(Date.now() / 1000).toString(16);
      const value = `0081;${stamp};${app.getName()};${require('crypto').randomUUID().toUpperCase()}`;
      require('child_process').execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, filePath]);
    } else if (process.platform === 'win32') {
      const host = isWeb(url) ? url : '';
      fs.writeFileSync(`${filePath}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${host}\r\n`);
    }
  } catch (err) {
    console.warn('Could not mark download:', err.message);
  }
}

function onWillDownload(_e, item, wc) {
  let finalPath = uniqueDownloadPath(item.getFilename() || 'download');
  if (store.data.settings.askDownloadLocation) {
    const owner = tabOfWc(wc)?.w || focusedWindow();
    const chosen = dialog.showSaveDialogSync(owner ? owner.win : undefined, { defaultPath: finalPath });
    if (!chosen) return item.cancel();
    finalPath = chosen;
  }
  reservedPaths.add(finalPath);
  const dangerous = isRiskyFile(finalPath);
  const savePath = dangerous ? `${finalPath}.unconfirmed` : finalPath;
  item.setSavePath(savePath);

  const sourceTab = tabOfWc(wc);
  const w = sourceTab ? sourceTab.w : windowOfSession(wc ? wc.session : null);
  const rec = {
    id: nextDownloadId++,
    url: item.getURL(),
    filename: path.basename(finalPath),
    path: finalPath,
    tempPath: dangerous ? savePath : null,
    dangerous,
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
    rec.received = item.getReceivedBytes();
    rec.paused = false;
    liveDownloads.delete(rec.id);
    if (state === 'completed') markAsDownloaded(savePath, rec.url); // survives the Keep rename
    if (state === 'completed' && dangerous) {
      rec.state = 'dangerous'; // waiting for Keep / Discard; finalPath stays reserved
      warnAboutDownload(w || focusedWindow(), rec);
    } else {
      rec.state = state; // 'completed' | 'cancelled' | 'interrupted'
      reservedPaths.delete(finalPath);
    }
    store.save();
    notifyDownloads(true);
  });

  store.save();
  notifyDownloads(true);
  if (liveWindow(w)) w.chromeView.webContents.send('download-started');
}

function warnAboutDownload(w, rec) {
  if (!liveWindow(w)) return; // still decidable from the downloads page
  w.downloadWarnings.push(rec.id);
  layout(w);
  sendTabs(w);
}

// decision: 'keep' moves the file to its real name; 'discard' deletes it.
function resolveDangerousDownload(id, decision) {
  const rec = store.data.downloads.find((d) => d.id === id);
  if (rec && rec.state === 'dangerous') {
    try {
      if (decision === 'keep') {
        reservedPaths.delete(rec.path);
        if (fs.existsSync(rec.path)) rec.path = uniqueDownloadPath(rec.filename);
        fs.renameSync(rec.tempPath, rec.path);
        rec.filename = path.basename(rec.path);
        rec.state = 'completed';
      } else {
        fs.rmSync(rec.tempPath, { force: true });
        reservedPaths.delete(rec.path);
        rec.state = 'cancelled';
        rec.discarded = true;
      }
    } catch (err) {
      console.error('Download decision failed:', err);
      rec.state = 'interrupted';
    }
    rec.tempPath = null;
    store.save();
  }
  for (const w of windows) {
    const before = w.downloadWarnings.length;
    w.downloadWarnings = w.downloadWarnings.filter((x) => x !== id);
    if (w.downloadWarnings.length !== before) layout(w);
  }
  notifyDownloads(true);
}

function openInternalPage(w, name) {
  const url = internalURL(name);
  const existing = w.tabs.find((t) => t.wc.getURL() === url);
  if (existing) selectTab(w, existing.id);
  else createTab(w, url);
}

// ---------------------------------------------------------------- clear browsing data

const CLEAR_RANGES = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 28 * 86400e3, all: Infinity };

// History and the downloads list honour the time range; Electron can only clear cookies,
// site data and the cache for all time.
async function clearBrowsingData(w, { range = 'hour', history, downloads, cookies, cache }) {
  const span = CLEAR_RANGES[range];
  if (!span) return;
  const since = span === Infinity ? 0 : Date.now() - span;
  const ses = w.private ? w.ses : session.defaultSession;
  if (history) {
    store.data.history = store.data.history.filter((h) => h.time < since);
    for (const win of windows) win.closedTabs = [];
  }
  if (downloads) {
    store.data.downloads = store.data.downloads.filter(
      (d) => d.state === 'progressing' || d.state === 'dangerous' || d.time < since,
    );
  }
  if (cookies) {
    await ses.clearStorageData();
    await ses.clearAuthCache();
  }
  if (cache) await ses.clearCache();
  store.save();
  sendAll();
}

// ---------------------------------------------------------------- address bar suggestions

const SUGGESTION_LIMIT = 6;

// Ranks bookmarks and history for what's typed: matches at the start of the host score highest,
// then title/URL matches, weighted by how often and how recently the page was visited.
function suggestions(text) {
  const query = text.trim().toLowerCase();
  if (!query) return { items: [], inline: null };

  const pages = new Map(); // url -> { url, title, visits, last, bookmarked }
  for (const h of store.data.history) {
    const p = pages.get(h.url) || { url: h.url, title: h.title, visits: 0, last: 0, bookmarked: false };
    p.visits++;
    if (h.time > p.last) {
      p.last = h.time;
      p.title = h.title;
    }
    pages.set(h.url, p);
  }
  for (const b of store.data.bookmarks) {
    const p = pages.get(b.url) || { url: b.url, title: b.title, visits: 0, last: 0 };
    p.bookmarked = true;
    p.title = p.title || b.title;
    pages.set(b.url, p);
  }

  const bare = (u) => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const now = Date.now();
  const scored = [];
  for (const p of pages.values()) {
    const short = bare(p.url).toLowerCase();
    const title = (p.title || '').toLowerCase();
    let score = 0;
    if (short.startsWith(query)) score = 100;
    else if (short.includes(query)) score = 40;
    else if (title.includes(query)) score = 30;
    else continue;
    const days = (now - p.last) / 86400000;
    score += Math.min(p.visits, 20) * 2 + (p.bookmarked ? 15 : 0) + Math.max(0, 10 - days);
    scored.push({ ...p, score, short });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, SUGGESTION_LIMIT);

  // Inline completion: finish the typed text when the best match's address starts with it,
  // completing to the host first (like other browsers) unless the user typed a path.
  let inline = null;
  const best = top[0];
  if (best && best.short.toLowerCase().startsWith(query) && !/\s/.test(query)) {
    const host = best.short.split('/')[0];
    const target = query.includes('/') || host.length <= query.length ? best.short.replace(/\/$/, '') : host;
    if (target.toLowerCase().startsWith(query) && target.length > query.length) inline = target;
  }

  return {
    items: top.map((p) => ({ url: p.url, title: p.title || p.short, display: p.short, bookmarked: !!p.bookmarked })),
    inline,
    engine: searchEngine().name,
  };
}

// ---------------------------------------------------------------- site info

const SITE_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'openExternal'];
const PERMISSION_NAMES = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard',
  openExternal: 'Open apps',
};

function siteInfo(w) {
  const tab = activeTab(w);
  if (!tab) return null;
  const url = tab.wc.getURL();
  const name = internalName(url);
  if (name) return { kind: 'internal', title: `${SCHEME}://${name}` };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isWeb(url)) return { kind: 'other', title: parsed.protocol.replace(':', '') };
  const origin = parsed.origin;
  const decisions = permissionStore(w)[origin] || {};
  const site = siteOf(url);
  // A reused connection may have been verified under a sibling hostname (e.g. without "www.").
  const host = parsed.hostname;
  const cert =
    parsed.protocol === 'https:'
      ? certificates.get(host) || certificates.get(host.replace(/^www\./, '')) || certificates.get(`www.${host}`) || null
      : null;
  return {
    kind: 'web',
    origin,
    host: parsed.host,
    secure: parsed.protocol === 'https:',
    certificate: cert,
    permissions: SITE_PERMISSIONS.map((key) => ({ key, name: PERMISSION_NAMES[key], value: decisions[key] || 'ask' })),
    adblock: { available: store.data.settings.adblock, on: blockingOnFor(w, site), blocked: tab.blocked },
    private: w.private,
  };
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
  handle('tab:menu', fromChrome, (w, id) => showTabMenu(w, id));
  handle('ui:overlay', fromChrome, (w, open) => {
    w.overlay = !!open;
    if (w.overlay) w.win.contentView.addChildView(w.chromeView); // bring the toolbar view to the front
    layout(w);
  });
  handle('suggest', fromChrome, (_w, text) => suggestions(String(text || '')));
  handle('screen:choose', fromChrome, (w, pickId, sourceId) => resolveScreenPick(w, pickId, sourceId ? String(sourceId) : null));
  handle('site:info', fromChrome, (w) => siteInfo(w));
  handle('site:set-permission', fromChrome, (w, origin, key, value) => {
    if (!PERM_LABELS[key] || !['allow', 'block', 'ask'].includes(value) || origin !== originOf(origin)) return;
    const perms = permissionStore(w);
    const site = (perms[origin] ||= {});
    if (value === 'ask') delete site[key];
    else site[key] = value;
    if (Object.keys(site).length === 0) delete perms[origin];
    if (!w.private) store.save();
  });
  handle('site:clear-data', fromChrome, async (w) => {
    const tab = activeTab(w);
    const origin = tab && originOf(tab.wc.getURL());
    if (!origin) return;
    await w.ses.clearStorageData({ origin });
    tab.wc.reload();
  });
  handle('tab:move', fromChrome, (w, id, index) => moveTab(w, id, index));
  handle('tab:mute', fromChrome, (w, id) => {
    const tab = getTab(w, id);
    if (tab) toggleMute(tab);
  });
  handle('nav:back', fromChrome, (w) => activeTab(w)?.wc.navigationHistory.goBack());
  handle('nav:forward', fromChrome, (w) => activeTab(w)?.wc.navigationHistory.goForward());
  handle('nav:history-menu', fromChrome, (w, dir) => {
    const tab = activeTab(w);
    if (!tab) return;
    const nav = tab.wc.navigationHistory;
    const entries = nav.getAllEntries();
    const current = nav.getActiveIndex();
    const indexes = [];
    if (dir === 'back') for (let i = current - 1; i >= 0 && indexes.length < 15; i--) indexes.push(i);
    else for (let i = current + 1; i < entries.length && indexes.length < 15; i++) indexes.push(i);
    if (indexes.length === 0) return;
    Menu.buildFromTemplate([
      ...indexes.map((i) => ({
        label: trimLabel(entries[i].title || displayUrl(entries[i].url) || entries[i].url, 60),
        click: () => nav.goToIndex(i),
      })),
      { type: 'separator' },
      { label: 'Show Full History', click: () => openInternalPage(w, 'history') },
    ]).popup({ window: w.win });
  });
  handle('zoom:reset', fromChrome, (w) => zoom(w, 0));
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
  handle('downloads:recent', fromChrome, (w) => visibleDownloads(w).slice(0, 6));
  handle('downloads:action', fromChrome, (w, id, action) => {
    const d = visibleDownloads(w).find((x) => x.id === id);
    if (!d) return;
    if (action === 'open' && d.state === 'completed') return shell.openPath(d.path).then(() => undefined);
    if (action === 'show') return shell.showItemInFolder(d.path);
    if (action === 'cancel') return liveDownloads.get(id)?.cancel();
    if (action === 'keep' || action === 'discard') return resolveDangerousDownload(id, action);
  });
  handle('download:warning-decide', fromChrome, (w, id, decision) => {
    if (w.downloadWarnings.includes(id) && ['keep', 'discard'].includes(decision)) resolveDangerousDownload(id, decision);
  });
  handle('update:install', fromChrome, () => restartToUpdate());
  handle('about:info', fromInternal, () => ({ version: app.getVersion(), update: updater.getState() }));
  handle('about:check', fromInternal, () => updater.check());
  handle('about:install', fromInternal, () => restartToUpdate());
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
  handle('download:decide', fromInternal, (tab, id, decision) => {
    if (ownDownload(tab, id) && ['keep', 'discard'].includes(decision)) resolveDangerousDownload(id, decision);
  });
  handle('download:clear', fromInternal, (tab) => {
    store.data.downloads = store.data.downloads.filter(
      (d) => d.state === 'progressing' || d.state === 'dangerous' || (d.private && !tab.w.private),
    );
    store.save();
    notifyDownloads(true);
  });

  handle('data:settings', fromInternal, () => ({
    ...store.data.settings,
    adblockAllowlist: store.data.adblockAllowlist,
    searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
    searchEngineName: searchEngine().name,
    downloadDirShown: downloadDir(),
  }));
  handle('downloads:choose-folder', fromInternal, async (tab) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(tab.w.win, {
      defaultPath: downloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return null;
    store.data.settings.downloadDir = filePaths[0];
    store.save();
    return filePaths[0];
  });
  handle('data:history-remove', fromInternal, (_tab, url) => {
    store.data.history = store.data.history.filter((h) => h.url !== url);
    store.save();
  });
  handle('data:settings-set', fromInternal, (_tab, key, value) => {
    const valid =
      (['restoreSession', 'adblock', 'askDownloadLocation'].includes(key) && typeof value === 'boolean') ||
      (key === 'searchEngine' && Object.hasOwn(SEARCH_ENGINES, value));
    if (!valid) return;
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

  handle('default:status', fromInternal, () => ({
    supported: app.isPackaged,
    isDefault: app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https'),
  }));
  handle('default:set', fromInternal, () => {
    if (!app.isPackaged) return false;
    // Windows 10+ only lets the user change the default browser in Settings.
    if (process.platform === 'win32') return shell.openExternal('ms-settings:defaultapps').then(() => false);
    return app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
  });
  handle('data:clear-browsing', fromInternal, (tab, opts) => clearBrowsingData(tab.w, opts || {}));
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
        { type: 'separator' },
        {
          label: 'Clear Browsing Data…',
          accelerator: 'CmdOrCtrl+Shift+Backspace',
          click: inWindow((w) => {
            const url = internalURL('settings') + '#clear';
            const existing = w.tabs.find((t) => t.wc.getURL().startsWith(internalURL('settings')));
            if (existing) {
              selectTab(w, existing.id);
              existing.wc.loadURL(url).catch(() => {});
            } else {
              createTab(w, url);
            }
          }),
        },
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
app.on('second-instance', (_e, argv) => {
  const urls = argv.slice(1).map(urlFromArg).filter(Boolean);
  if (urls.length && launched) return void urls.forEach(openFromOutside);
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
  if (isMac) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: 'New Window', click: () => createWindow() },
        { label: 'New Private Window', click: () => createWindow({ private: true }) },
      ]),
    );
  }
  const restore = store.data.settings.restoreSession ? savedWindows() : [];
  if (restore.length) for (const s of restore) createWindow({ session: s });
  else createWindow();
  launched = true;
  for (const url of [...process.argv.slice(1).map(urlFromArg).filter(Boolean), ...pendingOpens.splice(0)]) {
    openFromOutside(url);
  }
  updater.start(sendAll);
});

// ---------------------------------------------------------------- links from other apps

const pendingOpens = []; // links that arrive before the first window exists
let launched = false;

// A command-line argument that should open as a page (Windows/Linux pass links this way).
function urlFromArg(arg) {
  if (/^(https?|file):\/\//i.test(arg)) return arg;
  if (!arg.startsWith('-') && /\.(html?|xhtml|svg|pdf|txt)$/i.test(arg) && fs.existsSync(arg)) {
    return pathToFileURL(path.resolve(arg)).href;
  }
  return null;
}

function openFromOutside(url) {
  if (!/^(https?|file):/i.test(url)) return;
  if (!launched) return void pendingOpens.push(url);
  const normal = windows.filter((o) => !o.private && liveWindow(o));
  const w = normal.includes(lastFocused) ? lastFocused : normal[0] || createWindow({ empty: true });
  createTab(w, url);
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
  if (isMac) app.focus({ steal: true });
}

app.on('open-url', (e, url) => {
  e.preventDefault();
  openFromOutside(url);
});
app.on('open-file', (e, file) => {
  e.preventDefault();
  openFromOutside(pathToFileURL(file).href);
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
// macOS apps keep running with no windows; the Dock icon or a menu command opens a new one.
app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
app.on('activate', () => {
  if (app.isReady() && store && windows.length === 0) createWindow();
});
