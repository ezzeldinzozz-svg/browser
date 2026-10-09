# Browser

A basic cross-platform web browser built on Electron.

## Features

- Tabs, address bar with search, back/forward/reload
- Bookmarks, history, downloads, find in page
- Per-site permission prompts (camera, microphone, location, notifications, …)
- Hardened by default: sandboxed tabs, private `browser://` pages, locked-down Electron fuses

## Develop

```bash
npm install
npm start
```

## Build

```bash
npm run dist:mac     # dist/Browser-<version>-arm64.dmg
npm run dist:win     # Windows installer
npm run dist:linux   # AppImage and .deb
```

macOS builds are ad-hoc signed. On first launch, allow the app in
System Settings → Privacy & Security → Open Anyway.
