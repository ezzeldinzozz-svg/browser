# Feature checklist

What a modern desktop browser needs, benchmarked against Chrome, Safari, Firefox, Brave and Arc.
Checked items exist in the code today (v0.4.0, audited 2026-10-09 against `main.js`, `updater.js`,
`ui/`, `pages/`, `scripts/`). See `HANDOFF.md` for status and `research/browser-lessons.md` for background.

**Legend:** `[x]` done · `[ ]` not done · **P0** basic, users notice it's missing in the first hour ·
**P1** expected soon · **P2** nice to have / later · *(in progress)* being built now ·
*(Electron limit)* blocked or costly because of Electron.

## Top 15 next

Ordered by priority, then by what unblocks what.

1. ~~Private windows~~ done in v0.4.0
2. ~~Built-in ad/tracker blocking with per-site toggle~~ done in v0.4.0 (a shield popup with details is still open)
3. **P0** macOS "app stays open with no windows" (multiple windows are done in v0.4.0)
4. **P0** Storage: JSON → SQLite, needed before address-bar autocomplete, history ranges, passwords and sync
5. **P0** Address-bar autocomplete from history + bookmarks, with a dropdown and keyboard selection
6. **P0** Search engine choice (DuckDuckGo, Google, Bing, Brave, Ecosia, Kagi, custom) in Settings
7. **P0** Site info popup: lock/"Not secure" icon in the address bar, with permissions, cookies and certificate
8. **P0** Clear browsing data dialog (history, cookies/site data, cache, downloads; time ranges)
9. **P0** Tab context menu: duplicate, pin, mute, reload, close others/to the right, move to new window
10. **P0** Tab drag-to-reorder, plus an audio-playing/muted indicator on tabs
11. **P0** Dangerous download warning (.exe, .dmg, .pkg, scripts) and a "Save as / always ask where" option
12. **P0** Open links from other apps / set as default browser (`open-url`, `second-instance` argv, protocol registration)
13. **P0** Bookmarks bar, bookmark folders, edit bookmark dialog, import from Chrome/Safari/Firefox (bookmarks + history)
14. **P0** Windows/Linux builds tested, with their own updaters; macOS Developer ID signing + notarization
15. **P0** Screen-sharing picker (`setDisplayMediaRequestHandler`) and camera/mic-in-use indicators

---

## 1. Navigation & tabs

- [x] Tabs with title, favicon and loading spinner
- [x] New tab (Cmd/Ctrl+T), close tab (Cmd/Ctrl+W), middle-click to close
- [x] Next/previous tab (Ctrl+Tab / Ctrl+Shift+Tab), Cmd/Ctrl+1…9 to jump
- [x] Reopen closed tab (Cmd/Ctrl+Shift+T), restored to its old position with back/forward history
- [x] Links opened from a page open next to it (opener-ordered)
- [x] Open link in background tab (context menu; Cmd/Ctrl+click via `background-tab` disposition)
- [x] Back / forward / reload / stop / hard reload (Cmd/Ctrl+Shift+R)
- [x] Popups (`window.open`) open as tabs; navigation to `browser://` from websites blocked
- [ ] **P0** Tab context menu (right-click a tab): reload, duplicate, pin, mute, close others / to the right, move to new window
- [ ] **P0** Drag tabs to reorder
- [ ] **P0** Audio-playing indicator on tabs, click to mute; "Mute site"
- [ ] **P0** Duplicate tab
- [ ] **P0** Tab overflow handling (shrink, then scroll) with many tabs; tab tooltips with URL
- [ ] **P0** Long-press / right-click back and forward buttons for the history list
- [ ] **P1** Pin tabs (small, left-aligned, survive restart)
- [ ] **P1** Move tab to new window / tear off by dragging out; drag a tab into another window
- [ ] **P1** Tab search (Cmd/Ctrl+Shift+A style list of open tabs, also matched in the address bar: "Switch to tab")
- [ ] **P1** Close multiple selected tabs (Shift/Cmd-click to select)
- [ ] **P1** Popups that need `window.opener` (OAuth sign-in) open as real popup windows (known issue)
- [ ] **P1** Swipe / two-finger gesture for back and forward (macOS `swipe` event)
- [ ] **P2** Tab groups (named, colored, collapsible, saved)
- [ ] **P2** Vertical tabs / sidebar layout (Arc, Edge, Brave)
- [ ] **P2** Split view (two tabs side by side)
- [ ] **P2** Tab hover preview cards

## 2. Windows

- [x] Windows with a hardened toolbar view and one `WebContentsView` per tab
- [x] Single-instance lock: launching again focuses the existing window
- [x] Window full screen (Ctrl+Cmd+F / F11) and HTML video full screen
- [x] Multiple windows: New Window (Cmd/Ctrl+N), Close Window (Cmd/Ctrl+Shift+W), each with its own tabs; all normal windows restored on launch
- [ ] **P0** macOS: closing the last window keeps the app running; Dock click reopens a window (today closing quits)
- [x] Private window (Cmd/Ctrl+Shift+N): purple frame, in-memory session per window, no history/session/permission/download records kept, wiped on close; "Open Link in Private Window"
- [ ] **P0** Remember window size/position (per-window tabs are already restored)
- [x] Window menu (macOS): list windows, Minimize, Zoom, Bring All to Front
- [ ] **P1** Native-feeling title bar: tabs in the title bar with traffic lights (macOS `titleBarStyle: hiddenInset`), Windows overlay controls
- [ ] **P1** "Close window with N tabs?" / "Quit with N tabs?" confirmation (opt-out)
- [ ] **P2** Picture-in-picture-like floating "mini window" for a tab (Arc Little Arc)

## 3. Address bar (omnibox)

- [x] URL or search detection; `localhost`/IP get `http://`, domains get `https://`
- [x] Search via DuckDuckGo (fixed)
- [x] Select-all on focus, Esc to revert, Cmd/Ctrl+L to focus
- [x] Edit context menu (cut/copy/paste/select all) in toolbar fields
- [ ] **P0** Autocomplete dropdown from history and bookmarks (frecency ranking, inline completion)
- [ ] **P0** Search engine choice in Settings (and in onboarding)
- [ ] **P0** Security indicator: lock / "Not secure" for http / warning on cert problems
- [ ] **P0** Show URL without noise when unfocused (hide `https://`, `www.`), full URL on focus; highlight the domain (anti-spoofing)
- [ ] **P1** Search suggestions from the chosen engine (opt-in for privacy)
- [ ] **P1** "Switch to tab" suggestions for already-open tabs
- [ ] **P1** Keyword search / site search shortcuts (`w wikipedia`, Tab-to-search), custom search engines (OpenSearch discovery)
- [ ] **P1** Paste and Go / Paste and Search in the address bar menu
- [ ] **P1** Delete a single suggestion (Shift+Delete)
- [ ] **P1** IDN homograph protection (show punycode for mixed-script domains)
- [ ] **P2** Calculator / unit conversion / quick answers in suggestions
- [ ] **P2** Command bar actions (Arc/Chrome: "clear history", "settings" as suggestions)

## 4. Bookmarks

- [x] Bookmark this page (star button, Cmd/Ctrl+D) and remove; star shows state
- [x] Bookmarks page (`browser://bookmarks`) with remove
- [x] New tab page shows the first 12 bookmarks
- [ ] **P0** Edit dialog on save (name, folder) and edit existing bookmarks
- [ ] **P0** Folders (create, rename, nest, move)
- [ ] **P0** Bookmarks bar (toggle Cmd/Ctrl+Shift+B), with folder dropdowns and drag-and-drop
- [ ] **P0** Import from Chrome, Safari, Firefox, Edge, Brave, Arc, and from bookmarks HTML
- [ ] **P1** Export to standard bookmarks HTML
- [ ] **P1** Search bookmarks; sort; drag to reorder in the manager
- [ ] **P1** "Bookmark all tabs" / open all in folder
- [ ] **P2** Bookmarks menu in the menu bar listing bookmarks and folders
- [ ] **P2** Favicons stored for bookmarks

## 5. History

- [x] Visits recorded (http/https, including in-page navigations), titles updated, 5,000 entry cap
- [x] History page with text search (title + URL)
- [x] Clear all history
- [ ] **P0** Delete single entries (and "remove all from this site")
- [ ] **P0** Clear browsing data dialog: time range (last hour/day/week/all) × history, cookies & site data, cache, downloads list, permissions (Cmd/Ctrl+Shift+Delete)
- [ ] **P1** Group by day with date headers; infinite scroll beyond 500 items
- [ ] **P1** History menu shows recently closed tabs and recently visited pages
- [ ] **P1** Full-text indexed search (needs SQLite)
- [ ] **P2** Auto-delete history older than N days; "clear on quit" option

## 6. Downloads

- [x] Downloads saved to the OS Downloads folder with unique names
- [x] Downloads page: progress, pause/resume, cancel, open, show in folder, clear list
- [x] Toolbar download button with active count / percent badge; Dock/taskbar progress bar
- [x] Interrupted-on-quit downloads marked as failed
- [ ] **P0** Dangerous-file warning before saving/opening (.exe, .msi, .dmg, .pkg, .app, .command, .sh, .jar, Office macros…)
- [ ] **P0** Option "Ask where to save each file" and a choose-download-folder setting
- [ ] **P0** Download bubble/panel from the toolbar (not just a full page), with "download finished" feedback
- [ ] **P1** Retry/resume interrupted downloads (`session.createInterruptedDownload`)
- [ ] **P1** Remove a single entry; delete file from disk; drag a finished download into another app
- [ ] **P1** Block downloads from insecure (http) origins on https pages (mixed-content downloads)
- [ ] **P1** Multiple-automatic-downloads permission prompt
- [ ] **P2** Malware reputation check for downloads (Web Risk API) *(Electron limit: no free Google Safe Browsing)*

## 7. Passwords, autofill & passkeys

- [x] HTTP Basic/Digest sign-in bar, with "not secure" warning on http
- [ ] **P0** Save-password prompt on form submit, and autofill saved logins (encrypted with `safeStorage` → Keychain / DPAPI / libsecret) *(Electron limit: no built-in password manager; macOS Keychain access needs a signed app)*
- [ ] **P0** Passkeys / WebAuthn: verify Touch ID / security keys / iCloud Keychain passkeys work (needs signed app + entitlements on macOS) *(Electron limit: platform authenticator support is partial)*
- [ ] **P1** Password manager page: view (after OS auth), edit, delete, search, export/import CSV
- [ ] **P1** Strong password generator on sign-up fields
- [ ] **P1** Compatibility with 1Password/Bitwarden desktop apps (they need a supported browser or extension) *(Electron limit)*
- [ ] **P1** Address & contact form autofill
- [ ] **P1** Proxy authentication (today proxy auth is cancelled)
- [ ] **P2** Payment card autofill (encrypted, CVC never stored)
- [ ] **P2** Breached/reused/weak password checks
- [ ] **P2** Client certificate selection (`select-client-certificate`)

## 8. Security & privacy

- [x] Sandboxed renderers (`app.enableSandbox()`), context isolation, no Node in pages
- [x] Internal `browser://` pages served via custom protocol; websites can't load or frame them; IPC sender checks
- [x] Hardened Electron fuses in packaged builds (no RunAsNode, ASAR integrity, cookie encryption…)
- [x] Certificate errors show a "connection isn't private" page with no bypass
- [x] Favicons fetched in the main process; toolbar loads only `data:` images
- [x] Per-site permission prompts (camera, mic, location, notifications, clipboard, MIDI, external apps), remembered per site; everything else denied
- [x] Site permissions list with reset in Settings
- [x] Built-in ad & tracker blocking (`@ghostery/adblocker-electron`, EasyList/EasyPrivacy, weekly list refresh), toolbar shield with blocked count and per-site off switch, global switch in Settings
- [ ] **P1** Shield popup with details (what was blocked, cookie-banner blocking level)
- [ ] **P0** Site info popup (click lock): connection status, permissions for this site, cookies in use, "Site settings", clear site data
- [ ] **P0** Permission defaults per type (ask/block for all sites) and add/edit exceptions, not just reset
- [ ] **P0** Block third-party cookies by default (or partition them); cookie settings page with per-site exceptions
- [ ] **P0** Decide `file://` policy: typed `file://` URLs load today; block web pages from navigating to `file:` and restrict to top-level user navigation
- [ ] **P0** External protocol handling (`mailto:`, `zoommtg:`, `slack:`): ask before opening another app, remember choice
- [ ] **P1** HTTPS-Only / HTTPS-upgrade mode with a "continue to http" interstitial
- [ ] **P1** Certificate viewer (from the site info popup)
- [ ] **P1** Safe browsing / phishing & malware protection (Web Risk API, paid, or ship without and say so) *(Electron limit)*
- [ ] **P1** DNS over HTTPS setting (`app.configureHostResolver` secure DNS mode + provider)
- [ ] **P1** Mixed-content handling / indicator; block insecure forms on https pages
- [ ] **P1** "Send Do Not Track / Global Privacy Control" setting (GPC header + `navigator.globalPrivacyControl`)
- [ ] **P1** Weekly Electron patch bump routine + "update required" kill switch for critical CVEs
- [ ] **P1** Cookies & site data manager (list by site, remove one, remove all)
- [ ] **P2** Fingerprinting protection (Brave-style farbling of canvas/audio/fonts, reduce UA/client hints)
- [ ] **P2** Bounce tracking / query-parameter tracker stripping (utm_, fbclid, gclid)
- [ ] **P2** Cookie consent banner auto-reject (Brave "Block cookie notices")
- [ ] **P2** Clear-on-exit per site; Firefox-style containers
- [ ] **P2** Tor/onion window (Brave) — likely out of scope

## 9. Media

- [x] HTML5 video full screen (tab view takes over the window)
- [x] Camera/mic permission prompts with macOS usage strings (Info.plist)
- [ ] **P0** Screen-sharing picker (`session.setDisplayMediaRequestHandler` + `desktopCapturer`, screens/windows/tabs, system audio)
- [ ] **P0** Camera / mic / screen-share in-use indicator on the tab and in the address bar, with a stop button
- [ ] **P1** Picture-in-picture: verify the video PiP button and `requestPictureInPicture()` work; add a context-menu/toolbar entry
- [ ] **P1** Autoplay policy setting (block audible autoplay by default, per-site allow)
- [ ] **P1** Media keys / Now Playing integration on macOS (verify Chromium's hardware media key handling is on)
- [ ] **P1** Global media controls (toolbar popup for playing tabs)
- [ ] **P1** Video/audio context menu: play/pause, loop, show controls, save video, copy video address, PiP
- [ ] **P1** Widevine DRM for Netflix/Spotify/Disney+ via castLabs ECS + EVS signing, or a clear "not supported" message *(Electron limit)*
- [ ] **P2** Cast / AirPlay *(Electron limit: no Chromecast media router)*

## 10. Reading, viewing & page tools

- [x] Find in page (Cmd/Ctrl+F, next/previous, match count)
- [x] Zoom in / out / reset (Cmd/Ctrl +/−/0); applies per origin, not saved across restarts
- [x] Print (Cmd/Ctrl+P and context menu, system print dialog)
- [x] View page source; Inspect Element
- [ ] **P0** PDF viewer: verify Electron's built-in PDF viewer opens PDFs in tabs (and downloads vs. view behavior)
- [ ] **P0** Zoom level indicator in the address bar with reset; persist per-site zoom across restarts
- [ ] **P1** Save page as (Cmd/Ctrl+S: complete HTML, single file/MHTML, text) via `webContents.savePage`
- [ ] **P1** Export/Save as PDF (`printToPDF`), also from the print preview
- [ ] **P1** Print preview with page range/layout options (Chrome-style), not just the system dialog
- [ ] **P1** Reader mode (Mozilla Readability, font/size/theme controls)
- [ ] **P1** Default font and minimum font size settings; default zoom level
- [ ] **P2** Translate page (on-device or a privacy-friendly service; no free Google Translate) *(Electron limit)*
- [ ] **P2** Screenshot tool (visible area / full page / selection)
- [ ] **P2** Read aloud (Text-to-Speech)
- [ ] **P2** Caret browsing (F7)

## 11. Spellcheck, input & languages

- [x] Spellcheck in editable fields with suggestions and Add to Dictionary
- [x] Edit menu (undo/redo/cut/copy/paste/select all) and page text context menu (copy, search for selection)
- [ ] **P1** Spellcheck language selection (Windows/Linux need `setSpellCheckerLanguages`; macOS uses system) and toggle off
- [ ] **P1** Manage custom dictionary words
- [ ] **P1** Preferred languages for websites (`Accept-Language`)
- [ ] **P1** Context menu: "Look Up" / dictionary (macOS `showDefinitionForSelection`), Speech, emoji & symbols, writing direction
- [ ] **P2** Paste as plain text (Cmd/Ctrl+Shift+V)

## 12. Accessibility

- [x] Web content inherits Chromium accessibility (screen readers read pages)
- [ ] **P0** Toolbar keyboard access: Tab/arrow focus through toolbar and tab strip, visible focus rings, F6 to cycle regions
- [ ] **P0** ARIA for the toolbar: `tablist`/`tab` roles, labels on icon buttons, live region for permission/auth/find bars
- [ ] **P1** VoiceOver / NVDA / Orca pass on toolbar and internal pages
- [ ] **P1** Respect high contrast / increased contrast / forced colors in the toolbar and internal pages
- [ ] **P1** Respect `prefers-reduced-motion`; font size follows OS text size where possible
- [ ] **P2** Live captions *(Electron limit: Chrome's on-device captions not available)*

## 13. Settings

- [x] Settings page (Cmd/Ctrl+,) with "reopen tabs from last time" and site permissions
- [ ] **P0** Make this my default browser button + status (`app.setAsDefaultProtocolClient('http'/'https')`, plus macOS/Windows file and URL associations)
- [ ] **P0** Search engine setting
- [ ] **P0** Privacy & security section (clear data, cookies, tracker blocking level, HTTPS-only, DoH, safe browsing)
- [ ] **P0** On startup: new tab / continue where you left off / specific pages
- [ ] **P1** Appearance: light/dark/system theme (toolbar and internal pages follow `nativeTheme`), accent color, show bookmarks bar, show home button
- [ ] **P1** Home page / new-tab page choice
- [ ] **P1** Downloads location + ask where to save
- [ ] **P1** Languages (UI language, website languages, spellcheck)
- [ ] **P1** Search within settings
- [ ] **P1** Reset settings to defaults
- [ ] **P2** Custom themes / colors per profile; compact mode
- [ ] **P2** Keyboard shortcut customization

## 14. New tab page

- [x] New tab page with search box and bookmark tiles
- [ ] **P0** Dark mode support for new tab and all internal pages
- [ ] **P1** Most-visited / pinned shortcut tiles (with favicons), remove/edit tiles
- [ ] **P1** Customization: background image/color, show/hide shortcuts
- [ ] **P2** Option to use a custom URL as the new tab page
- [ ] **P2** Privacy stats (trackers blocked, time saved) like Brave

## 15. Import, profiles & sync

- [ ] **P0** Import from Chrome, Safari, Firefox, Edge, Brave, Arc: bookmarks, history, (passwords via CSV), search engine
- [ ] **P1** Profiles: separate persistent partitions per profile (data, cookies, permissions), profile switcher, per-profile window color
- [ ] **P1** Export all data (bookmarks HTML, passwords CSV) as the interim "sync"
- [ ] **P2** End-to-end encrypted sync (own server or file-based) for bookmarks, history, passwords, open tabs *(Electron limit: no Google Sync)*
- [ ] **P2** Send tab to another device

## 16. Extensions & developer tools

- [x] DevTools (Alt+Cmd+I / F12) and Inspect Element
- [ ] **P1** Built-in essentials instead of extensions: content blocking (done), dark-mode-for-sites, password manager
- [ ] **P2** Limited unpacked extension support (`electron-chrome-extensions`), marked experimental; manage/enable/remove UI *(Electron limit)*
- [ ] **P2** Chrome Web Store installs *(Electron limit: official non-goal)*
- [ ] **P2** Userscripts (Min-style) as an extension alternative
- [ ] **P2** DevTools dock position preference (docked/undocked) and a DevTools toolbar button

## 17. Reliability & performance

- [x] Session restore on relaunch with per-tab back/forward history (toggle)
- [x] Atomic store writes (`.tmp` + rename), debounced saves, flush on quit
- [x] Failed loads show a "can't be reached" page with retry
- [ ] **P0** Tab crash page ("Aw, snap" with reload) on `render-process-gone`; unresponsive page dialog ("Wait / Kill")
- [ ] **P0** Crash recovery: restore after an app crash, with "Restore pages?" prompt when the last exit was not clean
- [ ] **P0** Storage: JSON → SQLite (history/bookmarks/passwords scale, fewer full rewrites)
- [ ] **P1** Lazy-load restored tabs (only load the active tab at startup)
- [ ] **P1** Tab sleeping / memory saver: discard background tabs after N minutes, exclusions list
- [ ] **P1** Task manager (per-tab memory/CPU via `app.getAppMetrics`, end process)
- [ ] **P1** Corrupt-store recovery (keep a backup, don't silently start empty)
- [ ] **P2** Energy saver mode on battery (throttle background tabs, limit frame rate)
- [ ] **P2** Preload/prefetch settings

## 18. Notifications

- [x] Notification permission prompt per site
- [ ] **P0** Fix: notification permission reads "denied" instead of "default" before asking (known issue)
- [ ] **P1** Web notifications shown as native OS notifications with the site name; click focuses the tab
- [ ] **P1** Quieter notification prompts (Chrome/Firefox: block prompts from sites with abusive patterns, no prompt without user gesture)
- [ ] **P2** Notifications settings list and "Notifications from this browser" OS settings link

## 19. OS integration

- [x] macOS app menu (About, Services, Hide, Quit), standard Edit menu, keyboard shortcuts per platform
- [x] Dock / taskbar download progress
- [ ] **P0** Open links from other apps: handle `open-url` (macOS) and URL args in `second-instance`/launch argv (Windows/Linux)
- [ ] **P0** Register as default browser candidate: `CFBundleURLTypes` (http/https) + HTML document types in Info.plist, Windows registry `RegisteredApplications`/ProgId, Linux `.desktop` with `x-scheme-handler`
- [ ] **P0** Open local files (drag a .html/.pdf onto the window or Dock icon, `open-file` event)
- [ ] **P1** Drag & drop: URLs/text onto the tab strip or address bar to open; drag links/images out of pages; drag files into upload fields (verify)
- [ ] **P1** Dock menu (macOS) / Jump List (Windows): New Window, New Private Window
- [ ] **P1** Share menu (macOS `ShareMenu`, Windows share) for the current page
- [ ] **P1** Handoff / continuity on macOS (`app.setUserActivity` with the current URL)
- [ ] **P1** Web app protocol handlers (`navigator.registerProtocolHandler`)
- [ ] **P2** Install site as app (PWA) / web app windows
- [ ] **P2** Touch Bar / system services (look up, share) extras
- [ ] **P2** Spotlight/Windows search integration for bookmarks

## 20. Updates, telemetry & crash reporting

- [x] macOS self-updater: Ed25519-signed zip from GitHub Releases, bundle/version/codesign checks, applied on quit, "Restart to update" button
- [x] Check for Updates… menu item (macOS)
- [ ] **P0** Windows and Linux auto-update (electron-updater / AppImage; deb/rpm repos or Flatpak)
- [ ] **P1** Staged rollout and forced update for critical security releases
- [ ] **P1** Opt-in crash reporting (`crashReporter` → Sentry/Backtrace), asked in onboarding, named in the privacy policy
- [x] Update status in the UI: toolbar pill with download progress / "Restart to update"; Settings → About shows up to date, errors and "move to Applications"
- [ ] **P2** Opt-in, minimal, documented usage telemetry (or none, stated clearly)
- [ ] **P2** Release notes / "What's new" page after an update

## 21. Internationalization

- [ ] **P1** All UI strings in a translation layer (toolbar, menus, internal pages, dialogs)
- [ ] **P1** UI language follows the OS (`app.getLocale()`), with an override setting
- [ ] **P1** Right-to-left layout support for the toolbar and internal pages (Arabic, Hebrew)
- [ ] **P2** Ship translations for top languages
- [ ] **P2** Locale-aware date/size formatting everywhere (history uses `toLocaleString` already)

## 22. Onboarding, help & about

- [x] About panel (macOS `role: about`)
- [ ] **P0** First-run welcome: set as default browser, import from another browser, choose search engine, privacy choices
- [x] About section in Settings: version, update status, last check, Check for updates
- [ ] **P2** Electron/Chromium version and open-source licenses in About
- [ ] **P1** Help menu: keyboard shortcuts, report a problem, website/support link
- [ ] **P1** Keyboard shortcuts reference page
- [ ] **P2** Feature tips / tour

## 23. Legal & policy

- [x] MIT license file for the project
- [ ] **P0** Privacy policy (what goes over the network: update check, search provider, blocklist downloads) linked from Settings/About
- [ ] **P1** Bundle and show third-party licenses (Electron's `LICENSES.chromium.html`, npm dependencies, filter lists like EasyList)
- [ ] **P1** Product name + icon (replace placeholder "Browser" and the default Electron icon); trademark check
- [ ] **P2** Terms of use / EULA; avoid "Chrome"/"Google" marks

## 24. Packaging & signing

- [x] macOS DMG + zip (arm64), ad-hoc signed, Info.plist usage strings, fuses applied after pack
- [x] Release script: build, sign zip, tag, publish GitHub release
- [x] Separate dev profile (`Browser Dev`) so testing never touches real data
- [ ] **P0** macOS Developer ID signing + notarization + hardened runtime with entitlements (removes the "Open Anyway" step; needed for Keychain, passkeys)
- [ ] **P0** Universal or x64 macOS build for Intel Macs
- [ ] **P0** Windows NSIS build tested; code signing (SignPath for OSS, or Azure Artifact Signing / OV) to avoid SmartScreen blocks
- [ ] **P0** Linux AppImage/deb tested; Chromium sandbox works (SUID/user namespaces); `.desktop` file with MIME types
- [ ] **P1** Flatpak (zypak) / rpm; winget and Homebrew cask listings
- [ ] **P1** CI builds for all three OSes with a smoke test (launch, open a page, Google sign-in check)
- [ ] **P2** Microsoft Store listing (policy requires staying within 2 Chromium majors) *(Electron limit)*

## 25. Other expected basics

- [ ] **P0** Home button (optional) and keyboard shortcut to go home
- [ ] **P0** Status bubble showing the link URL on hover (bottom-left)
- [ ] **P0** "Leave site? Changes you made may not be saved" (`will-prevent-unload`) dialog
- [ ] **P0** JavaScript dialogs (`alert`/`confirm`/`prompt`) styled and tab-modal, with "prevent this page from creating more dialogs"
- [ ] **P1** Form re-submission warning on reload after POST
- [ ] **P1** Proxy settings (system proxy honored by default; manual/PAC option)
- [ ] **P1** Captive portal detection (hotel/airport Wi-Fi sign-in)
- [ ] **P1** Offline page (with a little game is optional)
- [ ] **P1** Web Serial/USB/HID/Bluetooth device chooser (`select-bluetooth-device`, `select-hid-device` handlers) or deny with a message
- [ ] **P1** Google sign-in smoke test (UA spoofing can break any time) *(Electron limit)*
- [ ] **P2** QR code for the current page
- [ ] **P2** Workspaces / spaces (Arc)
- [ ] **P2** Built-in AI features (summaries, chat) — product decision
