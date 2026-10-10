'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

// The toolbar shows extension buttons (and their popups) with <browser-action-list>.
if (location.href === 'browser://ui/') injectBrowserAction();

// Only the browser's own browser:// pages (toolbar UI + internal pages) get the API.
// The main process re-checks the sender on every call, so websites never reach it.
if (location.protocol === 'browser:' && window === window.top) {
  const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
  const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

  contextBridge.exposeInMainWorld('browserAPI', {
    newTab: call('tab:new'),
    closeTab: call('tab:close'),
    selectTab: call('tab:select'),
    tabMenu: call('tab:menu'),
    switchToTab: call('tab:switch'),
    openInNewTab: call('tab:open-url'),
    // file:// address of a file dragged in from Finder ('' for files that aren't on disk)
    fileUrl: (file) => {
      // (the sandboxed preload's url module has no pathToFileURL)
      const p = webUtils.getPathForFile(file).replace(/\\/g, '/');
      return p ? 'file://' + (p.startsWith('/') ? '' : '/') + p.split('/').map(encodeURIComponent).join('/').replace(/^(\/[A-Za-z])%3A/, '$1:') : '';
    },
    removeSuggestion: call('suggest:remove'),
    addressMenu: call('address:menu'),
    setOverlay: call('ui:overlay'),
    historyMenu: call('nav:history-menu'),
    extensionsMenu: call('ext:menu'),
    resetZoom: call('zoom:reset'),
    stopCapture: call('capture:stop'),
    goHome: call('nav:home'),
    focusPage: call('focus:page'),
    restorePages: call('restore:accept'),
    dismissRestore: call('restore:dismiss'),
    currentPagesForStartup: call('startup:current-pages'),
    chooseDownloadFolder: call('downloads:choose-folder'),
    removeHistoryEntry: call('data:history-remove'),
    suggest: call('suggest'),
    suggestSearch: call('suggest:search'),
    runCommand: call('suggest:command'),
    siteInfo: call('site:info'),
    setSitePermission: call('site:set-permission'),
    clearSiteData: call('site:clear-data'),
    moveTab: call('tab:move'),
    toggleMedia: call('media:toggle'),
    profileMenu: call('profile:menu'),
    getProfiles: call('profiles:list'),
    addProfile: call('profiles:add'),
    updateProfile: call('profiles:update'),
    openProfile: call('profiles:open'),
    removeProfile: call('profiles:remove'),
    tearOffTab: call('tab:tear-off'),
    adoptTab: call('tab:adopt'),
    muteTab: call('tab:mute'),
    go: call('nav:go'),
    search: call('nav:search'),
    back: call('nav:back'),
    forward: call('nav:forward'),
    reload: call('nav:reload'),
    toggleBookmark: call('bookmark:toggle'),
    respondPermission: call('permission:respond'),
    getPermissions: call('data:permissions'),
    getSiteData: call('data:site-data'),
    getDictionaryWords: call('dictionary:list'),
    removeDictionaryWord: call('dictionary:remove'),
    getReaderArticle: call('reader:article'),
    setReaderPrefs: call('reader:prefs'),
    exitReader: call('reader:exit'),
    toggleReader: call('reader:toggle'),
    addSearchEngine: call('data:engine-add'),
    removeSearchEngine: call('data:engine-remove'),
    removeSiteData: call('data:site-data-remove'),
    removeAllSiteData: call('data:site-data-remove-all'),
    resetPermissions: call('data:permission-reset'),
    setSitePermissionFromSettings: call('data:permission-set'),
    getPermissionDefaults: call('data:permission-defaults'),
    setPermissionDefault: call('data:permission-default-set'),
    relaunch: call('app:relaunch'),
    getHistory: call('data:history'),
    clearBrowsingData: call('data:clear-browsing'),
    clearHistory: call('data:history-clear'),
    getBookmarks: call('data:bookmarks'),
    removeBookmark: call('data:bookmark-remove'),
    find: call('find:query'),
    closeFind: call('find:close'),
    openDownloads: call('downloads:open'),
    installUpdate: call('update:install'),
    getAbout: call('about:info'),
    getChangelog: call('data:changelog'),
    checkForUpdates: call('about:check'),
    installUpdateFromSettings: call('about:install'),
    respondAuth: call('auth:respond'),
    toggleSiteBlocking: call('adblock:toggle-site'),
    adblockDetails: call('adblock:details'),
    exportCertificate: call('site:export-certificate'),
    removeAdblockException: call('data:adblock-allow-remove'),
    getSettings: call('data:settings'),
    setSetting: call('data:settings-set'),
    getDownloads: call('data:downloads'),
    openDownload: call('download:open'),
    showDownload: call('download:show'),
    cancelDownload: call('download:cancel'),
    pauseDownload: call('download:pause'),
    clearDownloads: call('download:clear'),
    removeDownloadEntry: call('download:remove'),
    retryDownload: call('download:retry'),
    removeHistorySite: call('data:history-remove-site'),
    getLicenses: call('data:licenses'),
    getTopSites: call('data:top-sites'),
    getNewtabImage: call('newtab:background'),
    getPrivacyStats: call('newtab:stats'),
    chooseNewtabImage: call('newtab:choose-image'),
    allowHttp: call('https:allow'),
    getTasks: call('data:tasks'),
    endTask: call('tasks:end'),
    hideTile: call('data:hide-tile'),
    resetSettings: call('settings:reset'),
    decideDownload: call('download:decide'),
    decideDownloadWarning: call('download:warning-decide'),
    onTabs: on('tabs:update'),
    onFocusAddress: on('focus-address'),
    onFocusFind: on('focus-find'),
    onFocusAuth: on('focus-auth'),
    onAutofillList: on('autofill:list'),
    chooseAutofill: call('autofill:choose'),
    manageAutofill: call('autofill:manage'),
    getAddresses: call('addresses:list'),
    saveAddress: call('addresses:save'),
    removeAddress: call('addresses:remove'),
    onWindowFullscreen: on('window:fullscreen'),
    onScreenPicker: on('screen-picker'),
    onDevicePicker: on('device-picker'),
    onStatus: on('status'),
    listExtensions: call('ext:list'),
    removeExtension: call('ext:remove'),
    setExtensionEnabled: call('ext:set-enabled'),
    setExtensionHidden: call('ext:set-hidden'),
    openWebStore: call('ext:store'),
    onBookmarkEdit: on('bookmark-edit'),
    starPage: call('bm:star'),
    openBookmark: call('bm:open'),
    bookmarkFolderMenu: call('bm:folder-menu'),
    bookmarkOverflowMenu: call('bm:overflow-menu'),
    setBookmarksBarHovered: call('bmbar:hover'),
    bookmarkContextMenu: call('bm:context'),
    bookmarkEditInfo: call('bm:edit-info'),
    updateBookmark: call('bm:update'),
    moveBookmark: call('bm:move'),
    removeBookmarkNode: call('bm:remove'),
    getBookmarkTree: call('bm:tree'),
    addBookmarkFolder: call('bm:add-folder'),
    bookmarkImportSources: call('bm:import-sources'),
    importBookmarks: call('bm:import'),
    importHistory: call('history:import'),
    exportAllData: call('data:export-all'),
    exportBookmarks: call('bm:export'),
    onDownloadStarted: on('download-started'),
    recentDownloads: call('downloads:recent'),
    downloadAction: call('downloads:action'),
    chooseScreen: call('screen:choose'),
    chooseDevice: call('device:choose'),
    getDefaultBrowser: call('default:status'),
    setDefaultBrowser: call('default:set'),
    tabPreview: call('tab:preview'),
    toggleGroup: call('group:toggle'),
    groupMenu: call('group:menu'),
    updateGroup: call('group:update'),
    onGroupRename: on('group:rename'),
    workspaceMenu: call('workspace:menu'),
    toggleSplit: call('split:toggle'),
    togglePip: call('media:pip'),
    translatePage: call('page:translate'),
    readAloud: call('page:read-aloud'),
    takeScreenshot: call('page:screenshot'),
    installSiteAsApp: call('page:install-app'),
    removeProtocolHandler: call('protocol:remove'),
    removeInstalledApp: call('apps:remove'),
    openInstalledApp: call('apps:open'),
    openPage: call('nav:open-page'),
    toolbarMenu: call('toolbar:menu'),
    toggleSidebarCollapse: call('sidebar:toggle-collapse'),
    tabstripMenu: call('tabstrip:menu'),
    onPageFrames: on('page:frames'),
    setShortcutRecording: call('shortcuts:recording'),
  });
}

// Interface language: translate the browser's own pages and toolbar in place, right-to-left for
// Arabic. (Runs in this isolated world; the page's DOM is shared.)
if (location.protocol === 'browser:' && window === window.top) {
  const i18n = require('./i18n');
  let locale = null;
  try {
    locale = ipcRenderer.sendSync('i18n:get');
  } catch {
    locale = null;
  }
  if (locale && locale.lang !== 'en') {
    const dict = i18n.compile(locale.strings);
    const start = () => {
      document.documentElement.lang = locale.lang;
      if (i18n.RTL.has(locale.lang)) document.documentElement.dir = 'rtl';
      i18n.watchDom(dict, document);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
}

