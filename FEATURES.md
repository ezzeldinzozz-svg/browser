# Operecs features

**Focus until we go public: Apple silicon Mac, English only.** Windows, Linux, Intel Macs and
other languages are parked (see the end) — the code that exists for them stays, but we don't
build, test or extend it until we decide to go public.

Edit freely: move lines between sections, delete what you don't want, add your own.
`[ ]` to do · `[x]` done. The old detailed checklist (all platforms) is in
`research/features-archive.md`.

---

## To do — must have for 1.0

- [ ] Check by hand: password-manager extensions (Bitwarden, Proton Pass) sign in and autofill
- [ ] Check by hand: device chooser for Serial / Bluetooth in the installed app (macOS asks for Bluetooth permission)
- [ ] Check by hand: dragging a file onto the window opens it
- [ ] Check by hand: media keys / Now Playing control the playing tab
- [x] Storage: history in SQLite (History.sqlite; bookmarks stay in JSON — small and written rarely)
- [x] Full-text history search (FTS5; every word as a prefix)
- [x] Security routine: weekly GitHub Action opens a pull request for a newer Electron patch (with CI); `npm run release -- X.Y.Z --critical` makes installed copies restart for the update within 10 minutes
- [x] Mixed content: lock turns to a warning when a secure page actually loads something over http (Chromium upgrades/blocks most); insecure form submissions from https pages ask first (with HTTPS-Only on they're upgraded)
- [x] Ask before closing a window or quitting (Cmd+Q / menu) when a page has unsaved changes; one dialog names the tabs

## To do — should have

- [ ] Profiles: separate data, cookies, permissions and extensions per profile; profile switcher; window color per profile
- [ ] Address & contact form autofill (not passwords)
- [ ] Print preview with page range and layout
- [ ] New tab: background image or color, show/hide shortcuts, favicons on tiles, pin/edit tiles
- [x] Resume interrupted downloads where they stopped (also after quitting Operecs, when the server supports it)
- [x] Auto-delete history older than 7/30/90/365 days; clear history, downloads, cookies or cache when Operecs quits
- [x] Paste as plain text (Cmd+Shift+V, Edit menu and right-click in text fields)
- [ ] "What's new" page after an update
- [x] Bookmarks menu in the menu bar listing bookmarks and folders (with icons)
- [x] Favicons stored for bookmarks (bar, menu, manager, new tab)

## To do — nice to have

- [ ] Tab groups (named, colored, collapsible, saved)
- [ ] Vertical tabs / sidebar layout
- [ ] Split view (two tabs side by side)
- [ ] Tab hover preview cards
- [ ] "Mute site" (all tabs of a site)
- [ ] Two-finger swipe back/forward with an arrow
- [ ] Command bar actions in the address bar ("clear history", "settings")
- [ ] Calculator / unit conversion in suggestions
- [ ] Tracker stripping from links (utm_, fbclid, gclid)
- [ ] Cookie banner auto-reject
- [ ] Fingerprinting protection
- [ ] Privacy stats on the new tab page (trackers blocked)
- [ ] Screenshot tool (visible area / full page / selection)
- [ ] Read aloud
- [ ] Translate page (privacy-friendly service)
- [ ] Picture-in-picture toolbar button
- [ ] Per-site autoplay exceptions
- [ ] Energy saver on battery
- [ ] Accent color choice; compact mode
- [ ] Keyboard shortcut customization
- [ ] Install a site as an app (PWA windows)
- [ ] Websites registering as handlers for link types (`navigator.registerProtocolHandler`)
- [ ] Share a single tab when screen sharing
- [ ] Client certificate selection
- [ ] Workspaces / spaces
- [ ] Built-in AI features (summaries, chat) — product decision
- [ ] QR code for the current page
- [ ] Encrypted sync / send tab to another device

## Blocked — needs a paid account or a provider

- [ ] Developer ID signing + notarization (removes "Open Anyway"; needs the $99/yr Apple Developer Program)
- [ ] Passkeys / Touch ID / security keys (needs Developer ID + entitlements)
- [ ] iCloud Passwords (needs Developer ID + Apple's web-browser entitlement)
- [ ] Netflix / Spotify / Disney+ (DRM: castLabs Electron build + Widevine signing)
- [ ] Safe Browsing / phishing and malware warnings (Google Web Risk is paid)
- [ ] Opt-in crash reporting (needs a Sentry/Backtrace account)

## Parked until we go public

- [ ] Windows: installer, updates and Default-apps registration exist and pass CI, never used by a person; code signing
- [ ] Linux: AppImage/.deb exist and pass CI; Ubuntu 24.04 sandbox note, Flatpak/rpm, package repositories
- [ ] Intel Macs: x64 build exists, never run
- [ ] Other languages: Arabic (with right-to-left) exists in `locales/ar.json`; more languages
- [ ] Listings: Homebrew, winget, Microsoft Store
- [ ] Trademark check for the name; terms of use

## Won't do

- Built-in password manager, password generator (password-manager extensions do this)
- Cast / AirPlay (no Chromecast support in Electron)

---

## Done

**Browsing:** tabs (pin, mute, drag to reorder, multi-select, drag out to a new window or into
another window, sleeping tabs), private windows, address bar with suggestions from history,
bookmarks, open tabs and (opt-in) the search engine, keyword search and custom engines, find in
page, zoom, reader mode, form resubmit warning, "Leave site?" on closing tabs, session restore,
reopen closed tabs, History menu with recently closed / visited.

**Bookmarks, history, downloads:** bookmarks bar and manager with folders, import from Chrome-family
browsers and HTML, export; history grouped by day with search, import from Chrome/Brave/Edge/Vivaldi/
Arc; downloads panel and page, insecure-download blocking, "download multiple files" prompt; export
all data.

**Privacy & security:** ad and tracker blocking with a details popup, third-party cookie blocking,
Global Privacy Control, HTTPS-Only, secure DNS, proxy settings, per-site permissions with defaults,
quiet notification prompts, cookies and site data manager, certificate viewer, lookalike-domain
(IDN) protection, sandboxed tabs, private `browser://` pages, locked-down Electron.

**Media & devices:** media button for playing tabs, camera/mic/screen indicators, screen sharing
picker, picture in picture, autoplay setting, device chooser (USB, HID, Serial, Bluetooth).

**Mac:** tabs in the title bar, Share menu, Handoff, Look Up / Speech / Emoji in the context menu,
notifications that open their tab.

**Extensions:** Chrome Web Store install, toolbar buttons, turn on/off, hide buttons, remove.

**Look & settings:** Operecs design (dark/light/system theme, private window frame, page card),
welcome page, settings with search, spellcheck with custom dictionary, website languages,
memory saver and task manager, error pages for offline / not found / certificate / proxy /
Wi-Fi sign-in.

**Updates:** free self-updates signed with our own key, update pill in the toolbar.
