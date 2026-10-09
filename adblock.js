'use strict';

// Built-in ad and tracker blocking, using Ghostery's open-source engine (EasyList,
// EasyPrivacy and friends, the same lists as uBlock Origin's defaults).
//
// We wire the engine into sessions ourselves instead of using enableBlockingInSession():
// that helper registers fixed IPC channels (so it can't serve a normal and a private
// session at once) and has no per-site switch.

const fs = require('fs');
const { ipcMain, net } = require('electron');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');

const PRELOAD_PATH = require.resolve('@ghostery/adblocker-electron-preload');
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

let engine = null;
let cacheFile = '';
// shouldBlock(webContentsId) -> boolean: is blocking on for the page in that tab?
// onBlocked(webContentsId, url): a request was blocked in that tab.
// beforeRequest(details) -> { redirectURL } | null: runs first for every request (Electron
// allows one onBeforeRequest listener per session, so other features hook in here).
let hooks = { shouldBlock: () => false, onBlocked: () => {}, beforeRequest: () => null };

const fetchImpl = (url, init) => net.fetch(url, init);

async function refresh() {
  try {
    const fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchImpl);
    await fs.promises.writeFile(cacheFile, fresh.serialize());
    engine = fresh;
  } catch (err) {
    console.warn('Ad blocker: could not update filter lists:', err.message);
  }
}

async function load() {
  let age = Infinity;
  try {
    const stat = await fs.promises.stat(cacheFile);
    engine = ElectronBlocker.deserialize(new Uint8Array(await fs.promises.readFile(cacheFile)));
    age = Date.now() - stat.mtimeMs;
  } catch {
    engine = null; // no cache yet, or written by an incompatible engine version
  }
  if (!engine) await refresh();
  else if (age > REFRESH_EVERY_MS) refresh();
  setInterval(refresh, REFRESH_EVERY_MS).unref();
}

function init(options) {
  cacheFile = options.cacheFile;
  hooks = options;

  // Cosmetic filtering: the engine's preload asks which CSS/scriptlets to inject.
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
    if (!engine || !hooks.shouldBlock(event.sender.id)) return undefined;
    return engine.onInjectCosmeticFilters(event, url, msg);
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) =>
    engine && hooks.shouldBlock(event.sender.id) ? engine.config.enableMutationObserver : false,
  );

  return load();
}

function attach(ses) {
  ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD_PATH });

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const early = hooks.beforeRequest ? hooks.beforeRequest(details) : null;
    if (early) return callback(early);
    if (!engine || !details.webContentsId || !hooks.shouldBlock(details.webContentsId)) return callback({});
    const request = fromElectronDetails(details);
    if (request.type === 'other') request.guessTypeOfRequest();
    if (request.isMainFrame()) return callback({});
    const { redirect, match } = engine.match(request);
    if (redirect) {
      hooks.onBlocked(details.webContentsId, details.url);
      return callback({ redirectURL: redirect.dataUrl });
    }
    if (match) {
      hooks.onBlocked(details.webContentsId, details.url);
      return callback({ cancel: true });
    }
    return callback({});
  });

  // Some filters add CSP directives to pages (e.g. to stop inline ad scripts).
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!engine || !details.webContentsId || !hooks.shouldBlock(details.webContentsId)) return callback({});
    return engine.onHeadersReceived(details, callback);
  });
}

module.exports = { init, attach, isReady: () => !!engine };
