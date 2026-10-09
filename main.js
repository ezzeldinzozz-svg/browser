'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL, domainToUnicode } = require('url');
const {
  app,
  BaseWindow,
  WebContentsView,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  ShareMenu,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
  webContents,
  webFrameMain,
} = require('electron');
// The product is called Operecs, but internally the app keeps the name it shipped with
// ("Browser"): the profile folder, the keychain item that encrypts cookies ("Browser Safe
// Storage") and the bundle id stay the same, so renaming signs nobody out and loses no data.
app.setName('Browser');
const DISPLAY_NAME = 'Operecs';

// An extension's native helper app (e.g. iCloud Passwords' Apple helper) can exit right away
// when it refuses to talk to this browser; the extension library then writes to a closed pipe.
// That must never take down the browser or show an error dialog.
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED')) {
    console.warn('Ignored a closed connection:', err.message);
    return;
  }
  console.error(err);
  dialog.showErrorBox('Something went wrong in Operecs', err && err.stack ? err.stack : String(err));
});

const updater = require('./updater');
const adblock = require('./adblock');
const bookmarks = require('./bookmarks');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');

const CHROME_H = 80; // tab strip (38, also the title bar) + toolbar (42)
// Pages sit in a rounded card inset from the window edge (matches the brand's card look).
const PAGE_INSET = 8;
const PAGE_RADIUS = 12;
// Window background behind the toolbar and around the page card; keep in sync with --canvas in ui/style.css.
const CANVAS = { light: '#ecebf1', dark: '#0c0a11', private: '#120a22' };
const canvasColor = (isPrivate) => (isPrivate ? CANVAS.private : nativeTheme.shouldUseDarkColors ? CANVAS.dark : CANVAS.light);
const windowsTitleBar = (isPrivate) => ({
  color: canvasColor(isPrivate),
  symbolColor: isPrivate || nativeTheme.shouldUseDarkColors ? '#f3f1f7' : '#17141f',
  height: 38,
});
const BOOKMARKS_BAR_H = 30;
const BAR_H = 44; // optional bars under the toolbar: permission prompt, sign-in, find
const UI_DIR = path.join(__dirname, 'ui');
const PAGES_DIR = path.join(__dirname, 'pages');
const PRELOAD = path.join(__dirname, 'gen', 'preload.js'); // bundled from preload.js by scripts/build.js
// The browser's own pages live at browser://<name>/ and are served from pages/<name>.html.
// The toolbar is browser://ui/. Only these origins may call the privileged IPC API.
const SCHEME = 'browser';
const INTERNAL = new Set(['newtab', 'history', 'bookmarks', 'downloads', 'settings', 'error', 'welcome', 'privacy', 'extensions', 'shortcuts', 'licenses', 'tasks', 'reader']);
const UI_URL = `${SCHEME}://ui/`;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const FAVICON_MAX_BYTES = 256 * 1024;
const SESSION_ENTRY_LIMIT = 50; // back/forward entries kept per tab
const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', suggest: 'https://ac.ecosia.org/autocomplete?q=%s&type=list' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=%s' }, // its suggestions need a sign-in token
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s', suggest: 'https://www.startpage.com/suggestions?q=%s&format=opensearch' },
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
  'automatic-downloads': 'download multiple files',
  // An embedded site (sign-in widget, video player…) asking for its cookies while third-party
  // cookies are blocked (Storage Access API).
  'storage-access': 'use its cookies and site data while embedded on other sites',
  'top-level-storage-access': 'use its cookies and site data while embedded on other sites',
};
// Permission types that can be set to Ask or Block for every site in Settings.
const PERMISSION_DEFAULT_KEYS = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'automatic-downloads'];
const PROMPTABLE = new Set(['media', ...Object.keys(PERM_LABELS)]);

const isMac = process.platform === 'darwin';

// ---------------------------------------------------------------- storage

// Settings a new profile starts with (and what Reset settings restores).
function defaultSettings() {
  return {
    restoreSession: true,
    blockThirdPartyCookies: true,
    startup: null, // 'continue' | 'newtab' | 'pages' (null: derived from restoreSession)
    startupPages: [],
    showHomeButton: false,
    homePage: '', // '' = the New Tab page
    permissionDefaults: {}, // type -> 'block' (absent = ask)
    adblock: true,
    searchEngine: 'duckduckgo',
    showBookmarksBar: true,
    confirmClose: true, // "Close 5 tabs?" / "Quit with 8 tabs open?"
    gpc: true, // Global Privacy Control: Sec-GPC header + navigator.globalPrivacyControl
    autoplay: 'block-audible', // 'block-audible' (until the user interacts) | 'allow'
    httpsOnly: true, // try https:// for http:// sites; warn before using http
    memorySaver: true, // put background tabs to sleep
    memorySaverMinutes: 30,
    languages: [], // preferred website languages (Accept-Language); empty = the system's
    spellcheck: true,
    defaultZoom: 100, // percent, for sites without their own zoom
    hiddenTiles: [], // sites removed from the new tab page's most-visited tiles
    dns: 'automatic', // 'automatic' | 'off' | 'cloudflare' | 'quad9' | 'custom'
    dnsCustom: '',
    askDownloadLocation: false,
    downloadDir: null, // null = the OS Downloads folder
    searchSuggestions: false, // send what's typed in the address bar to the search engine (opt-in)
    customEngines: [], // [{ name, keyword, url with %s }]
    theme: 'system', // 'system' | 'light' | 'dark' (browser UI, internal pages, and sites that follow it)
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.isNew = !fs.existsSync(file); // first launch of this profile
    this.data = {
      history: [],
      permissions: {},
      downloads: [],
      session: null,
      settings: {},
      adblockAllowlist: [],
      zoom: {}, // site -> zoom level (0 = 100%)
    };
    this.timer = null;
    // The previous good version is kept as .bak. If the main file is damaged, it's set aside
    // (never overwritten) and the backup is used instead of silently starting empty.
    this.recoveredFrom = null;
    for (const candidate of [file, `${file}.bak`]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        Object.assign(this.data, JSON.parse(fs.readFileSync(candidate, 'utf8')));
        if (candidate !== file) this.recoveredFrom = candidate;
        break;
      } catch (err) {
        if (candidate === file) {
          const aside = `${file}.damaged-${Date.now()}`;
          fs.renameSync(file, aside);
          console.error(`Profile data was unreadable (${err.message}); kept it as ${aside}`);
          this.isNew = false;
        }
      }
    }
    this.data.settings = { ...defaultSettings(), ...this.data.settings };
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
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
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
  if (name === 'error' || name === 'reader') return readableHost(new URL(u).searchParams.get('url') || '');
  if (name) return `${SCHEME}://${name}`;
  return readableHost(u);
}

// ---------------------------------------------------------------- reader mode

// Mozilla Readability (the library behind Firefox's Reader View) runs in an isolated world of the
// page, so the page's own scripts can't see or tamper with it. The article is then shown at
// browser://reader inside a sandboxed frame without scripts.
const READABILITY = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const READERABLE = fs.readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8');
const READER_WORLD = 1201;
const readerArticles = new Map(); // id -> article (kept for this run only)
let nextArticleId = 1;

async function checkReaderable(tab) {
  const url = tab.wc.getURL();
  if (!isWeb(url) || tab.wc.isDestroyed()) return;
  try {
    const ok = await tab.wc.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code: `${READERABLE}\n;isProbablyReaderable(document)` }]);
    if (tab.wc.isDestroyed() || tab.wc.getURL() !== url || tab.readerable === !!ok) return;
    tab.readerable = !!ok;
    if (tab.id === tab.w.activeId) sendTabs(tab.w);
  } catch {
    // page navigated away or crashed meanwhile
  }
}

const READER_EXTRACT = `;(() => {
  const a = new Readability(document.cloneNode(true)).parse();
  return a && { title: a.title, byline: a.byline, siteName: a.siteName, content: a.content, dir: a.dir,
    lang: a.lang || document.documentElement.lang, publishedTime: a.publishedTime, length: a.length };
})()`;

async function toggleReader(w) {
  const tab = activeTab(w);
  if (!tab) return;
  const url = tab.wc.getURL();
  if (internalName(url) === 'reader') return exitReader(tab);
  if (!isWeb(url)) return;
  let article = null;
  try {
    article = await tab.wc.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code: READABILITY + READER_EXTRACT }]);
  } catch {
    article = null;
  }
  if (!article || !article.content || tab.wc.isDestroyed() || tab.wc.getURL() !== url) {
    tab.readerable = false;
    return sendTabs(w);
  }
  const id = nextArticleId++;
  readerArticles.set(id, { ...article, url });
  if (readerArticles.size > 30) readerArticles.delete(readerArticles.keys().next().value);
  tab.wc.loadURL(internalURL('reader', { id: String(id), url })).catch(() => {});
}

function exitReader(tab) {
  const nav = tab.wc.navigationHistory;
  if (nav.canGoBack()) return nav.goBack();
  const original = new URL(tab.wc.getURL()).searchParams.get('url');
  if (original && isWeb(original)) tab.wc.loadURL(original).catch(() => {});
}

const READER_PREFS = { size: [14, 16, 18, 20, 22, 24, 26, 28], font: ['serif', 'sans'], theme: ['auto', 'light', 'sepia', 'dark'], width: ['narrow', 'medium', 'wide'] };
function readerPrefs() {
  const saved = store.data.settings.reader || {};
  return {
    size: READER_PREFS.size.includes(saved.size) ? saved.size : 20,
    font: READER_PREFS.font.includes(saved.font) ? saved.font : 'serif',
    theme: READER_PREFS.theme.includes(saved.theme) ? saved.theme : 'auto',
    width: READER_PREFS.width.includes(saved.width) ? saved.width : 'medium',
  };
}

// ---------------------------------------------------------------- cookies and site data

// Groups hosts by site: "mail.google.com" -> "google.com", "news.bbc.co.uk" -> "bbc.co.uk".
// (A short heuristic, not the full public suffix list.)
function siteKey(host) {
  const labels = String(host).replace(/^\./, '').replace(/\.$/, '').toLowerCase().split('.');
  if (labels.length <= 2 || /^[\d.]+$/.test(host)) return labels.join('.');
  const [sld, tld] = labels.slice(-2);
  const take = tld.length === 2 && (sld.length <= 3 || ['gov', 'com', 'net', 'org', 'edu', 'ac', 'co'].includes(sld)) ? 3 : 2;
  return labels.slice(-take).join('.');
}

// Sites with cookies, which is what Chromium lets us list (other storage can't be enumerated).
async function siteDataList(w) {
  const ses = w.private ? w.ses : session.defaultSession;
  const sites = new Map();
  for (const c of await ses.cookies.get({})) {
    const host = c.domain.replace(/^\./, '');
    const key = siteKey(host);
    const entry = sites.get(key) || { site: key, cookies: 0, hosts: new Set() };
    entry.cookies++;
    entry.hosts.add(host);
    sites.set(key, entry);
  }
  return [...sites.values()]
    .map((e) => ({ site: e.site, cookies: e.cookies, hosts: [...e.hosts].sort() }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

async function removeSiteData(w, site) {
  if (!site) return;
  const ses = w.private ? w.ses : session.defaultSession;
  const hosts = new Set([site, `www.${site}`]);
  for (const c of await ses.cookies.get({})) {
    const host = c.domain.replace(/^\./, '');
    if (siteKey(host) !== site) continue;
    hosts.add(host);
    await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, c.name).catch(() => {});
  }
  for (const host of hosts) {
    for (const scheme of ['https', 'http']) await ses.clearStorageData({ origin: `${scheme}://${host}` }).catch(() => {});
  }
}

// ---------------------------------------------------------------- international domain names

// Chromium keeps hosts in their ASCII (punycode) form, e.g. "xn--bcher-kva.de". We show the real
// letters ("bücher.de") unless the name could imitate another site: letters from scripts that
// don't normally mix ("аpple" with a Cyrillic а), or a name written entirely in Cyrillic letters
// that look Latin ("аррӏе"). Those stay in punycode, like Chrome and Firefox do.
const IDN_SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Hebrew', 'Arabic', 'Devanagari', 'Bengali', 'Tamil', 'Thai', 'Georgian', 'Hangul', 'Hiragana', 'Katakana', 'Han', 'Bopomofo', 'Ethiopic', 'Khmer']
  .map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')]);
const IDN_NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u;
const IDN_CJK_MIXES = [
  new Set(['Latin', 'Han', 'Hiragana', 'Katakana']),
  new Set(['Latin', 'Han', 'Hangul']),
  new Set(['Latin', 'Han', 'Bopomofo']),
];
const CYRILLIC_LOOKALIKES = new Set('аϲсԁеһіјӏорԛѕԝхуъьҽпгѵѡ'.normalize('NFC'));

function labelScripts(label) {
  const scripts = new Set();
  for (const ch of label) {
    if (IDN_NEUTRAL.test(ch)) continue;
    const hit = IDN_SCRIPTS.find(([, re]) => re.test(ch));
    scripts.add(hit ? hit[0] : `other:${ch}`);
  }
  return scripts;
}

function idnLooksSafe(unicodeHost) {
  const labels = unicodeHost.split('.');
  const tld = labels[labels.length - 1];
  for (const label of labels) {
    const scripts = labelScripts(label);
    if ([...scripts].some((sc) => sc.startsWith('other:'))) return false;
    if (scripts.size > 1 && !IDN_CJK_MIXES.some((mix) => [...scripts].every((sc) => mix.has(sc)))) return false;
    if (
      scripts.size === 1 && scripts.has('Cyrillic') && !labelScripts(tld).has('Cyrillic') &&
      [...label].every((ch) => CYRILLIC_LOOKALIKES.has(ch) || IDN_NEUTRAL.test(ch))
    ) return false;
  }
  return true;
}

function readableHost(u) {
  try {
    const parsed = new URL(u);
    if (!isWeb(parsed.href) || !parsed.hostname.includes('xn--')) return u;
    const unicode = domainToUnicode(parsed.hostname);
    if (!unicode || !idnLooksSafe(unicode)) return u;
    const at = u.indexOf(parsed.hostname, u.indexOf('://') + 3);
    return at === -1 ? u : u.slice(0, at) + unicode + u.slice(at + parsed.hostname.length);
  } catch {
    return u;
  }
}

function resolveInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const internal = text.match(/^browser:\/\/(\w+)\/?$/i);
  if (internal) return INTERNAL.has(internal[1].toLowerCase()) ? internalURL(internal[1].toLowerCase()) : null;
  if (/^(https?|file):\/\//i.test(text)) return text;
  const keyword = keywordSearch(text);
  if (keyword) return keyword.engine.url.replace('%s', encodeURIComponent(keyword.query));
  if (!/\s/.test(text)) {
    if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#].*)?$/i.test(text)) return 'http://' + text;
    if (/^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  }
  return searchUrl(text);
}

// Typing "<keyword> <words>" in the address bar searches that engine. Built-in engines use their
// domain as the keyword (like Chrome); the user's own engines have short keywords ("w", "yt").
const BUILTIN_KEYWORDS = {
  duckduckgo: 'duckduckgo.com',
  google: 'google.com',
  bing: 'bing.com',
  brave: 'search.brave.com',
  ecosia: 'ecosia.org',
  kagi: 'kagi.com',
  startpage: 'startpage.com',
};

function allEngines() {
  return [
    ...Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, ...e, keyword: BUILTIN_KEYWORDS[id] })),
    ...(store.data.settings.customEngines || []).map((c) => ({ id: `custom:${c.keyword}`, name: c.name, url: c.url, keyword: c.keyword, custom: true })),
  ];
}

function searchEngine() {
  return allEngines().find((e) => e.id === store.data.settings.searchEngine) || SEARCH_ENGINES.duckduckgo;
}

function keywordSearch(text) {
  const m = String(text).trim().match(/^(\S+)\s+(\S.*)$/);
  if (!m) return null;
  const keyword = m[1].toLowerCase();
  const engine = allEngines().find((e) => e.keyword && e.keyword.toLowerCase() === keyword);
  return engine ? { engine, query: m[2] } : null;
}

const ENGINE_KEYWORD = /^[^\s:/]{1,30}$/;
function validCustomEngine(name, keyword, url) {
  return (
    typeof name === 'string' && name.trim().length > 0 && name.length <= 60 &&
    typeof keyword === 'string' && ENGINE_KEYWORD.test(keyword) &&
    typeof url === 'string' && url.length <= 2000 && /^https?:\/\/[^\s]+$/i.test(url) && url.includes('%s')
  );
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

// macOS share sheet (Mail, Messages, AirDrop, Notes…) for the page.
function sharePage(w, tab) {
  if (!tab || !isWeb(tab.wc.getURL())) return;
  new ShareMenu({ urls: [tab.wc.getURL()] }).popup({ window: w.win });
}

// Handoff: the focused window's page shows up on the user's iPhone/iPad (and other Macs) to
// continue in their browser there. Never for private windows.
let handoffUrl = null;
function updateHandoff(w) {
  if (!isMac || w !== focusedWindow()) return;
  const tab = activeTab(w);
  const url = tab && !w.private && !tab.wc.isDestroyed() && isWeb(tab.wc.getURL()) ? tab.wc.getURL() : null;
  if (url === handoffUrl) return;
  handoffUrl = url;
  try {
    if (url) app.setUserActivity('NSUserActivityTypeBrowsingWeb', {}, url);
    else app.invalidateCurrentActivity();
  } catch {
    // not available on this system
  }
}

function sendTabs(w) {
  updateHandoff(w);
  if (!liveWindow(w) || w.chromeView.webContents.isDestroyed()) return;
  const current = activeTab(w);
  const currentUrl = current ? current.wc.getURL() : '';
  const prompt = current && current.prompts[0];
  const auth = current && current.auth[0];
  const site = siteOf(currentUrl);
  w.chromeView.webContents.send('tabs:update', {
    activeId: w.activeId,
    activeWebContentsId: current && !w.private ? current.wc.id : null,
    private: w.private,
    bookmarked: !!bookmarks.findByUrl(currentUrl),
    bookmarkBar: store.data.settings.showBookmarksBar ? bookmarks.tree().bar.children.map(bookmarks.summary) : null,
    canBookmark: isWeb(currentUrl),
    reader: current ? (internalName(currentUrl) === 'reader' ? 'on' : current.readerable ? 'available' : null) : null,
    prompt: prompt
      ? {
          id: prompt.id,
          text: prompt.scheme
            ? `${new URL(prompt.origin).host} wants to open \u201c${prompt.scheme}:\u201d links in another app`
            : `${new URL(prompt.origin).host} wants to ${promptText(prompt.keys)}`,
        }
      : null,
    auth: auth ? { id: auth.id, host: auth.host, realm: auth.realm, insecure: auth.insecure, proxy: auth.proxy } : null,
    find: current ? current.find : null,
    zoom: current ? Math.round(Math.pow(1.2, current.wc.getZoomLevel()) * 100) : 100,
    capture: current ? captureState(current) : null,
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
    restoreOffer: !!w.restoreOffer,
    showHome: !!store.data.settings.showHomeButton,
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
      const pendingEntry = t.pending && t.pending.entries[t.pending.index];
      const url = pendingEntry ? pendingEntry.url : t.wc.getURL();
      return {
        id: t.id,
        title: (pendingEntry ? pendingEntry.title : t.wc.getTitle()) || displayUrl(url) || 'New Tab',
        url: displayUrl(url),
        loading: t.wc.isLoading(),
        favicon: t.favicon,
        canGoBack: canGo(t.wc, 'back'),
        canGoForward: canGo(t.wc, 'forward'),
        pinned: t.pinned,
        multi: w.multi.size > 1 && w.multi.has(t.id),
        sleeping: !!t.pending,
        capture: captureState(t),
        audible: t.wc.isCurrentlyAudible(),
        muted: t.wc.isAudioMuted(),
      };
    }),
    media: mediaTabs(w),
  });
}

// ---------------------------------------------------------------- media hub

// Tabs (in windows of the same kind) that are playing or have paused media, for the toolbar's
// media button. Chromium's own media-key / Now Playing support handles the keyboard.
function mediaTabs(w) {
  const current = activeTab(w);
  return allTabs()
    .filter((t) => t.w.private === w.private && t.media && !t.wc.isDestroyed())
    .map((t) => ({
      id: t.id,
      title: t.wc.getTitle() || displayUrl(t.wc.getURL()),
      site: siteOf(t.wc.getURL()) || '',
      favicon: t.favicon,
      playing: t.media === 'playing',
      current: t === current,
    }));
}

function setMediaState(tab, state) {
  if (tab.media === state) return;
  tab.media = state;
  windows.filter((x) => x.private === tab.w.private).forEach(sendTabs);
}

// Play/pause the media in every frame of the tab (videos inside iframes too).
const MEDIA_TOGGLE = (pause) => `(() => {
  const els = [...document.querySelectorAll('video, audio')];
  if (${pause}) { els.forEach((m) => { if (!m.paused) m.pause(); }); return els.length; }
  const target = els.find((m) => m.paused && m.currentTime > 0) || els.find((m) => m.paused);
  if (target) target.play().catch(() => {});
  return target ? 1 : 0;
})()`;

async function toggleMedia(tab) {
  const pause = tab.media === 'playing';
  for (const frame of tab.wc.mainFrame.framesInSubtree) {
    try {
      const n = await frame.executeJavaScript(MEDIA_TOGGLE(pause));
      if (!pause && n) break; // resume one thing, not every player on the page
    } catch {
      // frame went away
    }
  }
}

const sendAll = () => windows.forEach(sendTabs);

function chromeHeight(w) {
  const tab = activeTab(w);
  if (!tab) return CHROME_H + (store.data.settings.showBookmarksBar ? BOOKMARKS_BAR_H : 0);
  if (tab.fullscreen) return 0;
  const bars = [w.restoreOffer, w.downloadWarnings.length, tab.prompts.length, tab.auth.length, tab.find.open].filter(Boolean).length;
  return CHROME_H + (store.data.settings.showBookmarksBar ? BOOKMARKS_BAR_H : 0) + bars * BAR_H;
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
  w.statusView.setBounds({ x: PAGE_INSET, y: height - STATUS_H - PAGE_INSET, width: Math.max(80, textWidth), height: STATUS_H });
  w.statusView.setVisible(!!w.statusText);
}

// Combined camera/mic/screen use of a tab's frames; null when nothing is being captured.
// Entries of frames that have gone away are dropped.
function captureState(tab) {
  const total = { camera: false, microphone: false, screen: false };
  for (const [key, state] of tab.capture) {
    const [processId, routingId] = key.split(':').map(Number);
    if (!webFrameMain.fromId(processId, routingId)) {
      tab.capture.delete(key);
      continue;
    }
    for (const k of Object.keys(total)) total[k] ||= state[k];
  }
  return total.camera || total.microphone || total.screen ? total : null;
}

function stopCapture(tab) {
  for (const frame of tab.wc.mainFrame.framesInSubtree) {
    try {
      frame.send('capture:stop');
    } catch {
      // frame went away
    }
  }
}

function layout(w) {
  if (!liveWindow(w)) return;
  const [width, height] = w.win.getContentSize();
  const top = chromeHeight(w);
  w.chromeView.setVisible(top > 0);
  // While a dropdown or popup is open the (transparent) toolbar view covers the whole window.
  w.chromeView.setBounds({ x: 0, y: 0, width, height: w.overlay && top ? height : top || CHROME_H });
  const inset = top > 0 ? PAGE_INSET : 0; // a page in fullscreen fills the window
  for (const t of w.tabs) {
    t.view.setBounds({ x: inset, y: top, width: Math.max(0, width - 2 * inset), height: Math.max(0, height - top - inset) });
    t.view.setBorderRadius(inset ? PAGE_RADIUS : 0);
  }
  if (w.statusView) layoutStatus(w);
}

// options.private: a private window with its own throwaway session
// options.session: { tabs: [history...], active } to restore
// options.ses: reuse this private session (a private tab moved to its own window)
// options.empty: start without a tab (one is about to be moved in)
// Light/dark switch: repaint the window frame around the toolbar and page card.
let themeWatch = false;
function watchTheme() {
  if (themeWatch) return;
  themeWatch = true;
  nativeTheme.on('updated', () => {
    for (const w of windows.filter(liveWindow)) {
      w.win.setBackgroundColor(canvasColor(w.private));
      if (process.platform === 'win32') w.win.setTitleBarOverlay(windowsTitleBar(w.private));
    }
  });
}

function createWindow({ private: isPrivate = false, session: saved = null, ses: reuse = null, empty = false } = {}) {
  const ses = isPrivate ? reuse || createPrivateSession() : session.defaultSession;
  watchTheme();
  const win = new BaseWindow({
    ...restoredBounds(saved),
    minWidth: 480,
    minHeight: 320,
    title: isPrivate ? 'Operecs — Private' : 'Operecs',
    backgroundColor: canvasColor(isPrivate),
    // The tab strip is the title bar: traffic lights inset on macOS, overlay buttons on Windows.
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 15, y: 13 } } : {}),
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: windowsTitleBar(isPrivate) } : {}),
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
    multi: new Set(), // tab ids selected together (Cmd/Ctrl- or Shift-click)
    multiAnchor: null,
    overlay: false, // toolbar dropdown/popup open
    downloadWarnings: [], // ids of finished risky downloads awaiting Keep/Discard
    restoreOffer: null, // saved windows from a run that crashed
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
    if (lastFocused !== w) rebuildMenuSoon(); // History → Recently Closed is per window
    lastFocused = w;
    updateHandoff(w);
  });
  win.on('resize', () => {
    layout(w);
    saveSessionSoon();
  });
  win.on('move', saveSessionSoon);
  if (saved && saved.maximized) win.maximize();
  // Leaving window fullscreen (green button, F11) also ends a page's video fullscreen.
  win.on('leave-full-screen', () => {
    exitFullscreen(activeTab(w));
    w.chromeView.webContents.send('window:fullscreen', false);
  });
  win.on('enter-full-screen', () => w.chromeView.webContents.send('window:fullscreen', true));
  win.on('close', (e) => {
    if (!quitting && !quitConfirmed && !w.closeConfirmed && store.data.settings.confirmClose && w.tabs.length > 1) {
      e.preventDefault();
      confirmClosing(w.win, `Close ${w.tabs.length} tabs?`, 'Close Window').then((ok) => {
        if (!ok) return;
        w.closeConfirmed = true;
        w.win.close();
      });
      return;
    }
    onWindowClose(w);
  });
  // macOS "swipe between pages" (three-finger swipe setting)
  win.on('swipe', (_e, direction) => {
    const tab = activeTab(w);
    if (tab && direction === 'right') tab.wc.navigationHistory.goBack();
    if (tab && direction === 'left') tab.wc.navigationHistory.goForward();
  });
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
    for (const h of saved.tabs) createTab(w, h.entries[h.index].url, { background: true, history: h, lazy: true });
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

// Resolves true to go ahead. "Don't ask again" turns the confirmation off in Settings.
async function confirmClosing(parent, message, action) {
  const { response, checkboxChecked } = await dialog.showMessageBox(parent, {
    type: 'question',
    message,
    buttons: [action, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: "Don't ask again",
  });
  if (checkboxChecked && response === 0) {
    store.data.settings.confirmClose = false;
    store.save();
  }
  return response === 0;
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
const certificates = new Map(); // hostname -> { issuer, subject, validStart, validExpiry, ok, details }

function certificateDetails(c) {
  const chain = [];
  for (let x = c.issuerCert, n = 0; x && n < 6; x = x.issuerCert, n++) chain.push(x.subjectName);
  return {
    subject: c.subject ? { commonName: c.subject.commonName, organizations: c.subject.organizations, country: c.subject.country } : null,
    issuer: c.issuer ? { commonName: c.issuer.commonName, organizations: c.issuer.organizations, country: c.issuer.country } : null,
    serialNumber: c.serialNumber,
    fingerprint: c.fingerprint, // "sha256/<base64>"
    chain,
    pem: c.data,
  };
}

function onVerifyCertificate(request, callback) {
  const c = request.certificate;
  certificates.set(request.hostname, {
    issuer: c.issuerName,
    subject: c.subjectName,
    validStart: c.validStart * 1000,
    validExpiry: c.validExpiry * 1000,
    ok: request.verificationResult === 'net::OK',
    verification: request.verificationResult,
    details: certificateDetails(c),
  });
  if (certificates.size > 500) certificates.delete(certificates.keys().next().value);
  callback(-3);
}

const DNS_PROVIDERS = {
  cloudflare: { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  quad9: { name: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
};

// Secure DNS (DNS over HTTPS). 'automatic' upgrades to DoH when the system's DNS provider
// supports it; a chosen provider means DoH only.
function applyDns() {
  const { dns, dnsCustom } = store.data.settings;
  const server = dns === 'custom' ? dnsCustom : DNS_PROVIDERS[dns] ? DNS_PROVIDERS[dns].url : null;
  if (server && /^https:\/\//i.test(server)) {
    app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [server] });
  } else {
    app.configureHostResolver({ secureDnsMode: dns === 'off' ? 'off' : 'automatic' });
  }
}

// Accept-Language for websites and spellcheck languages: the user's list, or the system's.
function preferredLanguages() {
  const list = store.data.settings.languages.length ? store.data.settings.languages : app.getPreferredSystemLanguages();
  return list.length ? list : ['en-US'];
}

function applyLanguages(ses) {
  const ua = app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(` ${app.getName()}/${app.getVersion()}`, '');
  ses.setUserAgent(ua, preferredLanguages().join(','));
  ses.setSpellCheckerEnabled(store.data.settings.spellcheck);
  // macOS uses the system spellchecker, which picks languages itself
  if (!isMac) {
    const available = new Set(ses.availableSpellCheckerLanguages);
    const langs = preferredLanguages().flatMap((l) => [l, l.split('-')[0]]).filter((l) => available.has(l));
    if (langs.length) ses.setSpellCheckerLanguages([...new Set(langs)].slice(0, 3));
  }
}

function configureSession(ses) {
  ses.setCertificateVerifyProc(onVerifyCertificate);
  // Present as plain Chrome (sites such as Google sign-in reject the Electron token), with the
  // user's languages.
  applyLanguages(ses);
  ses.setPermissionRequestHandler(onPermissionRequest);
  ses.setPermissionCheckHandler(onPermissionCheck);
  ses.on('will-download', onWillDownload);
  // Global Privacy Control: asks sites not to sell or share the user's data.
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    if (store.data.settings.gpc) details.requestHeaders['Sec-GPC'] = '1';
    callback({ requestHeaders: details.requestHeaders });
  });
  // macOS 15+ shows its own screen/window picker; elsewhere our picker in the toolbar view.
  ses.setDisplayMediaRequestHandler(onDisplayMediaRequest, { useSystemPicker: true });
  ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'capture-preload.js') });
  adblock.attach(ses);
}

// options.background: open without switching to it
// options.after: place right after this tab (links opened from a page)
// options.history: { entries, index } to restore back/forward history instead of loading url
// options.lazy: with history, don't load until the tab is first selected (restored sessions)
function createTab(w, url, { background = false, after = null, history = null, lazy = false } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      session: w.ses,
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      autoplayPolicy: store.data.settings.autoplay === 'allow' ? 'no-user-gesture-required' : 'document-user-activation-required',
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
    blockedHosts: new Map(), // host -> requests blocked on this page (shield popup)
    pageDownloads: 0, // downloads started since the user last clicked or typed in the page
    auth: [], // pending HTTP sign-in requests
    find: { open: false, text: '', active: 0, matches: 0 },
    fullscreen: false,
    blocked: 0, // ads/trackers blocked on the current page
    created: Date.now(),
    lastShown: Date.now(), // when the tab was last the active one (memory saver)
    capture: new Map(), // frame key -> { camera, microphone, screen } reported by capture-preload.js
    pinned: !!(history && history.pinned),
    openerId: after ? after.id : null,
  };
  const afterIdx = after ? w.tabs.indexOf(after) : -1;
  if (afterIdx === -1) w.tabs.push(tab);
  else w.tabs.splice(afterIdx + 1 + openerRunLength(w, after, afterIdx), 0, tab);
  normalizeOrder(w);
  view.setVisible(false);
  w.win.contentView.addChildView(view);
  if (extensions && !w.private) extensions.addTab(wc, w.win);

  wc.setWindowOpenHandler(({ url: target, disposition, features }) => {
    if (isBlockedNavigation(wc.getURL(), target)) return { action: 'deny' };
    // window.open() with size features (sign-in popups such as "Sign in with Google") opens a
    // real popup that keeps window.opener, which those flows need to report back.
    if (disposition === 'new-window' && isWeb(target)) return { action: 'allow', overrideBrowserWindowOptions: popupOptions(features, tab.w) };
    const resolved = resolveInput(target);
    if (resolved) createTab(tab.w, resolved, { after: tab, background: disposition === 'background-tab' });
    return { action: 'deny' };
  });
  wc.on('did-create-window', (popup) => setupPopup(popup, tab));
  wc.on('context-menu', (_e, params) => showPageMenu(tab, params));
  // Websites (in any frame, or via redirect) may never load the browser's own pages.
  const guard = (e) => {
    // A file dropped onto the page navigates without an initiating frame; pages can't open files.
    if (/^file:/i.test(e.url) && !e.initiator && e.isMainFrame) return;
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
  wc.on('media-started-playing', () => setMediaState(tab, 'playing'));
  wc.on('media-paused', () => setMediaState(tab, 'paused'));
  wc.on('did-stop-loading', () => {
    sendTabs(tab.w);
    checkReaderable(tab);
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      tab.blocked = 0;
      tab.blockedHosts.clear();
      tab.readerable = false;
      if (tab.media) setMediaState(tab, null);
    }
  });
  // A page may start one download on its own; more need the user's OK unless they clicked or
  // typed in between (like Chrome).
  wc.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown' || input.type === 'rawKeyDown' || input.type === 'keyDown' || input.type === 'touchStart') {
      tab.pageDownloads = 0;
      tab.lastInput = Date.now();
    }
  });
  wc.on('did-navigate', (_e, u) => {
    if (isWeb(u)) tab.httpsUpgrade = null;
    tab.capture.clear();
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
    if (tab.closing && tab.w.activeId !== tab.id) selectTab(tab.w, tab.id); // show which tab is asking
    const choice = dialog.showMessageBoxSync(tab.w.win, {
      type: 'question',
      message: 'Leave site?',
      detail: 'Changes you made may not be saved.',
      buttons: ['Leave', 'Stay'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) e.preventDefault(); // preventDefault ignores the page's beforeunload
    else tab.closing = false; // staying: the tab can be closed again later
  });
  wc.on('zoom-changed', (_e, direction) => zoom(tab.w, direction === 'in' ? 0.5 : -0.5, tab));
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */ || isInternalScheme(failedUrl)) return;
    const upgrade = tab.httpsUpgrade;
    tab.httpsUpgrade = null;
    if (upgrade && /^https:/i.test(failedUrl) && new URL(failedUrl).host === upgrade.host) {
      // the site has no working https version: ask before using http
      wc.loadURL(internalURL('error', { url: upgrade.from, desc: 'https-only' })).catch(() => {});
      return;
    }
    wc.loadURL(internalURL('error', { url: failedUrl, desc })).catch(() => {});
  });

  layout(w);
  if (history && history.entries.length && lazy && background) {
    tab.pending = history; // loaded by selectTab
  } else if (history && history.entries.length) {
    wc.navigationHistory.restore(history).catch(() => wc.loadURL(url).catch(() => {}));
  } else {
    wc.loadURL(url).catch(() => {});
  }
  if (background) sendTabs(w);
  else selectTab(w, tab.id);
  saveSession();
  return tab;
}

// ---- popups

function popupOptions(features, w) {
  const num = (k, d) => {
    const m = String(features || '').match(new RegExp(`(?:^|,)\\s*${k}\\s*=\\s*(\\d+)`, 'i'));
    return m ? Number(m[1]) : d;
  };
  return {
    width: Math.min(Math.max(num('width', 500), 200), 1600),
    height: Math.min(Math.max(num('height', 600), 150), 1200),
    autoHideMenuBar: true,
    backgroundColor: w.private ? '#25153f' : undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  };
}

// A popup shows which site it is in its title (it has no address bar), can't open the
// browser's own pages, and opens its own links as tabs in the opener's window.
function setupPopup(popup, opener) {
  const pwc = popup.webContents;
  const titled = () => {
    if (popup.isDestroyed()) return;
    const host = siteOf(pwc.getURL()) || pwc.getURL();
    const title = pwc.getTitle();
    popup.setTitle(title && title !== pwc.getURL() ? `${host} \u2014 ${title}` : host);
  };
  pwc.on('page-title-updated', (e) => {
    e.preventDefault();
    titled();
  });
  pwc.on('did-navigate', titled);
  const guard = (e) => {
    if (isBlockedNavigation(pwc.getURL(), e.url)) e.preventDefault();
  };
  pwc.on('will-frame-navigate', guard);
  pwc.on('will-redirect', guard);
  pwc.setWindowOpenHandler(({ url: target }) => {
    const w = opener.w;
    if (!isBlockedNavigation(pwc.getURL(), target) && liveWindow(w)) {
      const resolved = resolveInput(target);
      if (resolved) createTab(w, resolved, { after: opener });
    }
    return { action: 'deny' };
  });
  pwc.on('context-menu', (_e, params) => {
    if (!params.isEditable && !params.selectionText) return;
    Menu.buildFromTemplate([
      { label: 'Cut', enabled: params.editFlags.canCut, click: () => pwc.cut() },
      { label: 'Copy', enabled: params.editFlags.canCopy, click: () => pwc.copy() },
      { label: 'Paste', enabled: params.editFlags.canPaste, click: () => pwc.paste() },
    ]).popup({ window: popup });
  });
  titled();
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

// keepSelection: leave the multi-tab selection (Cmd/Ctrl- or Shift-click) as it is.
function selectTab(w, id, keepSelection = false) {
  const tab = getTab(w, id);
  if (!tab) return;
  if (!keepSelection) {
    w.multi.clear();
    w.multiAnchor = null;
  }
  if (w.activeId !== id) {
    const previous = activeTab(w);
    if (previous) previous.lastShown = Date.now();
    exitFullscreen(previous);
    w.statusText = '';
  }
  w.activeId = id;
  if (tab.pending) {
    const history = tab.pending;
    tab.pending = null;
    tab.wc.navigationHistory.restore(history).catch(() => tab.wc.loadURL(history.entries[history.index].url).catch(() => {}));
  }
  for (const t of w.tabs) t.view.setVisible(t.id === id);
  layout(w);
  tab.wc.focus();
  if (extensions && !w.private) extensions.selectTab(tab.wc);
  sendTabs(w);
  saveSession();
}

// Tabs selected together with Cmd/Ctrl- or Shift-click (only meaningful with 2 or more).
function selectedTabs(w) {
  const tabs = w.tabs.filter((t) => w.multi.has(t.id));
  return tabs.length > 1 ? tabs : [];
}

// Click with modifiers on a tab: toggle = Cmd/Ctrl, range = Shift (from the anchor tab).
function clickTab(w, id, mods = {}) {
  if (!getTab(w, id)) return;
  if (mods.range) {
    const anchor = getTab(w, w.multiAnchor) ? w.multiAnchor : w.activeId;
    const a = w.tabs.findIndex((t) => t.id === anchor);
    const b = w.tabs.findIndex((t) => t.id === id);
    w.multi = new Set(w.tabs.slice(Math.min(a, b), Math.max(a, b) + 1).map((t) => t.id));
    w.multiAnchor = anchor;
    return selectTab(w, id, true);
  }
  if (mods.toggle) {
    if (w.multi.size === 0) w.multi.add(w.activeId);
    if (w.multi.has(id) && w.multi.size > 1) {
      w.multi.delete(id);
      if (id === w.activeId) return selectTab(w, [...w.multi].pop(), true);
      return sendTabs(w);
    }
    w.multi.add(id);
    w.multiAnchor = id;
    return selectTab(w, id, true);
  }
  selectTab(w, id);
}

// Cmd/Ctrl+W: the selected tabs if the active tab is one of them, else just the active tab.
function closeActiveTabs(w) {
  const many = selectedTabs(w);
  if (many.length && many.some((t) => t.id === w.activeId)) closeTabs(w, (t) => !many.includes(t));
  else closeTab(w, w.activeId);
}

// A web page gets to run its beforeunload handler first: if it has unsaved changes, the
// "Leave site?" dialog (will-prevent-unload) decides, and the tab is removed once the page has
// actually closed.
function closeTab(w, id) {
  const tab = getTab(w, id);
  if (!tab || tab.closing) return;
  const history = tabHistory(tab); // read now; the page's history is gone after it closes
  const page = !tab.pending && !tab.wc.isDestroyed() && !tab.wc.isCrashed() && isWeb(tab.wc.getURL());
  if (!page) return finishCloseTab(tab, history);
  tab.closing = true;
  tab.wc.once('destroyed', () => finishCloseTab(tab, history));
  tab.wc.close({ waitForBeforeUnload: true });
  // Safety net: a page that neither closes nor asks (hung renderer) mustn't leave a stuck tab.
  setTimeout(() => {
    if (tab.closing && !tab.wc.isDestroyed()) finishCloseTab(tab, history);
  }, 4000);
}

function finishCloseTab(tab, history) {
  const { w } = tab;
  const idx = w.tabs.indexOf(tab);
  if (idx === -1) return;
  w.multi.delete(tab.id);
  w.tabs.splice(idx, 1);
  rememberClosedTab(w, tab, idx, history);
  dismissPrompts(tab);
  cancelAuth(tab);
  exitFullscreen(tab);
  if (liveWindow(w)) w.win.contentView.removeChildView(tab.view);
  if (!tab.wc.isDestroyed()) tab.wc.close();
  if (w.tabs.length === 0) {
    if (liveWindow(w)) w.win.close();
    return;
  }
  if (tab.id === w.activeId) selectTab(w, w.tabs[Math.min(idx, w.tabs.length - 1)].id);
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
  w.multi.delete(tab.id);
  dismissPrompts(tab);
  cancelAuth(tab);
  exitFullscreen(tab);
  w.win.contentView.removeChildView(tab.view);
  if (w.tabs.length === 0) w.win.close();
  else if (tab.id === w.activeId) selectTab(w, w.tabs[Math.min(idx, w.tabs.length - 1)].id);
  else sendTabs(w);
}

function moveTabToNewWindow(tab) {
  moveTabsToNewWindow([tab]);
}

function moveTabsToNewWindow(tabs) {
  const from = tabs[0].w;
  if (from.tabs.length <= tabs.length) return;
  const wasActive = tabs.find((t) => t.id === from.activeId) || tabs[tabs.length - 1];
  const target = createWindow({ private: from.private, ses: from.private ? from.ses : null, empty: true });
  for (const tab of tabs) {
    detachTab(tab);
    tab.w = target;
    tab.openerId = null;
    target.tabs.push(tab);
    target.win.contentView.addChildView(tab.view);
    if (extensions && !target.private) extensions.addTab(tab.wc, target.win);
  }
  normalizeOrder(target);
  layout(target);
  selectTab(target, wasActive.id);
}

// Dragging a tab out of the tab strip and dropping it elsewhere opens it in a new window at the
// cursor. (A drop on another window's tab strip arrives as adoptTab instead.)
function tearOffTab(w, id) {
  const tab = getTab(w, id);
  if (!tab || w.tabs.length < 2 || !liveWindow(w)) return;
  const cursor = screen.getCursorScreenPoint();
  const b = w.win.getContentBounds();
  const overStrip = cursor.x >= b.x && cursor.x <= b.x + b.width && cursor.y >= b.y && cursor.y <= b.y + 38;
  if (overStrip) return;
  const size = w.win.getSize();
  moveTabsToNewWindow([tab]);
  const target = tab.w;
  if (target !== w && liveWindow(target)) {
    target.win.setBounds({ x: Math.round(cursor.x - 120), y: Math.round(cursor.y - 20), width: size[0], height: size[1] });
  }
}

// A tab dropped onto this window's tab strip from another window (same session only: private
// windows each have their own).
function adoptTab(w, id, index) {
  const tab = allTabs().find((t) => t.id === id);
  if (!tab || !liveWindow(w)) return;
  if (tab.w === w) return moveTab(w, id, index);
  if (tab.w.ses !== w.ses) return;
  detachTab(tab);
  tab.w = w;
  tab.openerId = null;
  w.tabs.splice(Math.max(0, Math.min(index, w.tabs.length)), 0, tab);
  w.win.contentView.addChildView(tab.view);
  if (extensions && !w.private) extensions.addTab(tab.wc, w.win);
  normalizeOrder(w);
  layout(w);
  selectTab(w, tab.id);
  w.win.focus();
  saveSession();
}

function closeTabs(w, keep) {
  for (const t of w.tabs.filter((x) => !keep(x))) closeTab(w, t.id);
}

function showSelectedTabsMenu(w, tabs) {
  const n = tabs.length;
  const allPinned = tabs.every((t) => t.pinned);
  const allMuted = tabs.every((t) => t.wc.isAudioMuted());
  Menu.buildFromTemplate([
    { label: `Reload ${n} Tabs`, click: () => tabs.forEach((t) => (t.pending ? null : t.wc.reload())) },
    { label: `Duplicate ${n} Tabs`, click: () => tabs.forEach((t) => duplicateTab(t)) },
    { label: allPinned ? `Unpin ${n} Tabs` : `Pin ${n} Tabs`, click: () => tabs.forEach((t) => setPinned(t, !allPinned)) },
    {
      label: allMuted ? `Unmute ${n} Tabs` : `Mute ${n} Tabs`,
      click: () => tabs.forEach((t) => t.wc.isAudioMuted() === allMuted && toggleMute(t)),
    },
    { type: 'separator' },
    { label: `Move ${n} Tabs to New Window`, enabled: w.tabs.length > n, click: () => moveTabsToNewWindow(tabs) },
    { type: 'separator' },
    { label: `Close ${n} Tabs`, click: () => closeTabs(w, (t) => !tabs.includes(t)) },
  ]).popup({ window: w.win });
}

function showTabMenu(w, id) {
  const tab = getTab(w, id);
  if (!tab) return;
  const many = selectedTabs(w);
  if (many.includes(tab)) return showSelectedTabsMenu(w, many);
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

// Star / Cmd+D: bookmarks the page (into the bookmarks bar) if needed, then the toolbar shows the
// edit popup for it (name, folder, Remove).
function starPage(w) {
  const tab = activeTab(w);
  if (!tab) return;
  const url = tab.wc.getURL();
  if (!isWeb(url)) return;
  const existing = bookmarks.findByUrl(url);
  const node = existing || bookmarks.add({ url, title: tab.wc.getTitle() || url, parentId: 'bar' });
  w.chromeView.webContents.send('bookmark-edit', bookmarkEditInfo(node.id, !existing));
  w.chromeView.webContents.focus();
}

function bookmarkEditInfo(id, isNew = false) {
  const f = bookmarks.find(id);
  if (!f) return null;
  return {
    id,
    isNew,
    type: f.node.type,
    title: f.node.title,
    url: f.node.url || '',
    parentId: f.parent ? f.parent.id : null,
    folders: bookmarks.folders().filter((x) => f.node.type !== 'folder' || x.id !== id),
  };
}

function openBookmarkUrl(w, url, where) {
  if (!url) return;
  if (where === 'window' || where === 'private') return openInNewWindow(url, where === 'private');
  if (where === 'tab' || where === 'background') return void createTab(w, url, { background: where === 'background' });
  const tab = activeTab(w);
  if (tab) tab.wc.loadURL(url).catch(() => {});
  else createTab(w, url);
}

function openAllInFolder(w, folderId) {
  const f = bookmarks.find(folderId);
  if (!f || f.node.type !== 'folder') return;
  const urls = [];
  const collect = (n) => (n.type === 'folder' ? n.children.forEach(collect) : urls.push(n.url));
  collect(f.node);
  urls.slice(0, 30).forEach((url, i) => createTab(w, url, { background: i > 0 }));
}

// A folder in the bookmarks bar opens as a native menu (nested folders become submenus).
function folderMenuTemplate(w, folder) {
  const items = folder.children.map((n) =>
    n.type === 'folder'
      ? { label: trimLabel(n.title, 50), submenu: folderMenuTemplate(w, n) }
      : { label: trimLabel(n.title || n.url, 50), click: () => openBookmarkUrl(w, n.url, 'current') },
  );
  if (items.length === 0) return [{ label: '(empty)', enabled: false }];
  return [...items, { type: 'separator' }, { label: 'Open All in Tabs', click: () => openAllInFolder(w, folder.id) }];
}

function showBookmarkMenu(w, id) {
  const f = id ? bookmarks.find(id) : null;
  const edit = (targetId) => w.chromeView.webContents.send('bookmark-edit', bookmarkEditInfo(targetId));
  const common = [
    { type: 'separator' },
    {
      label: 'Add Folder…',
      click: () => {
        const parent = f && f.node.type === 'folder' ? f.node.id : f && f.parent ? f.parent.id : 'bar';
        edit(bookmarks.addFolder('New folder', parent).id);
      },
    },
    { label: 'Bookmark Manager', click: () => openInternalPage(w, 'bookmarks') },
    { label: 'Hide Bookmarks Bar', click: () => setBookmarksBar(false) },
  ];
  let template;
  if (f && f.node.type === 'bookmark') {
    template = [
      { label: 'Open in New Tab', click: () => openBookmarkUrl(w, f.node.url, 'background') },
      { label: 'Open in New Window', click: () => openBookmarkUrl(w, f.node.url, 'window') },
      { label: 'Open in Private Window', click: () => openBookmarkUrl(w, f.node.url, 'private') },
      { type: 'separator' },
      { label: 'Edit…', click: () => edit(f.node.id) },
      { label: 'Delete', click: () => bookmarks.remove(f.node.id) },
      ...common,
    ];
  } else if (f && f.node.type === 'folder' && f.parent) {
    template = [
      { label: 'Open All in Tabs', click: () => openAllInFolder(w, f.node.id) },
      { type: 'separator' },
      { label: 'Rename…', click: () => edit(f.node.id) },
      { label: 'Delete', click: () => bookmarks.remove(f.node.id) },
      ...common,
    ];
  } else {
    template = common.slice(1);
  }
  Menu.buildFromTemplate(template).popup({ window: w.win });
}

// A new folder in the bookmarks bar with every web page open in the window.
function bookmarkAllTabs(w) {
  const pages = w.tabs
    .map((t) => {
      const entry = t.pending && t.pending.entries[t.pending.index];
      return { url: entry ? entry.url : t.wc.getURL(), title: entry ? entry.title : t.wc.getTitle() };
    })
    .filter((p) => isWeb(p.url));
  if (pages.length === 0) return;
  const folder = bookmarks.addFolder(`Tabs ${new Date().toLocaleDateString()}`, 'bar');
  for (const p of pages) bookmarks.add({ url: p.url, title: p.title || p.url, parentId: folder.id });
  w.chromeView.webContents.send('bookmark-edit', bookmarkEditInfo(folder.id, true));
}

function setBookmarksBar(show) {
  store.data.settings.showBookmarksBar = show;
  store.save();
  windows.forEach((w) => {
    layout(w);
    sendTabs(w);
  });
  buildMenu();
}

// Chrome-family browsers keep bookmarks in a JSON file in their profile folder.
function importSources() {
  const home = app.getPath('home');
  const base = isMac
    ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
      : path.join(home, '.config');
  const userData = process.platform === 'win32' ? 'User Data' : '';
  const candidates = isMac
    ? [
        ['Google Chrome', 'Google/Chrome'],
        ['Brave', 'BraveSoftware/Brave-Browser'],
        ['Microsoft Edge', 'Microsoft Edge'],
        ['Vivaldi', 'Vivaldi'],
        ['Arc', 'Arc/User Data'],
      ]
    : process.platform === 'win32'
      ? [
          ['Google Chrome', 'Google/Chrome'],
          ['Brave', 'BraveSoftware/Brave-Browser'],
          ['Microsoft Edge', 'Microsoft/Edge'],
          ['Vivaldi', 'Vivaldi'],
        ]
      : [
          ['Google Chrome', 'google-chrome'],
          ['Chromium', 'chromium'],
          ['Brave', 'BraveSoftware/Brave-Browser'],
          ['Microsoft Edge', 'microsoft-edge'],
          ['Vivaldi', 'vivaldi'],
        ];
  return candidates
    .map(([name, dir]) => ({ name, file: path.join(base, dir, userData, 'Default', 'Bookmarks') }))
    .filter((c) => fs.existsSync(c.file));
}

async function importBookmarks(w, source) {
  if (source === 'html') {
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
      title: 'Import bookmarks from an HTML file',
      filters: [{ name: 'Bookmarks HTML', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    const html = await fs.promises.readFile(filePaths[0], 'utf8');
    return { count: bookmarks.importHtml(html, `Imported from ${path.basename(filePaths[0])}`), from: path.basename(filePaths[0]) };
  }
  const src = importSources().find((c) => c.name === source);
  if (!src) return null;
  const json = JSON.parse(await fs.promises.readFile(src.file, 'utf8'));
  return { count: bookmarks.importChromeJson(json, `Imported from ${src.name}`), from: src.name };
}

async function exportBookmarks(w) {
  const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
    title: 'Export bookmarks',
    defaultPath: path.join(app.getPath('documents'), 'bookmarks.html'),
    filters: [{ name: 'Bookmarks HTML', extensions: ['html'] }],
  });
  if (canceled || !filePath) return null;
  await fs.promises.writeFile(filePath, bookmarks.exportHtml());
  return filePath;
}

function homeUrl() {
  const home = store.data.settings.homePage;
  return home && /^(https?|file):/i.test(home) ? home : internalURL('newtab');
}

function goHome(w) {
  const tab = activeTab(w);
  if (tab) tab.wc.loadURL(homeUrl()).catch(() => {});
  else createTab(w, homeUrl());
}

// F6: address bar -> page -> address bar…
function cycleFocus(w) {
  if (w.chromeView.webContents.isFocused()) activeTab(w)?.wc.focus();
  else focusAddress(w);
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

const zoomLevelOf = (percent) => Math.log(percent / 100) / Math.log(1.2);

function applySiteZoom(tab) {
  const site = siteOf(tab.wc.getURL());
  const own = site && !tab.w.private ? store.data.zoom[site] : undefined;
  const level = own !== undefined ? own : zoomLevelOf(store.data.settings.defaultZoom || 100);
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
  rebuildMenuSoon();
}

function updateHistoryTitle(tab) {
  if (tab.w.private) return;
  const url = tab.wc.getURL();
  const entry = store.data.history.slice(0, 20).find((e) => e.url === url);
  if (entry) {
    entry.title = tab.wc.getTitle() || url;
    store.save();
    rebuildMenuSoon();
  }
}

// ---------------------------------------------------------------- session

// A tab's back/forward history, trimmed for storage. Error pages restore as their original URL.
function tabHistory(tab) {
  if (tab.pending) return { ...tab.pending, pinned: tab.pinned }; // restored but never opened
  if (tab.wc.isDestroyed()) return null;
  const nav = tab.wc.navigationHistory;
  let entries = nav.getAllEntries().map((e) => {
    const name = internalName(e.url);
    if (name === 'error' || name === 'reader') return { url: new URL(e.url).searchParams.get('url') || '', title: e.title };
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

function startupMode() {
  const { startup, restoreSession } = store.data.settings;
  if (['continue', 'newtab', 'pages'].includes(startup)) return startup;
  return restoreSession ? 'continue' : 'newtab';
}

function restorePrevious(w) {
  const previous = w.restoreOffer;
  w.restoreOffer = null;
  layout(w);
  sendTabs(w);
  if (!previous) return;
  for (const s of previous) createWindow({ session: s });
  // the window that offered the restore is dropped if it's just an untouched new tab
  if (w.tabs.length === 1 && internalName(w.tabs[0].wc.getURL()) === 'newtab') w.win.close();
}

function savedWindows() {
  const s = store.data.session;
  if (!s) return [];
  if (Array.isArray(s.windows)) return s.windows;
  return s.tabs && s.tabs.length ? [{ tabs: s.tabs, active: s.active }] : []; // v0.3 format
}

function rememberClosedTab(w, tab, index, history = tabHistory(tab)) {
  if (!history) return;
  w.closedTabs.push({ history, index });
  if (w.closedTabs.length > 25) w.closedTabs.shift();
  rebuildMenuSoon();
}

// position: index in w.closedTabs (default: the most recently closed)
function reopenClosedTab(w, position = w.closedTabs.length - 1) {
  const [closed] = w.closedTabs.splice(position, 1);
  if (!closed) return;
  rebuildMenuSoon();
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
const permissionDefault = (key) => store.data.settings.permissionDefaults[key] || 'ask';
const decisionFor = (w, origin, key) => (permissionStore(w)[origin] || {})[key];
const windowOfSession = (ses) => windows.find((w) => w.ses === ses) || null;

let nextPromptId = 1;

function onPermissionRequest(wc, permission, callback, details) {
  if (ALWAYS_ALLOWED.has(permission)) return callback(true);
  if (!PROMPTABLE.has(permission)) return callback(false);

  const tab = tabOfWc(wc);
  const origin = originOf(details.requestingUrl || wc.getURL());
  if (!tab || !origin) return callback(false);

  // Notification prompts only right after the user did something on the page; sites that ask on
  // load are refused quietly this time (nothing remembered), like Chrome's quieter prompts.
  if (permission === 'notifications' && Date.now() - (tab.lastInput || 0) > 5000 && !decisionFor(tab.w, origin, 'notifications')) {
    return callback(false);
  }

  const keys = permissionKeys(permission, details.mediaTypes);
  // A site's own decision wins; otherwise the per-type default from Settings (ask or block).
  const decisions = keys.map((k) => decisionFor(tab.w, origin, k) || (permissionDefault(k) === 'block' ? 'block' : undefined));
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
  if (!tab) return callback(); // cancels (e.g. a request from a service worker)
  tab.auth.push({
    id: nextAuthId++,
    host: authInfo.port && ![80, 443].includes(authInfo.port) ? `${authInfo.host}:${authInfo.port}` : authInfo.host,
    realm: authInfo.realm || '',
    proxy: !!authInfo.isProxy,
    insecure: !authInfo.isProxy && !/^https:/i.test(details.url),
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

// ---------------------------------------------------------------- task manager

// Every process with what it's for: tabs by title, plus the browser's own processes.
function taskList() {
  const owners = new Map(); // pid -> labels
  const add = (pid, label, tabPid) => {
    if (!pid) return;
    const entry = owners.get(pid) || { labels: [], tab: false };
    entry.labels.push(label);
    entry.tab ||= tabPid;
    owners.set(pid, entry);
  };
  for (const t of allTabs()) {
    if (t.wc.isDestroyed()) continue;
    const title = t.pending ? `${t.pending.entries[t.pending.index].title || 'Tab'} (sleeping)` : t.wc.getTitle() || displayUrl(t.wc.getURL()) || 'New Tab';
    add(t.wc.getOSProcessId(), `Tab: ${title}`, true);
  }
  for (const wc of webContents.getAllWebContents()) {
    const url = wc.getURL();
    if (url.startsWith('chrome-extension://')) {
      const ext = session.defaultSession.extensions.getExtension(new URL(url).host);
      add(wc.getOSProcessId(), `Extension: ${ext ? ext.name : new URL(url).host}`, false);
    }
  }
  const names = { Browser: 'Operecs (main process)', Tab: 'Page process (shared or closing)', GPU: 'GPU', Utility: 'Utility', Zygote: 'Zygote', 'Pepper Plugin': 'Plugin' };
  return app
    .getAppMetrics()
    .map((m) => {
      const owner = owners.get(m.pid);
      return {
        pid: m.pid,
        name: owner ? owner.labels.join(', ') : m.serviceName ? `${names[m.type] || m.type}: ${m.serviceName}` : names[m.type] || m.type,
        memoryMB: Math.round((m.memory.workingSetSize || 0) / 1024),
        cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
        canEnd: !!(owner && owner.tab),
      };
    })
    .sort((a, b) => b.memoryMB - a.memoryMB);
}

// ---------------------------------------------------------------- memory saver

// A sleeping tab keeps its history in tab.pending (like a restored tab) and its page is
// replaced by an empty one; selecting it loads it again.
function sleepTab(tab) {
  const history = tabHistory(tab);
  if (!history || tab.pending) return;
  const favicon = tab.favicon;
  tab.pending = { entries: history.entries, index: history.index };
  tab.wc.loadURL('about:blank').then(() => {
    if (tab.wc.isDestroyed()) return;
    tab.wc.navigationHistory.clear();
    tab.favicon = favicon;
    sendTabs(tab.w);
  }, () => {});
}

function canSleep(tab) {
  const w = tab.w;
  return (
    tab.id !== w.activeId &&
    !tab.pending &&
    !tab.pinned &&
    !tab.wc.isDestroyed() &&
    !tab.wc.isCurrentlyAudible() &&
    !captureState(tab) &&
    !tab.prompts.length &&
    !tab.auth.length &&
    isWeb(tab.wc.getURL())
  );
}

setInterval(() => {
  if (!store || !store.data.settings.memorySaver) return;
  const limit = (store.data.settings.memorySaverMinutes || 30) * 60000;
  for (const tab of allTabs()) {
    if (canSleep(tab) && Date.now() - (tab.lastShown || tab.created || Date.now()) > limit) sleepTab(tab);
  }
}, 60000).unref();

// ---------------------------------------------------------------- HTTPS-Only

const httpsExceptions = new Set(); // hosts the user chose to visit over http (until restart)

// Hosts that normally have no public certificate: this machine, local networks, intranet names.
function localHost(host) {
  return (
    host === 'localhost' ||
    !host.includes('.') ||
    /\.(local|localhost|test|internal|lan|home\.arpa)$/i.test(host) ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[)/.test(host)
  );
}

// Main-frame http:// requests become https://; if that fails, did-fail-load shows a warning
// page with "Continue to site".
function upgradeToHttps(details) {
  if (!store.data.settings.httpsOnly || details.resourceType !== 'mainFrame' || !/^http:\/\//i.test(details.url)) return null;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }
  if (localHost(url.hostname) || httpsExceptions.has(url.host)) return null;
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === details.webContentsId);
  if (tab) tab.httpsUpgrade = { from: details.url, host: url.host };
  url.protocol = 'https:';
  return { redirectURL: url.href };
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

function onBlocked(webContentsId, url) {
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === webContentsId);
  if (!tab) return;
  tab.blocked++;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // not a URL we can name
  }
  if (host) tab.blockedHosts.set(host, (tab.blockedHosts.get(host) || 0) + 1);
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
  if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL !== undefined) {
    const f = params.mediaFlags || {};
    // Acts on the media element under the cursor (main frame only; coordinates are its own).
    const onMedia = (code) =>
      params.frame === wc.mainFrame
        ? wc.executeJavaScript(`(() => { const m = document.elementFromPoint(${params.x}, ${params.y})?.closest('video, audio'); if (m) { ${code} } })()`, true).catch(() => {})
        : null;
    const kind = params.mediaType === 'video' ? 'Video' : 'Audio';
    const media = [
      { label: f.isPaused ? 'Play' : 'Pause', click: () => onMedia(f.isPaused ? 'm.play()' : 'm.pause()') },
      { label: f.isMuted ? 'Unmute' : 'Mute', click: () => onMedia('m.muted = !m.muted') },
      { label: 'Loop', type: 'checkbox', checked: !!f.isLooping, click: () => onMedia('m.loop = !m.loop') },
      ...(f.canToggleControls
        ? [{ label: 'Show Controls', type: 'checkbox', checked: !!f.isControlsVisible, click: () => onMedia('m.controls = !m.controls') }]
        : []),
      ...(params.mediaType === 'video' && f.canShowPictureInPicture
        ? [
            {
              label: 'Picture in Picture',
              type: 'checkbox',
              checked: !!f.isShowingPictureInPicture,
              click: () => onMedia('document.pictureInPictureElement ? document.exitPictureInPicture() : m.requestPictureInPicture()'),
            },
          ]
        : []),
    ];
    if (isWeb(params.srcURL)) {
      media.push(
        { type: 'separator' },
        { label: `Open ${kind} in New Tab`, click: () => createTab(w, params.srcURL, { after: tab, background: true }) },
        { label: `Save ${kind} As…`, enabled: f.canSave !== false, click: () => userDownload(wc, params.srcURL) },
        { label: `Copy ${kind} Address`, click: () => clipboard.writeText(params.srcURL) },
      );
    }
    groups.push(media);
  }
  if (params.mediaType === 'image' && params.srcURL) {
    const image = [
      { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Save Image As…', click: () => userDownload(wc, params.srcURL) },
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
      ...(isMac && isWeb(wc.getURL()) ? [{ label: 'Share…', click: () => sharePage(w, tab) }] : []),
      ...(isWeb(wc.getURL())
        ? [{ label: 'View Page Source', click: () => createTab(w, `view-source:${wc.getURL()}`, { after: tab }) }]
        : []),
    ]);
  }
  const extensionItems = extensions && !w.private ? extensions.getContextMenuItems(wc, params) : [];
  if (extensionItems.length) groups.push(extensionItems);
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

// A secure (https) page starting a download over plain http: anyone on the network could swap
// the file. Blocked unless the user says to download it anyway (that one URL, once).
const insecureDownloadsAllowed = new Set();
function isInsecureDownload(item, wc) {
  const page = wc && !wc.isDestroyed() ? wc.getURL() : '';
  if (!/^https:/i.test(page)) return false;
  return item.getURLChain().some((u) => {
    try {
      const parsed = new URL(u);
      return parsed.protocol === 'http:' && !localHost(parsed.hostname);
    } catch {
      return false;
    }
  });
}

// Downloads the user started (Save As…, Retry, an allowed prompt) skip the multiple-downloads check.
const userDownloads = new Set();
function userDownload(target, url) {
  userDownloads.add(url);
  target.downloadURL(url);
}

// Returns true when the download may go ahead now. Otherwise it's cancelled here, and restarted
// if the user allows automatic downloads for the site.
function allowAutomaticDownload(item, wc) {
  const url = item.getURL();
  if (userDownloads.delete(url)) return true;
  const tab = tabOfWc(wc);
  if (!tab) return true;
  tab.pageDownloads++;
  if (tab.pageDownloads <= 1) return true;
  const origin = originOf(wc.getURL());
  if (!origin) return true;
  const decision = decisionFor(tab.w, origin, 'automatic-downloads') || (permissionDefault('automatic-downloads') === 'block' ? 'block' : undefined);
  if (decision === 'allow') return true;
  item.cancel();
  if (decision === 'block') return false;
  const retry = (ok) => {
    if (ok && !wc.isDestroyed()) userDownload(wc, url);
  };
  const same = tab.prompts.find((p) => p.origin === origin && p.keys.join() === 'automatic-downloads');
  if (same) same.callbacks.push(retry);
  else {
    tab.prompts.push({ id: nextPromptId++, origin, keys: ['automatic-downloads'], scheme: null, callbacks: [retry] });
    if (tab.id === tab.w.activeId) {
      layout(tab.w);
      sendTabs(tab.w);
    }
  }
  return false;
}

function onWillDownload(_e, item, wc) {
  if (isInsecureDownload(item, wc) && !insecureDownloadsAllowed.delete(item.getURL())) {
    item.cancel();
    const url = item.getURL();
    const owner = tabOfWc(wc)?.w || focusedWindow();
    dialog
      .showMessageBox(owner ? owner.win : undefined, {
        type: 'warning',
        message: `"${item.getFilename() || 'This file'}" was blocked because it isn't downloaded securely`,
        detail: `${trimLabel(url, 120)}\n\nThe file comes over an unencrypted (http) connection, so someone on your network could replace it with something harmful.`,
        buttons: ['Don\'t Download', 'Download Anyway'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (response !== 1 || wc.isDestroyed()) return;
        insecureDownloadsAllowed.add(url);
        userDownload(wc, url);
      })
      .catch(() => {});
    return;
  }
  if (!allowAutomaticDownload(item, wc)) return;
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
    rebuildMenuSoon();
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

// Most-visited sites for the new tab page: one tile per site, by visit count.
function topSites() {
  const hidden = new Set(store.data.settings.hiddenTiles);
  const sites = new Map();
  for (const h of store.data.history) {
    const site = siteOf(h.url);
    if (!site || hidden.has(site)) continue;
    const entry = sites.get(site) || { site, url: new URL(h.url).origin + '/', title: '', visits: 0 };
    entry.visits++;
    if (!entry.title && new URL(h.url).pathname === '/') entry.title = h.title;
    sites.set(site, entry);
  }
  return [...sites.values()]
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 8)
    .map(({ site, url, title }) => ({ site, url, title: title || site }));
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
  for (const b of bookmarks.all()) {
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

// Suggestions from the search engine, only when the user turned them on and never in private
// windows. Fetched without cookies from a separate in-memory session, so the engine can't tie
// them to a signed-in account.
let suggestSession = null;
const suggestCache = new Map();
async function searchSuggestions(w, text) {
  const query = text.trim();
  const engine = searchEngine();
  if (!store.data.settings.searchSuggestions || w.private || !engine.suggest || !query || query.length > 200) return [];
  if (keywordSearch(query)) return []; // meant for another engine; don't send it to this one
  const key = `${engine.name}\n${query.toLowerCase()}`;
  if (suggestCache.has(key)) return suggestCache.get(key);
  suggestSession ||= session.fromPartition('operecs-suggest'); // no "persist:" -> memory only
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await suggestSession.fetch(engine.suggest.replace('%s', encodeURIComponent(query)), {
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    const result = list
      .filter((x) => typeof x === 'string' && x.trim() && x.length <= 200 && x.toLowerCase() !== query.toLowerCase())
      .slice(0, 4);
    suggestCache.set(key, result);
    if (suggestCache.size > 200) suggestCache.delete(suggestCache.keys().next().value);
    return result;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Open tabs (same kind of window: normal or private) matching what's typed: "Switch to tab".
function openTabSuggestions(w, text) {
  const q = text.trim().toLowerCase();
  if (q.length < 2) return [];
  const current = activeTab(w);
  const results = [];
  for (const win of windows.filter((x) => x.private === w.private)) {
    for (const t of win.tabs) {
      if (t === current) continue;
      const entry = t.pending && t.pending.entries[t.pending.index];
      const url = entry ? entry.url : t.wc.getURL();
      const title = (entry ? entry.title : t.wc.getTitle()) || url;
      if (!isWeb(url)) continue;
      if (title.toLowerCase().includes(q) || url.toLowerCase().includes(q)) {
        results.push({ tabId: t.id, title, display: url.replace(/^https?:\/\/(www\.)?/, '') });
      }
    }
  }
  return results.slice(0, 3);
}

function switchToTab(w, tabId) {
  const tab = allTabs().find((t) => t.id === tabId && t.w.private === w.private);
  if (!tab) return;
  selectTab(tab.w, tab.id);
  tab.w.win.focus();
}

// Cmd/Ctrl+Shift+A: every open tab, grouped by window.
function showTabSearch(w) {
  const groups = windows
    .filter((x) => x.private === w.private && liveWindow(x))
    .map((x, i) => [
      ...(i ? [{ type: 'separator' }] : []),
      ...x.tabs.map((t) => {
        const entry = t.pending && t.pending.entries[t.pending.index];
        const title = (entry ? entry.title : t.wc.getTitle()) || displayUrl(entry ? entry.url : t.wc.getURL()) || 'New Tab';
        return { label: trimLabel(title, 60), type: 'checkbox', checked: x === w && t.id === w.activeId, click: () => switchToTab(w, t.id) };
      }),
    ]);
  Menu.buildFromTemplate(groups.flat()).popup({ window: w.win });
}

// Right-click in the address bar: the edit menu plus Paste and Go / Paste and Search.
async function showAddressMenu(w) {
  const wc = w.chromeView.webContents;
  const clip = String((await clipboard.readText()) || '').trim(); // async in this Electron
  const pasteTarget = clip ? resolveInput(clip) : null;
  const searches = pasteTarget && pasteTarget.startsWith(searchUrl('').split('?')[0]) && !/^https?:\/\//i.test(clip);
  Menu.buildFromTemplate([
    { label: 'Undo', click: () => wc.undo() },
    { type: 'separator' },
    { label: 'Cut', click: () => wc.cut() },
    { label: 'Copy', click: () => wc.copy() },
    { label: 'Paste', enabled: !!clip, click: () => wc.paste() },
    {
      label: searches ? `Paste and Search` : 'Paste and Go',
      enabled: !!pasteTarget,
      click: () => {
        const tab = activeTab(w);
        if (tab && pasteTarget) tab.wc.loadURL(pasteTarget).catch(() => {});
        tab?.wc.focus();
      },
    },
    { type: 'separator' },
    { label: 'Select All', click: () => wc.selectAll() },
  ]).popup({ window: w.win });
}

// Cmd/Ctrl+S: complete web page, single-file archive or PDF, picked by the file type.
async function savePageAs(w) {
  const tab = activeTab(w);
  if (!tab || tab.pending) return;
  const title = (tab.wc.getTitle() || 'page').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'page';
  const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
    defaultPath: path.join(downloadDir(), `${title}.html`),
    filters: [
      { name: 'Web Page, Complete', extensions: ['html'] },
      { name: 'Web Archive (single file)', extensions: ['mhtml'] },
      { name: 'PDF', extensions: ['pdf'] },
    ],
  });
  if (canceled || !filePath) return;
  try {
    if (/\.pdf$/i.test(filePath)) {
      await fs.promises.writeFile(filePath, await tab.wc.printToPDF({ printBackground: true }));
    } else {
      await tab.wc.savePage(filePath, /\.mhtml?$/i.test(filePath) ? 'MHTML' : 'HTMLComplete');
    }
  } catch (err) {
    dialog.showMessageBox(w.win, { type: 'warning', message: "Couldn't save the page.", detail: err.message });
  }
}

// ---------------------------------------------------------------- site info

const SITE_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'automatic-downloads'];
const PERMISSION_NAMES = {
  'storage-access': 'Cookies while embedded',
  'top-level-storage-access': 'Cookies while embedded',
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard',
  openExternal: 'Open apps',
  'automatic-downloads': 'Automatic downloads',
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
  ipcMain.on('gpc:enabled', (e) => {
    e.returnValue = !!(store && store.data.settings.gpc);
  });

  // capture-preload.js: has neither the site nor the per-type default decided on notifications?
  ipcMain.on('notification:undecided', (e) => {
    const tab = tabOfWc(e.sender);
    const origin = e.senderFrame ? originOf(e.senderFrame.url) : null;
    e.returnValue = !!(tab && origin && !decisionFor(tab.w, origin, 'notifications') && permissionDefault('notifications') !== 'block');
  });

  // Sent by capture-preload.js when the user clicks one of the page's notifications.
  ipcMain.on('notification:click', (e) => {
    const tab = tabOfWc(e.sender);
    if (!tab || !liveWindow(tab.w)) return;
    if (tab.w.win.isMinimized()) tab.w.win.restore();
    selectTab(tab.w, tab.id);
    tab.w.win.focus();
    if (isMac) app.focus({ steal: true });
  });

  // Sent by capture-preload.js in web pages: only ever changes that page's own tab indicator.
  ipcMain.on('capture:state', (e, state) => {
    const tab = tabOfWc(e.sender);
    if (!tab || !e.senderFrame || !state) return;
    tab.capture.set(`${e.senderFrame.processId}:${e.senderFrame.routingId}`, {
      camera: state.camera === true,
      microphone: state.microphone === true,
      screen: state.screen === true,
    });
    sendTabs(tab.w);
  });
  handle('capture:stop', fromChrome, (w) => {
    const tab = activeTab(w);
    if (tab) stopCapture(tab);
  });

  // nav:go comes from the toolbar (navigates the active tab) or an internal page (navigates itself).
  ipcMain.handle('nav:go', (e, text) => {
    const tab = fromInternal(e) || activeTab(fromChrome(e));
    if (!tab) throw new Error('Unauthorized: nav:go');
    const url = resolveInput(text);
    if (url) tab.wc.loadURL(url).catch(() => {});
  });
  handle('nav:search', fromChrome, (w, text) => {
    const tab = activeTab(w);
    const query = String(text || '').trim();
    if (tab && query) tab.wc.loadURL(searchUrl(query)).catch(() => {});
  });

  handle('tab:new', fromChrome, (w) => {
    createTab(w, internalURL('newtab'));
  });
  handle('tab:close', fromChrome, (w, id) => closeTab(w, id));
  handle('tab:select', fromChrome, (w, id, mods) => clickTab(w, id, { toggle: !!(mods && mods.toggle), range: !!(mods && mods.range) }));
  handle('tab:menu', fromChrome, (w, id) => showTabMenu(w, id));
  handle('ui:overlay', fromChrome, (w, open) => {
    w.overlay = !!open;
    if (w.overlay) w.win.contentView.addChildView(w.chromeView); // bring the toolbar view to the front
    layout(w);
  });
  handle('suggest', fromChrome, (w, text) => {
    const result = suggestions(String(text || ''));
    result.tabs = openTabSuggestions(w, String(text || ''));
    const keyword = keywordSearch(String(text || ''));
    if (keyword) result.engine = keyword.engine.name;
    return result;
  });
  handle('suggest:search', fromChrome, (w, text) => searchSuggestions(w, String(text || '')));
  handle('suggest:remove', fromChrome, (_w, url) => {
    store.data.history = store.data.history.filter((h) => h.url !== url);
    rebuildMenuSoon();
    store.save();
  });
  handle('tab:switch', fromChrome, (w, tabId) => switchToTab(w, tabId));
  handle('tab:open-url', fromChrome, (w, text) => {
    const url = resolveInput(String(text || ''));
    if (url && !isInternalScheme(url)) createTab(w, url);
  });
  handle('address:menu', fromChrome, (w) => showAddressMenu(w));
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
  handle('reader:article', fromInternal, (tab) => {
    const params = new URL(tab.wc.getURL()).searchParams;
    const original = params.get('url') || '';
    const article = readerArticles.get(Number(params.get('id')));
    return { article: article || null, url: isWeb(original) ? original : '', prefs: readerPrefs() };
  });
  handle('reader:prefs', fromInternal, (_tab, prefs) => {
    const next = { ...readerPrefs() };
    for (const [k, allowed] of Object.entries(READER_PREFS)) if (prefs && allowed.includes(prefs[k])) next[k] = prefs[k];
    store.data.settings.reader = next;
    store.save();
    return next;
  });
  handle('reader:exit', fromInternal, (tab) => exitReader(tab));
  handle('reader:toggle', fromChrome, (w) => toggleReader(w));
  handle('data:site-data', fromInternal, (tab) => siteDataList(tab.w));
  handle('data:site-data-remove', fromInternal, (tab, site) => removeSiteData(tab.w, String(site || '')));
  handle('data:site-data-remove-all', fromInternal, async (tab) => {
    const ses = tab.w.private ? tab.w.ses : session.defaultSession;
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'websql', 'shadercache'] });
  });
  handle('site:export-certificate', fromChrome, async (w) => {
    const info = siteInfo(w);
    const pem = info && info.certificate && info.certificate.details && info.certificate.details.pem;
    if (!pem) return;
    const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
      defaultPath: path.join(app.getPath('downloads'), `${info.host.replace(/[^\w.-]/g, '_')}.pem`),
      filters: [{ name: 'Certificate (PEM)', extensions: ['pem', 'crt'] }],
    });
    if (!canceled && filePath) await fs.promises.writeFile(filePath, pem);
  });
  handle('site:clear-data', fromChrome, async (w) => {
    const tab = activeTab(w);
    const origin = tab && originOf(tab.wc.getURL());
    if (!origin) return;
    await w.ses.clearStorageData({ origin });
    tab.wc.reload();
  });
  handle('tab:move', fromChrome, (w, id, index) => moveTab(w, id, index));
  handle('tab:tear-off', fromChrome, (w, id) => tearOffTab(w, id));
  handle('media:toggle', fromChrome, (w, id) => {
    const tab = allTabs().find((t) => t.id === id && t.w.private === w.private);
    if (tab) return toggleMedia(tab);
  });
  handle('tab:adopt', fromChrome, (w, id, index) => adoptTab(w, Number(id), Number(index)));
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
  handle('nav:home', fromChrome, (w) => goHome(w));
  handle('restore:accept', fromChrome, (w) => restorePrevious(w));
  handle('restore:dismiss', fromChrome, (w) => {
    w.restoreOffer = null;
    layout(w);
    sendTabs(w);
  });
  handle('focus:page', fromChrome, (w) => activeTab(w)?.wc.focus());
  handle('nav:reload', fromChrome, (w) => {
    const t = activeTab(w);
    if (!t) return;
    if (t.wc.isLoading()) t.wc.stop();
    else t.wc.reload();
  });
  handle('bookmark:toggle', fromChrome, (w) => starPage(w));
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
  handle('adblock:details', fromChrome, (w) => {
    const tab = activeTab(w);
    const site = tab && siteOf(tab.wc.getURL());
    if (!tab || !site) return null;
    return {
      site,
      available: store.data.settings.adblock,
      on: blockingOnFor(w, site),
      blocked: tab.blocked,
      hosts: [...tab.blockedHosts].sort((a, b) => b[1] - a[1]).slice(0, 40),
      more: Math.max(0, tab.blockedHosts.size - 40),
    };
  });

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
  handle('download:remove', fromInternal, (tab, id) => {
    const d = ownDownload(tab, id);
    if (!d || d.state === 'progressing' || d.state === 'dangerous') return;
    store.data.downloads = store.data.downloads.filter((x) => x.id !== id);
    store.save();
    notifyDownloads(true);
  });
  handle('download:retry', fromInternal, (tab, id) => {
    const d = ownDownload(tab, id);
    if (d && ['cancelled', 'interrupted'].includes(d.state) && isWeb(d.url)) userDownload(tab.w.private ? tab.w.ses : session.defaultSession, d.url);
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
    searchEngines: allEngines().map((e) => ({ id: e.id, name: e.name, keyword: e.keyword, url: e.url, custom: !!e.custom })),
    searchEngineName: searchEngine().name,
    thirdPartyCookiesBlockedNow: thirdPartyCookiesBlocked,
    startupMode: startupMode(),
    downloadDirShown: downloadDir(),
    systemLanguages: app.getPreferredSystemLanguages(),
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
    rebuildMenuSoon();
    store.save();
  });
  handle('data:settings-set', fromInternal, (_tab, key, value) => {
    const valid =
      (['restoreSession', 'adblock', 'askDownloadLocation', 'blockThirdPartyCookies', 'showHomeButton', 'confirmClose', 'gpc', 'httpsOnly', 'memorySaver', 'spellcheck', 'searchSuggestions'].includes(key) &&
        typeof value === 'boolean') ||
      (key === 'startup' && ['continue', 'newtab', 'pages'].includes(value)) ||
      (key === 'autoplay' && ['block-audible', 'allow'].includes(value)) ||
      (key === 'theme' && ['system', 'light', 'dark'].includes(value)) ||
      (key === 'memorySaverMinutes' && [15, 30, 60, 120, 240].includes(value)) ||
      (key === 'languages' && Array.isArray(value) && value.length <= 10 && value.every((l) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l))) ||
      (key === 'defaultZoom' && [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200].includes(value)) ||
      (key === 'dns' && ['automatic', 'off', 'custom', ...Object.keys(DNS_PROVIDERS)].includes(value)) ||
      (key === 'dnsCustom' && typeof value === 'string' && (value === '' || /^https:\/\/[^\s]+$/i.test(value))) ||
      (key === 'homePage' && typeof value === 'string' && (value === '' || /^(https?|file):\/\//i.test(value))) ||
      (key === 'startupPages' && Array.isArray(value) && value.every((u) => typeof u === 'string' && /^(https?|file):\/\//i.test(u))) ||
      (key === 'searchEngine' && allEngines().some((e) => e.id === value));
    if (!valid) return;
    store.data.settings[key] = value;
    store.save();
    if (key === 'dns' || key === 'dnsCustom') applyDns();
    if (key === 'theme') nativeTheme.themeSource = value;
    if (key === 'languages' || key === 'spellcheck') {
      applyLanguages(session.defaultSession);
      windows.filter((w) => w.private).forEach((w) => applyLanguages(w.ses));
    }
    sendAll();
  });
  handle('data:engine-add', fromInternal, (_tab, name, keyword, url) => {
    if (!validCustomEngine(name, keyword, url)) return 'invalid';
    if (allEngines().some((e) => e.keyword && e.keyword.toLowerCase() === keyword.toLowerCase())) return 'keyword-taken';
    const list = (store.data.settings.customEngines ||= []);
    if (list.length >= 30) return 'too-many';
    list.push({ name: name.trim(), keyword, url });
    store.save();
    sendAll();
    return 'ok';
  });
  handle('data:engine-remove', fromInternal, (_tab, keyword) => {
    const list = store.data.settings.customEngines || [];
    store.data.settings.customEngines = list.filter((c) => c.keyword !== keyword);
    if (store.data.settings.searchEngine === `custom:${keyword}`) store.data.settings.searchEngine = 'duckduckgo';
    store.save();
    sendAll();
  });
  handle('data:adblock-allow-remove', fromInternal, (_tab, site) => {
    store.data.adblockAllowlist = store.data.adblockAllowlist.filter((s) => s !== site);
    store.save();
    sendAll();
  });

  handle('data:permissions', fromInternal, (tab) => permissionStore(tab.w));
  handle('data:permission-set', fromInternal, (tab, origin, key, value) => {
    const clean = originOf(String(origin || '').includes('://') ? origin : `https://${origin}`);
    if (!clean || !PERM_LABELS[key] || !['allow', 'block', 'ask'].includes(value)) return null;
    const perms = permissionStore(tab.w);
    const site = (perms[clean] ||= {});
    if (value === 'ask') delete site[key];
    else site[key] = value;
    if (Object.keys(site).length === 0) delete perms[clean];
    if (!tab.w.private) store.save();
    return clean;
  });
  handle('data:permission-defaults', fromInternal, () => ({
    keys: PERMISSION_DEFAULT_KEYS.map((key) => ({ key, name: PERMISSION_NAMES[key], value: permissionDefault(key) })),
    names: PERMISSION_NAMES,
  }));
  handle('data:permission-default-set', fromInternal, (_tab, key, value) => {
    if (!PERMISSION_DEFAULT_KEYS.includes(key) || !['ask', 'block'].includes(value)) return;
    if (value === 'ask') delete store.data.settings.permissionDefaults[key];
    else store.data.settings.permissionDefaults[key] = value;
    store.save();
  });
  handle('startup:current-pages', fromInternal, (tab) =>
    tab.w.tabs.map((t) => t.wc.getURL()).filter((u) => isWeb(u)),
  );
  handle('settings:reset', fromInternal, () => {
    store.data.settings = defaultSettings();
    store.save();
    applyDns();
    nativeTheme.themeSource = 'system';
    windows.forEach((w) => {
      layout(w);
      sendTabs(w);
    });
    buildMenu();
  });
  handle('data:top-sites', fromInternal, (tab) => (tab.w.private ? [] : topSites())); // private windows don't show history
  handle('data:hide-tile', fromInternal, (_tab, site) => {
    if (!store.data.settings.hiddenTiles.includes(site)) store.data.settings.hiddenTiles.push(String(site));
    store.save();
  });
  handle('app:relaunch', fromInternal, () => {
    app.relaunch();
    app.quit();
  });
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
  handle('data:tasks', fromInternal, () => taskList());
  handle('tasks:end', fromInternal, (_tab, pid) => {
    const target = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.getOSProcessId() === pid);
    if (target) target.wc.forcefullyCrashRenderer(); // the tab shows "This page crashed" with Reload
  });
  handle('https:allow', fromInternal, (tab, url) => {
    if (!/^http:\/\//i.test(url)) return;
    httpsExceptions.add(new URL(url).host);
    tab.wc.loadURL(url).catch(() => {});
  });
  handle('data:licenses', fromInternal, async () => JSON.parse(await fs.promises.readFile(path.join(__dirname, 'gen', 'licenses.json'), 'utf8')));
  handle('data:history-remove-site', fromInternal, (_tab, site) => {
    store.data.history = store.data.history.filter((h) => siteOf(h.url) !== site);
    rebuildMenuSoon();
    store.save();
  });
  handle('data:history-clear', fromInternal, () => {
    store.data.history = [];
    rebuildMenuSoon();
    store.save();
  });
  handle('ext:list', fromInternal, () => extensionList());
  handle('ext:remove', fromInternal, async (_tab, id) => {
    await uninstallExtension(String(id), { session: session.defaultSession });
    return extensionList();
  });
  handle('ext:store', fromInternal, (tab) => createTab(tab.w, 'https://chromewebstore.google.com/') && undefined);
  handle('data:bookmarks', fromInternal, () => bookmarks.all().map(bookmarks.summary));

  // Bookmark editing is shared by the toolbar (star popup, bar) and the bookmark manager page.
  const fromToolbarOrPage = (e) => fromChrome(e) || fromInternal(e)?.w || null;
  handle('bm:tree', fromInternal, () => bookmarks.tree());
  handle('bm:edit-info', fromToolbarOrPage, (_w, id) => bookmarkEditInfo(String(id)));
  handle('bm:update', fromToolbarOrPage, (_w, id, changes = {}) => {
    const f = bookmarks.find(String(id));
    if (!f) return;
    bookmarks.update(f.node.id, { title: changes.title, url: changes.url });
    if (changes.parentId && f.parent && changes.parentId !== f.parent.id) bookmarks.move(f.node.id, String(changes.parentId));
  });
  handle('bm:move', fromToolbarOrPage, (_w, id, parentId, index) => bookmarks.move(String(id), String(parentId), index));
  handle('bm:remove', fromToolbarOrPage, (_w, id) => bookmarks.remove(String(id)));
  handle('bm:add-folder', fromInternal, (_tab, title, parentId) => bookmarks.addFolder(String(title || ''), String(parentId || 'bar')).id);
  handle('bm:import-sources', fromInternal, () => importSources().map((c) => c.name));
  handle('bm:import', fromInternal, (tab, source) => importBookmarks(tab.w, String(source)));
  handle('bm:export', fromInternal, (tab) => exportBookmarks(tab.w));
  handle('bm:star', fromChrome, (w) => starPage(w));
  handle('bm:open', fromChrome, (w, id, where) => {
    const f = bookmarks.find(String(id));
    if (f && f.node.type === 'bookmark') openBookmarkUrl(w, f.node.url, where);
  });
  handle('bm:folder-menu', fromChrome, (w, id) => {
    const f = bookmarks.find(String(id));
    if (f && f.node.type === 'folder') Menu.buildFromTemplate(folderMenuTemplate(w, f.node)).popup({ window: w.win });
  });
  handle('bm:context', fromChrome, (w, id) => showBookmarkMenu(w, id ? String(id) : null));
}

// ---------------------------------------------------------------- menu

let menuTimer = null;
function rebuildMenuSoon() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(buildMenu, 1000);
}

// History menu: the focused window's closed tabs and the last pages visited.
function recentMenuItems(inWindow) {
  const w = focusedWindow();
  const closed = w
    ? w.closedTabs
        .map((c, position) => ({ c, position }))
        .reverse()
        .slice(0, 10)
        .map(({ c, position }) => {
          const entry = c.history.entries[c.history.index];
          return { label: trimLabel(entry.title || displayUrl(entry.url) || 'Tab', 60), click: () => liveWindow(w) && reopenClosedTab(w, position) };
        })
    : [];
  const seen = new Set();
  const visited = [];
  for (const h of store.data.history) {
    if (visited.length >= 10) break;
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    visited.push({ label: trimLabel(h.title || displayUrl(h.url), 60), click: inWindow((win) => createTab(win, h.url)) });
  }
  return [
    { type: 'separator' },
    { label: 'Recently Closed', enabled: closed.length > 0, submenu: closed.length ? closed : [{ label: 'Nothing yet', enabled: false }] },
    ...(visited.length ? [{ type: 'separator' }, { label: 'Recently Visited', enabled: false }, ...visited] : []),
  ];
}

function buildMenu() {
  clearTimeout(menuTimer);
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
              { label: `About ${DISPLAY_NAME}`, click: () => app.showAboutPanel() },
              { label: 'Check for Updates…', click: checkForUpdatesManually },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { label: `Hide ${DISPLAY_NAME}`, role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { label: 'Quit Operecs', accelerator: 'Cmd+Q', click: userQuit },
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
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: inWindow((w) => closeActiveTabs(w)) },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: inWindow((w) => w.win.close()) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: inWindow(reopenClosedTab) },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: inWindow(focusAddress) },
        { label: 'Switch Between Toolbar and Page', accelerator: 'F6', click: inWindow(cycleFocus) },
        { type: 'separator' },
        { label: 'Save Page As…', accelerator: 'CmdOrCtrl+S', click: inWindow(savePageAs) },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: inWindow((w) => printTab(activeTab(w))) },
        ...(isMac ? [{ label: 'Share…', click: inWindow((w) => sharePage(w, activeTab(w))) }] : []),
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: open('settings') },
        { label: 'Extensions', click: open('extensions') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'Exit', accelerator: 'Ctrl+Q', click: userQuit }]),
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
        { label: 'Reader Mode', accelerator: 'Alt+CmdOrCtrl+R', click: inWindow(toggleReader) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: inWindow((w) => zoom(w, 0.5)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: inWindow((w) => zoom(w, -0.5)) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: inWindow((w) => zoom(w, 0)) },
        { type: 'separator' },
        { label: 'Task Manager', accelerator: isMac ? undefined : 'Shift+Esc', click: open('tasks') },
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
        { label: 'Home', accelerator: isMac ? 'Cmd+Shift+H' : 'Alt+Home', click: inWindow(goHome) },
        { type: 'separator' },
        { label: 'Show History', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: open('history') },
        { label: 'Show Downloads', accelerator: isMac ? 'Alt+Cmd+L' : 'Ctrl+J', click: open('downloads') },
        ...recentMenuItems(inWindow),
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
        { label: 'Bookmark This Page…', accelerator: 'CmdOrCtrl+D', click: inWindow(starPage) },
        {
          label: 'Show Bookmarks Bar',
          type: 'checkbox',
          checked: !!(store && store.data.settings.showBookmarksBar),
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (item) => setBookmarksBar(item.checked),
        },
        { label: 'Bookmark All Tabs…', accelerator: 'CmdOrCtrl+Shift+D', click: inWindow(bookmarkAllTabs) },
        { label: 'Bookmark Manager', accelerator: 'CmdOrCtrl+Shift+O', click: open('bookmarks') },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: inWindow((w) => cycleTab(w, 1)) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: inWindow((w) => cycleTab(w, -1)) },
        { label: 'Search Tabs…', accelerator: 'CmdOrCtrl+Shift+A', click: inWindow(showTabSearch) },
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
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: open('shortcuts') },
        {
          label: 'Report a Problem…',
          click: inWindow((w) => createTab(w, 'https://github.com/ezzeldinzozz-svg/operecs-browser/issues/new')),
        },
        { label: 'Privacy', click: open('privacy') },
        { label: 'Open-Source Licenses', click: open('licenses') },
      ],
    },
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
  // Chromium's and Electron's own license notices, which ship with the app (the npm packages'
  // licenses come from gen/licenses.json through data:licenses).
  if (host === 'licenses' && rel === 'chromium') {
    const candidates = [
      path.join(process.resourcesPath || '', 'LICENSES.chromium.html'),
      path.join(__dirname, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html'),
    ];
    const found = candidates.find((c) => fs.existsSync(c));
    if (!found) return new Response('Not found', { status: 404 });
    return new Response(await fs.promises.readFile(found), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
    });
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

// Settings that must be applied before Electron starts, read straight from the profile.
function readEarlySettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'browser-data.json'), 'utf8'));
    return raw.settings || {};
  } catch {
    return {};
  }
}

// Third-party cookies: Chromium's own blocking (the same code path as its planned phase-out),
// on by default like Safari and Brave. Embedded sites can still ask via the Storage Access API.
const thirdPartyCookiesBlocked = readEarlySettings().blockThirdPartyCookies !== false;
if (thirdPartyCookiesBlocked) app.commandLine.appendSwitch('test-third-party-cookie-phaseout');

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
  nativeTheme.themeSource = store.data.settings.theme || 'system';
  app.setAboutPanelOptions({
    applicationName: DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Free software under the GPL-3.0. github.com/ezzeldinzozz-svg/operecs-browser',
  });
  bookmarks.init(store.data, () => {
    store.save();
    sendAll();
  });
  // Downloads still running when the app last quit can't be resumed.
  for (const d of store.data.downloads) if (d.state === 'progressing') d.state = 'interrupted';
  nextDownloadId = store.data.downloads.reduce((max, d) => Math.max(max, d.id), 0) + 1;

  adblock.init({
    cacheFile: path.join(app.getPath('userData'), 'adblock-engine.bin'),
    shouldBlock,
    onBlocked,
    beforeRequest: upgradeToHttps,
  });
  applyDns();
  configureSession(session.defaultSession);
  setupExtensions();
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
  // The previous run didn't reach before-quit: it crashed or was killed.
  const crashed = store.data.cleanExit === false;
  store.data.cleanExit = false;
  const firstRun = store.isNew && !store.data.welcomed;
  store.data.welcomed = true;
  store.flush();
  const previous = savedWindows(); // snapshot before new windows overwrite the saved session

  const mode = startupMode();
  const pages = store.data.settings.startupPages.filter((u) => /^(https?|file):/i.test(u));
  if (mode === 'continue' && previous.length) {
    for (const s of previous) createWindow({ session: s });
  } else if (mode === 'pages' && pages.length) {
    const w = createWindow({ empty: true });
    pages.forEach((url, i) => createTab(w, url, { background: i > 0 }));
  } else if (firstRun) {
    createWindow({ empty: true });
    createTab(windows[0], internalURL('welcome'));
  } else {
    const w = createWindow();
    if (crashed && previous.length) {
      w.restoreOffer = previous;
      layout(w);
      sendTabs(w);
    }
  }
  launched = true;
  for (const url of [...process.argv.slice(1).map(urlFromArg).filter(Boolean), ...pendingOpens.splice(0)]) {
    openFromOutside(url);
  }
  updater.start(sendAll);
});

// ---------------------------------------------------------------- extensions

// Chrome extensions (electron-chrome-extensions, GPL-3.0) in normal windows; private windows
// have none, like Chrome's default. The Chrome Web Store can install them
// (electron-chrome-web-store), after the user confirms.
let extensions = null;

const windowOfBrowserWindow = (win) => windows.find((x) => x.win === win) || null;
const normalWindow = () => {
  const normal = windows.filter((x) => !x.private && liveWindow(x));
  return normal.includes(lastFocused) ? lastFocused : normal[0] || null;
};

function setupExtensions() {
  extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: session.defaultSession,
    createTab: async (details) => {
      const w = (details.windowId && windows.find((x) => x.win.id === details.windowId && !x.private)) || normalWindow() || createWindow({ empty: true });
      const tab = createTab(w, details.url || internalURL('newtab'), { background: details.active === false });
      return [tab.wc, w.win];
    },
    selectTab: (wc) => {
      const tab = tabOfWc(wc);
      if (!tab) return;
      if (tab.w.activeId !== tab.id) selectTab(tab.w, tab.id); // (also called back when we select a tab)
      tab.w.win.focus();
    },
    removeTab: (wc) => {
      const tab = tabOfWc(wc);
      if (tab) closeTab(tab.w, tab.id);
    },
    createWindow: async (details) => {
      const url = Array.isArray(details.url) ? details.url[0] : details.url;
      const w = createWindow({ empty: !!url });
      if (url) createTab(w, url);
      return w.win;
    },
    removeWindow: (win) => {
      const w = windowOfBrowserWindow(win);
      if (w) w.win.close();
    },
  });
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession); // icons in the toolbar
  installChromeWebStore({
    session: session.defaultSession,
    beforeInstall: async (details) => {
      const permissions = [
        ...(details.manifest.permissions || []),
        ...(details.manifest.host_permissions || []),
      ].filter((p) => typeof p === 'string');
      const parent = details.browserWindow || normalWindow()?.win;
      const { response } = await dialog.showMessageBox(parent, {
        type: 'question',
        icon: details.icon,
        message: `Add \u201c${details.localizedName}\u201d?`,
        detail: permissions.length
          ? `It can:\n\u2022 ${permissions.slice(0, 12).join('\n\u2022 ')}${permissions.length > 12 ? '\n\u2022 \u2026' : ''}`
          : 'It needs no special permissions.',
        buttons: ['Add Extension', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      return { action: response === 0 ? 'allow' : 'deny' };
    },
  }).catch((err) => console.error('Chrome Web Store setup failed:', err));
}

function extensionList() {
  return session.defaultSession.extensions.getAllExtensions().map((e) => ({
    id: e.id,
    name: e.name,
    version: e.version,
    description: e.manifest.description || '',
  }));
}

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

let quitConfirmed = false;

// Only a quit the user asks for (Cmd/Ctrl+Q, the Quit menu item) gets "Quit with N tabs?".
// Shutdown, logout, signals and the updater quit without asking.
let userQuitRequested = false;
function userQuit() {
  userQuitRequested = true;
  app.quit();
}

function restartToUpdate() {
  if (!updater.install(true)) return;
  quitConfirmed = true; // no "Quit with N tabs?" when restarting for an update
  app.quit();
}

async function checkForUpdatesManually() {
  const parent = focusedWindow()?.win;
  const state = await updater.check();
  const version = app.getVersion();
  if (state.status === 'ready') {
    const { response } = await dialog.showMessageBox(parent, {
      message: `Operecs ${state.version} is ready to install.`,
      detail: `You have ${version}. Operecs will restart to finish updating.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    });
    if (response === 0) restartToUpdate();
  } else if (state.status === 'none') {
    dialog.showMessageBox(parent, { message: "You're up to date.", detail: `Operecs ${version} is the latest version.` });
  } else if (state.status === 'checking' || state.status === 'downloading') {
    dialog.showMessageBox(parent, { message: 'An update is already being downloaded.' });
  } else {
    dialog.showMessageBox(parent, { type: 'warning', message: "Couldn't check for updates.", detail: state.error || '' });
  }
}

app.on('before-quit', (e) => {
  const openTabs = windows.reduce((n, w) => n + w.tabs.length, 0);
  if (store && userQuitRequested && !quitting && !quitConfirmed && store.data.settings.confirmClose && openTabs > 1) {
    e.preventDefault();
    userQuitRequested = false;
    confirmClosing(focusedWindow()?.win, `Quit with ${openTabs} tabs open?`, 'Quit').then((ok) => {
      if (!ok) return;
      quitConfirmed = true;
      app.quit();
    });
    return;
  }
  if (store) {
    saveSession(); // all windows are still open here, so this captures every one of them
    quitting = true;
    store.data.cleanExit = true;
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
