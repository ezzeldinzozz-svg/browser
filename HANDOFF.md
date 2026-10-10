# Handoff

Everything needed to pick this project up on any device. **Keep this file current:** update it
in the same commit as any change to features, architecture, setup, or plans.

_Last updated: 2026-10-10 · Current release: v0.22.1 (all platforms: Apple silicon + Intel Mac, Windows, Linux)_

**v0.21.8 added:** balanced outer card frame in vertical tabs mode — restored even 8px insets and rounded 12px corners with border outline and shadow around the webpage view, matching horizontal tabs mode.

**v0.21.7 added:** silky-smooth bookmarks bar hover — hardware-accelerated floating overlay that slides and fades smoothly under the toolbar without resizing or shifting the web page.

**v0.21.6 added:** vertical tabs layout refinement — removed the floating page border frame and insets in vertical tabs so web pages sit flush edge-to-edge against the sidebar and toolbar, while preserving the rounded card border in horizontal tabs mode.

**v0.21.5 added:** full Keyboard Shortcuts editor in Settings with 60+ commands, live search, physical ANSI key normalization, conflict detection, ⌫ unassigning, and restore buttons; compact toolbar option; bookmarks bar appear-on-hover mode; bookmarks bar overflow chevron button (») with native dropdown menu.

**v0.21.4 added:** unified container for top toolbar and vertical sidebar with no divider line, rounded viewport frame, removed Default workspace button.

**v0.21.3 added:** vertical tab sidebar with + New Tab button under latest tab, icons-only collapsed sidebar with hover expand.

**v0.21.2 added:** screenshot capture target chooser (Current Screen, Full Page, Selection).

**v0.21.0 added:** quick answers & commands in the address bar, tab groups, vertical tabs, split view, tab hover previews, workspaces, two-finger swipe navigation, cookie banner auto-reject, fingerprinting protection, screenshot tool, read aloud, in-page translation, Picture-in-Picture in media hub, per-site autoplay exceptions, accent colors & compact mode, keyboard shortcut customization, installable web apps (PWA windows), `navigator.registerProtocolHandler`, single-tab screen sharing, client certificate selection, QR code generator, redesigned tabbed Settings dashboard with pagination, Settings toolbar button, and customizable toolbar buttons.

**v0.20.0 added:** SQLite history + FTS5 search, history retention + clear-on-quit, download resume, mixed-content & insecure-form warnings, unsaved-changes quit confirmation, form-resubmit prompt, Look Up / Speech / Emoji, Bookmarks menu + favicons, extension on/off + hide buttons, proxy settings, offline / Wi-Fi error pages, device chooser, history import + data export, weekly Electron patch workflow, customizable new-tab page, address autofill, multi-profile support, site muting, tracking-parameter stripping, privacy stats, energy saver.

## What this is

**Operecs** (renamed from "Browser" after v0.13.0): a basic cross-platform web browser (macOS, Windows, Linux) built on Electron. Goal right now: a
solid, safe, daily-usable basic browser. Repo: https://github.com/ezzeldinzozz-svg/operecs-browser

## Status

**Done**
- Tabs, address bar (URL or search with the chosen engine: DuckDuckGo default, Google, Bing, Brave, Ecosia, Kagi, Startpage), back/forward/reload/stop, keyboard shortcuts
- Tab strip: drag to reorder, pinned tabs (kept left, restored), audio indicator with click-to-mute, right-click menu (new tab to the right, reload, duplicate, pin, mute, move to new window, close / others / to the right, reopen closed)
- Bookmarks, history, downloads page, find in page, new-tab page, settings page
- Search engines: `allEngines()` = built-ins (keyword = their domain, `BUILTIN_KEYWORDS`) + `settings.customEngines` (`{ name, keyword, url with %s }`, id `custom:<keyword>`); `keywordSearch()` turns "<keyword> <words>" into that engine's search in `resolveInput`, the suggestion row and (skipped) search suggestions
- Closing a web tab runs its beforeunload first: `closeTab` marks `tab.closing`, calls `wc.close({ waitForBeforeUnload: true })` and removes the tab in `finishCloseTab` when the page is destroyed (history is read before). "Stay" in the Leave site? dialog resets `closing`; a 4 s safety net force-closes a page that neither closes nor asks
- macOS: File → Share… / page menu Share… (`sharePage`, ShareMenu); Handoff advertises the focused normal window's page (`updateHandoff`, called from `sendTabs` and window focus)
- Reader mode: after each load `checkReaderable` runs Readability's `isProbablyReaderable` in isolated world 1201 and the toolbar shows the reader button; `toggleReader` extracts the article there, keeps it in memory (`readerArticles`, 30 max, gone after restart) and opens `browser://reader?id=…&url=…`. The page shows the site's HTML only inside a sandboxed srcdoc iframe (no scripts, unique origin) styled by `pages/reader-article.css`; prefs in `settings.reader`. Alt+Cmd/Ctrl+R toggles; the address bar and session save show the original URL
- Shield popup: clicking the shield opens a panel (reuses `#sitepopup` with class `right`) listing hosts blocked on this page (`tab.blockedHosts`, filled by adblock.js `onBlocked(wcId, url)`) and the per-site switch
- Certificates: `onVerifyCertificate` keeps what Chromium verified per host (`certificates`, incl. `certificateDetails`: names, chain, serial, fingerprint, PEM); the site popup's "Show certificate" lists it and Export… saves the PEM
- Notifications: capture-preload.js wraps `window.Notification` in the page (adds the site as the last body line, reports clicks); `notification:click` selects that tab and focuses its window. Service-worker notifications aren't wrapped
- Design (v0.18): same language as the brand / ezzeddin.work — near-black canvas (`#0c0a11`, light `#ecebf1`, private `#120a22`; `CANVAS` in main.js must match `--canvas` in ui/style.css), violet `#9b6cff` with gradient primary buttons, pill controls, violet-glow panels, Outfit + Azeret Mono (OFL; copies in `ui/fonts` and `pages/fonts`, source in `brand/fonts`). Pages are a rounded card (`PAGE_INSET` 8, `PAGE_RADIUS` 12 via `setBorderRadius`) except in page fullscreen. The tab strip is the title bar: macOS `hiddenInset` traffic lights (UI gets `body.mac` / `.fullscreen` via `window:fullscreen`), Windows `titleBarOverlay` (`windowsTitleBar`, recoloured on theme change), Linux framed. Toolbar icons are inline SVG (`.ico`)
- Tab drag between windows: the tab's drag carries `application/x-operecs-tab`; a drop on another window's strip calls `tab:adopt` (`adoptTab`), a drop where nothing accepts (`dropEffect === 'none'`) calls `tab:tear-off` (`tearOffTab`: new window at the cursor unless the cursor is still over the strip)
- Media hub: `media-started-playing` / `media-paused` set `tab.media`; `mediaTabs(w)` goes out with the tab state; the toolbar `#media` button opens a list (reuses `#sitepopup` with class `media`) with play/pause (`media:toggle` → `toggleMedia` runs a small script in every frame) and jump-to-tab
- Theme: Settings → Appearance → Theme sets `settings.theme` → `nativeTheme.themeSource` (also applied at startup and on Reset)
- Notifications: capture-preload.js reports `Notification.permission` "default" / permissions.query "prompt" while the site is undecided (`notification:undecided`); `onPermissionRequest` refuses notification prompts unless the tab had input in the last 5 s (`tab.lastInput`)
- Extensions page: On/Off unloads an extension (`setExtensionEnabled`, keeps `settings.disabledExtensions` with its path; `keepDisabledExtensionsOff` unloads it again when the web store library loads it at startup/update); "Show in toolbar" (`settings.hiddenActions`) is applied by injecting a style into `<browser-action-list>`'s open shadow root (`hideExtensionButtons`). Context menu adds Look Up / Speech (macOS) and Emoji & Symbols; Settings → Languages lists custom dictionary words
- Reloads all go through `reloadTab`. After a main-frame POST (`rememberMainFrameRequest` keeps `uploadData`, `rememberPostType` the Content-Type), Reload asks "Resubmit the form?" and re-sends with `loadURL(url, { postData })` — Electron otherwise cancels POST reloads silently
- Proxy: `settings.proxyMode` (system/direct/manual/pac) + `proxyServer`, `proxyBypass`, `proxyPac` → `applyProxy(ses)` (in `configureSession`, on change, on Reset); proxy sign-in uses the sign-in bar
- Device chooser: `watchDevices(ses)` handles `select-hid-device` / `select-serial-port` / `select-usb-device` (session) and `select-bluetooth-device` (per tab, repeats while scanning) → `showDeviceChooser` → toolbar `#devicepicker` → `device:choose` → `finishDeviceChooser`; chosen devices go into `grantedDevices` (memory) for `setDevicePermissionHandler`; `onPermissionCheck` allows `hid`/`serial`/`usb` checks for https tabs. Testing Serial in `npm start` crashes the dev Electron.app (no NSBluetoothAlwaysUsageDescription in its plist) — test Serial/Bluetooth with a packaged build
- Windows: `build/installer.nsh` (nsis.include) registers Operecs as a browser for the current user (StartMenuInternet + Capabilities + RegisteredApplications + OperecsURL/OperecsHTML ProgIds), kept across updates (`${isUpdated}`), removed on uninstall. Jump List via `app.setUserTasks`; `--new-window` / `--private-window` work at launch and through `second-instance`
- Import/export: `importHistory(source)` copies the other browser's `History` file (it's locked while that browser runs) and reads it with `node:sqlite` (convert `visit_time` in SQL — it overflows JS numbers); `exportAllData` writes bookmarks.html + operecs-data.json to a chosen folder
- Mac builds: arm64 and x64 (`build.mac.target[].arch`). The release script uploads `Operecs-X-arm64.dmg/-arm64-mac.zip` (manifest `latest-mac.json`) and `Operecs-X.dmg/-mac.zip` (manifest `latest-mac-x64.json`); the updater picks the manifest by `process.arch`
- Interface language (**parked: English only** — 'auto' means English and Settings hides the picker; see the comment in `setupUiLanguage`): `settings.uiLanguage` ('auto' | 'en' | 'ar') → `setupUiLanguage()` at startup loads `locales/<lang>.json`. Keys are the English text exactly as shown; `{name}` parts match anything ("Close {n} Tabs"). preload.js asks `i18n:get` and `i18n.watchDom` translates browser:// pages + toolbar in place (text, placeholder/title/aria-label) with a MutationObserver, skipping user/site content (`USER_CONTENT` selectors); `dir=rtl` for Arabic. main.js wraps `Menu.buildFromTemplate` and `dialog.showMessageBox(Sync)` so menus/dialogs translate too. To add a language: copy locales/ar.json, translate, add it to `UI_LANGUAGES`. Strings built from several pieces (or not in the file) stay English — add them to the locale file as you find them
- History: `history-db.js` keeps it in `History.sqlite` (profile folder) with `node:sqlite`: `visits` (one row per visit), `pages` (per URL: latest title, count, last visit — address-bar suggestions, new tab tiles, History menu), `visits_fts` (FTS5 over title + URL, kept in sync by triggers — History page search). Capped at 200k visits. Old profiles' `history` array in browser-data.json is moved in once at startup. The History page asks for pages of 300 (`data:history` with `{ query, before }`)
- Security updates: `.github/workflows/electron-patch.yml` (Mondays, or run it by hand) opens a PR `electron-X.Y.Z` bumping the pinned Electron patch and starts `build.yml` on it (PRs made with GITHUB_TOKEN don't trigger CI otherwise). `--critical` on a release adds `critical: true` to the manifests (unsigned on purpose — it only makes a genuine update more urgent); `onUpdateState` in main.js then asks to restart and restarts by itself after 10 minutes. The release script smoke-tests the Mac build before publishing (CI has no Mac job)
- Mixed content / insecure forms: adblock's `beforeRequest` hook also runs `noteMixedContent` (http subresource on an https page → `tab.mixedContent`, security state `mixed`, amber icon + a line in the site popup) and `checkInsecureForm` (HTTPS-Only off: a main-frame http POST from an https page is cancelled and asked about; "Send Anyway" re-sends the form data with `loadURL(..., { postData })`; "Go Back" returns to the form — `tab.heldForm` makes did-fail-load go back instead of showing an error)
- Unsaved changes on window close / quit: capture-preload.js records each page's `beforeunload` handlers (wraps `addEventListener`) and exposes `window[Symbol.for('operecs.wouldWarnOnUnload')]`, which runs them with a fake event (only after user activation). `unsavedTabs()` asks every frame, `confirmUnsaved()` shows one "Leave site?" naming the tabs. Quit checks only for our Quit menu item / Cmd+Q (`userQuitRequested`), never for shutdown or signals
- Bookmark icons: `rememberBookmarkIcon` stores a 32px PNG data: URL on every bookmark node of the page's URL (`bookmarks.setIcon`) when its favicon loads or it's bookmarked; `summary()` includes `icon`. The Bookmarks menu (`bookmarkMenuItems`) lists the bar and Other Bookmarks as submenus, rebuilt on bookmark changes
- Retention: `settings.historyKeepDays` → `pruneOldHistory()` at startup, every 6 h and on change. `settings.clearOnQuit` ({history, downloads, cookies, cache}) is applied in `before-quit` (prevents the quit, clears, quits again) — on every quit, including shutdown
- Download resume: each record keeps `savePath` and `resume` ({urlChain, mimeType, etag, lastModified, startTime}). Retry (`retryDownload`) resumes the live interrupted item, or after a restart re-creates it with `createInterruptedDownload` (`pendingResumes` routes it back to its old entry in `onWillDownload`). Chromium deletes unfinished files on quit, so `keepPartialDownloads` (before-quit) hard-links them to `<file>.operecs-part`; clearing the entry deletes them
- What's new: release notes live in `pages/changelog.json`. Add user-visible changes to `"next"` as they land; `npm run release` renames `next` to the version (and refuses to release with no notes). At startup, if `store.data.lastVersion` differs from the running version, a `browser://whatsnew` tab opens
- New tab customization: `settings.newtab` ({background: none|color|image, color, showTiles, showBookmarks}), `settings.pinnedTiles` (first in `topSites()`), image in `newtab-background.jpg` (profile folder, ≤2560px JPEG) served by `newtab:background`. Site icons for tiles live in History.sqlite `icons` (site → 32px data: URL, saved in `rememberBookmarkIcon` when a page's favicon loads). Internal files are served with `cache-control: no-store` so an update never shows stale CSS/JS
- Address autofill: `store.data.addresses`. capture-preload.js (top frame, isolated world) classifies fields (`autocomplete`, then name/id/label patterns; skips card/password/login fields), reports focus (`autofill:show` with the field's rect), fills on `autofill:fill` (prototype value setter + input/change events, so React etc. notice), and offers `autofill:offer` on submit. The list is `w.autofillView` (ui/autofill.html, a small WebContentsView over the page — the page never sees addresses until one is picked). "Save this address?" reuses the prompt bar (`kind: 'save-address'`, `keepOnce` survives the submit's navigation)
- Profiles: `profiles.json` in the main profile folder lists them ({id, name, color}; `main` is the original profile). Others live in `<main>/Profiles/<id>` and run as their own process started with `--profile=<id>` (`openProfile` spawns `process.execPath`; the single-instance lock is per profile folder, so a running profile just gets focused). The arg is read at startup, before `app.setPath('userData', …)`. Only the main profile runs the updater. Toolbar `#profile` shows the initial on the profile color (`profile` in the tab state) and opens `showProfileMenu`
- Small privacy/battery bits & quick answers: `settings.mutedSites` (tab menu "Mute <site>", applied on did-navigate), `stripTrackingParams` in the adblock `beforeRequest` chain (main-frame GETs; `TRACKING_PARAMS` + `utm_*`), `store.data.stats` counted in `onBlocked` (normal windows) for the new tab line, energy saver in the memory-saver timer (`powerMonitor.isOnBatteryPower()` → 10-minute limit), and `quick-answers.js` wired into `suggestions()` / `ui/ui.js` (calculator, unit conversion, and quick commands like "settings" / "clear history" via `suggest:command`)
- Tab groups, vertical tabs, split view, workspaces & hover previews: `w.groups` (named, 7 colors, collapsible, saved in session), `settings.verticalTabs` (200px left sidebar in `ui/style.css` + `sidebarWidth(w)` in `layout()`, collapsible to 48px icons-only via `#sidebar-toggle` / `settings.verticalTabsCollapsed`, expands on hover over the page via `sidebar-hover` / `settings.verticalTabsExpandOnHover`, with `#newtab` directly under the latest tab via `settings.verticalNewTabUnderTabs`), `w.splitTabId` (two `WebContentsView`s side by side in `layout()`), `w.workspaces` / `w.currentWorkspace` (saved in session, `#workspace` pill + `showWorkspaceMenu`), and `tab:preview` (`captureTabPreview` caches a 320px thumbnail per tab and renders `#tabpreview` on hover)
- Privacy & security extras: `settings.rejectCookies` (auto-clicks reject/decline buttons on common CMPs in `capture-preload.js`), `settings.fingerprintingProtection` (deterministic per-session/per-origin Canvas 2D noise, standardized WebGL unmasked vendor/renderer, AudioBuffer noise, and clamped `hardwareConcurrency`/`deviceMemory` via `site:features` sync IPC), per-site `'autoplay'` permission (blocks `HTMLMediaElement.prototype.play` before user activation when set to `'block'`), `navigator.registerProtocolHandler` (`protocol:register` prompt + `resolveProtocolUrl` + Settings → Protocol handlers), single-tab screen sharing in `#screenpicker` (`tabSources` with `mainFrame`), and client certificate selection (`app.on('select-client-certificate')` dialog)
- Page tools, appearance, PWAs & customizable toolbar: Screenshot tool (`takeScreenshot`: visible area, interactive selection overlay `screenshot:select-start`, or full-page stitched scroll capture `captureFullPage`), Read Aloud (`speech:toggle` floating Web Speech API pill on web pages + Listen button in `browser://reader`), in-page translation (`translate:toggle` + `translate:batch` via Lingva/MyMemory), Picture-in-Picture button in the `#media` popup (`media:pip`), QR code generator (`qr.js`, zero-dependency SVG QR in `#sitepopup`), accent color swatches (`violet`, `blue`, `emerald`, `amber`, `rose`, `cyan`) & `compactMode`, customizable keyboard shortcuts on `browser://shortcuts` (`settings.shortcuts` + `acc()`), installable web apps (`installSiteAsApp` → standalone chromeless `createAppWindow` + `--app=<url>`), customizable toolbar buttons (`settings.toolbarButtons`, `TOOLBAR_BUTTON_DEFAULTS`, right-click `#toolbar` → `toolbar:menu` or visual grid in Settings → Appearance & Toolbar, including `#settings-btn`), and tabbed Settings dashboard (`main.settings-shell` with 6 category tabs, cards, cross-tab search, and `renderPaginatedList` pagination)
- Testing: `node scripts/feature-test.js` (after `npm run build`) runs the dev app on a throwaway profile and checks 24 features end to end over DevTools (browsing, tracker stripping, address-bar answers, history search, bookmarks, reader, form resubmit, autofill, unsaved-changes prompt, internal pages, split view, vertical tabs, page isolation, certificate errors). Run it before every release. `scripts/smoke-test.js` checks a packaged build (the release script runs it)
- Security review 2026-10-10 (Antigravity's v0.21 work): fixed — link handlers (`registerProtocolHandler`) are now validated in the main process too (spec safelist or `web+…`, https handler on the page's own origin); page translation (Google Translate's `translate.googleapis.com`) asks once before the first use, never runs in private windows, and is listed in the privacy page; swipe and screenshot-selection listeners ignore synthetic events
- User agent (2026-10-10): the default is honest — Chrome's plus `Operecs/x.y.z` and `Electron/…` (`DEFAULT_UA`). Presenting as plain Chrome made Cloudflare's bot check loop forever ("Verifying you are human" on futbin.com): it expects Chrome-only features Electron lacks, and the "Electron" token is what makes it relax. Google sign-in refuses "Electron", so `accounts.google.com` / `accounts.youtube.com` get the plain Chrome UA (`CHROME_UA`, major version only like real Chrome) both as the request header (onBeforeSendHeaders) and in `navigator.userAgent` (`syncUserAgent` on each main-frame navigation, tabs and popups). We also send the low-entropy `sec-ch-ua*` headers ourselves (`addClientHints`; Chromium drops them under a UA override). capture-preload.js fills in `window.chrome.app/csi/loadTimes` and makes Operecs' page wrappers report as built-in functions (`Symbol.for('operecs.native')`). Test Cloudflare without DevTools attached (remote debugging is itself detected): drive the app through the main-process inspector only
- Multi-tab selection: Cmd/Ctrl-click toggles, Shift-click selects a range (`w.multi`, `clickTab`); the tab menu then acts on all of them (reload, duplicate, pin, mute, move to new window, close) and Cmd/Ctrl+W closes them. `selectTab(w, id, keepSelection)` clears the selection unless asked not to; the extensions library calls back `selectTab` when we select a tab, so that callback only acts when the tab isn't already active
- Automatic downloads: a page gets one download on its own; `allowAutomaticDownload` resets on a click/keypress in the page (`input-event`) and otherwise asks with the normal permission bar ("download multiple files", site permission `automatic-downloads`). Cancelled downloads restart via `userDownload()` when allowed; Save As/Retry also go through `userDownload()` so they're never counted
- Cookies and site data (Settings): `siteDataList` groups cookies by site (`siteKey`, a small heuristic instead of the public suffix list); Remove deletes that site's cookies and clears storage for each host (https and http); Remove all clears every kind of storage. Only sites with cookies can be listed (Chromium doesn't enumerate other storage)
- Search suggestions (opt-in, `searchSuggestions`): `searchSuggestions()` fetches the engine's OpenSearch suggest URL from a separate in-memory session without cookies, never in private windows; the UI adds them asynchronously (`suggest:search`) below the typed row and opens them with `nav:search`
- International domains: `readableHost()` shows punycode hosts in Unicode only when `idnLooksSafe()` passes (no mixed scripts except Latin+CJK combos, no all-Cyrillic Latin lookalikes)
- History menu lists the focused window's recently closed tabs and the last 10 visited pages (`recentMenuItems`, rebuilt via `rebuildMenuSoon()`)
- Downloads: an http download started from an https page is blocked with a "Download Anyway" dialog (`isInsecureDownload`)
- Proxy sign-in uses the same sign-in bar as HTTP auth ("Sign in to proxy host")
- HTTPS-Only: `adblock.js` exposes a `beforeRequest` hook (Electron allows one onBeforeRequest per session); `upgradeToHttps` rewrites main-frame http:// to https:// and remembers it on the tab, so a failed upgrade shows `browser://error?desc=https-only` with "Continue to site" (session-only exception)
- Memory saver: background tabs past the idle limit are put to sleep like restored tabs (`tab.pending` + about:blank); task manager at `browser://tasks` (`app.getAppMetrics` mapped to tabs/extensions)
- Languages: `applyLanguages()` sets Accept-Language (via `setUserAgent`) and spellcheck per session
- Popups: `window.open` with size features (`disposition: 'new-window'`) becomes a real popup BrowserWindow (keeps `window.opener` for sign-in flows; title shows the site; its links open as tabs); everything else opens as a tab
- Settings live in `defaultSettings()` (also used by Reset); autoplay policy and default zoom apply to newly opened pages; settings page has a search box
- New tab page: most-visited tiles from history (`topSites()`), hide with ×
- Privacy/network: Global Privacy Control (Sec-GPC header via `webRequest.onBeforeSendHeaders`, `navigator.globalPrivacyControl` via capture-preload.js), secure DNS (`app.configureHostResolver`)
- Store safety: each save keeps the previous file as `browser-data.json.bak`; an unreadable file is renamed `.damaged-<time>` and the backup is loaded
- Help menu: `browser://shortcuts`, report a problem, privacy, `browser://licenses` (npm licenses generated into `gen/licenses.json` by `scripts/build.js`; Chromium's `LICENSES.chromium.html` bundled via `extraResources`)
- Media context menu (play/pause, mute, loop, controls, picture in picture, save/copy); history grouped by day with "Remove site"; downloads Retry and remove entry; Bookmark All Tabs
- Address bar: "Switch to tab" suggestions, Paste and Go (its context menu is built in main; note `clipboard.readText()` is async in this Electron), Shift+Delete removes a history suggestion; Cmd/Ctrl+Shift+A searches open tabs
- Restored tabs are lazy: background tabs keep their saved history in `tab.pending` and load on first select (the session saver uses `tab.pending` as their history)
- "Close N tabs?" / "Quit with N tabs open?" only for quits the user asks for (our own Quit menu item sets `userQuitRequested`); signals, shutdown and updates never ask. Save Page As (HTML / MHTML / PDF)
- Chrome extensions (`electron-chrome-extensions` + `electron-chrome-web-store`): normal-window tabs are registered with the extension system (`extensions.addTab/selectTab`), which calls back into our createTab/selectTab/closeTab/createWindow; `<browser-action-list>` in the toolbar shows extension buttons for the active tab; installing from chromewebstore.google.com asks first (`beforeInstall`); `browser://extensions` lists/removes. Private windows have no extensions. **No built-in password manager, by decision**: passwords come from extensions like Bitwarden
- Startup: continue where you left off / New Tab page / specific pages (`settings.startup`); `cleanExit` in the store detects crashes and offers "Restore pages" from a snapshot taken before new windows overwrite the session
- First run (no profile file yet) opens `browser://welcome` (default browser, import, search engine, privacy); `browser://privacy` and `PRIVACY.md` list all network traffic
- Optional Home button and home page; F6 toolbar ⇄ page; tab strip arrow keys
- Privacy: third-party cookies blocked by default via Chromium's `--test-third-party-cookie-phaseout` switch (read from the profile before ready; changing it needs a restart); Storage Access API requests go through the permission prompt. Permission defaults per type (Ask/Block) and editable per-site exceptions in Settings
- Camera/mic/screen in-use: `capture-preload.js` (a session preload in every web frame) wraps getUserMedia/getDisplayMedia via `contextBridge.executeInMainWorld` and reports live tracks; tab dot + "● Camera · Stop" pill. Best effort: the OS indicators are the authoritative ones
- Bookmarks are a tree (`bookmarks.js`, stored as `bookmarkTree` with fixed roots `bar` and `other`; v0.5 flat lists migrate into the bar). Star opens an edit popup (name, folder, Remove); bookmarks bar under the toolbar (Cmd/Ctrl+Shift+B) with native folder menus, right-click menus and drag-and-drop; manager page with folders, search, edit/move/delete; import from Chromium browsers' `Bookmarks` JSON or any bookmarks HTML; export to HTML
- Toolbar polish: unfocused address shows `site.com/path` with the site highlighted; link-hover URL bubble bottom-left (a small `statusView` per window, `ui/status.html`); tab strip scrolls when full; downloads panel from the ↓ button
- Page robustness: crash page with Reload, "Page unresponsive" (Wait / Exit Page), "Leave site?" on navigation for pages with unsaved changes
- Back/forward history list (right-click or long-press), per-site zoom remembered (badge in the address bar resets it), window size/position remembered
- Downloads: choose the download folder, optional "Ask where to save each file"; history page can remove single entries
- Default browser: macOS registers http/https and HTML files (`build.protocols`, `build.fileAssociations`); Settings has a "Make default" button (installed app only). Links from other apps arrive via `open-url` (macOS) or launch/`second-instance` arguments (Windows/Linux) and open in the last normal window
- Screen sharing: macOS 15+ uses the system picker (`useSystemPicker`); elsewhere a picker of screens/windows in the toolbar view
- Clear browsing data (Settings → Clear browsing data, Cmd/Ctrl+Shift+Backspace): time range for history and the download list; cookies/site data and cache clear for all time (Electron can't clear them by date)
- Downloads: risky file types (.exe, .dmg, .pkg, .sh, …) download as `.unconfirmed` until the user picks Keep/Discard in a toolbar bar or the downloads page; every finished download gets the macOS quarantine attribute / Windows Mark of the Web, which Electron doesn't set by itself
- Address bar: suggestions from history + bookmarks (frequency/recency ranking), inline completion, arrow keys / Enter / Esc; lock icon or "Not secure" opens a site info popup (connection, certificate issuer/expiry, per-site permissions, ad blocking switch, clear site data)
- Toolbar dropdowns/popups: while one is open the transparent toolbar view is stretched over the whole window (`ui:overlay`), and clicks outside close it
- Per-site permission prompts (camera, mic, location, notifications, clipboard, MIDI, external apps), remembered per site, resettable in Settings
- HTML video fullscreen
- HTTP sign-in bar (username/password for sites using HTTP auth), with a warning on plain http
- Right-click menus: links (open in background tab, copy), images (open, copy, save), text (copy, search), editable fields (spelling fixes, cut/copy/paste), page (back/forward/reload, print, view source), Inspect Element; edit menu in the toolbar's text fields
- Multiple windows (Cmd/Ctrl+N); all normal windows and their tabs restored on launch; on macOS the app stays open with no windows (Dock click or Dock menu opens one)
- Private windows (Cmd/Ctrl+Shift+N): purple frame, separate in-memory session per window, nothing recorded (history, session, permissions, downloads list), all data wiped when the window closes
- Ad & tracker blocking (Ghostery engine, EasyList/EasyPrivacy, lists refreshed weekly and cached in the profile): toolbar shield shows the blocked count and turns blocking off per site; global switch in Settings
- Print (Cmd/Ctrl+P), session restore with back/forward history (toggle in Settings), Reopen Closed Tab (Cmd/Ctrl+Shift+T); links opened from a page line up next to it
- Security: sandboxed tabs, private `browser://` pages that websites can't reach, favicons fetched in the main process, certificate-error page with no bypass, single-instance lock, hardened Electron fuses in packaged builds
- macOS packaging (ad-hoc signed DMG) and a free self-updater using our own Ed25519 key + GitHub Releases (tested end to end: 0.1.9 → 0.2.0). Visible status: a toolbar pill shows "Updating… N%" while downloading and "Restart to update" when ready; Settings → About Browser shows the version, last check and a Check for updates button

**Known issues**
- Restored tabs may show pages from cache (same as Chrome), including pages that needed a sign-in
- Popups that need `window.opener` (some OAuth logins) open as plain tabs
- Google sign-in may block Electron despite the Chrome user agent
- No DRM (Netflix/Spotify), no Chrome extensions (Electron limits, see research)
- Windows/Linux builds pass automated smoke and self-update tests in CI but haven't been used by a person yet; the Linux .deb doesn't auto-update (no apt repository), the AppImage does
- Name: shown as **Operecs** everywhere (`productName`, `DISPLAY_NAME` in main.js, pages). Internally it stays "Browser" on purpose: `app.setName('Browser')` keeps the profile folder and the "Browser Safe Storage" keychain item, the bundle id stays `com.ezzeddinmagdy.browser`, the npm `name` stays `browser` (Windows install folder) and the Linux executable stays `browser`. The Mac updater renames `Browser.app` to `Operecs.app` when it installs. Don't change these without a migration.
- Icon: `build/icon.png` (1024px, "O." in Outfit 600 on #0b0910, lavender #c5abfe dot); electron-builder makes the .icns/.ico from it. Wordmark and fonts in `brand/`
- iCloud Passwords can't work: Apple's native helper (`PasswordManagerBrowserExtensionHelper`) has a kernel-enforced *parent launch constraint*. It only runs under a hard-coded list of browsers (bundle id + Team ID: Chrome, Edge, Brave, Arc, Vivaldi, Polypane (Electron), …) or apps signed with the restricted entitlement `com.apple.developer.web-browser.public-key-credential` (needs the paid Apple Developer Program plus Apple's approval; that is how Aside gets it). A self-signed app can't hold restricted entitlements. The extension's failed pipe write used to crash the app (EPIPE); main.js now ignores closed-pipe errors
- macOS asks once for keychain access ("Browser Safe Storage", the cookie-encryption key) when moving to v0.4.0, the first build signed with our self-signed certificate. Choose "Always Allow"; later versions keep the same identity and shouldn't ask again
- Ad blocking: prebuilt lists skip generic cosmetic rules (site-specific hiding works); no details popup yet

## Roadmap

**Focus (decided 2026-10-09): Apple silicon Mac, English only, until we decide to go public.**
Windows, Linux, Intel Mac and translations are parked: their code stays and CI still builds
Windows/Linux, but don't extend or test them. The working list is `FEATURES.md` (the user edits
it: must have / should have / nice to have / blocked / parked); the old all-platform checklist is
`research/features-archive.md`. Work top to bottom through "must have for 1.0".

Blocked or decided against (don't pick up without the user):
- Passkeys, Developer ID signing/notarization, iCloud Passwords: need the paid Apple Developer Program (the user's enrollment was under review on 2026-10-09). iCloud Passwords also needs Apple to grant `com.apple.developer.web-browser.public-key-credential`
- Windows code signing (SignPath for OSS or a paid certificate)
- DRM (Netflix/Spotify): castLabs Electron fork + Widevine signing
- Safe Browsing: Google Web Risk is paid
- Built-in password manager: the user wants none (extensions only)
- Opt-in crash reporting: needs a Sentry/Backtrace account

See `research/browser-lessons.md` for the full research on how Brave and others are built.

## Architecture

| File | Role |
|---|---|
| `main.js` | Main process: windows (normal/private), tabs (one `WebContentsView` each), layout, permissions, downloads, find, menu, IPC, `browser://` protocol, session restore |
| `bookmarks.js` | Bookmark tree (folders, bar/other roots), migration from the flat v0.5 list, Chromium JSON and HTML import, HTML export |
| `adblock.js` | Ad/tracker blocking: loads/caches the Ghostery engine, hooks it into each session's `webRequest`, serves cosmetic filters to its preload |
| `preload.js` | Exposes `window.browserAPI` only to `browser://` pages; main re-checks every IPC sender. Bundled with esbuild into `gen/preload.js` (`npm run build`, run by `npm start`/`dist`/`release`) because it imports the extension toolbar element |
| `updater.js` | Self-updater: macOS (swap the .app), Windows (silent NSIS reinstall), Linux AppImage (swap the file) |
| `update-format.js` | What update signatures sign (`signature2`: platform + version + file + SHA-256); shared by the app and release scripts |
| `ui/` | Toolbar UI, served at `browser://ui/` (tab strip, address bar, permission bar, find bar) |
| `pages/` | Internal pages at `browser://<name>/` → `pages/<name>.html` (newtab, history, bookmarks, downloads, settings, error) |
| `scripts/after-pack.js` | electron-builder afterPack hook: flips fuses (`scripts/fuses.js`), then signs the mac app with our self-signed certificate |
| `scripts/fuses.js` | Locks down the packaged Electron binary (no RunAsNode, asar-only with integrity check, cookie encryption…) |
| `scripts/keygen.js`, `scripts/release.js` | Release signing key setup, and build+sign+publish |

Key decisions:
- **License: GPL-3.0-or-later** since v0.10 (required by `electron-chrome-extensions`, which is GPL-3.0; up to v0.9 the project was MIT).
- **Electron over Rust/system webview:** same Chromium engine on all three OSes; Linux webviews are weak. Revisit only if "lightweight/native" becomes the product's identity.
- **Security model:** websites never get the IPC API; only `browser://` pages do, checked by sender in main. Websites can't navigate/frame/redirect to `browser://`.
- **Updates without paid certificates:** our own Ed25519 signatures. `signature2` covers platform, version, file name and SHA-256, so an older signed file can't be passed off as newer; Mac manifests also keep the original signature (over the zip) for copies older than v0.11. On macOS the update must also be code-signed by the same certificate as the running app. Each platform has its own manifest: `latest-mac.json`, `latest-win.json`, `latest-linux.json`.
- **Self-signed code signing certificate** ("Browser Self-Signed Code Signing", 10 years): gives every build the same code identity, so the keychain trusts updates. It isn't trusted by Gatekeeper, so the first-install warning remains until we pay for a Developer ID.
- **Versioning:** semantic versioning. PATCH (0.4.**1**) for fix-only releases (the `npm run release` default), MINOR (0.**5**.0) when a release adds features, MAJOR 1.0 when it's ready for everyday users.
- **Private windows** use `session.fromPartition('private-N')` (no `persist:` prefix = memory only), one partition per window, cleared on close. Their pages must be closed explicitly when the window closes (views don't close with the window).
- **Ad blocking** wires Ghostery's engine in ourselves instead of `enableBlockingInSession()`, which registers fixed IPC channels (one session only) and has no per-site switch.
- User data lives in the OS app-data folder (`~/Library/Application Support/Browser/browser-data.json` on macOS), not in the app, so it survives updates.

## Setting up on a new device

```bash
git clone https://github.com/ezzeldinzozz-svg/operecs-browser.git
cd browser
npm install
npm start
```

Requirements: Node 22+, git, GitHub CLI (`gh`) logged in as `ezzeldinzozz-svg`. Building the
macOS DMG needs a Mac (Apple Silicon builds are arm64).

**To publish releases from the new device**, also:
1. Copy the whole `~/.browser-release/` folder from the old device (via a password manager or USB,
   **never** commit it or send it in chat). Keep it at the same path, permissions `700`/`600`. It holds:
   - `update-private-key.pem`: signs updates. If lost, installed copies can't auto-update and
     users must reinstall a build signed with a new key (`npm run keygen` after deleting the old public key).
   - `codesign.p12` + `codesign-p12-password.txt` + `codesign-cert.pem`: the code signing certificate.
     Import it on the new Mac:
     ```bash
     security import ~/.browser-release/codesign.p12 -k ~/Library/Keychains/login.keychain-db -P "$(cat ~/.browser-release/codesign-p12-password.txt)" -T /usr/bin/codesign
     ```
     If it's lost, builds fall back to ad-hoc signing and installed copies (v0.4.0+) reject those
     updates; users would need to reinstall once from a DMG signed with a new certificate.
2. If more than one GitHub account is logged into `gh`, make pushes from this repo use the right one:
   ```bash
   git config --add credential.https://github.com.helper ""
   git config --add credential.https://github.com.helper '!f() { test "$1" = get && echo username=ezzeldinzozz-svg && echo "password=$(gh auth token --user ezzeldinzozz-svg)"; }; f'
   ```
3. Commits use the private GitHub noreply address:
   ```bash
   git config user.name "ezzeldinzozz-svg"
   git config user.email "282520688+ezzeldinzozz-svg@users.noreply.github.com"
   ```

## Everyday commands

| Command | What it does |
|---|---|
| `npm start` | Run in development |
| `npm run dist:mac` | Build `dist/Browser-<version>-arm64.dmg` without publishing |
| `npm run release` | Bump patch version, tag and push (CI builds Windows/Linux), build the Mac app, download CI's packages, sign all update manifests, publish one GitHub release for all platforms. Takes ~20–30 min (CI + uploading ~600 MB) |
| `npm run release -- 0.3.0` | Release a specific version |
| `npm run release -- 0.3.0 --critical` | Security fix: installed copies ask to restart now and restart by themselves within 10 minutes |
| `npm run release -- 0.3.0 --all-platforms` | Also Intel Mac + Windows/Linux from CI (parked; default is Apple silicon only) |

Release needs a clean git tree. Uploading the DMG and zip (~130 MB each) can take 10+ minutes;
run it somewhere that won't time out. If the upload is interrupted, GitHub leaves the release as a
**draft** (invisible to installed apps, so nothing breaks). Finish it with:
```bash
export GH_TOKEN=$(gh auth token --user ezzeldinzozz-svg)
gh release upload vX.Y.Z dist/Operecs-X.Y.Z-arm64-mac.zip dist/Operecs-X.Y.Z-arm64.dmg dist/latest-mac.json --repo ezzeldinzozz-svg/operecs-browser --clobber
gh release edit vX.Y.Z --repo ezzeldinzozz-svg/operecs-browser --draft=false --latest
```
 Electron is pinned (currently 44.7.0): bump patch versions
regularly for security fixes, then release.

## CI (GitHub Actions)

`.github/workflows/build.yml` runs on every push to `main` and on pull requests: it builds the
Windows installer (`Browser-Setup-<version>.exe`) and the Linux AppImage + `.deb` on real
runners, starts each build with `scripts/smoke-test.js` (toolbar, new tab, extension element,
navigation, API isolation, settings, ad-block lists), and uploads the packages as run artifacts.
It also runs a real self-update on Windows and Linux: it installs an old build (0.0.1), serves the
current build as an update signed with a throwaway key from a local server (`BROWSER_UPDATE_TEST=1`
plus `BROWSER_UPDATE_URL`/`BROWSER_UPDATE_KEY`, honored only together), clicks "Restart to update"
and checks the new version is installed and running.

Release tags (`v*`) run the same workflow; `npm run release` waits for it, downloads the Windows
and Linux packages, signs every platform's update manifest locally and publishes them with the Mac
build. The signing keys never leave the Mac.

## Testing notes

- **Packaged app on a test profile:** `BROWSER_PROFILE_DIR=/tmp/some-dir dist/mac-arm64/Browser.app/Contents/MacOS/Browser`.
  Note: any build with a new signature makes macOS show the keychain prompt on the user's screen.
- **Profiles:** `npm start` uses its own profile (`~/Library/Application Support/Browser Dev`). The
  installed app uses `~/Library/Application Support/Browser`. Never delete or edit the installed
  app's profile while testing; it holds the user's real bookmarks/history/permissions.

- Most testing is scripted over the Chrome DevTools Protocol: run `npm run build` once, then launch with
  `npx electron . --remote-debugging-port=9333` and evaluate in `browser://ui/` or a tab.
- If the window is hidden behind other windows on macOS, renderer sizes look stale; add
  `--disable-features=MacWebContentsOcclusion` when testing layout.
- Main-process debugging: `npx electron . --inspect=9229 --remote-debugging-port=9333` (flags after `.`).
  Native menus block the app while open, so tests replace `Menu.prototype.popup` via the inspector
  to record items instead, and call `webContents.emit('context-menu', …)` with synthetic params.
- Updater test: build an older copy with
  `npx electron-builder --mac dir --publish never -c.extraMetadata.version=0.1.9`, copy the
  `.app` to a writable temp folder, run it, and wait for "Restart to update".
