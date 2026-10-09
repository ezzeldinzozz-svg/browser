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
3. ~~macOS app stays open with no windows~~ done in v0.5.0
4. **P1** Storage: JSON → SQLite (autocomplete works in memory over the JSON store for now; needed before passwords and sync)
5. ~~Address-bar autocomplete~~ done in v0.5.0
6. ~~Search engine choice~~ done in v0.5.0 (custom engines still open)
7. ~~Site info popup~~ done in v0.5.0
8. ~~Clear browsing data~~ done in v0.5.0
9. ~~Tab context menu~~ done in v0.5.0
10. ~~Tab drag-to-reorder, audio indicator~~ done in v0.5.0
11. ~~Dangerous download warning~~ done in v0.5.0 ("always ask where to save" still open)
12. ~~Open links from other apps / default browser~~ done in v0.5.0 (Windows registry registration still open)
13. ~~Bookmarks bar, folders, edit popup, import~~ done in v0.7.0 (history import still open)
14. **P0** Windows/Linux builds tested, with their own updaters; macOS Developer ID signing + notarization
15. ~~Screen-sharing picker~~ done in v0.5.0; **P0** camera/mic-in-use indicators still open

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
- [x] Tab context menu (right-click a tab): new tab to the right, reload, duplicate, pin, mute, move to new window, close, close others / to the right, reopen closed tab
- [x] Drag tabs to reorder (within the pinned / unpinned groups)
- [x] Audio-playing indicator on tabs, click to mute
- [ ] **P2** "Mute site" (all tabs of a site)
- [x] Duplicate tab (keeps back/forward history)
- [x] Tab overflow handling (shrink to 56px, then scroll; active tab kept in view); tab tooltips with URL
- [x] Long-press / right-click back and forward buttons for the history list
- [x] Pin tabs (small, left-aligned, survive restart; Close Other Tabs keeps them)
- [x] Move tab to new window (context menu; the page keeps running)
- [x] **P1** Tear off by dragging a tab out; drag a tab into another window (same session; private windows each have their own)
- [x] Tab search (Cmd/Ctrl+Shift+A lists open tabs by window) and "Switch to tab" in the address bar
- [x] **P1** Close multiple selected tabs (Shift/Cmd-click to select)
- [x] Sign-in popups (`window.open` with size features) open as real popup windows that keep `window.opener`; the title shows the site
- [x] Swipe back/forward on macOS (three-finger "swipe between pages" setting)
- [ ] **P2** Two-finger swipe with an overscroll arrow (Chrome-style)
- [ ] **P2** Tab groups (named, colored, collapsible, saved)
- [ ] **P2** Vertical tabs / sidebar layout (Arc, Edge, Brave)
- [ ] **P2** Split view (two tabs side by side)
- [ ] **P2** Tab hover preview cards

## 2. Windows

- [x] Windows with a hardened toolbar view and one `WebContentsView` per tab
- [x] Single-instance lock: launching again focuses the existing window
- [x] Window full screen (Ctrl+Cmd+F / F11) and HTML video full screen
- [x] Multiple windows: New Window (Cmd/Ctrl+N), Close Window (Cmd/Ctrl+Shift+W), each with its own tabs; all normal windows restored on launch
- [x] macOS: closing the last window keeps the app running; Dock click opens a new window
- [x] Private window (Cmd/Ctrl+Shift+N): purple frame, in-memory session per window, no history/session/permission/download records kept, wiped on close; "Open Link in Private Window"
- [x] Remember window size/position/maximized per window (only restored if still on a connected display)
- [x] Window menu (macOS): list windows, Minimize, Zoom, Bring All to Front
- [x] **P1** Native-feeling title bar: tabs in the title bar with traffic lights (macOS `titleBarStyle: hiddenInset`), Windows overlay controls (Linux keeps the system frame)
- [x] "Close N tabs?" when closing a window and "Quit with N tabs open?" on Cmd/Ctrl+Q ("Don't ask again", Settings toggle); never on shutdown, logout or updates
- [ ] **P2** Picture-in-picture-like floating "mini window" for a tab (Arc Little Arc)

## 3. Address bar (omnibox)

- [x] URL or search detection; `localhost`/IP get `http://`, domains get `https://`
- [x] Search via DuckDuckGo (fixed)
- [x] Select-all on focus, Esc to revert, Cmd/Ctrl+L to focus
- [x] Edit context menu (cut/copy/paste/select all) in toolbar fields
- [x] Autocomplete dropdown from history and bookmarks (frequency + recency ranking, inline completion, arrow keys, Esc)
- [x] Search engine choice in Settings: DuckDuckGo, Google, Bing, Brave Search, Ecosia, Kagi, Startpage
- [ ] **P1** Search engine choice in onboarding; custom engines
- [x] Security indicator: lock for https, "Not secure" for http (certificate failures already stop the page)
- [x] Show URL without noise when unfocused (hide `https://`, `www.`), full URL on focus; site highlighted (anti-spoofing)
- [x] **P1** Search suggestions from the chosen engine (opt-in for privacy)
- [x] "Switch to tab" suggestions for already-open tabs
- [x] **P1** Keyword search / site search shortcuts (`w wikipedia`), custom search engines
- [ ] **P2** Tab-to-search and OpenSearch discovery (sites offering themselves as engines)
- [x] Paste and Go / Paste and Search in the address bar menu
- [x] Delete a single history suggestion (Shift+Delete), including an inline completion
- [x] **P1** IDN homograph protection (show punycode for mixed-script domains)
- [ ] **P2** Calculator / unit conversion / quick answers in suggestions
- [ ] **P2** Command bar actions (Arc/Chrome: "clear history", "settings" as suggestions)

## 4. Bookmarks

- [x] Bookmark this page (star button, Cmd/Ctrl+D) and remove; star shows state
- [x] Bookmark manager (`browser://bookmarks`): folder tree, search, edit, move, delete, import/export
- [x] New tab page shows the first 12 bookmarks
- [x] Edit popup on save (name, folder, Remove) and edit existing bookmarks (bar menu, manager)
- [x] Folders (create, rename, nest, move; a folder can't be moved into itself)
- [x] Bookmarks bar (toggle Cmd/Ctrl+Shift+B), folder menus, right-click menus, drag to reorder / drop into folders
- [x] Import from Chrome, Brave, Edge, Vivaldi, Arc (auto-detected) and from a bookmarks HTML file (Safari, Firefox, …)
- [x] Export to standard bookmarks HTML
- [x] Search bookmarks; drag to reorder or into folders in the manager
- [ ] **P2** Sort bookmarks
- [x] Open all in folder
- [x] "Bookmark all tabs" (Cmd/Ctrl+Shift+D) into a dated folder
- [ ] **P2** Bookmarks menu in the menu bar listing bookmarks and folders
- [ ] **P2** Favicons stored for bookmarks

## 5. History

- [x] Visits recorded (http/https, including in-page navigations), titles updated, 5,000 entry cap
- [x] History page with text search (title + URL)
- [x] Clear all history
- [x] Delete single entries (removes every visit to that page)
- [x] "Remove site" (every visit to that site)
- [x] Clear browsing data (Settings, Cmd/Ctrl+Shift+Backspace): time range × history, download list, cookies & site data, cache (cookies/cache always all time: Electron limit)
- [ ] **P2** Clear site permissions from the same dialog
- [x] Grouped by day with date headers; "Show more" for older entries
- [x] **P1** History menu shows recently closed tabs and recently visited pages
- [ ] **P1** Full-text indexed search (needs SQLite)
- [ ] **P2** Auto-delete history older than N days; "clear on quit" option

## 6. Downloads

- [x] Downloads saved to the OS Downloads folder with unique names
- [x] Downloads page: progress, pause/resume, cancel, open, show in folder, clear list
- [x] Toolbar download button with active count / percent badge; Dock/taskbar progress bar
- [x] Interrupted-on-quit downloads marked as failed
- [x] Dangerous-file warning: risky types download as `.unconfirmed` until Keep/Discard (toolbar bar + downloads page)
- [x] Downloads marked as from the internet (macOS quarantine attribute, Windows Mark of the Web) so Gatekeeper/SmartScreen check them
- [x] Option "Ask where to save each file" and a choose-download-folder setting
- [x] Downloads panel from the toolbar button (recent items, progress, Open/Show/Cancel/Keep/Discard), button pulses when a download starts
- [x] Retry failed/cancelled downloads (downloads again)
- [ ] **P2** Resume interrupted downloads from where they stopped (`session.createInterruptedDownload`)
- [x] Remove a single entry from the downloads list
- [ ] **P2** Delete the file from disk; drag a finished download into another app
- [x] **P1** Block downloads from insecure (http) origins on https pages (mixed-content downloads)
- [x] **P1** Multiple-automatic-downloads permission prompt
- [ ] **P2** Malware reputation check for downloads (Web Risk API) *(Electron limit: no free Google Safe Browsing)*

## 7. Passwords, autofill & passkeys

- [x] HTTP Basic/Digest sign-in bar, with "not secure" warning on http
- [x] Passwords come only from password-manager extensions (Bitwarden, Proton Pass…), by decision: no built-in password manager. Bitwarden installs, shows its toolbar button and popup (sign-in/autofill to be verified with a real account)
- [ ] **P0** Passkeys / WebAuthn: verify Touch ID / security keys / iCloud Keychain passkeys work (needs signed app + entitlements on macOS) *(Electron limit: platform authenticator support is partial)*
- [ ] **P1** Password manager page: view (after OS auth), edit, delete, search, export/import CSV
- [ ] **P1** Strong password generator on sign-up fields
- [ ] **P1** Compatibility with 1Password/Bitwarden desktop apps (they need a supported browser or extension) *(Electron limit)*
- [ ] **P1** Address & contact form autofill
- [x] **P1** Proxy authentication (today proxy auth is cancelled)
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
- [x] **P1** Shield popup with details (blocked count, which hosts, per-site switch)
- [ ] **P2** Cookie-banner blocking level in the shield popup
- [x] Site info popup (click lock): connection status, certificate issuer/expiry, per-site permissions (Ask/Allow/Block), ad blocking switch, clear cookies and site data
- [ ] **P2** List of cookies in use per site
- [x] Permission defaults per type (Ask/Block for all sites) and add/edit per-site exceptions in Settings
- [x] Block third-party cookies by default (Chromium's own blocking; setting applies after restart); embedded sites can ask via the Storage Access API, which goes through the permission prompt
- [ ] **P2** Manual per-site cookie exceptions list
- [x] `file://` policy: typed addresses and files opened from the OS load; web pages can't navigate, redirect, frame or open `file:` URLs
- [x] External protocol handling (`mailto:`, `zoommtg:`, `slack:`): asks before opening another app (names the link type), remembers per site
- [x] HTTPS-Only (on by default): http:// sites load over https://; sites without https get a warning page with "Continue to site"; local/intranet hosts exempt
- [x] **P1** Certificate viewer in the site info popup (subject, issuer, validity, chain, serial, SHA-256 fingerprint, export as PEM)
- [ ] **P1** Safe browsing / phishing & malware protection (Web Risk API, paid, or ship without and say so) *(Electron limit)*
- [x] Secure DNS setting: Automatic / Cloudflare / Quad9 / custom DoH / Off (`app.configureHostResolver`)
- [ ] **P1** Mixed-content handling / indicator; block insecure forms on https pages
- [x] Global Privacy Control on by default (Sec-GPC header + `navigator.globalPrivacyControl`), setting to turn off
- [ ] **P1** Weekly Electron patch bump routine + "update required" kill switch for critical CVEs
- [x] **P1** Cookies & site data manager (list by site, remove one, remove all)
- [ ] **P2** Fingerprinting protection (Brave-style farbling of canvas/audio/fonts, reduce UA/client hints)
- [ ] **P2** Bounce tracking / query-parameter tracker stripping (utm_, fbclid, gclid)
- [ ] **P2** Cookie consent banner auto-reject (Brave "Block cookie notices")
- [ ] **P2** Clear-on-exit per site; Firefox-style containers
- [ ] **P2** Tor/onion window (Brave) — likely out of scope

## 9. Media

- [x] HTML5 video full screen (tab view takes over the window)
- [x] Camera/mic permission prompts with macOS usage strings (Info.plist)
- [x] Screen-sharing picker: macOS 15+ system picker; elsewhere our picker of screens/windows with thumbnails
- [ ] **P1** Share a single tab, system audio (Windows loopback)
- [x] Camera / microphone / screen-sharing in-use dot on tabs (best effort: tracks getUserMedia/getDisplayMedia in the page)
- [x] In-use indicator in the address bar with a Stop button
- [x] Picture-in-picture from the video context menu
- [ ] **P2** Picture-in-picture toolbar button
- [x] Autoplay setting: block media with sound until the user interacts (default) or allow
- [ ] **P2** Per-site autoplay exceptions
- [ ] **P1** Media keys / Now Playing integration on macOS (Chromium's hardware media key handling is on by default in Electron; not verified by hand)
- [x] **P1** Global media controls: toolbar media button lists tabs playing/paused media with play/pause and jump-to-tab
- [x] Video/audio context menu: play/pause, mute, loop, show controls, picture in picture, open/save/copy address
- [ ] **P1** Widevine DRM for Netflix/Spotify/Disney+ via castLabs ECS + EVS signing, or a clear "not supported" message *(Electron limit)*
- [ ] **P2** Cast / AirPlay *(Electron limit: no Chromecast media router)*

## 10. Reading, viewing & page tools

- [x] Find in page (Cmd/Ctrl+F, next/previous, match count)
- [x] Zoom in / out / reset (Cmd/Ctrl +/−/0); applies per origin, not saved across restarts
- [x] Print (Cmd/Ctrl+P and context menu, system print dialog)
- [x] View page source; Inspect Element
- [x] PDF viewer: PDFs open in a tab with Electron's built-in viewer (verified)
- [x] Zoom level indicator in the address bar (click to reset); per-site zoom persists across restarts (not in private windows)
- [x] Save page as (Cmd/Ctrl+S): complete HTML, single-file web archive (MHTML) or PDF
- [x] Save as PDF (`printToPDF`) from Save Page As
- [ ] **P2** Save as PDF from a print preview
- [ ] **P1** Print preview with page range/layout options (Chrome-style), not just the system dialog
- [x] **P1** Reader mode (Mozilla Readability, font/size/theme/width controls)
- [x] Default zoom level setting
- [ ] **P2** Default font and minimum font size
- [ ] **P2** Translate page (on-device or a privacy-friendly service; no free Google Translate) *(Electron limit)*
- [ ] **P2** Screenshot tool (visible area / full page / selection)
- [ ] **P2** Read aloud (Text-to-Speech)
- [ ] **P2** Caret browsing (F7)

## 11. Spellcheck, input & languages

- [x] Spellcheck in editable fields with suggestions and Add to Dictionary
- [x] Edit menu (undo/redo/cut/copy/paste/select all) and page text context menu (copy, search for selection)
- [x] Spellcheck on/off; languages follow the preferred-language list (Windows/Linux; macOS uses the system checker)
- [x] **P1** Manage custom dictionary words (Settings → Languages)
- [x] Preferred languages for websites (`Accept-Language`), defaulting to the system's
- [x] **P1** Context menu: "Look Up" (macOS `showDefinitionForSelection`), Speech (macOS), Emoji & Symbols (macOS/Windows)
- [ ] **P2** Context menu: writing direction
- [ ] **P2** Paste as plain text (Cmd/Ctrl+Shift+V)

## 12. Accessibility

- [x] Web content inherits Chromium accessibility (screen readers read pages)
- [x] Visible focus rings in the toolbar
- [x] Keyboard: arrow keys / Home / End through the tab strip, Enter selects, Delete closes; F6 switches between toolbar and page
- [x] ARIA basics: `tablist`/`tab` roles with `aria-selected`, labels on icon buttons, permission bar as an alert
- [x] **P1** Labels and roles for every toolbar control, bar, popup and settings field (dialogs, listbox/options, alerts)
- [ ] **P1** VoiceOver / NVDA / Orca pass on toolbar and internal pages
- [x] Forced colors (Windows high contrast) in the toolbar and internal pages
- [ ] **P2** macOS increased contrast styles
- [x] Respect `prefers-reduced-motion` in the toolbar and internal pages
- [ ] **P2** Font size follows the OS text size
- [ ] **P2** Live captions *(Electron limit: Chrome's on-device captions not available)*

## 13. Settings

- [x] Settings page (Cmd/Ctrl+,) with "reopen tabs from last time" and site permissions
- [x] Make this my default browser button + status in Settings (macOS confirms; Windows opens Default apps settings)
- [x] Search engine setting
- [x] Privacy & security in Settings: clear data, ad/tracker blocking, third-party cookies, permission defaults and exceptions
- [ ] **P1** HTTPS-only mode, safe browsing (needs a provider); DNS over HTTPS is done
- [x] On startup: continue where you left off / New Tab page / specific pages (with "Use current pages")
- [x] **P1** Appearance: light/dark/system theme (Settings → Appearance; `nativeTheme.themeSource`), show bookmarks bar, show home button
- [ ] **P2** Accent color choice
- [x] **P1** Home page / new-tab page choice
- [x] **P1** Downloads location + ask where to save
- [ ] **P1** Languages (UI language, website languages, spellcheck)
- [x] Search within settings
- [x] Reset settings to defaults
- [ ] **P2** Custom themes / colors per profile; compact mode
- [ ] **P2** Keyboard shortcut customization

## 14. New tab page

- [x] New tab page with search box and bookmark tiles
- [x] Dark mode support for new tab and all internal pages (follows the system)
- [x] Most-visited tiles on the new tab page (one per site), × to hide
- [ ] **P2** Favicons on tiles, pin/edit tiles
- [ ] **P1** Customization: background image/color, show/hide shortcuts
- [ ] **P2** Option to use a custom URL as the new tab page
- [ ] **P2** Privacy stats (trackers blocked, time saved) like Brave

## 15. Import, profiles & sync

- [x] Import bookmarks from Chromium browsers and HTML files
- [x] **P1** Import history from Chrome/Brave/Edge/Vivaldi/Arc (History page; reads a copy of their SQLite file with `node:sqlite`)
- [ ] **P2** Import search engines from other browsers
- [ ] **P1** Profiles: separate persistent partitions per profile (data, cookies, permissions), profile switcher, per-profile window color
- [x] **P1** Export all data (Settings → Your data: bookmarks HTML + history/settings/permissions JSON)
- [ ] **P2** End-to-end encrypted sync (own server or file-based) for bookmarks, history, passwords, open tabs *(Electron limit: no Google Sync)*
- [ ] **P2** Send tab to another device

## 16. Extensions & developer tools

- [x] DevTools (Alt+Cmd+I / F12) and Inspect Element
- [ ] **P2** Built-in dark mode for sites (content blocking is built in; passwords come from extensions)
- [x] Chrome extensions via `electron-chrome-extensions` (GPL-3.0): toolbar buttons, popups, badges, context menu items, tabs/windows APIs; install from the Chrome Web Store ("Add to Chrome", with a confirmation listing permissions); `browser://extensions` lists and removes them; not in private windows
- [x] **P1** Hide/show extension toolbar buttons, enable/disable without removing (Extensions page)
- [ ] **P2** Per-extension site access
- [ ] **P1** Verify popular extensions: Bitwarden sign-in + autofill, Proton Pass, 1Password (needs its desktop app), Dark Reader, uBlock Origin Lite
- [ ] **P2** Userscripts (Min-style) as an extension alternative
- [ ] **P2** DevTools dock position preference (docked/undocked) and a DevTools toolbar button

## 17. Reliability & performance

- [x] Session restore on relaunch with per-tab back/forward history (toggle)
- [x] Atomic store writes (`.tmp` + rename), debounced saves, flush on quit
- [x] Failed loads show a "can't be reached" page with retry
- [x] Tab crash page ("This page crashed" with Reload) on `render-process-gone`; unresponsive page dialog (Wait / Exit Page)
- [x] Crash recovery: after an unclean exit the browser offers "Restore pages" (or restores automatically when continuing where you left off)
- [ ] **P0** Storage: JSON → SQLite (history/bookmarks/passwords scale, fewer full rewrites)
- [x] Lazy-load restored tabs (only the active tab of each window loads at startup)
- [x] Memory saver: background tabs sleep after 15 min–4 h (default 30); pinned, audible and capturing tabs stay awake
- [ ] **P2** Per-site "always keep awake" list
- [x] Task manager (View menu): memory/CPU per process with tab and extension names, End process for tabs
- [x] Corrupt-store recovery: previous version kept as `.bak`; an unreadable file is set aside and the backup loaded
- [ ] **P2** Energy saver mode on battery (throttle background tabs, limit frame rate)
- [ ] **P2** Preload/prefetch settings

## 18. Notifications

- [x] Notification permission prompt per site
- [x] **P0** Fix: notification permission reads "default"/"prompt" before the site is decided (capture-preload.js)
- [x] **P1** Web notifications shown as native OS notifications with the site name; click focuses the tab (page notifications; service-worker notifications not yet)
- [x] **P1** Quieter notification prompts: no prompt unless the user clicked or typed on the page in the last 5 s
- [ ] **P2** Notifications settings list and "Notifications from this browser" OS settings link

## 19. OS integration

- [x] macOS app menu (About, Services, Hide, Quit), standard Edit menu, keyboard shortcuts per platform
- [x] Dock / taskbar download progress
- [x] Open links from other apps: `open-url` (macOS) and URL args at launch / in `second-instance` (Windows/Linux); opens a tab in the last normal window
- [x] macOS: registered as a browser candidate (`CFBundleURLTypes` http/https, HTML document types)
- [x] **P0** Windows registry `RegisteredApplications`/StartMenuInternet/ProgIds (build/installer.nsh) and Linux `.desktop` `x-scheme-handler` (package.json mimeTypes). Not yet checked by hand on real Windows/Linux
- [x] Open local HTML files from Finder / the Dock icon (`open-file`)
- [ ] **P1** Drag a file onto the window to open it (allowed by the navigation guard; not verified, automation can't simulate an OS file drop)
- [x] Drop a link or text onto the tab strip to open it in a new tab
- [ ] **P2** Drag links/images out of pages; verify dragging files into upload fields
- [x] Dock menu (macOS): New Window, New Private Window
- [x] **P1** Jump List (Windows): New Window, New Private Window (`--new-window`, `--private-window`)
- [x] **P1** Share menu on macOS (`ShareMenu`: File → Share…, page right-click)
- [ ] **P2** Windows share sheet
- [x] **P1** Handoff on macOS (`app.setUserActivity` with the focused window's page; never private). May need a Developer ID-signed build to appear on other devices
- [ ] **P1** Web app protocol handlers (`navigator.registerProtocolHandler`)
- [ ] **P2** Install site as app (PWA) / web app windows
- [ ] **P2** Touch Bar / system services (look up, share) extras
- [ ] **P2** Spotlight/Windows search integration for bookmarks

## 20. Updates, telemetry & crash reporting

- [x] macOS self-updater: Ed25519-signed zip from GitHub Releases, bundle/version/codesign checks, applied on quit, "Restart to update" button
- [x] Check for Updates… menu item (macOS)
- [x] Windows (silent NSIS reinstall) and Linux AppImage self-update, signed like macOS; end-to-end update test in CI on both
- [ ] **P2** apt/rpm repository or Flathub so the .deb/other packages update too
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
- [x] First-run welcome: default browser, bookmark import, search engine, ad/cookie blocking, link to privacy page
- [x] About section in Settings: version, update status, last check, Check for updates
- [ ] **P2** Electron/Chromium version and open-source licenses in About
- [x] Help menu: keyboard shortcuts, report a problem (GitHub issues), privacy, licenses
- [x] Keyboard shortcuts page (`browser://shortcuts`, Cmd/Ctrl+/)
- [ ] **P2** Feature tips / tour

## 23. Legal & policy

- [x] MIT license file for the project
- [x] Privacy policy (`PRIVACY.md`, `browser://privacy`) listing everything that goes over the network; linked from Settings and the welcome page
- [x] Licenses page (`browser://licenses`): npm dependencies (generated at build), Chromium/Electron notices (bundled), filter lists
- [x] **P1** Product name + icon: Operecs, "O." icon
- [ ] **P2** Trademark check for the name
- [ ] **P2** Terms of use / EULA; avoid "Chrome"/"Google" marks

## 24. Packaging & signing

- [x] macOS DMG + zip (arm64), ad-hoc signed, Info.plist usage strings, fuses applied after pack
- [x] Release script: build, sign zip, tag, publish GitHub release
- [x] Separate dev profile (`Browser Dev`) so testing never touches real data
- [ ] **P0** macOS Developer ID signing + notarization + hardened runtime with entitlements (removes the "Open Anyway" step; needed for Keychain, passkeys)
- [x] **P0** x64 macOS build for Intel Macs (separate dmg/zip + `latest-mac-x64.json`; built and checked, not run — no Intel Mac/Rosetta here)
- [x] Windows NSIS build (per-user, one-click) built and smoke-tested on GitHub Actions for every push
- [ ] **P1** Windows code signing (SignPath for OSS, or Azure Artifact Signing / OV) to avoid SmartScreen warnings
- [x] Linux AppImage + .deb built and smoke-tested (sandbox on) on GitHub Actions for every push; `.desktop` file with http/https/HTML MIME types
- [ ] **P1** AppImage on Ubuntu 24.04+ needs unprivileged user namespaces (AppArmor) or `--no-sandbox`; document or ship an AppArmor profile
- [ ] **P1** Flatpak (zypak) / rpm; winget and Homebrew cask listings
- [x] **P1** CI builds for Windows and Linux with a smoke test and an update test (Mac builds locally)
- [ ] **P2** Microsoft Store listing (policy requires staying within 2 Chromium majors) *(Electron limit)*

## 25. Other expected basics

- [x] Home button (optional, Settings → Appearance), configurable home page, Cmd+Shift+H / Alt+Home
- [x] Status bubble showing the link URL on hover (bottom-left)
- [x] "Leave site? Changes you made may not be saved" (`will-prevent-unload`) dialog on navigation/reload
- [x] **P1** Same prompt when closing a tab with unsaved changes
- [ ] **P2** Same prompt when closing a whole window or quitting
- [ ] **P1** JavaScript dialogs styled and tab-modal *(Electron limit: `alert`/`confirm` use native app-modal dialogs and `prompt()` isn't supported; Electron has no hook to replace them)*
- [x] **P1** Form re-submission warning on reload after POST (Electron used to cancel such reloads silently; we confirm and resend the form data)
- [x] **P1** Proxy settings (system by default; no proxy, manual server, PAC) in Settings → Privacy
- [x] **P1** Captive portal help: error pages for timeouts, unknown hosts and certificate errors offer "Sign in to the network" (opens http://neverssl.com, exempt from HTTPS-Only)
- [ ] **P2** Automatic captive portal detection (probe on network change)
- [x] **P1** Offline page: "You're offline" that reloads by itself when the connection is back; clearer pages for unknown hosts, timeouts and proxy failures
- [x] **P1** Web Serial/USB/HID/Bluetooth device chooser (toolbar dialog; picked devices stay allowed per site until quit). Verified HID/USB in a dev run; Serial/Bluetooth trigger macOS's Bluetooth permission prompt (packaged app has the usage text; the dev Electron binary crashes there)
- [ ] **P1** Google sign-in smoke test (UA spoofing can break any time) *(Electron limit)*
- [ ] **P2** QR code for the current page
- [ ] **P2** Workspaces / spaces (Arc)
- [ ] **P2** Built-in AI features (summaries, chat) — product decision
