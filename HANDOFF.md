# Handoff

Everything needed to pick this project up on any device. **Keep this file current:** update it
in the same commit as any change to features, architecture, setup, or plans.

_Last updated: 2026-10-09 · Current release: v0.3.0_

## What this is

A basic cross-platform web browser (macOS, Windows, Linux) built on Electron. Goal right now: a
solid, safe, daily-usable basic browser. Repo: https://github.com/ezzeldinzozz-svg/browser

## Status

**Done**
- Tabs, address bar (URL or DuckDuckGo search), back/forward/reload/stop, keyboard shortcuts
- Bookmarks, history, downloads page, find in page, new-tab page, settings page
- Per-site permission prompts (camera, mic, location, notifications, clipboard, MIDI, external apps), remembered per site, resettable in Settings
- HTML video fullscreen
- HTTP sign-in bar (username/password for sites using HTTP auth), with a warning on plain http
- Right-click menus: links (open in background tab, copy), images (open, copy, save), text (copy, search), editable fields (spelling fixes, cut/copy/paste), page (back/forward/reload, print, view source), Inspect Element; edit menu in the toolbar's text fields
- Print (Cmd/Ctrl+P), session restore with back/forward history (toggle in Settings), Reopen Closed Tab (Cmd/Ctrl+Shift+T); links opened from a page line up next to it
- Security: sandboxed tabs, private `browser://` pages that websites can't reach, favicons fetched in the main process, certificate-error page with no bypass, single-instance lock, hardened Electron fuses in packaged builds
- macOS packaging (ad-hoc signed DMG) and a free self-updater using our own Ed25519 key + GitHub Releases (tested end to end: 0.1.9 → 0.2.0)

**Known issues**
- Notification permission reads as "denied" (not "default") until a site is allowed/blocked, so some sites hide their "enable notifications" button
- Proxy sign-in not supported (proxy auth requests are cancelled)
- Restored tabs may show pages from cache (same as Chrome), including pages that needed a sign-in
- No screen-sharing picker; no warning before opening risky downloads (.exe, .dmg…)
- Popups that need `window.opener` (some OAuth logins) open as plain tabs
- Google sign-in may block Electron despite the Chrome user agent
- No DRM (Netflix/Spotify), no Chrome extensions (Electron limits, see research)
- Not yet tested on Windows or Linux; auto-update is macOS only
- Default Electron icon; product name "Browser" is a placeholder

## Roadmap (next, in order)

1. Private windows; built-in ad/tracker blocking
2. Storage: JSON file → SQLite
3. Windows/Linux builds + their updaters (electron-updater works unsigned there)
4. Name + icon
5. Later: Apple Developer ID ($99/yr) to remove the first-launch warning; Windows signing (SignPath Foundation is free for open source)

See `research/browser-lessons.md` for the full research on how Brave and others are built.

## Architecture

| File | Role |
|---|---|
| `main.js` | Main process: window, tabs (one `WebContentsView` each), layout, permissions, downloads, find, menu, IPC, `browser://` protocol |
| `preload.js` | Exposes `window.browserAPI` only to `browser://` pages; main re-checks every IPC sender |
| `updater.js` | macOS self-updater (see Releases below) |
| `ui/` | Toolbar UI, served at `browser://ui/` (tab strip, address bar, permission bar, find bar) |
| `pages/` | Internal pages at `browser://<name>/` → `pages/<name>.html` (newtab, history, bookmarks, downloads, settings, error) |
| `scripts/fuses.js` | electron-builder afterPack hook that locks down the packaged Electron binary |
| `scripts/keygen.js`, `scripts/release.js` | Release signing key setup, and build+sign+publish |

Key decisions:
- **Electron over Rust/system webview:** same Chromium engine on all three OSes; Linux webviews are weak. Revisit only if "lightweight/native" becomes the product's identity.
- **Security model:** websites never get the IPC API; only `browser://` pages do, checked by sender in main. Websites can't navigate/frame/redirect to `browser://`.
- **Updates without paying Apple:** our own Ed25519 signature on the zip + bundle id/version/codesign checks; the app swaps itself after quitting.
- User data lives in the OS app-data folder (`~/Library/Application Support/Browser/browser-data.json` on macOS), not in the app, so it survives updates.

## Setting up on a new device

```bash
git clone https://github.com/ezzeldinzozz-svg/browser.git
cd browser
npm install
npm start
```

Requirements: Node 22+, git, GitHub CLI (`gh`) logged in as `ezzeldinzozz-svg`. Building the
macOS DMG needs a Mac (Apple Silicon builds are arm64).

**To publish releases from the new device**, also:
1. Copy the private signing key `~/.browser-release/update-private-key.pem` from the old device
   (via a password manager or USB, **never** commit it or send it in chat). Keep it at the same
   path, permissions `600`. If it's lost, installed copies can't auto-update and users must
   reinstall a build signed with a new key (`npm run keygen` after deleting the old public key).
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
| `npm run release` | Bump patch version, build, sign, tag, push, create GitHub release (installed apps update within ~6 h, or via Browser → Check for Updates…) |
| `npm run release -- 0.3.0` | Release a specific version |

Release needs a clean git tree. Electron is pinned (currently 44.7.0): bump patch versions
regularly for security fixes, then release.

## Testing notes

- **Profiles:** `npm start` uses its own profile (`~/Library/Application Support/Browser Dev`). The
  installed app uses `~/Library/Application Support/Browser`. Never delete or edit the installed
  app's profile while testing; it holds the user's real bookmarks/history/permissions.

- Most testing is scripted over the Chrome DevTools Protocol: launch with
  `npx electron . --remote-debugging-port=9333` and evaluate in `browser://ui/` or a tab.
- If the window is hidden behind other windows on macOS, renderer sizes look stale; add
  `--disable-features=MacWebContentsOcclusion` when testing layout.
- Main-process debugging: `npx electron . --inspect=9229 --remote-debugging-port=9333` (flags after `.`).
  Native menus block the app while open, so tests replace `Menu.prototype.popup` via the inspector
  to record items instead, and call `webContents.emit('context-menu', …)` with synthetic params.
- Updater test: build an older copy with
  `npx electron-builder --mac dir --publish never -c.extraMetadata.version=0.1.9`, copy the
  `.app` to a writable temp folder, run it, and wait for "Restart to update".
