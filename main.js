'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
  nativeImage,
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
const i18n = require('./i18n');
const historyDb = require('./history-db');
const bookmarks = require('./bookmarks');
const quickAnswers = require('./quick-answers');
const qr = require('./qr');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');

const CHROME_H = 80; // tab strip (38, also the title bar) + toolbar (42)
const COMPACT_CHROME_H = 68; // compact tab strip (32) + compact toolbar (36)
const TOOLBAR_ONLY_H = 42;
const COMPACT_TOOLBAR_ONLY_H = 36;
const SIDEBAR_W = 200; // vertical tabs sidebar width
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
const INTERNAL = new Set(['newtab', 'history', 'bookmarks', 'downloads', 'settings', 'error', 'welcome', 'privacy', 'extensions', 'shortcuts', 'licenses', 'tasks', 'reader', 'whatsnew']);
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
const HISTORY_IMPORT_LIMIT = 50000; // visits taken from another browser's history
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
  autoplay: 'play media with sound automatically',
  // An embedded site (sign-in widget, video player…) asking for its cookies while third-party
  // cookies are blocked (Storage Access API).
  'storage-access': 'use its cookies and site data while embedded on other sites',
  'top-level-storage-access': 'use its cookies and site data while embedded on other sites',
};
// Permission types that can be set to Ask or Block for every site in Settings.
const PERMISSION_DEFAULT_KEYS = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'automatic-downloads', 'autoplay'];
const PROMPTABLE = new Set(['media', ...Object.keys(PERM_LABELS)]);

const isMac = process.platform === 'darwin';
const ACCENT_COLORS = ['violet', 'blue', 'emerald', 'amber', 'rose', 'cyan'];
const GROUP_COLORS = { violet: '#9b6cff', blue: '#4f8cff', emerald: '#2fb67c', amber: '#f2994a', rose: '#eb5757', cyan: '#12a4b8' };
const TOOLBAR_BUTTON_DEFAULTS = {
  home: false,
  shield: true,
  star: true,
  split: false,
  screenshot: false,
  translate: false,
  readAloud: false,
  bookmarks: false,
  history: false,
  downloads: true,
  profile: true,
  settings: true,
};
const TOOLBAR_BUTTON_LABELS = {
  home: 'Home Button',
  shield: 'Ad & Tracker Shield',
  star: 'Bookmark Star',
  split: 'Split View',
  screenshot: 'Take Screenshot',
  translate: 'Translate Page',
  readAloud: 'Read Aloud',
  bookmarks: 'Bookmarks',
  history: 'History',
  downloads: 'Downloads',
  profile: 'Profile Switcher',
  settings: 'Settings',
};

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
    disabledExtensions: [], // [{ id, name, version, description, path }] installed but turned off
    hiddenActions: [], // extension ids whose toolbar button is hidden
    proxyMode: 'system', // 'system' | 'direct' | 'manual' | 'pac'
    proxyServer: '', // e.g. "proxy.example.com:8080" or "socks5://127.0.0.1:1080"
    proxyBypass: '', // e.g. "<local>;*.example.com"
    proxyPac: '', // PAC script address
    uiLanguage: 'auto', // 'auto' (the system's) | 'en' | 'ar'
    historyKeepDays: 0, // 0 = forever; else visits older than this are deleted
    clearOnQuit: { history: false, cookies: false, cache: false, downloads: false },
    newtab: { background: 'none', color: '#2a1f4d', showTiles: true, showBookmarks: true }, // background: none | color | image
    pinnedTiles: [], // [{ url, title }] shown first on the new tab page
    mutedSites: [], // sites muted in every tab ("Mute Site")
    energySaver: true, // on battery: idle tabs sleep sooner
    privacyStats: true, // show ads and trackers blocked on the new tab page
    stripTracking: true, // remove utm_ / fbclid / gclid… from addresses you open
    theme: 'system', // 'system' | 'light' | 'dark' (browser UI, internal pages, and sites that follow it)
    rejectCookies: true, // auto-reject common cookie consent banners
    fingerprintingProtection: true, // canvas/WebGL/audio noise + hardwareConcurrency clamping
    accentColor: 'violet', // 'violet' | 'blue' | 'emerald' | 'amber' | 'rose' | 'cyan'
    compactMode: false, // compact toolbar & tab strip
    verticalTabs: false, // show tabs in a left sidebar
    toolbarButtons: { ...TOOLBAR_BUTTON_DEFAULTS }, // customizable toolbar buttons
    protocolHandlers: {}, // scheme -> { url, host }
    installedApps: [], // [{ url, title, icon }]
    shortcuts: {}, // actionId -> accelerator override
  };
}

function toolbarButtonsState() {
  const saved = store && store.data.settings && store.data.settings.toolbarButtons;
  const out = { ...TOOLBAR_BUTTON_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (store && store.data.settings && (!saved || !Object.hasOwn(saved, 'home'))) {
    out.home = !!store.data.settings.showHomeButton;
  }
  return out;
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
      addresses: [], // [{ id, name, organization, street, street2, city, region, postal, country, email, phone }]
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

// ---------------------------------------------------------------- interface language

// settings.uiLanguage: 'auto' (follow the system) or a language with a locales/<lang>.json.
const UI_LANGUAGES = { en: 'English', ar: 'العربية' };
let uiLang = 'en';
let uiRaw = null; // the locale file, sent to pages
let uiDict = null; // compiled, for menus and dialogs here

function setupUiLanguage() {
  const pref = store.data.settings.uiLanguage || 'auto';
  const system = (app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en').toLowerCase().split('-')[0];
  // English only for now (see CLAUDE.md): 'auto' doesn't follow the system yet, and Settings hides
  // the choice. To bring languages back: use `UI_LANGUAGES[system] ? system : 'en'` for 'auto'
  // and unhide #ui-language-row in settings.html.
  void system;
  uiLang = pref !== 'auto' && UI_LANGUAGES[pref] ? pref : 'en';
  uiRaw = null;
  uiDict = null;
  if (uiLang !== 'en') {
    try {
      uiRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', `${uiLang}.json`), 'utf8'));
      uiDict = i18n.compile(uiRaw);
    } catch (err) {
      console.warn('Interface language:', err.message);
      uiLang = 'en';
    }
  }
  // Every menu and message box goes through these, so their text is translated in one place.
  if (!setupUiLanguage.patched) {
    setupUiLanguage.patched = true;
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => build(i18n.translateMenuTemplate(uiDict, template));
    const tr = (o) =>
      o && uiDict
        ? { ...o, message: i18n.translate(uiDict, o.message), detail: i18n.translate(uiDict, o.detail), buttons: o.buttons && o.buttons.map((b) => i18n.translate(uiDict, b)), title: i18n.translate(uiDict, o.title) }
        : o;
    for (const name of ['showMessageBox', 'showMessageBoxSync']) {
      const original = dialog[name].bind(dialog);
      dialog[name] = (win, options) => (options === undefined && win && !win.contentView ? original(tr(win)) : original(win, tr(options)));
    }
  }
}

const t = (text) => i18n.translate(uiDict, text);

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

function resolveProtocolUrl(targetUrl) {
  if (!store || !targetUrl) return null;
  const m = String(targetUrl).trim().match(/^([a-z][a-z0-9+.-]*):/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (['http', 'https', 'file', 'browser', 'javascript', 'data', 'blob', 'about', 'view-source', 'chrome-extension'].includes(scheme)) return null;
  const h = (store.data.settings.protocolHandlers || {})[scheme];
  if (!h || !h.url || !h.url.includes('%s')) return null;
  return h.url.replace('%s', encodeURIComponent(String(targetUrl).trim()));
}

function resolveInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const internal = text.match(/^browser:\/\/(\w+)\/?$/i);
  if (internal) return INTERNAL.has(internal[1].toLowerCase()) ? internalURL(internal[1].toLowerCase()) : null;
  if (/^(https?|file):\/\//i.test(text)) return text;
  const proto = resolveProtocolUrl(text);
  if (proto) return proto;
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
const visibleTabs = (w) => {
  const ws = (w && w.activeWorkspace) || 'Default';
  return w.tabs.filter((t) => t.pinned || (t.workspace || 'Default') === ws);
};

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
  const shownTabs = visibleTabs(w);
  w.chromeView.webContents.send('tabs:update', {
    activeId: w.activeId,
    splitId: w.splitId || null,
    activeWebContentsId: current && !w.private ? current.wc.id : null,
    private: w.private,
    bookmarked: !!bookmarks.findByUrl(currentUrl),
    bookmarkBar: store.data.settings.showBookmarksBar ? bookmarks.tree().bar.children.map(bookmarks.summary) : null,
    canBookmark: isWeb(currentUrl),
    reader: current ? (internalName(currentUrl) === 'reader' ? 'on' : current.readerable ? 'available' : null) : null,
    prompt: prompt
      ? {
          id: prompt.id,
          allowLabel: prompt.kind === 'save-address' ? 'Save' : 'Allow',
          blockLabel: prompt.kind === 'save-address' ? 'Not now' : 'Block',
          text: prompt.kind === 'save-address'
            ? `Save this address for filling in forms? ${[prompt.address.name, prompt.address.street || prompt.address.email].filter(Boolean).join(', ')}`
            : prompt.kind === 'protocol-handler'
            ? `${new URL(prompt.origin).host} wants to open \u201c${prompt.scheme}:\u201d links`
            : prompt.scheme
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
      ? current && current.mixedContent
        ? 'mixed'
        : 'secure'
      : /^http:/i.test(currentUrl)
        ? 'insecure'
        : internalName(currentUrl) && internalName(currentUrl) !== 'newtab'
          ? 'internal'
          : 'none',
    downloads: downloadSummary(w),
    update: updater.getState(),
    restoreOffer: !!w.restoreOffer,
    showHome: !!toolbarButtonsState().home,
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
    groups: w.groups || [],
    workspace: {
      current: w.activeWorkspace || 'Default',
      list: (w.workspaces || ['Default']).map((ws) => ({
        name: ws,
        count: w.tabs.filter((t) => !t.pinned && (t.workspace || 'Default') === ws).length,
      })),
    },
    uiPrefs: {
      accentColor: store.data.settings.accentColor || 'violet',
      compactMode: !!store.data.settings.compactMode,
      verticalTabs: !!store.data.settings.verticalTabs,
      toolbarButtons: toolbarButtonsState(),
    },
    tabs: shownTabs.map((t) => {
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
        groupId: t.groupId || null,
        split: t.id === w.splitId && t.id !== w.activeId,
        multi: w.multi.size > 1 && w.multi.has(t.id),
        sleeping: !!t.pending,
        capture: captureState(t),
        audible: t.wc.isCurrentlyAudible(),
        muted: t.wc.isAudioMuted(),
      };
    }),
    media: mediaTabs(w),
    hiddenActions: store.data.settings.hiddenActions || [],
    profile: (() => {
      const p = profileInfo();
      return { name: p.name, color: p.color, initial: (p.name.trim()[0] || 'P').toUpperCase(), many: readProfiles().length > 1 };
    })(),
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

const PIP_TOGGLE = `(() => {
  if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return 1; }
  const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState >= 1 && !v.disablePictureInPicture);
  const target = vids.find((v) => !v.paused) || vids[0];
  if (target) { target.requestPictureInPicture().catch(() => {}); return 1; }
  return 0;
})()`;

async function togglePip(tab) {
  if (!tab || tab.wc.isDestroyed()) return;
  for (const frame of tab.wc.mainFrame.framesInSubtree) {
    try {
      const n = await frame.executeJavaScript(PIP_TOGGLE, true);
      if (n) break;
    } catch {
      // frame went away
    }
  }
}

const sendAll = () => windows.forEach(sendTabs);

function chromeHeight(w) {
  const compact = !!(store && store.data.settings.compactMode);
  const vertical = !!(store && store.data.settings.verticalTabs);
  const baseH = vertical ? (compact ? COMPACT_TOOLBAR_ONLY_H : TOOLBAR_ONLY_H) : (compact ? COMPACT_CHROME_H : CHROME_H);
  const bmH = store && store.data.settings.showBookmarksBar ? BOOKMARKS_BAR_H : 0;
  const tab = activeTab(w);
  if (!tab) return baseH + bmH;
  if (tab.fullscreen) return 0;
  const bars = [w.restoreOffer, w.downloadWarnings.length, tab.prompts.length, tab.auth.length, tab.find.open].filter(Boolean).length;
  return baseH + bmH + bars * BAR_H;
}

function sidebarWidth(w) {
  const tab = activeTab(w);
  if (tab && tab.fullscreen) return 0;
  return store && store.data.settings.verticalTabs ? SIDEBAR_W : 0;
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
  const left = sidebarWidth(w);
  const textWidth = Math.min(Math.round((width - left) * 0.6), 7 * w.statusText.length + 28);
  w.statusView.setBounds({ x: (left || PAGE_INSET), y: height - STATUS_H - PAGE_INSET, width: Math.max(80, textWidth), height: STATUS_H });
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
  const left = sidebarWidth(w);
  w.chromeView.setVisible(top > 0);
  // While a dropdown/popup is open, or when vertical tabs are on, the toolbar view covers the whole window.
  w.chromeView.setBounds({ x: 0, y: 0, width, height: (w.overlay || left > 0) && top ? height : top || CHROME_H });
  const inset = top > 0 ? PAGE_INSET : 0; // a page in fullscreen fills the window
  const x0 = left > 0 ? left : inset;
  const availW = Math.max(0, width - x0 - inset);
  const availH = Math.max(0, height - top - inset);
  const splitTab = w.splitId && w.splitId !== w.activeId && !(activeTab(w) && activeTab(w).fullscreen) ? getTab(w, w.splitId) : null;
  const pair = splitTab ? (w.splitOrder && w.splitOrder.includes(w.activeId) && w.splitOrder.includes(w.splitId) ? w.splitOrder : [w.activeId, w.splitId]) : null;
  const halfW = splitTab ? Math.max(0, Math.floor((availW - PAGE_INSET) / 2)) : availW;
  for (const t of w.tabs) {
    const visible = t.id === w.activeId || (splitTab && t.id === splitTab.id);
    t.view.setVisible(!!visible);
    if (pair && t.id === pair[0]) {
      t.view.setBounds({ x: x0, y: top, width: halfW, height: availH });
    } else if (pair && t.id === pair[1]) {
      t.view.setBounds({ x: x0 + halfW + PAGE_INSET, y: top, width: Math.max(0, availW - halfW - PAGE_INSET), height: availH });
    } else {
      t.view.setBounds({ x: x0, y: top, width: availW, height: availH });
    }
    t.view.setBorderRadius(inset ? PAGE_RADIUS : 0);
  }
  if (!w.overlay && top > 0) {
    for (const t of w.tabs) {
      if (t.id === w.activeId || (splitTab && t.id === splitTab.id)) w.win.contentView.addChildView(t.view);
    }
    if (w.statusView && w.statusText) w.win.contentView.addChildView(w.statusView);
    if (w.autofillView && w.autofillView.getVisible()) w.win.contentView.addChildView(w.autofillView);
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
    title: isPrivate ? 'Operecs — Private' : readProfiles().length > 1 ? `Operecs — ${profileInfo().name}` : 'Operecs',
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
    splitId: null,
    splitOrder: null,
    groups: saved && Array.isArray(saved.groups) ? saved.groups : [],
    workspaces: saved && Array.isArray(saved.workspaces) && saved.workspaces.length ? saved.workspaces : ['Default', 'Work', 'Personal'],
    activeWorkspace: (saved && saved.activeWorkspace) || 'Default',
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
    hideAutofill(w);
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
    if (!quitting && !quitConfirmed && !w.closeConfirmed) {
      e.preventDefault();
      (async () => {
        const dirty = await unsavedTabs(w.tabs);
        let ok = true;
        if (dirty.length) ok = await confirmUnsaved(w.win, dirty, 'Close Window');
        else if (store.data.settings.confirmClose && w.tabs.length > 1) ok = await confirmClosing(w.win, `Close ${w.tabs.length} tabs?`, 'Close Window');
        if (!ok || !liveWindow(w)) return;
        w.closeConfirmed = true;
        w.win.close();
      })();
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

// Proxy: the system's settings by default; or none, a manual server, or a PAC script address.
function proxyConfig() {
  const s = store.data.settings;
  switch (s.proxyMode) {
    case 'direct':
      return { mode: 'direct' };
    case 'manual':
      return s.proxyServer ? { mode: 'fixed_servers', proxyRules: s.proxyServer, proxyBypassRules: s.proxyBypass || '<local>' } : { mode: 'system' };
    case 'pac':
      return s.proxyPac ? { mode: 'pac_script', pacScript: s.proxyPac } : { mode: 'system' };
    default:
      return { mode: 'system' };
  }
}

function applyProxy(ses) {
  ses.setProxy(proxyConfig()).then(() => ses.closeAllConnections()).catch((err) => console.warn('Proxy:', err.message));
}

// ---------------------------------------------------------------- device chooser

// WebHID / Web Serial / WebUSB / Web Bluetooth: the page asks, the user picks a device in the
// toolbar's chooser (or cancels). Picked devices stay allowed for that site until Operecs quits.
const DEVICE_KINDS = new Set(['hid', 'serial', 'usb']);
const DEVICE_NAMES = { hid: 'a HID device', serial: 'a serial port', usb: 'a USB device', bluetooth: 'a Bluetooth device', certificate: 'a client certificate' };
const grantedDevices = new Map(); // origin -> Set of device keys
let nextDevicePickId = 1;

const deviceKey = (d) => [d.vendorId, d.productId, d.serialNumber, d.deviceId, d.portId].filter((x) => x !== undefined && x !== '').join(':');

function showDeviceChooser(wc, kind, devices, callback) {
  const tab = tabOfWc(wc);
  if (!tab || !liveWindow(tab.w)) return callback('');
  const w = tab.w;
  const origin = originOf(wc.getURL());
  const same = w.devicePick && w.devicePick.wc === wc && w.devicePick.kind === kind;
  if (w.devicePick && !same) finishDeviceChooser(w, w.devicePick.id, null); // one at a time
  const pick = same ? w.devicePick : { id: nextDevicePickId++, wc, kind, origin };
  pick.callback = callback; // Bluetooth keeps re-asking with fresh lists while it scans
  pick.devices = devices;
  w.devicePick = pick;
  if (tab.id !== w.activeId) selectTab(w, tab.id);
  w.chromeView.webContents.send('device-picker', {
    id: pick.id,
    title: `${origin ? new URL(origin).host : 'This site'} wants to connect to ${DEVICE_NAMES[kind]}`,
    scanning: kind === 'bluetooth',
    devices: devices.map((d) => ({ id: d.id, name: d.name })),
  });
}

function finishDeviceChooser(w, pickId, deviceId) {
  const pick = w.devicePick;
  if (!pick || pick.id !== pickId) return;
  w.devicePick = null;
  const device = pick.devices.find((d) => d.id === deviceId);
  if (device && pick.origin) {
    if (!grantedDevices.has(pick.origin)) grantedDevices.set(pick.origin, new Set());
    grantedDevices.get(pick.origin).add(device.key);
  }
  try {
    pick.callback(device ? device.id : '');
  } catch {
    // the page went away
  }
  if (!w.chromeView.webContents.isDestroyed()) w.chromeView.webContents.send('device-picker', null);
}

function watchDevices(ses) {
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const devices = details.deviceList.map((d) => ({ id: d.deviceId, name: d.name || `Device ${d.vendorId}:${d.productId}`, key: deviceKey(d) }));
    showDeviceChooser(details.frame ? webContents.fromFrame(details.frame) : null, 'hid', devices, callback);
  });
  ses.on('select-serial-port', (event, portList, wc, callback) => {
    event.preventDefault();
    const devices = portList.map((p) => ({ id: p.portId, name: p.displayName || p.portName, key: deviceKey(p) }));
    showDeviceChooser(wc, 'serial', devices, callback);
  });
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const devices = details.deviceList.map((d) => ({ id: d.deviceId, name: [d.manufacturerName, d.productName].filter(Boolean).join(' ') || `USB device ${d.vendorId}:${d.productId}`, key: deviceKey(d) }));
    showDeviceChooser(details.frame ? webContents.fromFrame(details.frame) : null, 'usb', devices, callback);
  });
  ses.setDevicePermissionHandler((details) => {
    const keys = grantedDevices.get(originOf(details.origin));
    return !!keys && keys.has(deviceKey(details.device));
  });
}

function configureSession(ses) {
  ses.setCertificateVerifyProc(onVerifyCertificate);
  watchDevices(ses);
  applyProxy(ses);
  // Present as plain Chrome (sites such as Google sign-in reject the Electron token), with the
  // user's languages.
  applyLanguages(ses);
  ses.setPermissionRequestHandler(onPermissionRequest);
  ses.setPermissionCheckHandler(onPermissionCheck);
  ses.on('will-download', onWillDownload);
  // Global Privacy Control: asks sites not to sell or share the user's data.
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    if (store.data.settings.gpc) details.requestHeaders['Sec-GPC'] = '1';
    if (details.resourceType === 'mainFrame' && details.method === 'POST') rememberPostType(details);
    callback({ requestHeaders: details.requestHeaders });
  });
  // Our picker in the toolbar view lets the user share a single Operecs tab, a window, or a screen.
  ses.setDisplayMediaRequestHandler(onDisplayMediaRequest, { useSystemPicker: false });
  ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'capture-preload.js') });
  adblock.attach(ses);
}

async function captureTabPreview(tab) {
  if (!tab || tab.pending || tab.wc.isDestroyed() || !tab.view.getVisible() || !isWeb(tab.wc.getURL())) return;
  try {
    const img = await tab.wc.capturePage();
    if (!img.isEmpty() && !tab.wc.isDestroyed()) {
      tab.preview = img.resize({ width: 240, quality: 'good' }).toDataURL();
    }
  } catch {
    // ignore capture error
  }
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
    preview: '', // thumbnail data: URL for tab hover preview
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
    groupId: (history && history.groupId) || (after && after.groupId) || null,
    workspace: (history && history.workspace) || (after && after.workspace) || w.activeWorkspace || 'Default',
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
    const custom = resolveProtocolUrl(e.url);
    if (custom) {
      e.preventDefault();
      if (e.isMainFrame) wc.loadURL(custom).catch(() => {});
      else createTab(tab.w, custom, { after: tab });
    }
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
    if (tab.id === tab.w.activeId || tab.id === tab.w.splitId) showStatus(tab.w, url);
  });
  wc.on('did-start-loading', () => sendTabs(tab.w));
  wc.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    const devices = deviceList.map((d) => ({ id: d.deviceId, name: d.deviceName || 'Unnamed device', key: d.deviceId }));
    showDeviceChooser(wc, 'bluetooth', devices, callback);
  });
  wc.on('media-started-playing', () => setMediaState(tab, 'playing'));
  wc.on('media-paused', () => setMediaState(tab, 'paused'));
  wc.on('did-stop-loading', () => {
    sendTabs(tab.w);
    checkReaderable(tab);
    setTimeout(() => captureTabPreview(tab), 350);
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      tab.blocked = 0;
      tab.blockedHosts.clear();
      tab.readerable = false;
      tab.mixedContent = false;
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
    if (input.type === 'mouseDown' && tab.w.splitId === tab.id && tab.w.activeId !== tab.id) {
      selectTab(tab.w, tab.id);
    }
  });
  wc.on('did-navigate', (_e, u) => {
    if (isWeb(u)) tab.httpsUpgrade = null;
    tab.capture.clear();
    applySiteZoom(tab);
    if (siteMuted(u)) tab.wc.setAudioMuted(true);
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
    if (tab.heldForm === failedUrl) {
      // an insecure form we stopped to ask about: Chromium shows its blocked page, so go back to
      // the form (fields usually keep what was typed)
      tab.heldForm = null;
      if (tab.wc.getURL() === failedUrl && tab.wc.navigationHistory.canGoBack()) tab.wc.navigationHistory.goBack();
      return;
    }
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
// Bookmarks keep a 32px copy of their site's icon (bookmarks bar, menu, manager, new tab).
function rememberBookmarkIcon(tab) {
  if (tab.w.private || !tab.favicon) return;
  const url = tab.wc.getURL();
  const img = nativeImage.createFromDataURL(tab.favicon);
  // formats Electron can't decode here (.ico) are kept as they are when small; <img> shows them
  const small = !img.isEmpty() ? img.resize({ width: 32, height: 32, quality: 'best' }).toDataURL() : tab.favicon.length < 24000 ? tab.favicon : '';
  if (!small) return;
  // the site's icon for new tab tiles, once per site per run
  const site = siteOf(url);
  if (site && !siteIconsSaved.has(site)) {
    siteIconsSaved.add(site);
    historyDb.setSiteIcon(site, small);
  }
  if (bookmarks.findByUrl(url)) bookmarks.setIcon(url, small);
}
const siteIconsSaved = new Set();

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
    rememberBookmarkIcon(tab);
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
  if (!tab.pinned && tab.workspace && tab.workspace !== w.activeWorkspace) {
    w.activeWorkspace = tab.workspace;
    w.splitId = null;
    w.splitOrder = null;
  }
  if (tab.groupId) {
    const grp = (w.groups || []).find((g) => g.id === tab.groupId);
    if (grp && grp.collapsed) grp.collapsed = false;
  }
  hideAutofill(w);
  if (w.activeId !== id) {
    const previous = activeTab(w);
    if (previous) {
      previous.lastShown = Date.now();
      captureTabPreview(previous);
    }
    exitFullscreen(previous);
    w.statusText = '';
    if (w.splitId) {
      if (id === w.splitId) {
        w.splitId = w.activeId;
      } else if (w.splitOrder) {
        w.splitOrder = w.splitOrder.map((x) => (x === w.activeId ? id : x));
      }
    }
  }
  w.activeId = id;
  if (tab.pending) {
    const history = tab.pending;
    tab.pending = null;
    tab.wc.navigationHistory.restore(history).catch(() => tab.wc.loadURL(history.entries[history.index].url).catch(() => {}));
  }
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
  if (w.splitId === tab.id) {
    w.splitId = null;
    w.splitOrder = null;
  } else if (tab.id === w.activeId && w.splitId) {
    const promote = w.splitId;
    w.splitId = null;
    w.splitOrder = null;
    w.activeId = promote;
  }
  // Drop empty tab groups
  if (tab.groupId && !w.tabs.some((t) => t.groupId === tab.groupId)) {
    w.groups = (w.groups || []).filter((g) => g.id !== tab.groupId);
  }
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
  const vis = visibleTabs(w);
  if (vis.length === 0) {
    createTab(w, internalURL('newtab'));
    return;
  }
  if (!getTab(w, w.activeId) || !vis.some((t) => t.id === w.activeId)) {
    selectTab(w, vis[Math.min(idx, vis.length - 1)].id);
  } else {
    layout(w);
    sendTabs(w);
  }
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
  if (pinned) tab.groupId = null;
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

// "Mute Site": every tab of the site, now and whenever it's opened later.
const siteMuted = (url) => {
  const site = siteOf(url);
  return !!site && (store.data.settings.mutedSites || []).includes(site);
};
function toggleSiteMute(tab) {
  const site = siteOf(tab.wc.getURL());
  if (!site) return;
  const list = new Set(store.data.settings.mutedSites || []);
  const mute = !list.has(site);
  if (mute) list.add(site);
  else list.delete(site);
  store.data.settings.mutedSites = [...list];
  store.save();
  for (const t of allTabs()) if (!t.wc.isDestroyed() && siteOf(t.wc.getURL()) === site) t.wc.setAudioMuted(mute);
  sendAll();
}

// Takes the tab out of its window without closing its page.
function detachTab(tab) {
  const { w } = tab;
  const idx = w.tabs.indexOf(tab);
  w.tabs.splice(idx, 1);
  w.multi.delete(tab.id);
  if (w.splitId === tab.id) {
    w.splitId = null;
    w.splitOrder = null;
  }
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
    tab.groupId = null;
    tab.workspace = target.activeWorkspace || 'Default';
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
  tab.groupId = null;
  tab.workspace = w.activeWorkspace || 'Default';
  w.tabs.splice(Math.max(0, Math.min(index, w.tabs.length)), 0, tab);
  w.win.contentView.addChildView(tab.view);
  if (extensions && !w.private) extensions.addTab(tab.wc, w.win);
  normalizeOrder(w);
  layout(w);
  selectTab(w, tab.id);
  w.win.focus();
  saveSession();
}

// ---------------------------------------------------------------- tab groups, split view & workspaces

let nextGroupId = 1;
function createTabGroup(w, tabs, name) {
  w.groups ||= [];
  const colorKeys = Object.keys(GROUP_COLORS);
  const color = colorKeys[w.groups.length % colorKeys.length];
  const id = `g-${Date.now().toString(36)}-${nextGroupId++}`;
  const group = { id, name: name || `Group ${w.groups.length + 1}`, color, collapsed: false };
  w.groups.push(group);
  for (const t of tabs) {
    if (!t.pinned) t.groupId = id;
  }
  sendTabs(w);
  saveSession();
  return group;
}

function setTabGroup(w, tabs, groupId) {
  for (const t of tabs) {
    if (!t.pinned) t.groupId = groupId || null;
  }
  w.groups = (w.groups || []).filter((g) => w.tabs.some((t) => t.groupId === g.id));
  sendTabs(w);
  saveSession();
}

function toggleTabGroup(w, groupId) {
  const grp = (w.groups || []).find((g) => g.id === groupId);
  if (!grp) return;
  grp.collapsed = !grp.collapsed;
  // If collapsing the group containing the active tab, switch to a non-collapsed tab if available
  const active = activeTab(w);
  if (grp.collapsed && active && active.groupId === groupId) {
    const other = visibleTabs(w).find((t) => t.groupId !== groupId);
    if (other) return selectTab(w, other.id);
  }
  sendTabs(w);
  saveSession();
}

function updateTabGroup(w, groupId, changes = {}) {
  const grp = (w.groups || []).find((g) => g.id === groupId);
  if (!grp) return;
  if (typeof changes.name === 'string' && changes.name.trim()) grp.name = changes.name.trim().slice(0, 32);
  if (changes.color && GROUP_COLORS[changes.color]) grp.color = changes.color;
  if (typeof changes.collapsed === 'boolean') grp.collapsed = changes.collapsed;
  sendTabs(w);
  saveSession();
}

function showGroupMenu(w, groupId) {
  const grp = (w.groups || []).find((g) => g.id === groupId);
  if (!grp) return;
  const colorNames = { violet: 'Violet', blue: 'Blue', emerald: 'Emerald', amber: 'Amber', rose: 'Rose', cyan: 'Cyan' };
  Menu.buildFromTemplate([
    {
      label: 'Rename Group…',
      click: () => w.chromeView.webContents.send('group:rename', { id: grp.id, name: grp.name }),
    },
    {
      label: grp.collapsed ? 'Expand Group' : 'Collapse Group',
      click: () => toggleTabGroup(w, grp.id),
    },
    {
      label: 'Color',
      submenu: Object.entries(colorNames).map(([key, label]) => ({
        label,
        type: 'checkbox',
        checked: grp.color === key,
        click: () => updateTabGroup(w, grp.id, { color: key }),
      })),
    },
    { type: 'separator' },
    {
      label: 'New Tab in Group',
      click: () => {
        const groupTabs = w.tabs.filter((t) => t.groupId === grp.id);
        const last = groupTabs[groupTabs.length - 1];
        const t = createTab(w, internalURL('newtab'), { after: last });
        t.groupId = grp.id;
        grp.collapsed = false;
        sendTabs(w);
        saveSession();
      },
    },
    {
      label: 'Ungroup Tabs',
      click: () => setTabGroup(w, w.tabs.filter((t) => t.groupId === grp.id), null),
    },
    {
      label: 'Close Group',
      click: () => closeTabs(w, (t) => t.groupId !== grp.id),
    },
  ]).popup({ window: w.win });
}

function toggleSplitView(w, partnerId = null) {
  if (!w) return;
  if (w.splitId && (!partnerId || partnerId === w.splitId || partnerId === w.activeId)) {
    w.splitId = null;
    w.splitOrder = null;
    layout(w);
    sendTabs(w);
    return;
  }
  const partner = partnerId
    ? getTab(w, partnerId)
    : visibleTabs(w).find((t) => t.id !== w.activeId) || createTab(w, internalURL('newtab'), { background: true });
  if (!partner || partner.id === w.activeId) return;
  w.splitId = partner.id;
  w.splitOrder = [w.activeId, partner.id];
  if (partner.pending) {
    const h = partner.pending;
    partner.pending = null;
    partner.wc.navigationHistory.restore(h).catch(() => partner.wc.loadURL(h.entries[h.index].url).catch(() => {}));
  }
  layout(w);
  sendTabs(w);
}

function switchWorkspace(w, name) {
  if (!w || !name) return;
  if (!w.workspaces.includes(name)) w.workspaces.push(name);
  w.activeWorkspace = name;
  w.splitId = null;
  w.splitOrder = null;
  const vis = visibleTabs(w);
  const nonPinned = vis.filter((t) => !t.pinned);
  if (nonPinned.length) {
    selectTab(w, nonPinned[nonPinned.length - 1].id);
  } else {
    createTab(w, internalURL('newtab'));
  }
  sendTabs(w);
  saveSession();
}

function showWorkspaceMenu(w) {
  w.workspaces ||= ['Default', 'Work', 'Personal'];
  const presets = ['Default', 'Work', 'Personal', 'Research', 'School', 'Shopping'];
  const nextName = presets.find((p) => !w.workspaces.includes(p)) || `Workspace ${w.workspaces.length + 1}`;
  Menu.buildFromTemplate([
    ...w.workspaces.map((ws) => {
      const count = w.tabs.filter((t) => !t.pinned && (t.workspace || 'Default') === ws).length;
      return {
        label: `${ws} (${count} tab${count === 1 ? '' : 's'})`,
        type: 'checkbox',
        checked: (w.activeWorkspace || 'Default') === ws,
        click: () => switchWorkspace(w, ws),
      };
    }),
    { type: 'separator' },
    {
      label: `New Workspace (“${nextName}”)`,
      click: () => switchWorkspace(w, nextName),
    },
    ...(w.workspaces.length > 1 && w.activeWorkspace !== 'Default'
      ? [
          {
            label: `Close Workspace “${w.activeWorkspace}”`,
            click: () => {
              const old = w.activeWorkspace;
              for (const t of w.tabs) if (t.workspace === old) t.workspace = 'Default';
              w.workspaces = w.workspaces.filter((x) => x !== old);
              switchWorkspace(w, 'Default');
            },
          },
        ]
      : []),
  ]).popup({ window: w.win });
}

// Tabs whose page would warn about unsaved changes (capture-preload.js answers for each frame).
const UNLOAD_CHECK = `(() => { const f = window[Symbol.for('operecs.wouldWarnOnUnload')]; return typeof f === 'function' ? f() === true : false; })()`;
async function unsavedTabs(tabs) {
  const results = await Promise.all(
    tabs
      .filter((t) => !t.pending && !t.wc.isDestroyed() && isWeb(t.wc.getURL()))
      .map(async (t) => {
        for (const frame of t.wc.mainFrame.framesInSubtree) {
          try {
            const warn = await Promise.race([frame.executeJavaScript(UNLOAD_CHECK), new Promise((r) => setTimeout(() => r(false), 800))]);
            if (warn === true) return t;
          } catch {
            // frame went away
          }
        }
        return null;
      }),
  );
  return results.filter(Boolean);
}

// "Leave site?" for a window close or quit; Cancel shows the first tab with changes.
async function confirmUnsaved(parent, dirty, action) {
  const names = dirty.slice(0, 5).map((t) => `\u2022 ${trimLabel(t.wc.getTitle() || displayUrl(t.wc.getURL()), 60)}`);
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    message: 'Leave site?',
    detail: `Changes you made may not be saved in:\n${names.join('\n')}${dirty.length > 5 ? '\n\u2026' : ''}`,
    buttons: [action, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) return true;
  const first = dirty[0];
  if (liveWindow(first.w)) {
    selectTab(first.w, first.id);
    first.w.win.focus();
  }
  return false;
}

function closeTabs(w, keep) {
  for (const t of w.tabs.filter((x) => !keep(x))) closeTab(w, t.id);
}

function groupSubmenuForTabs(w, tabs) {
  const unpinned = tabs.filter((t) => !t.pinned);
  if (!unpinned.length) return [];
  const existing = (w.groups || []).map((g) => ({
    label: g.name,
    type: 'checkbox',
    checked: unpinned.every((t) => t.groupId === g.id),
    click: () => setTabGroup(w, unpinned, g.id),
  }));
  return [
    {
      label: 'Tab Group',
      submenu: [
        { label: 'New Group', click: () => createTabGroup(w, unpinned) },
        ...(existing.length ? [{ type: 'separator' }, ...existing] : []),
        ...(unpinned.some((t) => t.groupId) ? [{ type: 'separator' }, { label: 'Remove from Group', click: () => setTabGroup(w, unpinned, null) }] : []),
      ],
    },
  ];
}

function showSelectedTabsMenu(w, tabs) {
  const n = tabs.length;
  const allPinned = tabs.every((t) => t.pinned);
  const allMuted = tabs.every((t) => t.wc.isAudioMuted());
  Menu.buildFromTemplate([
    { label: `Reload ${n} Tabs`, click: () => tabs.forEach((t) => reloadTab(t)) },
    { label: `Duplicate ${n} Tabs`, click: () => tabs.forEach((t) => duplicateTab(t)) },
    { label: allPinned ? `Unpin ${n} Tabs` : `Pin ${n} Tabs`, click: () => tabs.forEach((t) => setPinned(t, !allPinned)) },
    ...groupSubmenuForTabs(w, tabs),
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
  const vis = visibleTabs(w);
  const idx = vis.indexOf(tab);
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
    { label: 'Reload', click: () => reloadTab(tab) },
    { label: 'Duplicate', click: () => duplicateTab(tab) },
    { label: tab.pinned ? 'Unpin' : 'Pin', click: () => setPinned(tab, !tab.pinned) },
    ...groupSubmenuForTabs(w, [tab]),
    {
      label: w.splitId === tab.id || (w.splitId && tab.id === w.activeId)
        ? 'Exit Split View'
        : tab.id === w.activeId
        ? 'Open Split View'
        : 'Split View with Active Tab',
      click: () => toggleSplitView(w, tab.id === w.activeId ? null : tab.id),
    },
    ...(w.workspaces && w.workspaces.length > 1 && !tab.pinned
      ? [
          {
            label: 'Move to Workspace',
            submenu: w.workspaces.map((ws) => ({
              label: ws,
              type: 'checkbox',
              checked: (tab.workspace || 'Default') === ws,
              click: () => {
                tab.workspace = ws;
                if (tab.id === w.activeId && ws !== w.activeWorkspace) {
                  const rem = visibleTabs(w);
                  if (rem.length) selectTab(w, rem[0].id);
                  else createTab(w, internalURL('newtab'));
                } else {
                  sendTabs(w);
                }
                saveSession();
              },
            })),
          },
        ]
      : []),
    { label: muted ? 'Unmute Tab' : 'Mute Tab', click: () => toggleMute(tab) },
    ...(siteOf(tab.wc.getURL()) ? [{ label: siteMuted(tab.wc.getURL()) ? `Unmute ${siteOf(tab.wc.getURL())}` : `Mute ${siteOf(tab.wc.getURL())}`, click: () => toggleSiteMute(tab) }] : []),
    { type: 'separator' },
    { label: 'Move to New Window', enabled: w.tabs.length > 1, click: () => moveTabToNewWindow(tab) },
    { type: 'separator' },
    { label: 'Close', click: () => closeTab(w, tab.id) },
    { label: 'Close Other Tabs', enabled: vis.length > 1, click: () => closeTabs(w, (t) => t === tab || t.pinned || !vis.includes(t)) },
    {
      label: 'Close Tabs to the Right',
      enabled: idx !== -1 && idx < vis.length - 1,
      click: () => closeTabs(w, (t) => !vis.includes(t) || vis.indexOf(t) <= vis.indexOf(tab) || t.pinned),
    },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', enabled: w.closedTabs.length > 0, click: () => reopenClosedTab(w) },
  ]).popup({ window: w.win });
}

function cycleTab(w, step) {
  const vis = visibleTabs(w);
  const idx = vis.findIndex((t) => t.id === w.activeId);
  if (idx === -1 || !vis.length) return;
  selectTab(w, vis[(idx + step + vis.length) % vis.length].id);
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
  if (!existing) rememberBookmarkIcon(tab);
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

// History from a Chromium-based browser: its `History` SQLite file next to `Bookmarks`. The
// browser keeps it locked while running, so we read a copy. Chrome stores times as
// microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET_MS = 11644473600000;
async function importHistory(source) {
  const src = importSources().find((c) => c.name === source);
  if (!src) return null;
  const file = path.join(path.dirname(src.file), 'History');
  if (!fs.existsSync(file)) return { count: 0, from: src.name };
  const copy = path.join(app.getPath('temp'), `operecs-history-import-${Date.now()}.sqlite`);
  await fs.promises.copyFile(file, copy);
  let rows = [];
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    rows = db
      .prepare(
        // visit_time is too large for a JS number; convert to Unix milliseconds in SQL
        `SELECT u.url AS url, u.title AS title, (v.visit_time / 1000) - ${CHROME_EPOCH_OFFSET_MS} AS time FROM visits v JOIN urls u ON v.url = u.id
         WHERE u.url LIKE 'http%' ORDER BY v.visit_time DESC LIMIT ${HISTORY_IMPORT_LIMIT}`,
      )
      .all();
    db.close();
  } finally {
    fs.promises.rm(copy, { force: true }).catch(() => {});
  }
  const count = historyDb.importVisits(rows.filter((r) => isWeb(r.url)).map((r) => ({ url: r.url, title: r.title || r.url, time: Number(r.time) })));
  rebuildMenuSoon();
  return { count, from: src.name };
}

// Everything worth keeping, as plain files: bookmarks (HTML, importable anywhere) and history,
// settings and site permissions (JSON).
async function exportAllData(w) {
  const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
    title: 'Choose a folder for your Operecs data',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('documents'),
  });
  if (canceled || !filePaths[0]) return null;
  const dir = path.join(filePaths[0], `Operecs data ${new Date().toISOString().slice(0, 10)}`);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'bookmarks.html'), bookmarks.exportHtml());
  await fs.promises.writeFile(
    path.join(dir, 'operecs-data.json'),
    JSON.stringify(
      {
        exported: new Date().toISOString(),
        version: app.getVersion(),
        history: historyDb.all(),
        settings: store.data.settings,
        permissions: store.data.permissions,
        adblockAllowlist: store.data.adblockAllowlist,
      },
      null,
      2,
    ),
  );
  shell.showItemInFolder(path.join(dir, 'bookmarks.html'));
  return dir;
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

// Settings → Clear browsing data → "Keep history for": drop older visits.
function pruneOldHistory() {
  const days = store.data.settings.historyKeepDays;
  if (days > 0) historyDb.removeBefore(Date.now() - days * 86400000);
}

function recordHistory(tab, url) {
  if (tab.w.private || !isWeb(url)) return;
  historyDb.addVisit(url, tab.wc.getTitle() || url);
  rebuildMenuSoon();
}

function updateHistoryTitle(tab) {
  if (tab.w.private) return;
  const url = tab.wc.getURL();
  if (!isWeb(url)) return;
  historyDb.updateTitle(url, tab.wc.getTitle() || url);
  rebuildMenuSoon();
}

// ---------------------------------------------------------------- session

// A tab's back/forward history, trimmed for storage. Error pages restore as their original URL.
function tabHistory(tab) {
  if (tab.pending) return { ...tab.pending, pinned: tab.pinned, groupId: tab.groupId || null, workspace: tab.workspace || 'Default' }; // restored but never opened
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
  return entries.length ? { entries, index, pinned: tab.pinned, groupId: tab.groupId || null, workspace: tab.workspace || 'Default' } : null;
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
      saved.push({
        tabs,
        active,
        bounds,
        maximized: w.win.isMaximized(),
        groups: w.groups || [],
        workspaces: w.workspaces || ['Default'],
        activeWorkspace: w.activeWorkspace || 'Default',
      });
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
  // Device APIs: allowed to ask; the device chooser is where the user decides.
  if (DEVICE_KINDS.has(permission)) return !!tabOfWc(wc) && /^https:/i.test(String(requestingOrigin));
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
    if (p.kind === 'save-address') {
      if (decision === 'allow') saveAddress(p.address);
      layout(w);
      sendTabs(w);
      return;
    }
    if (p.kind === 'protocol-handler') {
      if (decision === 'allow' && !w.private) {
        (store.data.settings.protocolHandlers ||= {})[p.scheme] = { url: p.handlerUrl, host: new URL(p.origin).host };
        store.save();
      }
      layout(w);
      sendTabs(w);
      return;
    }
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
  hideAutofill(tab.w);
  if (tab.prompts.length === 0) return;
  // "Save this address?" is offered as the form submits, so it must outlive that one navigation
  const keep = tab.prompts.filter((p) => p.keepOnce);
  for (const p of tab.prompts.filter((x) => !x.keepOnce)) for (const cb of p.callbacks) cb(false);
  for (const p of keep) p.keepOnce = false;
  tab.prompts = keep;
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
  const tabSources = allTabs()
    .filter((t) => !t.pending && !t.wc.isDestroyed() && isWeb(t.wc.getURL()))
    .map((t) => ({
      id: `tab:${t.id}`,
      name: t.wc.getTitle() || displayUrl(t.wc.getURL()) || 'Tab',
      kind: 'tab',
      thumbnail: t.preview || t.favicon || '',
      isTab: true,
      wc: t.wc,
    }));
  w.screenPick = {
    id: nextPickId++,
    tab,
    callback,
    sources: new Map([...tabSources.map((s) => [s.id, s]), ...sources.map((s) => [s.id, s])]),
  };
  selectTab(w, tab.id);
  w.chromeView.webContents.send('screen-picker', {
    id: w.screenPick.id,
    site: siteOf(request.securityOrigin) || request.securityOrigin,
    sources: [
      ...tabSources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, thumbnail: s.thumbnail })),
      ...sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      })),
    ],
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
    if (source && source.isTab) {
      pick.callback(!source.wc.isDestroyed() ? { video: source.wc.mainFrame } : null);
    } else {
      pick.callback(source ? { video: source } : null);
    }
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
    tab.id !== w.splitId &&
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
  if (!store) return;
  // Energy saver: on battery, idle tabs sleep after 10 minutes (even with memory saver off).
  const onBattery = store.data.settings.energySaver && app.isReady() && require('electron').powerMonitor.isOnBatteryPower();
  if (!store.data.settings.memorySaver && !onBattery) return;
  let limit = store.data.settings.memorySaver ? (store.data.settings.memorySaverMinutes || 30) * 60000 : Infinity;
  if (onBattery) limit = Math.min(limit, 10 * 60000);
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
// ---------------------------------------------------------------- form resubmission

// Reloading a page that was the result of a form (POST): Chromium asks the embedder to confirm
// and Electron silently cancels, so Reload did nothing. We remember the form data of each tab's
// last main-frame POST and, after "Resubmit?", send it again.
// ---------------------------------------------------------------- address autofill

// Saved addresses fill forms through capture-preload.js. The list under a focused field is a
// small browser view (ui/autofill.html) above the page, so the page can't read the addresses.
const ADDRESS_FIELDS = ['name', 'organization', 'street', 'street2', 'city', 'region', 'postal', 'country', 'email', 'phone'];
let nextAddressId = 1;

function cleanAddress(a) {
  const out = {};
  for (const k of ADDRESS_FIELDS) out[k] = typeof a?.[k] === 'string' ? a[k].trim().slice(0, 200) : '';
  return out;
}
const sameAddress = (a, b) => ['name', 'street', 'email', 'phone'].every((k) => (a[k] || '').toLowerCase() === (b[k] || '').toLowerCase());

function saveAddress(a) {
  const clean = cleanAddress(a);
  if (!clean.name) return;
  const list = (store.data.addresses ||= []);
  if (list.some((x) => sameAddress(x, clean))) return;
  nextAddressId = Math.max(nextAddressId, ...list.map((x) => x.id + 1));
  list.push({ id: nextAddressId++, ...clean });
  store.save();
  announceAutofill();
}

// Tell open pages whether there's anything to fill (they only report focus when there is).
function announceAutofill() {
  const available = !!(store.data.addresses && store.data.addresses.length);
  for (const t of allTabs()) if (!t.wc.isDestroyed()) t.wc.send('autofill:available', available);
}

function autofillView(w) {
  if (w.autofillView) return w.autofillView;
  const view = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  view.setBackgroundColor('#00000000');
  view.setVisible(false);
  view.webContents.loadURL(`${SCHEME}://ui/autofill.html`);
  view.webContents.on('will-navigate', (e) => e.preventDefault());
  w.autofillView = view;
  w.win.contentView.addChildView(view);
  return view;
}

function showAutofill(tab, { type, rect }) {
  const w = tab.w;
  const list = store.data.addresses || [];
  if (!list.length || tab.id !== w.activeId || !liveWindow(w)) return;
  clearTimeout(w.autofillHideTimer);
  const view = autofillView(w);
  const detail = (a) => ({ email: a.email, tel: a.phone, postal: a.postal, city: a.city, organization: a.organization }[type] || [a.street, a.city].filter(Boolean).join(', ') || a.email);
  const items = list.slice(0, 6).map((a) => ({ id: a.id, label: a.name, detail: detail(a) || '' }));
  const [width, height] = w.win.getContentSize();
  const top = chromeHeight(w);
  const h = items.length * 46 + 46;
  let x = Math.round(PAGE_INSET + rect.x);
  let y = Math.round(top + rect.y + rect.height + 4);
  if (y + h > height) y = Math.max(top, Math.round(top + rect.y - h - 4)); // no room below: above the field
  x = Math.max(0, Math.min(x, width - 320));
  view.setBounds({ x, y, width: 320, height: h });
  const payload = { tabId: tab.id, items };
  if (view.webContents.isLoading()) view.webContents.once('did-finish-load', () => view.webContents.send('autofill:list', payload));
  else view.webContents.send('autofill:list', payload);
  w.win.contentView.addChildView(view); // above the page
  view.setVisible(true);
  w.autofillTab = tab;
}

function hideAutofill(w, delay = 0) {
  if (!w || !w.autofillView) return;
  clearTimeout(w.autofillHideTimer);
  const hide = () => {
    if (w.autofillView && !w.autofillView.webContents.isDestroyed()) w.autofillView.setVisible(false);
  };
  if (delay) w.autofillHideTimer = setTimeout(hide, delay);
  else hide();
}

// ---------------------------------------------------------------- tracking parameters

// Common click-tracking parameters, removed from addresses you open (Brave and Firefox do this).
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid', 'yclid', 'twclid', 'ttclid', 'li_fat_id', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'mkt_tok', 'oly_anon_id', 'oly_enc_id', 'vero_id', 'vero_conv', 'wickedid', 'ref_src', 'srsltid', 'epik', 'rb_clickid', 's_cid', 'ss_campaign_id', '_openstat']);
const isTrackingParam = (name) => TRACKING_PARAMS.has(name.toLowerCase()) || /^utm_/i.test(name);

function stripTrackingParams(details) {
  if (!store.data.settings.stripTracking || details.resourceType !== 'mainFrame' || details.method !== 'GET' || !isWeb(details.url)) return null;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }
  const names = [...url.searchParams.keys()].filter(isTrackingParam);
  if (!names.length) return null;
  for (const n of names) url.searchParams.delete(n);
  return { redirectURL: url.href };
}

// ---------------------------------------------------------------- mixed content / insecure forms

// A secure (https) page loading something over plain http. Chromium upgrades or blocks most of
// it; what still goes out unencrypted marks the page "not fully secure".
function noteMixedContent(details) {
  if (details.resourceType === 'mainFrame' || !details.webContentsId || !/^http:/i.test(details.url)) return;
  let host;
  try {
    host = new URL(details.url).hostname;
  } catch {
    return;
  }
  if (localHost(host)) return;
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === details.webContentsId);
  if (!tab || tab.mixedContent || !/^https:/i.test(tab.wc.getURL())) return;
  tab.mixedContent = true;
  if (tab.id === tab.w.activeId) sendTabs(tab.w);
}

// A form on an https page sending its data over plain http. With HTTPS-Only on, the request is
// upgraded instead (upgradeToHttps). Otherwise: stop it and ask; "Send Anyway" re-sends it.
const insecureFormsAllowed = new Set();
function checkInsecureForm(details) {
  if (details.resourceType !== 'mainFrame' || details.method !== 'POST' || !/^http:/i.test(details.url)) return null;
  if (store.data.settings.httpsOnly) return null;
  let target;
  try {
    target = new URL(details.url);
  } catch {
    return null;
  }
  if (localHost(target.hostname)) return null;
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === details.webContentsId);
  if (!tab || !/^https:/i.test(tab.wc.getURL())) return null;
  if (insecureFormsAllowed.delete(details.url)) return null;
  tab.heldForm = details.url;
  const data = (details.uploadData || []).map((part) => (part.bytes ? { type: 'rawData', bytes: part.bytes } : part.file ? { type: 'file', filePath: part.file } : null)).filter(Boolean);
  // the body of a multipart form starts with its boundary line
  const first = data[0] && data[0].bytes ? Buffer.from(data[0].bytes).subarray(0, 200).toString('latin1') : '';
  const boundary = first.startsWith('--') ? first.slice(2).split(/\r?\n/)[0] : null;
  const contentType = boundary ? `multipart/form-data; boundary=${boundary}` : 'application/x-www-form-urlencoded';
  setImmediate(async () => {
    const { response } = await dialog.showMessageBox(tab.w.win, {
      type: 'warning',
      message: 'This form is not secure',
      detail: `The information you entered would be sent to ${target.host} without encryption, so others on your network could see or change it.`,
      buttons: ['Go Back', 'Send Anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1 || tab.wc.isDestroyed()) return;
    insecureFormsAllowed.add(details.url);
    tab.wc.loadURL(details.url, { postData: data, extraHeaders: `Content-Type: ${contentType}` }).catch(() => {});
  });
  return { cancel: true };
}

function rememberMainFrameRequest(details) {
  if (details.resourceType !== 'mainFrame' || !details.webContentsId) return;
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === details.webContentsId);
  if (!tab) return;
  if (details.method !== 'POST') {
    tab.lastPost = null;
    return;
  }
  const data = (details.uploadData || [])
    .map((part) => (part.bytes ? { type: 'rawData', bytes: part.bytes } : part.file ? { type: 'file', filePath: part.file } : null))
    .filter(Boolean);
  tab.lastPost = { url: details.url, data, contentType: tab.lastPost && tab.lastPost.url === details.url ? tab.lastPost.contentType : null };
}

function rememberPostType(details) {
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === details.webContentsId);
  if (!tab || !tab.lastPost || tab.lastPost.url !== details.url) return;
  const type = Object.entries(details.requestHeaders).find(([k]) => k.toLowerCase() === 'content-type');
  tab.lastPost.contentType = type ? type[1] : null;
}

// Every Reload (toolbar, menu, keyboard, context menu) goes through here.
async function reloadTab(tab, { ignoreCache = false } = {}) {
  if (!tab || tab.pending || tab.wc.isDestroyed()) return;
  const post = tab.lastPost;
  if (!post || tab.wc.getURL() !== post.url) {
    return ignoreCache ? tab.wc.reloadIgnoringCache() : tab.wc.reload();
  }
  const { response } = await dialog.showMessageBox(tab.w.win, {
    type: 'warning',
    message: 'Resubmit the form?',
    detail: 'This page was the result of a form you sent. Reloading sends it again, which could repeat an action such as a purchase or a post.',
    buttons: ['Resubmit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0 || tab.wc.isDestroyed()) return;
  tab.wc
    .loadURL(post.url, {
      postData: post.data,
      extraHeaders: post.contentType ? `Content-Type: ${post.contentType}` : undefined,
    })
    .catch(() => {});
}

function upgradeToHttps(details) {
  if (!store.data.settings.httpsOnly || details.resourceType !== 'mainFrame' || !/^http:\/\//i.test(details.url)) return null;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }
  if (localHost(url.hostname) || httpsExceptions.has(url.host)) return null;
  if (url.hostname === 'neverssl.com') return null; // used on purpose to reach Wi-Fi sign-in pages
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

// Privacy stats for the new tab page: ads and trackers blocked since `since`.
let statsSaveTimer = null;
function countBlocked() {
  const stats = (store.data.stats ||= { blocked: 0, since: Date.now() });
  stats.blocked++;
  if (!statsSaveTimer) statsSaveTimer = setTimeout(() => {
    statsSaveTimer = null;
    store.save();
  }, 5000);
}

function onBlocked(webContentsId, url) {
  const tab = allTabs().find((t) => !t.wc.isDestroyed() && t.wc.id === webContentsId);
  if (!tab) return;
  tab.blocked++;
  if (!tab.w.private) countBlocked();
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
      { label: 'Paste as Plain Text', enabled: f.canPaste, click: () => wc.pasteAndMatchStyle() },
      { label: 'Select All', enabled: f.canSelectAll, click: () => wc.selectAll() },
    ]);
    if (isMac || process.platform === 'win32') groups.push([{ label: 'Emoji & Symbols', click: () => app.showEmojiPanel() }]);
    if (isMac && params.selectionText.trim()) groups.push(macTextItems(wc, params));
  } else if (params.selectionText.trim()) {
    groups.push([
      { label: 'Copy', click: () => wc.copy() },
      {
        label: `Search ${searchEngine().name} for “${trimLabel(params.selectionText)}”`,
        click: () => createTab(w, searchUrl(params.selectionText.trim()), { after: tab }),
      },
    ]);
    if (isMac) groups.push(macTextItems(wc, params));
  }
  if (groups.length === 0) {
    groups.push([
      { label: 'Back', enabled: canGo(wc, 'back'), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: canGo(wc, 'forward'), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => reloadTab(tab) },
    ]);
    groups.push([
      { label: 'Print…', click: () => printTab(tab) },
      ...(isMac && isWeb(wc.getURL()) ? [{ label: 'Share…', click: () => sharePage(w, tab) }] : []),
      ...(isWeb(wc.getURL())
        ? [
            {
              label: 'Take Screenshot',
              submenu: [
                { label: 'Capture Visible Page', click: () => takeScreenshot(w, 'visible') },
                { label: 'Capture Selection…', click: () => takeScreenshot(w, 'selection') },
                { label: 'Capture Full Page', click: () => takeScreenshot(w, 'full') },
              ],
            },
            { label: 'Read Page Aloud', click: () => toggleReadAloud(w) },
            { label: 'Translate Page', click: () => toggleTranslatePage(w) },
            { label: 'View Page Source', click: () => createTab(w, `view-source:${wc.getURL()}`, { after: tab }) },
          ]
        : []),
    ]);
  }
  const extensionItems = extensions && !w.private ? extensions.getContextMenuItems(wc, params) : [];
  if (extensionItems.length) groups.push(extensionItems);
  groups.push([{ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) }]);

  const template = groups.flatMap((g, i) => (i ? [{ type: 'separator' }, ...g] : g));
  Menu.buildFromTemplate(template).popup({ window: w.win });
}

// macOS: Look Up (dictionary panel) and Speech for selected text, as in Safari and Chrome.
function macTextItems(wc, params) {
  return [
    { label: `Look Up “${trimLabel(params.selectionText, 20)}”`, click: () => wc.showDefinitionForSelection() },
    { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
  ];
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

// ---------------------------------------------------------------- screenshots, speech, translate & web apps

async function saveScreenshotImage(w, img) {
  if (!img || img.isEmpty()) return;
  try {
    clipboard.writeImage(img);
  } catch {
    // ignore clipboard failure
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = uniqueDownloadPath(`Screenshot-${stamp}.png`);
  await fs.promises.writeFile(outPath, img.toPNG());
  if (liveWindow(w)) {
    showStatus(w, 'Screenshot saved to Downloads & copied');
    setTimeout(() => {
      if (w.statusText === 'Screenshot saved to Downloads & copied') showStatus(w, '');
    }, 3000);
  }
}

async function captureFullPage(tab) {
  const wc = tab.wc;
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attached = true;
    }
    const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
    });
    if (!data) return null;
    return nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  } catch {
    return wc.capturePage();
  } finally {
    if (attached && !wc.isDestroyed() && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach();
      } catch {
        // ignore
      }
    }
  }
}

async function takeScreenshot(w, mode = 'visible') {
  const tab = activeTab(w);
  if (!tab || tab.pending || tab.wc.isDestroyed()) return;
  if (mode === 'selection') {
    if (isWeb(tab.wc.getURL())) tab.wc.mainFrame.send('screenshot:select-start');
    else {
      const img = await tab.wc.capturePage();
      await saveScreenshotImage(w, img);
    }
    return;
  }
  if (mode === 'full') {
    const img = await captureFullPage(tab);
    await saveScreenshotImage(w, img);
    return;
  }
  const img = await tab.wc.capturePage();
  await saveScreenshotImage(w, img);
}

function toggleReadAloud(w) {
  const tab = activeTab(w);
  if (!tab || tab.pending || tab.wc.isDestroyed()) return;
  const url = tab.wc.getURL();
  if (internalName(url) === 'reader') {
    tab.wc.executeJavaScript('window.__toggleReaderSpeech && window.__toggleReaderSpeech()', true).catch(() => {});
    return;
  }
  if (isWeb(url)) tab.wc.mainFrame.send('speech:toggle');
}

function toggleTranslatePage(w) {
  const tab = activeTab(w);
  if (!tab || tab.pending || tab.wc.isDestroyed() || !isWeb(tab.wc.getURL())) return;
  const lang = store.data.settings.languages && store.data.settings.languages[0] ? store.data.settings.languages[0].split('-')[0] : 'en';
  tab.wc.mainFrame.send('translate:toggle', lang || 'en');
}

let translateSession = null;
async function translateTexts(texts, targetLang = 'en') {
  if (!Array.isArray(texts) || !texts.length) return [];
  translateSession ||= session.fromPartition('operecs-translate');
  const tl = String(targetLang || 'en').replace(/[^a-zA-Z-]/g, '') || 'en';
  const sep = '\n[[[OPSEP]]]\n';
  const joined = texts.map((x) => String(x || '').slice(0, 500)).join(sep);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(joined)}`;
    const res = await translateSession.fetch(u, { credentials: 'omit', signal: controller.signal });
    if (!res.ok) return texts;
    const data = await res.json();
    const full = Array.isArray(data?.[0]) ? data[0].map((part) => (Array.isArray(part) ? part[0] || '' : '')).join('') : '';
    if (!full) return texts;
    const parts = full.split(/\s*\[\[\[OPSEP\]\]\]\s*/);
    return texts.map((orig, i) => (parts[i] !== undefined && parts[i].trim() ? parts[i] : orig));
  } catch {
    return texts;
  } finally {
    clearTimeout(timer);
  }
}

function createAppWindow(url, title) {
  if (!isWeb(url)) return null;
  const appWin = new BaseWindow({
    width: 1120,
    height: 780,
    minWidth: 420,
    minHeight: 320,
    title: title || displayUrl(url) || DISPLAY_NAME,
    backgroundColor: '#121217',
    icon: WIN_ICON,
  });
  const view = new WebContentsView({
    webPreferences: {
      preload: CAPTURE_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: session.defaultSession,
    },
  });
  appWin.contentView.addChildView(view);
  const resize = () => {
    if (appWin.isDestroyed()) return;
    const [width, height] = appWin.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  resize();
  appWin.on('resize', resize);
  appWin.on('closed', () => {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  view.webContents.on('page-title-updated', (_e, t) => {
    if (!appWin.isDestroyed() && t) appWin.setTitle(t);
  });
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isWeb(target)) openFromOutside(target);
    return { action: 'deny' };
  });
  view.webContents.loadURL(url).catch(() => {});
  return appWin;
}

function installSiteAsApp(w) {
  const tab = activeTab(w);
  if (!tab || tab.pending || tab.wc.isDestroyed()) return;
  const url = tab.wc.getURL();
  if (!isWeb(url)) return;
  const origin = originOf(url);
  const title = (tab.wc.getTitle() || siteOf(url) || 'Web App').trim().slice(0, 60);
  const list = (store.data.settings.installedApps ||= []);
  if (!list.some((a) => a.url === url || (origin && a.origin === origin))) {
    list.push({ id: `app-${Date.now().toString(36)}`, title, url, origin: origin || url, icon: tab.favicon || '' });
    store.save();
    sendAll();
  }
  createAppWindow(url, title);
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
  // A download we're resuming after a restart (createInterruptedDownload) continues its old entry.
  const resuming = pendingResumes.get(item.getURLChain()[0] || item.getURL());
  if (resuming && item.getState() === 'interrupted') {
    pendingResumes.delete(item.getURLChain()[0] || item.getURL());
    const { rec, w } = resuming;
    rec.state = 'progressing';
    liveDownloads.set(rec.id, item);
    watchDownload(rec, item, { savePath: rec.savePath, finalPath: rec.path, dangerous: rec.dangerous, w });
    item.resume();
    store.save();
    notifyDownloads(true);
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
    savePath,
    // what Chromium needs to continue the download after a restart (createInterruptedDownload)
    resume: { urlChain: item.getURLChain(), mimeType: item.getMimeType(), etag: item.getETag(), lastModified: item.getLastModifiedTime(), startTime: item.getStartTime() },
  };
  const list = store.data.downloads;
  list.unshift(rec);
  if (list.length > DOWNLOADS_LIMIT) list.length = DOWNLOADS_LIMIT;
  liveDownloads.set(rec.id, item);
  watchDownload(rec, item, { savePath, finalPath, dangerous, w });

  store.save();
  notifyDownloads(true);
  if (liveWindow(w)) w.chromeView.webContents.send('download-started');
}

// Interrupted downloads that can continue: the live item (same run) and, after a restart,
// the entries waiting for their createInterruptedDownload to arrive in onWillDownload.
const interruptedItems = new Map(); // download id -> DownloadItem
const pendingResumes = new Map(); // first URL -> { rec, w }

function watchDownload(rec, item, { savePath, finalPath, dangerous, w }) {
  item.on('updated', (_ev, state) => {
    rec.received = item.getReceivedBytes();
    rec.total = item.getTotalBytes();
    rec.paused = item.isPaused();
    rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
    notifyDownloads();
  });
  item.on('done', (_ev, state) => {
    rec.received = item.getReceivedBytes();
    rec.paused = false;
    liveDownloads.delete(rec.id);
    if (state === 'interrupted' && item.canResume()) interruptedItems.set(rec.id, item);
    else interruptedItems.delete(rec.id);
    if (state === 'completed') markAsDownloaded(savePath, rec.url); // survives the Keep rename
    if (state === 'completed' && dangerous) {
      rec.state = 'dangerous'; // waiting for Keep / Discard; finalPath stays reserved
      warnAboutDownload(w || focusedWindow(), rec);
    } else {
      rec.state = state; // 'completed' | 'cancelled' | 'interrupted'
      if (state !== 'interrupted') reservedPaths.delete(finalPath);
    }
    store.save();
    notifyDownloads(true);
  });
}

// Chromium deletes unfinished downloads when the app quits. Keep what was downloaded so far
// under a hard link (instant, no copy) so Retry can continue after the restart.
function keepPartialDownloads() {
  for (const [id, item] of liveDownloads) {
    const rec = store.data.downloads.find((d) => d.id === id);
    if (!rec || !rec.savePath || item.getState() !== 'progressing') continue;
    try {
      item.pause();
      const part = `${rec.savePath}.operecs-part`;
      fs.rmSync(part, { force: true });
      fs.linkSync(rec.savePath, part);
      rec.partPath = part;
      rec.received = item.getReceivedBytes();
      rec.state = 'interrupted';
    } catch {
      // nothing on disk yet, or another volume: Retry starts over
    }
  }
}

// An unfinished download leaves the list: delete what it had downloaded so far.
function dropPartialDownload(d) {
  if (d.state !== 'interrupted' && d.state !== 'cancelled') return;
  interruptedItems.delete(d.id);
  for (const file of [d.partPath, d.state === 'interrupted' ? d.savePath : null]) {
    if (file) fs.promises.rm(file, { force: true }).catch(() => {});
  }
}

// Retry: continue where it stopped when possible, otherwise download again from the start.
function retryDownload(w, d) {
  const ses = w.private ? w.ses : session.defaultSession;
  const live = interruptedItems.get(d.id);
  if (live && live.canResume()) {
    interruptedItems.delete(d.id);
    liveDownloads.set(d.id, live);
    d.state = 'progressing';
    live.resume();
    return notifyDownloads(true);
  }
  const r = d.resume;
  let size = 0;
  try {
    if (d.partPath && fs.existsSync(d.partPath)) {
      fs.renameSync(d.partPath, d.savePath); // the part kept at quit goes back in place
      d.partPath = null;
    }
    size = d.savePath ? fs.statSync(d.savePath).size : 0;
  } catch {
    size = 0;
  }
  if (r && size > 0 && (r.etag || r.lastModified) && r.urlChain && r.urlChain.length) {
    pendingResumes.set(r.urlChain[0], { rec: d, w });
    ses.createInterruptedDownload({
      path: d.savePath,
      urlChain: r.urlChain,
      mimeType: r.mimeType,
      offset: size,
      length: d.total || 0,
      lastModified: r.lastModified,
      eTag: r.etag,
      startTime: r.startTime,
    });
    return;
  }
  userDownload(ses, d.url);
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
    if (since === 0) historyDb.clear();
    else historyDb.removeSince(since);
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
  for (const h of historyDb.topPages(300)) {
    const site = siteOf(h.url);
    if (!site || hidden.has(site)) continue;
    const entry = sites.get(site) || { site, url: new URL(h.url).origin + '/', title: '', visits: 0 };
    entry.visits += h.visits;
    if (!entry.title && new URL(h.url).pathname === '/') entry.title = h.title;
    sites.set(site, entry);
  }
  const pinned = (store.data.settings.pinnedTiles || []).map((p) => ({ ...p, site: siteOf(p.url) || p.url, pinned: true }));
  const pinnedSites = new Set(pinned.map((p) => p.site));
  const most = [...sites.values()]
    .filter((s) => !pinnedSites.has(s.site))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, Math.max(0, 8 - pinned.length))
    .map(({ site, url, title }) => ({ site, url, title: title || site, pinned: false }));
  return [...pinned, ...most].map((t) => ({ ...t, icon: historyDb.siteIcon(t.site) }));
}

// New tab background image: the picked file, scaled down, kept in the profile folder.
const NEWTAB_IMAGE = () => path.join(app.getPath('userData'), 'newtab-background.jpg');
let newtabImageCache = null;
async function chooseNewtabImage(w) {
  const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
    title: 'Choose a background image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif'] }],
  });
  if (canceled || !filePaths[0]) return false;
  let img = nativeImage.createFromPath(filePaths[0]);
  if (img.isEmpty()) return false;
  const { width } = img.getSize();
  if (width > 2560) img = img.resize({ width: 2560, quality: 'good' });
  await fs.promises.writeFile(NEWTAB_IMAGE(), img.toJPEG(85));
  newtabImageCache = null;
  store.data.settings.newtab = { ...store.data.settings.newtab, background: 'image' };
  store.save();
  return true;
}
function newtabImage() {
  if (newtabImageCache === null) {
    try {
      newtabImageCache = `data:image/jpeg;base64,${fs.readFileSync(NEWTAB_IMAGE()).toString('base64')}`;
    } catch {
      newtabImageCache = '';
    }
  }
  return newtabImageCache;
}

// ---------------------------------------------------------------- address bar suggestions

const SUGGESTION_LIMIT = 6;

// Ranks bookmarks and history for what's typed: matches at the start of the host score highest,
// then title/URL matches, weighted by how often and how recently the page was visited.
function suggestions(text) {
  const query = text.trim().toLowerCase();
  if (!query) return { items: [], inline: null };

  const pages = new Map(); // url -> { url, title, visits, last, bookmarked }
  for (const h of historyDb.pagesMatching(query)) {
    pages.set(h.url, { url: h.url, title: h.title, visits: h.visits, last: h.last, bookmarked: false });
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
    answer: quickAnswers.answer(text),
    command: quickAnswers.command(text),
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

function runAddressCommand(w, id) {
  if (id === 'private') return createWindow({ private: true });
  if (id === 'screenshot') return takeScreenshot(w, 'visible');
  if (id === 'read-aloud') return toggleReadAloud(w);
  if (id === 'translate') return toggleTranslatePage(w);
  if (id === 'vertical') {
    store.data.settings.verticalTabs = !store.data.settings.verticalTabs;
    store.save();
    windows.forEach((win) => {
      layout(win);
      sendTabs(win);
    });
    buildMenu();
    return;
  }
  if (id === 'split') return toggleSplitView(w);
  if (id === 'clear') {
    const url = internalURL('settings') + '#clear';
    const existing = w.tabs.find((t) => t.wc.getURL().startsWith(internalURL('settings')));
    if (existing) {
      selectTab(w, existing.id);
      existing.wc.loadURL(url).catch(() => {});
    } else {
      createTab(w, url);
    }
    return;
  }
  if (['settings', 'history', 'downloads', 'bookmarks', 'extensions', 'tasks', 'whatsnew', 'shortcuts'].includes(id)) {
    openInternalPage(w, id);
  }
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

const SITE_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'automatic-downloads', 'autoplay'];
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
  autoplay: 'Autoplay audio',
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
    url,
    qr: qr.svg(url),
    secure: parsed.protocol === 'https:',
    mixedContent: !!tab.mixedContent,
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
  const sessionFpSecret = crypto.randomBytes(16).toString('hex');

  // preload.js on browser:// pages asks which interface language to show
  ipcMain.on('i18n:get', (e) => {
    const internal = e.senderFrame && /^browser:/.test(e.senderFrame.url);
    e.returnValue = internal ? { lang: uiLang, strings: uiRaw } : null;
  });
  ipcMain.on('gpc:enabled', (e) => {
    e.returnValue = !!(store && store.data.settings.gpc);
  });

  // capture-preload.js: per-site privacy, fingerprinting, cookie banner & autoplay settings
  ipcMain.on('site:features', (e, origin) => {
    const tab = tabOfWc(e.sender);
    if (!tab || !store) {
      e.returnValue = { fpProtection: false, fpSeed: 0, rejectCookies: false, blockAutoplay: false };
      return;
    }
    const cleanOrigin = originOf(origin || e.senderFrame?.url || tab.wc.getURL()) || String(origin || '');
    const site = siteOf(cleanOrigin || tab.wc.getURL());
    const allowlisted = site ? !blockingOnFor(tab.w, site) && store.data.settings.adblock : false;
    const fpProtection = !!(store.data.settings.fingerprintingProtection && !allowlisted);
    const fpSeed = fpProtection
      ? crypto.createHash('sha256').update(`${sessionFpSecret}:${tab.w.private ? 'priv' : 'norm'}:${cleanOrigin}`).digest().readUInt32LE(0)
      : 0;
    const rejectCookies = !!(store.data.settings.rejectCookies && !allowlisted);
    const siteAutoplay = cleanOrigin ? decisionFor(tab.w, cleanOrigin, 'autoplay') : undefined;
    const defaultAutoplayBlock = permissionDefault('autoplay') === 'block' || store.data.settings.autoplay === 'block-audible';
    const blockAutoplay = siteAutoplay === 'block' || (siteAutoplay !== 'allow' && defaultAutoplayBlock);
    e.returnValue = { fpProtection, fpSeed, rejectCookies, blockAutoplay };
  });

  ipcMain.on('protocol:register', (e, info) => {
    const tab = tabOfWc(e.sender);
    if (!tab || !info || typeof info.scheme !== 'string' || typeof info.url !== 'string') return;
    const origin = originOf(tab.wc.getURL());
    if (!origin) return;
    let parsed;
    try {
      parsed = new URL(info.url);
    } catch {
      return;
    }
    if (parsed.origin !== origin || !info.url.includes('%s')) return;
    const scheme = info.scheme.toLowerCase();
    const existing = (store.data.settings.protocolHandlers || {})[scheme];
    if (existing && existing.url === info.url) return;
    tab.prompts = tab.prompts.filter((p) => !(p.kind === 'protocol-handler' && p.scheme === scheme));
    tab.prompts.push({
      id: nextPromptId++,
      origin,
      keys: [],
      kind: 'protocol-handler',
      scheme,
      handlerUrl: info.url,
      callbacks: [],
    });
    if (tab.id === tab.w.activeId) {
      layout(tab.w);
      sendTabs(tab.w);
    }
  });

  ipcMain.on('swipe:navigate', (e, dir) => {
    const tab = tabOfWc(e.sender);
    if (!tab || tab.wc.isDestroyed()) return;
    if (dir === 'back' && canGo(tab.wc, 'back')) tab.wc.navigationHistory.goBack();
    else if (dir === 'forward' && canGo(tab.wc, 'forward')) tab.wc.navigationHistory.goForward();
  });

  ipcMain.on('screenshot:rect', async (e, rect) => {
    const tab = tabOfWc(e.sender);
    if (!tab || tab.wc.isDestroyed() || !rect) return;
    const x = Math.max(0, Math.round(Number(rect.x) || 0));
    const y = Math.max(0, Math.round(Number(rect.y) || 0));
    const width = Math.max(1, Math.round(Number(rect.width) || 0));
    const height = Math.max(1, Math.round(Number(rect.height) || 0));
    try {
      const img = await tab.wc.capturePage({ x, y, width, height });
      await saveScreenshotImage(tab.w, img);
    } catch {
      // ignore
    }
  });

  ipcMain.handle('translate:batch', (e, texts, targetLang) => {
    const tab = tabOfWc(e.sender);
    if (!tab || !Array.isArray(texts)) return [];
    return translateTexts(texts.slice(0, 50), String(targetLang || 'en'));
  });

  // capture-preload.js: has neither the site nor the per-type default decided on notifications?
  ipcMain.on('notification:undecided', (e) => {
    const tab = tabOfWc(e.sender);
    const origin = e.senderFrame ? originOf(e.senderFrame.url) : null;
    e.returnValue = !!(tab && origin && !decisionFor(tab.w, origin, 'notifications') && permissionDefault('notifications') !== 'block');
  });

  // Address autofill (capture-preload.js in the page's top frame; ui/autofill.html is the list).
  const autofillTab = (e) => {
    const tab = tabOfWc(e.sender);
    return tab && e.senderFrame === e.sender.mainFrame ? tab : null;
  };
  ipcMain.on('autofill:available', (e) => {
    e.returnValue = !!(autofillTab(e) && store.data.addresses && store.data.addresses.length);
  });
  ipcMain.on('autofill:show', (e, info) => {
    const tab = autofillTab(e);
    if (tab && info && info.rect && typeof info.type === 'string') showAutofill(tab, info);
  });
  ipcMain.on('autofill:hide', (e) => {
    const tab = autofillTab(e);
    if (tab) hideAutofill(tab.w, 180); // a click on the list blurs the field first
  });
  ipcMain.on('autofill:offer', (e, address) => {
    const tab = autofillTab(e);
    if (!tab || tab.w.private) return;
    const clean = cleanAddress(address);
    if (!clean.name || (store.data.addresses || []).some((x) => sameAddress(x, clean))) return;
    const origin = originOf(tab.wc.getURL());
    if (!origin) return;
    tab.prompts = tab.prompts.filter((p) => p.kind !== 'save-address');
    tab.prompts.push({ id: nextPromptId++, origin, keys: [], kind: 'save-address', address: clean, keepOnce: true, callbacks: [] });
    if (tab.id === tab.w.activeId) {
      layout(tab.w);
      sendTabs(tab.w);
    }
  });
  const fromAutofill = (e) => windows.find((w) => w.autofillView && w.autofillView.webContents === e.sender) || null;
  handle('autofill:choose', fromAutofill, (w, id) => {
    const tab = w.autofillTab;
    const address = (store.data.addresses || []).find((a) => a.id === id);
    hideAutofill(w);
    if (!tab || tab.wc.isDestroyed() || !address) return;
    tab.wc.focus();
    tab.wc.mainFrame.send('autofill:fill', address);
  });
  handle('autofill:manage', fromAutofill, (w) => {
    hideAutofill(w);
    openInternalPage(w, 'settings');
  });
  handle('addresses:list', fromInternal, () => store.data.addresses || []);
  handle('addresses:save', fromInternal, (_tab, a) => {
    const clean = cleanAddress(a);
    if (!clean.name) return store.data.addresses || [];
    const list = (store.data.addresses ||= []);
    const existing = list.find((x) => x.id === a.id);
    if (existing) Object.assign(existing, clean);
    else {
      nextAddressId = Math.max(nextAddressId, ...list.map((x) => x.id + 1));
      list.push({ id: nextAddressId++, ...clean });
    }
    store.save();
    announceAutofill();
    return list;
  });
  handle('addresses:remove', fromInternal, (_tab, id) => {
    store.data.addresses = (store.data.addresses || []).filter((x) => x.id !== id);
    store.save();
    announceAutofill();
    return store.data.addresses;
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
  handle('tab:preview', fromChrome, async (w, id) => {
    const tab = getTab(w, Number(id));
    if (!tab) return null;
    if (!tab.preview && tab.id === w.activeId) await captureTabPreview(tab);
    const entry = tab.pending && tab.pending.entries[tab.pending.index];
    const u = entry ? entry.url : tab.wc.getURL();
    return {
      id: tab.id,
      title: (entry ? entry.title : tab.wc.getTitle()) || displayUrl(u) || 'New Tab',
      domain: siteOf(u) || displayUrl(u) || '',
      preview: tab.preview || '',
    };
  });
  handle('group:toggle', fromChrome, (w, groupId) => toggleTabGroup(w, String(groupId || '')));
  handle('group:menu', fromChrome, (w, groupId) => showGroupMenu(w, String(groupId || '')));
  handle('group:update', fromChrome, (w, groupId, changes) => updateTabGroup(w, String(groupId || ''), changes || {}));
  handle('workspace:menu', fromChrome, (w) => showWorkspaceMenu(w));
  handle('split:toggle', fromChrome, (w, id) => toggleSplitView(w, id ? Number(id) : null));
  handle('page:translate', fromChrome, (w) => toggleTranslatePage(w));
  handle('page:read-aloud', fromChrome, (w) => toggleReadAloud(w));
  handle('page:screenshot', fromChrome, (w, mode) => takeScreenshot(w, String(mode || 'visible')));
  handle('page:install-app', fromChrome, (w) => installSiteAsApp(w));
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
  handle('suggest:command', fromChrome, (w, id) => runAddressCommand(w, String(id || '')));
  handle('suggest:remove', fromChrome, (_w, url) => {
    historyDb.removeUrl(String(url));
    rebuildMenuSoon();
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
  handle('dictionary:list', fromInternal, async () => (await session.defaultSession.listWordsInSpellCheckerDictionary()).sort((a, b) => a.localeCompare(b)));
  handle('dictionary:remove', fromInternal, (_tab, word) => session.defaultSession.removeWordFromSpellCheckerDictionary(String(word || '')));
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
  handle('device:choose', fromChrome, (w, pickId, deviceId) => finishDeviceChooser(w, pickId, deviceId || null));
  handle('profile:menu', fromChrome, (w) => showProfileMenu(w));
  const profileList = () => ({ list: readProfiles(), current: currentProfile, colors: PROFILE_COLORS });
  handle('profiles:list', fromInternal, () => profileList());
  handle('profiles:add', fromInternal, (_tab, name, color) => {
    addProfile(name, color);
    sendAll();
    return profileList();
  });
  handle('profiles:update', fromInternal, (_tab, id, changes = {}) => {
    const list = readProfiles();
    const p = list.find((x) => x.id === id);
    if (p) {
      if (typeof changes.name === 'string' && changes.name.trim()) p.name = changes.name.trim().slice(0, 40);
      if (PROFILE_COLORS.includes(changes.color)) p.color = changes.color;
      writeProfiles(list);
      sendAll();
    }
    return profileList();
  });
  handle('profiles:open', fromInternal, (_tab, id) => openProfile(String(id)));
  handle('profiles:remove', fromInternal, async (tab, id) => {
    id = String(id);
    if (id === 'main' || id === currentProfile) return profileList();
    const p = readProfiles().find((x) => x.id === id);
    if (!p) return profileList();
    const { response } = await dialog.showMessageBox(tab.w.win, {
      type: 'warning',
      message: `Delete the profile \u201c${p.name}\u201d?`,
      detail: 'Its history, bookmarks, passwords in extensions, cookies and settings are deleted from this computer. Close its windows first.',
      buttons: ['Delete Profile', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return profileList();
    writeProfiles(readProfiles().filter((x) => x.id !== id));
    await fs.promises.rm(profileDir(id), { recursive: true, force: true }).catch(() => {});
    sendAll();
    return profileList();
  });
  handle('media:toggle', fromChrome, (w, id) => {
    const tab = allTabs().find((t) => t.id === id && t.w.private === w.private);
    if (tab) return toggleMedia(tab);
  });
  handle('media:pip', fromChrome, (w, id) => {
    const tab = id ? allTabs().find((t) => t.id === id && t.w.private === w.private) : activeTab(w);
    if (tab) return togglePip(tab);
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
  handle('nav:open-page', fromChrome, (w, name) => {
    const page = String(name || '');
    if (INTERNAL.has(page)) openInternalPage(w, page);
  });
  handle('toolbar:menu', fromChrome, (w) => {
    const btns = toolbarButtonsState();
    const toggleBtn = (key) => {
      const next = { ...toolbarButtonsState(), [key]: !btns[key] };
      store.data.settings.toolbarButtons = next;
      if (key === 'home') store.data.settings.showHomeButton = next.home;
      store.save();
      sendAll();
      buildMenu();
    };
    Menu.buildFromTemplate([
      { label: 'Toolbar Buttons', enabled: false },
      ...Object.entries(TOOLBAR_BUTTON_LABELS).map(([key, label]) => ({
        label,
        type: 'checkbox',
        checked: !!btns[key],
        click: () => toggleBtn(key),
      })),
      { type: 'separator' },
      {
        label: 'Show Bookmarks Bar',
        type: 'checkbox',
        checked: !!store.data.settings.showBookmarksBar,
        click: () => {
          store.data.settings.showBookmarksBar = !store.data.settings.showBookmarksBar;
          store.save();
          windows.forEach((win) => {
            layout(win);
            sendTabs(win);
          });
          buildMenu();
        },
      },
      {
        label: 'Vertical Tabs Sidebar',
        type: 'checkbox',
        checked: !!store.data.settings.verticalTabs,
        click: () => {
          store.data.settings.verticalTabs = !store.data.settings.verticalTabs;
          store.save();
          windows.forEach((win) => {
            layout(win);
            sendTabs(win);
          });
          buildMenu();
        },
      },
      {
        label: 'Compact Toolbar & Tabs',
        type: 'checkbox',
        checked: !!store.data.settings.compactMode,
        click: () => {
          store.data.settings.compactMode = !store.data.settings.compactMode;
          store.save();
          windows.forEach((win) => {
            layout(win);
            sendTabs(win);
          });
          buildMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Customize Toolbar in Settings…',
        click: () => openInternalPage(w, 'settings'),
      },
    ]).popup({ window: w.win });
  });
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
    else reloadTab(t);
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
  handle('data:changelog', fromInternal, async () => JSON.parse(await fs.promises.readFile(path.join(__dirname, 'pages', 'changelog.json'), 'utf8')));
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
    dropPartialDownload(d);
    store.data.downloads = store.data.downloads.filter((x) => x.id !== id);
    store.save();
    notifyDownloads(true);
  });
  handle('download:retry', fromInternal, (tab, id) => {
    const d = ownDownload(tab, id);
    if (d && ['cancelled', 'interrupted'].includes(d.state) && isWeb(d.url)) retryDownload(tab.w, d);
  });
  handle('download:clear', fromInternal, (tab) => {
    const keep = (d) => d.state === 'progressing' || d.state === 'dangerous' || (d.private && !tab.w.private);
    store.data.downloads.filter((d) => !keep(d)).forEach(dropPartialDownload);
    store.data.downloads = store.data.downloads.filter(keep);
    store.save();
    notifyDownloads(true);
  });

  handle('data:settings', fromInternal, () => ({
    ...store.data.settings,
    toolbarButtons: toolbarButtonsState(),
    toolbarButtonDefs: Object.entries(TOOLBAR_BUTTON_LABELS).map(([id, label]) => ({ id, label, defaultOn: !!TOOLBAR_BUTTON_DEFAULTS[id] })),
    accentColors: ACCENT_COLORS.map((id) => ({ id, hex: GROUP_COLORS[id] })),
    adblockAllowlist: store.data.adblockAllowlist,
    searchEngines: allEngines().map((e) => ({ id: e.id, name: e.name, keyword: e.keyword, url: e.url, custom: !!e.custom })),
    searchEngineName: searchEngine().name,
    thirdPartyCookiesBlockedNow: thirdPartyCookiesBlocked,
    startupMode: startupMode(),
    downloadDirShown: downloadDir(),
    systemLanguages: app.getPreferredSystemLanguages(),
    uiLanguages: Object.entries(UI_LANGUAGES).map(([id, name]) => ({ id, name })),
    uiLanguageNow: uiLang,
  }));
  handle('protocol:remove', fromInternal, (_tab, scheme) => {
    if (store.data.settings.protocolHandlers) {
      delete store.data.settings.protocolHandlers[String(scheme || '')];
      store.save();
    }
    return store.data.settings.protocolHandlers || {};
  });
  handle('apps:remove', fromInternal, (_tab, id) => {
    store.data.settings.installedApps = (store.data.settings.installedApps || []).filter((a) => a.id !== id);
    store.save();
    return store.data.settings.installedApps;
  });
  handle('apps:open', fromInternal, (_tab, id) => {
    const a = (store.data.settings.installedApps || []).find((x) => x.id === id);
    if (a) createAppWindow(a.url, a.title);
  });
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
    historyDb.removeUrl(String(url));
    rebuildMenuSoon();
  });
  handle('data:settings-set', fromInternal, (_tab, key, value) => {
    const valid =
      ([
        'restoreSession',
        'adblock',
        'askDownloadLocation',
        'blockThirdPartyCookies',
        'showHomeButton',
        'showBookmarksBar',
        'confirmClose',
        'gpc',
        'httpsOnly',
        'memorySaver',
        'spellcheck',
        'searchSuggestions',
        'stripTracking',
        'energySaver',
        'privacyStats',
        'rejectCookies',
        'fingerprintingProtection',
        'compactMode',
        'verticalTabs',
      ].includes(key) &&
        typeof value === 'boolean') ||
      (key === 'accentColor' && ACCENT_COLORS.includes(value)) ||
      (key === 'toolbarButtons' &&
        value &&
        typeof value === 'object' &&
        Object.entries(value).every(([k, v]) => Object.hasOwn(TOOLBAR_BUTTON_DEFAULTS, k) && typeof v === 'boolean')) ||
      (key === 'shortcuts' && value && typeof value === 'object' && Object.entries(value).every(([k, v]) => typeof k === 'string' && typeof v === 'string' && v.length <= 50)) ||
      (key === 'startup' && ['continue', 'newtab', 'pages'].includes(value)) ||
      (key === 'autoplay' && ['block-audible', 'allow'].includes(value)) ||
      (key === 'theme' && ['system', 'light', 'dark'].includes(value)) ||
      (key === 'newtab' && value && typeof value === 'object' && ['none', 'color', 'image'].includes(value.background) && /^#[0-9a-f]{6}$/i.test(value.color) && typeof value.showTiles === 'boolean' && typeof value.showBookmarks === 'boolean') ||
      (key === 'pinnedTiles' && Array.isArray(value) && value.length <= 8 && value.every((p) => p && /^https?:\/\//i.test(p.url) && typeof p.title === 'string' && p.title.length <= 80)) ||
      (key === 'historyKeepDays' && [0, 7, 30, 90, 365].includes(value)) ||
      (key === 'clearOnQuit' && value && typeof value === 'object' && ['history', 'cookies', 'cache', 'downloads'].every((k) => typeof value[k] === 'boolean')) ||
      (key === 'uiLanguage' && (value === 'auto' || Object.hasOwn(UI_LANGUAGES, value))) ||
      (key === 'proxyMode' && ['system', 'direct', 'manual', 'pac'].includes(value)) ||
      (key === 'proxyServer' && typeof value === 'string' && value.length <= 300 && /^[\w.:\-\[\]=;/ ]*$/.test(value)) ||
      (key === 'proxyBypass' && typeof value === 'string' && value.length <= 500 && !/[\r\n]/.test(value)) ||
      (key === 'proxyPac' && typeof value === 'string' && (value === '' || /^(https?|file):\/\/\S+$/i.test(value))) ||
      (key === 'memorySaverMinutes' && [15, 30, 60, 120, 240].includes(value)) ||
      (key === 'languages' && Array.isArray(value) && value.length <= 10 && value.every((l) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l))) ||
      (key === 'defaultZoom' && [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200].includes(value)) ||
      (key === 'dns' && ['automatic', 'off', 'custom', ...Object.keys(DNS_PROVIDERS)].includes(value)) ||
      (key === 'dnsCustom' && typeof value === 'string' && (value === '' || /^https:\/\/[^\s]+$/i.test(value))) ||
      (key === 'homePage' && typeof value === 'string' && (value === '' || /^(https?|file):\/\//i.test(value))) ||
      (key === 'startupPages' && Array.isArray(value) && value.every((u) => typeof u === 'string' && /^(https?|file):\/\//i.test(u))) ||
      (key === 'searchEngine' && allEngines().some((e) => e.id === value));
    if (!valid) return;
    if (key === 'toolbarButtons') {
      store.data.settings.toolbarButtons = { ...toolbarButtonsState(), ...value };
      store.data.settings.showHomeButton = !!store.data.settings.toolbarButtons.home;
    } else {
      store.data.settings[key] = value;
      if (key === 'showHomeButton') {
        store.data.settings.toolbarButtons = { ...toolbarButtonsState(), home: value };
      }
    }
    store.save();
    if (key === 'dns' || key === 'dnsCustom') applyDns();
    if (key === 'theme') nativeTheme.themeSource = value;
    if (key === 'historyKeepDays') pruneOldHistory();
    if (key === 'compactMode' || key === 'verticalTabs' || key === 'showBookmarksBar') {
      windows.forEach((w) => {
        layout(w);
        sendTabs(w);
      });
      buildMenu();
    }
    if (key === 'shortcuts') buildMenu();
    if (key.startsWith('proxy')) {
      applyProxy(session.defaultSession);
      windows.filter((w) => w.private).forEach((w) => applyProxy(w.ses));
    }
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
    applyProxy(session.defaultSession);
    windows.forEach((w) => {
      layout(w);
      sendTabs(w);
    });
    buildMenu();
  });
  handle('data:top-sites', fromInternal, (tab) => (tab.w.private ? [] : topSites())); // private windows don't show history
  handle('newtab:stats', fromInternal, () => (store.data.settings.privacyStats ? store.data.stats || { blocked: 0, since: Date.now() } : null));
  handle('newtab:background', fromInternal, () => (store.data.settings.newtab.background === 'image' ? newtabImage() : ''));
  handle('newtab:choose-image', fromInternal, (tab) => chooseNewtabImage(tab.w));
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
  handle('data:history', fromInternal, (_tab, opts = {}) =>
    historyDb.list({ query: String(opts.query || ''), before: Number(opts.before) || Number.MAX_SAFE_INTEGER, limit: Math.min(Number(opts.limit) || 300, 1000) }),
  );
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
    historyDb.removeWhere((url) => siteOf(url) === site);
    rebuildMenuSoon();
  });
  handle('data:history-clear', fromInternal, () => {
    historyDb.clear();
    rebuildMenuSoon();
  });
  handle('ext:list', fromInternal, () => extensionList());
  handle('ext:remove', fromInternal, async (_tab, id) => {
    id = String(id);
    const disabled = (store.data.settings.disabledExtensions || []).find((d) => d.id === id);
    if (disabled && !session.defaultSession.extensions.getExtension(id)) {
      await session.defaultSession.extensions.loadExtension(disabled.path).catch(() => {}); // the uninstaller expects it loaded
    }
    await uninstallExtension(id, { session: session.defaultSession }).catch(() => {});
    store.data.settings.disabledExtensions = (store.data.settings.disabledExtensions || []).filter((d) => d.id !== id);
    store.data.settings.hiddenActions = (store.data.settings.hiddenActions || []).filter((x) => x !== id);
    store.save();
    sendAll();
    return extensionList();
  });
  handle('ext:set-enabled', fromInternal, async (_tab, id, enabled) => {
    await setExtensionEnabled(String(id), !!enabled);
    return extensionList();
  });
  handle('ext:set-hidden', fromInternal, (_tab, id, hide) => {
    const set = new Set(store.data.settings.hiddenActions || []);
    if (hide) set.add(String(id));
    else set.delete(String(id));
    store.data.settings.hiddenActions = [...set];
    store.save();
    sendAll();
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
  handle('data:export-all', fromInternal, (tab) => exportAllData(tab.w));
  handle('history:import', fromInternal, (_tab, source) => importHistory(String(source)));
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
  const visited = historyDb.recentPages(10).map((h) => ({ label: trimLabel(h.title || displayUrl(h.url), 60), click: inWindow((win) => createTab(win, h.url)) }));
  return [
    { type: 'separator' },
    { label: 'Recently Closed', enabled: closed.length > 0, submenu: closed.length ? closed : [{ label: 'Nothing yet', enabled: false }] },
    ...(visited.length ? [{ type: 'separator' }, { label: 'Recently Visited', enabled: false }, ...visited] : []),
  ];
}

const menuIcon = (dataUrl) => {
  if (!dataUrl) return undefined;
  const img = nativeImage.createFromDataURL(dataUrl);
  return img.isEmpty() ? undefined : img.resize({ width: 16, height: 16, quality: 'best' });
};

// Bookmarks menu: the bookmarks bar's contents and Other Bookmarks, folders as submenus.
function bookmarkMenuItems(inWindow) {
  if (!store) return [];
  const MAX = 60; // per folder; the manager has the rest
  const toItems = (children, depth) => {
    const items = children.slice(0, MAX).map((n) =>
      n.type === 'folder'
        ? { label: trimLabel(n.title || 'Folder', 50), submenu: depth > 6 || !n.children.length ? [{ label: '(empty)', enabled: false }] : toItems(n.children, depth + 1) }
        : { label: trimLabel(n.title || displayUrl(n.url), 50), icon: menuIcon(n.icon), click: inWindow((w) => createTab(w, n.url)) },
    );
    if (children.length > MAX) items.push({ label: `${children.length - MAX} more in the Bookmark Manager…`, click: inWindow((w) => openInternalPage(w, 'bookmarks')) });
    return items;
  };
  const { bar, other } = bookmarks.tree();
  const items = [];
  if (bar.children.length) items.push({ type: 'separator' }, ...toItems(bar.children, 0));
  if (other.children.length) items.push({ type: 'separator' }, { label: other.title || 'Other Bookmarks', submenu: toItems(other.children, 1) });
  return items;
}

function buildMenu() {
  clearTimeout(menuTimer);
  // Menu commands act on the focused browser window, opening one if none is open.
  const inWindow = (fn) => () => {
    const w = focusedWindow() || createWindow();
    fn(w);
  };
  const open = (name) => inWindow((w) => openInternalPage(w, name));
  const acc = (id, fallback) => (store && store.data.settings.shortcuts && store.data.settings.shortcuts[id]) || fallback;

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
        { label: 'New Tab', accelerator: acc('new-tab', 'CmdOrCtrl+T'), click: inWindow((w) => createTab(w, internalURL('newtab'))) },
        { label: 'New Window', accelerator: acc('new-window', 'CmdOrCtrl+N'), click: () => createWindow() },
        { label: 'New Private Window', accelerator: acc('private-window', 'CmdOrCtrl+Shift+N'), click: () => createWindow({ private: true }) },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: acc('close-tab', 'CmdOrCtrl+W'), click: inWindow((w) => closeActiveTabs(w)) },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: inWindow((w) => w.win.close()) },
        { label: 'Reopen Closed Tab', accelerator: acc('reopen-tab', 'CmdOrCtrl+Shift+T'), click: inWindow(reopenClosedTab) },
        { label: 'Open Location', accelerator: acc('focus-address', 'CmdOrCtrl+L'), click: inWindow(focusAddress) },
        { label: 'Switch Between Toolbar and Page', accelerator: 'F6', click: inWindow(cycleFocus) },
        { type: 'separator' },
        { label: 'Save Page As…', accelerator: 'CmdOrCtrl+S', click: inWindow(savePageAs) },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: inWindow((w) => printTab(activeTab(w))) },
        ...(isMac ? [{ label: 'Share…', click: inWindow((w) => sharePage(w, activeTab(w))) }] : []),
        { label: 'Install Site as App…', click: inWindow(installSiteAsApp) },
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
        { role: 'pasteAndMatchStyle', label: 'Paste as Plain Text', accelerator: 'CmdOrCtrl+Shift+V' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: acc('find', 'CmdOrCtrl+F'), click: inWindow(openFind) },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: inWindow((w) => findStep(w, true)) },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: inWindow((w) => findStep(w, false)) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: acc('reload', 'CmdOrCtrl+R'), click: inWindow((w) => reloadTab(activeTab(w))) },
        {
          label: 'Hard Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: inWindow((w) => reloadTab(activeTab(w), { ignoreCache: true })),
        },
        { type: 'separator' },
        { label: 'Reader Mode', accelerator: acc('reader', 'Alt+CmdOrCtrl+R'), click: inWindow(toggleReader) },
        {
          label: 'Vertical Tabs',
          type: 'checkbox',
          checked: !!(store && store.data.settings.verticalTabs),
          accelerator: acc('vertical-tabs', 'Alt+CmdOrCtrl+V'),
          click: (item) => {
            store.data.settings.verticalTabs = item.checked;
            store.save();
            windows.forEach((w) => {
              layout(w);
              sendTabs(w);
            });
            buildMenu();
          },
        },
        { label: 'Split View', accelerator: acc('split-view', 'Alt+CmdOrCtrl+S'), click: inWindow((w) => toggleSplitView(w)) },
        { label: 'Picture in Picture', click: inWindow((w) => togglePip(activeTab(w))) },
        { type: 'separator' },
        { label: 'Read Page Aloud', click: inWindow(toggleReadAloud) },
        { label: 'Translate Page', click: inWindow(toggleTranslatePage) },
        {
          label: 'Take Screenshot',
          submenu: [
            { label: 'Capture Visible Page', accelerator: acc('screenshot', 'CmdOrCtrl+Shift+S'), click: inWindow((w) => takeScreenshot(w, 'visible')) },
            { label: 'Capture Selection…', click: inWindow((w) => takeScreenshot(w, 'selection')) },
            { label: 'Capture Full Page', click: inWindow((w) => takeScreenshot(w, 'full')) },
          ],
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: inWindow((w) => zoom(w, 0.5)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: inWindow((w) => zoom(w, -0.5)) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: inWindow((w) => zoom(w, 0)) },
        { type: 'separator' },
        { label: 'Task Manager', accelerator: isMac ? undefined : 'Shift+Esc', click: open('tasks') },
        {
          label: 'Developer Tools',
          accelerator: acc('devtools', isMac ? 'Alt+Cmd+I' : 'F12'),
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
        { label: 'Show History', accelerator: acc('history', isMac ? 'Cmd+Y' : 'Ctrl+H'), click: open('history') },
        { label: 'Show Downloads', accelerator: acc('downloads', isMac ? 'Alt+Cmd+L' : 'Ctrl+J'), click: open('downloads') },
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
          accelerator: acc('bookmarks-bar', 'CmdOrCtrl+Shift+B'),
          click: (item) => setBookmarksBar(item.checked),
        },
        { label: 'Bookmark All Tabs…', accelerator: 'CmdOrCtrl+Shift+D', click: inWindow(bookmarkAllTabs) },
        { label: 'Bookmark Manager', accelerator: 'CmdOrCtrl+Shift+O', click: open('bookmarks') },
        ...bookmarkMenuItems(inWindow),
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
        { label: "What's New", click: open('whatsnew') },
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
    // no-store: a page must never use files from an older version after an update
    return new Response(await fs.promises.readFile(file), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// Development runs (npm start) keep their own profile so testing never touches the
// installed app's bookmarks, history or settings. Must run before anything reads userData.
// BROWSER_PROFILE_DIR points any build (including a packaged one) at a throwaway profile for testing.
if (process.env.BROWSER_PROFILE_DIR) app.setPath('userData', path.resolve(process.env.BROWSER_PROFILE_DIR));
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Browser Dev'));

// ---------------------------------------------------------------- profiles

// Each extra profile is its own folder (<main profile>/Profiles/<id>) and runs as its own
// Operecs process (`--profile=<id>`), so cookies, history, bookmarks, extensions, settings and
// addresses are completely separate. profiles.json in the main profile lists them.
const MAIN_USER_DATA = app.getPath('userData');
const PROFILES_FILE = path.join(MAIN_USER_DATA, 'profiles.json');
const PROFILE_COLORS = ['#9b6cff', '#4f8cff', '#2fb67c', '#f2994a', '#eb5757', '#e35d9b', '#12a4b8', '#8d8d99'];

let profilesCache = null; // { mtime, list }; another profile's process may change the file
function readProfiles() {
  let mtime = 0;
  try {
    mtime = fs.statSync(PROFILES_FILE).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (profilesCache && profilesCache.mtime === mtime) return profilesCache.list.map((p) => ({ ...p }));
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch {
    list = [];
  }
  list = (Array.isArray(list) ? list : []).filter((p) => p && /^[a-z0-9-]{1,40}$/.test(p.id) && typeof p.name === 'string');
  if (!list.some((p) => p.id === 'main')) list.unshift({ id: 'main', name: 'Personal', color: PROFILE_COLORS[0] });
  profilesCache = { mtime, list };
  return list.map((p) => ({ ...p }));
}
function writeProfiles(list) {
  fs.mkdirSync(MAIN_USER_DATA, { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(list, null, 2));
}
const profileDir = (id) => (id === 'main' ? MAIN_USER_DATA : path.join(MAIN_USER_DATA, 'Profiles', id));

const PROFILE_ARG = (process.argv.find((a) => a.startsWith('--profile=')) || '').slice('--profile='.length);
const currentProfile = PROFILE_ARG && PROFILE_ARG !== 'main' && readProfiles().some((p) => p.id === PROFILE_ARG) ? PROFILE_ARG : 'main';
if (currentProfile !== 'main') app.setPath('userData', profileDir(currentProfile));
const profileInfo = () => readProfiles().find((p) => p.id === currentProfile) || { id: 'main', name: 'Personal', color: PROFILE_COLORS[0] };

// Opens a profile's window: here for this profile, otherwise by starting (or waking) its process.
function openProfile(id) {
  if (id === currentProfile) return void createWindow();
  if (!readProfiles().some((p) => p.id === id)) return;
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), ...(id === 'main' ? [] : [`--profile=${id}`])];
  require('child_process').spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
}

function addProfile(name, color) {
  const list = readProfiles();
  const id = `p-${Date.now().toString(36)}`;
  list.push({ id, name: String(name || 'Profile').trim().slice(0, 40) || 'Profile', color: PROFILE_COLORS.includes(color) ? color : PROFILE_COLORS[list.length % PROFILE_COLORS.length] });
  writeProfiles(list);
  return id;
}

function showProfileMenu(w) {
  const list = readProfiles();
  Menu.buildFromTemplate([
    ...list.map((p) => ({ label: p.name, type: 'checkbox', checked: p.id === currentProfile, click: () => openProfile(p.id) })),
    { type: 'separator' },
    { label: 'Add Profile…', click: () => openInternalPage(w, 'settings') },
    { label: 'Manage Profiles…', click: () => openInternalPage(w, 'settings') },
  ]).popup({ window: w.win });
}

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
app.on('will-quit', () => {
  try {
    historyDb.close();
  } catch {
    // already closed
  }
});

app.on('second-instance', (_e, argv) => {
  // Windows Jump List / Linux desktop actions
  const appArg = argv.find((a) => a.startsWith('--app='));
  if (appArg && launched) return void createAppWindow(appArg.slice('--app='.length));
  if (argv.includes('--private-window')) return void createWindow({ private: true });
  if (argv.includes('--new-window')) return void createWindow();
  const urls = argv.slice(1).map(urlFromArg).filter(Boolean);
  if (urls.length && launched) return void urls.forEach(openFromOutside);
  const w = focusedWindow();
  if (!w) return void createWindow();
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
  if (isMac) app.focus({ steal: true });
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('select-client-certificate', (event, wc, _url, certificateList, callback) => {
  event.preventDefault();
  if (!certificateList || !certificateList.length) return callback(null);
  const devices = certificateList.map((c, i) => ({
    id: String(i),
    name: `${c.subjectName || 'Certificate'}${c.issuerName ? ` (issued by ${c.issuerName})` : ''}`,
    key: c.fingerprint || String(i),
  }));
  showDeviceChooser(wc, 'certificate', devices, (chosenId) => {
    const idx = chosenId === '' ? -1 : Number(chosenId);
    callback(idx >= 0 && certificateList[idx] ? certificateList[idx] : null);
  });
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  protocol.handle(SCHEME, serveInternal);
  store = new Store(path.join(app.getPath('userData'), 'browser-data.json'));
  nativeTheme.themeSource = store.data.settings.theme || 'system';
  setupUiLanguage();
  historyDb.open(path.join(app.getPath('userData'), 'History.sqlite'));
  pruneOldHistory();
  setInterval(pruneOldHistory, 6 * 60 * 60 * 1000).unref();
  // v1 profiles kept history in browser-data.json; move it into the database once
  if (store.data.history && store.data.history.length) {
    historyDb.importVisits(store.data.history);
    store.data.history = [];
    store.save();
  }
  app.setAboutPanelOptions({
    applicationName: DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Free software under the GPL-3.0. github.com/ezzeldinzozz-svg/operecs-browser',
  });
  bookmarks.init(store.data, () => {
    store.save();
    sendAll();
    rebuildMenuSoon(); // the Bookmarks menu lists them
  });
  // Downloads still running when the app last quit: Retry continues them if the partial file and
  // the server's validators (ETag / Last-Modified) are still there (retryDownload).
  for (const d of store.data.downloads) if (d.state === 'progressing') d.state = 'interrupted';
  nextDownloadId = store.data.downloads.reduce((max, d) => Math.max(max, d.id), 0) + 1;

  adblock.init({
    cacheFile: path.join(app.getPath('userData'), 'adblock-engine.bin'),
    shouldBlock,
    onBlocked,
    beforeRequest: (details) => {
      rememberMainFrameRequest(details);
      noteMixedContent(details);
      return checkInsecureForm(details) || upgradeToHttps(details) || stripTrackingParams(details);
    },
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
  // After an update, show what changed (once per version).
  const updatedFrom = store.data.lastVersion;
  const justUpdated = !store.isNew && updatedFrom !== app.getVersion(); // (profiles before 1.0 have no lastVersion)
  store.data.lastVersion = app.getVersion();
  const crashed = store.data.cleanExit === false;
  store.data.cleanExit = false;
  const firstRun = store.isNew && !store.data.welcomed;
  store.data.welcomed = true;
  store.flush();
  const previous = savedWindows(); // snapshot before new windows overwrite the saved session

  const appArg = process.argv.find((a) => a.startsWith('--app='));
  const mode = startupMode();
  const pages = store.data.settings.startupPages.filter((u) => /^(https?|file):/i.test(u));
  if (appArg && isWeb(appArg.slice('--app='.length))) {
    createAppWindow(appArg.slice('--app='.length));
  } else if (mode === 'continue' && previous.length) {
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
  if (justUpdated && !firstRun) {
    const w = windows.find((x) => !x.private && liveWindow(x));
    if (w) createTab(w, internalURL('whatsnew'));
  }
  launched = true;
  for (const url of [...process.argv.slice(1).map(urlFromArg).filter(Boolean), ...pendingOpens.splice(0)]) {
    openFromOutside(url);
  }
  if (process.argv.includes('--private-window')) createWindow({ private: true });
  // Windows taskbar Jump List
  if (process.platform === 'win32') {
    app.setUserTasks([
      { program: process.execPath, arguments: '--new-window', iconPath: process.execPath, iconIndex: 0, title: 'New Window', description: 'Open a new window' },
      { program: process.execPath, arguments: '--private-window', iconPath: process.execPath, iconIndex: 0, title: 'New Private Window', description: 'Open a private window' },
    ]);
  }
  // Only the main profile's process updates the app; the others just run the new version later.
  if (currentProfile === 'main') updater.start(onUpdateState);
});

// A critical (security) update: ask to restart now; restart by itself 10 minutes later.
let criticalPrompted = false;
function onUpdateState() {
  sendAll();
  const state = updater.getState();
  if (state.status !== 'ready' || !state.critical || criticalPrompted) return;
  criticalPrompted = true;
  const parent = focusedWindow()?.win;
  dialog
    .showMessageBox(parent, {
      type: 'warning',
      message: 'Important security update',
      detail: `Operecs ${state.version} fixes a security problem. Restart now to install it; otherwise Operecs restarts by itself in 10 minutes, so save anything you are writing.`,
      buttons: ['Restart Now', 'In 10 Minutes'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) restartToUpdate();
      else setTimeout(restartToUpdate, 10 * 60 * 1000).unref();
    })
    .catch(() => {});
}

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
  keepDisabledExtensionsOff();
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
  const hidden = new Set(store.data.settings.hiddenActions || []);
  const loaded = session.defaultSession.extensions.getAllExtensions().map((e) => ({
    id: e.id,
    name: e.name,
    version: e.version,
    description: e.manifest.description || '',
    enabled: true,
    hasAction: !!(e.manifest.action || e.manifest.browser_action),
    hidden: hidden.has(e.id),
  }));
  const off = (store.data.settings.disabledExtensions || [])
    .filter((d) => !loaded.some((e) => e.id === d.id))
    .map((d) => ({ id: d.id, name: d.name, version: d.version, description: d.description, enabled: false, hasAction: false, hidden: hidden.has(d.id) }));
  return [...loaded, ...off].sort((a, b) => a.name.localeCompare(b.name));
}

// Turning an extension off unloads it but keeps its files; Operecs unloads it again whenever the
// web store library loads it (startup, auto-update) until it's turned back on.
async function setExtensionEnabled(id, enabled) {
  const ses = session.defaultSession;
  const list = (store.data.settings.disabledExtensions ||= []);
  if (enabled) {
    const entry = list.find((d) => d.id === id);
    store.data.settings.disabledExtensions = list.filter((d) => d.id !== id);
    store.save();
    if (entry && !ses.extensions.getExtension(id)) await ses.extensions.loadExtension(entry.path).catch(() => {});
  } else {
    const ext = ses.extensions.getExtension(id);
    if (!ext) return;
    if (!list.some((d) => d.id === id)) {
      list.push({ id, name: ext.name, version: ext.version, description: ext.manifest.description || '', path: ext.path });
    }
    store.save();
    ses.extensions.removeExtension(id);
  }
  sendAll();
}

function keepDisabledExtensionsOff() {
  session.defaultSession.extensions.on('extension-loaded', (_e, ext) => {
    if ((store.data.settings.disabledExtensions || []).some((d) => d.id === ext.id)) {
      setImmediate(() => session.defaultSession.extensions.removeExtension(ext.id));
    }
  });
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

let clearedOnQuit = false;
app.on('before-quit', (e) => {
  const openTabs = windows.reduce((n, w) => n + w.tabs.length, 0);
  // Only when the user quits from our menu / Cmd+Q: shutdown and signals must never be held up.
  if (store && userQuitRequested && !quitting && !quitConfirmed) {
    e.preventDefault();
    userQuitRequested = false;
    (async () => {
      const dirty = await unsavedTabs(windows.flatMap((w) => w.tabs));
      let ok = true;
      if (dirty.length) ok = await confirmUnsaved(focusedWindow()?.win, dirty, 'Quit');
      else if (store.data.settings.confirmClose && openTabs > 1) ok = await confirmClosing(focusedWindow()?.win, `Quit with ${openTabs} tabs open?`, 'Quit');
      if (!ok) return;
      quitConfirmed = true;
      app.quit();
    })();
    return;
  }
  // Settings → "Clear when Operecs quits": wipe what was chosen, then quit for real.
  const onQuit = store && store.data.settings.clearOnQuit;
  if (onQuit && !clearedOnQuit && (onQuit.history || onQuit.cookies || onQuit.cache || onQuit.downloads)) {
    e.preventDefault();
    clearedOnQuit = true;
    (async () => {
      try {
        if (onQuit.history) historyDb.clear();
        if (onQuit.downloads) store.data.downloads = store.data.downloads.filter((d) => d.state === 'progressing');
        const ses = session.defaultSession;
        if (onQuit.cookies) await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'websql'] });
        if (onQuit.cache) await ses.clearCache();
      } catch (err) {
        console.warn('Clear on quit:', err.message);
      }
      app.quit();
    })();
    return;
  }
  if (store) {
    keepPartialDownloads();
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
