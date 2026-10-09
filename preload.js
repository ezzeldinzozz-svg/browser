'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only the browser's own browser:// pages (toolbar UI + internal pages) get the API.
// The main process re-checks the sender on every call, so websites never reach it.
if (location.protocol === 'browser:' && window === window.top) {
  const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
  const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

  contextBridge.exposeInMainWorld('browserAPI', {
    newTab: call('tab:new'),
    closeTab: call('tab:close'),
    selectTab: call('tab:select'),
    go: call('nav:go'),
    back: call('nav:back'),
    forward: call('nav:forward'),
    reload: call('nav:reload'),
    toggleBookmark: call('bookmark:toggle'),
    respondPermission: call('permission:respond'),
    getPermissions: call('data:permissions'),
    resetPermissions: call('data:permission-reset'),
    getHistory: call('data:history'),
    clearHistory: call('data:history-clear'),
    getBookmarks: call('data:bookmarks'),
    removeBookmark: call('data:bookmark-remove'),
    find: call('find:query'),
    closeFind: call('find:close'),
    openDownloads: call('downloads:open'),
    installUpdate: call('update:install'),
    respondAuth: call('auth:respond'),
    toggleSiteBlocking: call('adblock:toggle-site'),
    removeAdblockException: call('data:adblock-allow-remove'),
    getSettings: call('data:settings'),
    setSetting: call('data:settings-set'),
    getDownloads: call('data:downloads'),
    openDownload: call('download:open'),
    showDownload: call('download:show'),
    cancelDownload: call('download:cancel'),
    pauseDownload: call('download:pause'),
    clearDownloads: call('download:clear'),
    onTabs: on('tabs:update'),
    onFocusAddress: on('focus-address'),
    onFocusFind: on('focus-find'),
    onFocusAuth: on('focus-auth'),
  });
}
