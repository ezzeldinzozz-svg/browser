# Lessons from successful browsers, applied to this Electron browser

Researched 2026-10-09. Sources are linked inline; dates are given where they matter. Claims marked *(inference)* are my reading of the sources, not something a source states.

---

## TL;DR

- **Every successful independent browser outsources the engine.** Their own work goes into UI, privacy features, services and distribution. The few that build an engine (Ladybird) or ship a non-Chromium engine everywhere (Orion) run into heavy resource limits. In Oct 2026 Kagi stopped Orion for Linux and Windows for exactly that reason.
- **The real job is keeping up with security updates.** Chrome moved to **2-week milestones on 2026-09-08** (Chrome 153), plus weekly security fixes. Brave ships within about 24 h of Chromium security releases. An Electron browser rides Electron's **8-week** majors and their backports, so it always trails Chrome.
- **Electron is a reasonable base for a basic browser, but it has hard limits.** You get no Chrome Web Store extensions (an official non-goal), Widevine only through castLabs ECS plus a VMP signing deal, no Google Safe Browsing or Sync for free, and Google sign-in blocks embedded frameworks. Electron's own docs say arbitrary untrusted content is "a severe security risk that Electron is not intended to handle".
- **For this project:** ship auto-update and signing first, track Electron patch releases weekly, harden the Electron surface (fuses, custom protocol, navigation rules), then add downloads, find, context menu, session restore, private windows and content blocking. Only consider a Chromium fork once you have users, money and at least 2–3 dedicated engineers for rebases.

---

## 1. How the notable browsers are built

| Browser | Engine / base | Architecture choice | Why / lesson |
|---|---|---|---|
| **Brave** | Chromium. `brave-core` is a layer on top of `src/` | Order of preference: (1) code only in `brave-core`, (2) `chromium_src` overrides, which are files that shadow Chromium files at compile time, often using preprocessor renames to wrap the original function, (3) small `.patch` files as a last resort. Patches must stay trivial with no nested logic. Mojom can be extended via `[BraveAdd]`/`[BraveExtend]`. ([patching doc](https://github.com/brave/brave-core/blob/master/docs/patching_and_chromium_src.md)) | Keeps rebases cheap. A dedicated rebase team checks for renamed or moved patched files and toolchain changes (macOS SDK, VS, Rust), runs tests, audits network services and does security review ([Chromium rebases](https://github.com/brave/brave-browser/wiki/Chromium-rebases)). Release schedule: about one major every 2 weeks, each tied to a Chromium version (e.g. 1.97 = Chromium 155 on 2026-10-07). Brave aims to always match Chrome's Chromium version and ships security updates within about 24 h ([release schedule](https://github.com/brave/brave-browser/wiki/Brave-Release-Schedule)). |
| Brave adblock | [adblock-rust](https://github.com/brave/adblock-rust) | Native Rust engine instead of an extension. Moved to FlatBuffers zero-copy storage, cutting memory use by about 75% (~45 MB saved) ([Brave, Jan 2026](https://brave.com/privacy-updates/36-adblock-memory-reduction)) | Independent of MV2/MV3, so Brave still supports a few MV2 extensions (uBO, NoScript, AdGuard, uMatrix) after Chrome removed MV2 ([ghacks](https://www.ghacks.net/?p=181006)). Scale: about 340 staff, about 122M MAU in July 2026, more than $100M annualized revenue ([stockanalysis](https://stockanalysis.com/private/brave/), [piunikaweb](https://piunikaweb.com/2026/09/03/brave-browser-126-million-users-august-2026/)). |
| **Vivaldi** | Chromium | The UI is a **React/HTML/CSS app** running on top of a patched Chromium, which is the same idea as your toolbar ([thurrott](https://www.thurrott.com/?p=287859)) | Web-tech UI speeds up iteration. Every Chromium version still has to be re-patched on 4 platforms. Early on, one engineer did that integration in under 2 weeks per version ([Vivaldi blog](https://vivaldi.com/?p=29166)). |
| **Arc → Dia** (The Browser Company) | Chromium, native **Swift** UI | Arc went into maintenance in May 2025. Dia is an AI-first browser. Atlassian acquired the company for $610M in Sept 2025 ([TidBITS](https://tidbits.com/2025/09/04/atlassian-acquires-the-browser-company-for-610-million/), [Wikipedia](https://en.wikipedia.org/wiki/Dia_(web_browser))) | Even well-funded startups need years and VC money to ship a polished Chromium shell, and they pivot when they lack a monetization path. |
| **Opera** | Chromium/Blink since 2013, after dropping its Presto engine | Proprietary UI and services on Chromium | Revenue comes from search deals, ads and news. |
| **Microsoft Edge** | Chromium since 2018–2020 ([announcement, 2018-12-06](https://blogs.windows.com/windowsexperience/2018/12/06/microsoft-edge-making-the-web-better-through-more-open-source-collaboration/)) | Dropped its own EdgeHTML engine for web compatibility and contributes upstream | Even Microsoft decided maintaining its own engine wasn't worth it. |
| **Zen / Floorp / LibreWolf** | Firefox (Gecko) forks | Zen ships near-weekly and claims to rebase onto Firefox security releases within 0–72 h. Floorp moved from ESR to Rapid Release. LibreWolf has no built-in auto-updater and relies on package managers ([linuxcompatible](https://www.linuxcompatible.org/story/zen-browser-122b-ships-crossdevice-workspace-sync-squircle-ui-and-firefox-155-security-patches/), [factually](https://factually.co/fact-checks/electronics-tech/zen-browser-long-term-reliability-update-cadence-review-5f1a8c)) | Mozilla's toolchain is friendlier to small forks. The weak point is still update lag and the lack of auto-update. |
| **Orion** (Kagi) | WebKit | Orion 1.0 shipped on macOS in Nov 2025. **On 2026-10-05 Kagi ended Linux/Windows development** (the Linux beta got its last update 2026-10-02) and is open-sourcing that code, citing "substantial engineering demands" ([AlternativeTo](https://alternativeto.net/news/2026/10/kagi-ends-development-of-orion-for-linux-and-windows-open-sources-code-to-community/)) | A non-Chromium engine on Windows or Linux is beyond what a small team can sustain. |
| **Ladybird** | New engine written from scratch (C++, being ported incrementally to Rust; the Swift plan was dropped) | Run by a 501(c)(3) nonprofit, funded by donations, with no search deals. Alpha targeted for 2026 on Linux and macOS and **not yet released** as of this research ([ladybird.org](https://ladybird.org/)) | A multi-year, multi-million-dollar effort. Not a path for a product team. |

**Pattern:** wrap Chromium (or Gecko), put all your differentiation in UI, privacy features and services, and invest heavily in rebase tooling and release engineering.

---

## 2. Electron-based browsers: what worked, what broke

| Project | Status | Notes |
|---|---|---|
| [Min](https://github.com/minbrowser/min) | Active (~9.2k stars) | Minimal by design: built-in ad and tracker blocking, reader view, tasks. Offers **userscripts instead of extensions**, and its niche is focus and minimalism. |
| [Beaker](https://github.com/beakerbrowser/beaker) | **Archived 2022-12-27** | A P2P (Dat/Hypercore) browser. It died when the product thesis faded, not because of Electron. |
| Wexond / browser-base | **Archived 2023-06-04** ([whatismybrowser](https://www.whatismybrowser.com/guides/big-list-of-all-web-browsers/view/wexond)) | Ambitious Chrome-like Electron browser with an extensions layer. It couldn't keep up with full browser expectations. |
| Sizzy, Ferdium, etc. | Active | They succeed by being *specialized* (dev multi-viewport, messenger wrapper) rather than competing as a general browser. |

**The limits they hit:**

- **Extensions.** Electron supports only a subset of `chrome.*` (runtime, tabs partially, `storage.local`, scripting, webRequest, devtools). Only unpacked extensions are loaded, and Chrome Web Store support is an **explicit non-goal** ([Electron docs](https://www.electronjs.org/docs/latest/api/extensions)). [electron-chrome-extensions / electron-chrome-web-store](https://github.com/samuelmaddock/electron-browser-shell) fill gaps, but MV3 is blocked on an upstream Electron issue (#44411) and there is no enable/disable/uninstall UX.
- **Update cadence.** Electron cuts a major every 8 weeks and supports the latest 3 majors ([timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)). As of 2026-10-07, Electron **44.7.0 ships Chromium 152** ([release](https://releases.electronjs.org/release/v44.7.0)), while Chrome stable is at **155**. Electron 45 (about M156) is scheduled around 2026-10-20 ([endoflife.ai](https://endoflife.ai/article-electron-42-eol), [releases](https://releases.electronjs.org/)). Security fixes are backported, but the gap is structural.
- **Security track record.** The "Electrovolt" research (DEF CON 30) compromised 20 Electron apps, partly through stale Chromium ([Infosecurity](https://infosecurity-magazine.com/news/defcon-electrovolt-exploits), [Intego](https://www.intego.com/mac-security-blog/chromium-vulnerabilities-threaten-electron-app-security/)). Electron says untrusted content is "a severe security risk that Electron is not intended to handle" ([security checklist](https://www.electronjs.org/docs/latest/tutorial/security)).
- **Google sign-in.** Since June 2019 Google has blocked sign-in from embedded frameworks such as CEF and Electron to stop MITM phishing ([Google Security Blog, 2019-04-18](https://security.googleblog.com/2019/04/better-protection-against-man-in-middle.html)). Removing the `Electron/` token from the UA (as `main.js` does) helps with UA sniffing. Google also uses other signals, so this is a cat-and-mouse game and can break at any time *(inference)*.
- **DRM (Netflix, Spotify, Disney+).** Stock Electron has no Widevine. The usual route is [castLabs Electron for Content Security](https://github.com/castlabs/electron-releases): a fork with Widevine CDM, VMP-signed for development only. **Production requires enrolling in castLabs EVS** for VMP signing. It works on Windows and macOS, Linux is limited, and the fork is maintained "best-effort" and trails upstream Electron. Small Chromium forks have the same problem: Widevine VMP needs Google's approval ([Axinom VMP](https://75.docs.axinom.com/services/drm/technical-articles/verified-media-path)).
- **Performance and memory.** One `WebContentsView` per tab is fine. Plan tab discarding and sleeping for 50+ tabs, which Chrome does natively and Electron leaves to you *(inference)*.

---

## 3. The must-get-right list

| Area | What "right" looks like | Notes for Electron |
|---|---|---|
| **Security update cadence** | Chrome: 2-week milestones since 2026-09-08 ([Chrome blog, 2026-03-03](https://developer.chrome.com/blog/chrome-two-week-release)) plus **weekly** security fixes since Chrome 116 ([Google, 2023-08](https://security.googleblog.com/2023/08/an-update-on-chrome-security-updates.html)). Brave ships within about 24 h. | Subscribe to Electron releases and ship every patch release that has security backports **within days**. Never fall outside the 3 supported majors. |
| **Sandbox / site isolation** | Every renderer sandboxed, site-per-process, no privileged APIs in web content | Already done: `sandbox:true`, `contextIsolation`, IPC sender checks. Add `app.enableSandbox()` and the fuses (see §4). |
| **Auto-update + signing** | Silent, signed, staged updates on all OSes | macOS: Developer ID + notarization are required, and Squirrel.Mac **won't update unsigned apps** ([Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)). Windows: Azure Artifact Signing at $9.99/mo (individual onboarding paused as of Mar 2026, US/CA entities only) or an OV/EV cert on an HSM. EV **no longer gives instant SmartScreen reputation** ([devclass, 2026-01](https://devclass.com/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/)). Linux: Electron's updater doesn't cover it ([updates](https://www.electronjs.org/docs/latest/tutorial/updates)), so use distro repos (apt/rpm), Flatpak or AppImage with electron-updater. |
| **Safe browsing / phishing** | Real-time URL reputation and download scanning | Google Safe Browsing API is **non-commercial only**. Commercial products use the paid **Web Risk API** ([terms](https://developers.google.com/safe-browsing/terms)). Google cut third-party Chromium browsers off its private APIs, including Safe Browsing and Sync, in March 2021 ([ghacks](https://www.ghacks.net/2021/01/16/sync-and-other-features-may-stop-working-in-some-chromium-browsers-in-march-2021)). |
| **DRM** | Widevine for streaming | castLabs ECS + EVS (above). Budget for it, or say clearly that streaming DRM isn't supported. |
| **Search deals / revenue** | Default-search revenue share is the industry's main funding source | In Sept 2025 Google was barred from *exclusive* default deals for 6 years, but payments are still allowed ([Techdirt](https://www.techdirt.com/2025/09/03/judge-mehtas-google-antitrust-remedies-threading-the-needle-between-overkill-and-underkill/)). The DOJ is appealing to ban payments ([MediaPost](https://www.mediapost.com/publications/article/416888/google-search-remedies-too-weak-feds-tell-appeals.html)). Small browsers usually get affiliate deals through partners (DuckDuckGo, Brave Search, Ecosia, Startpage) rather than directly. Alternatives: subscriptions (Kagi/Orion), donations (Ladybird), ads (Brave). |
| **Privacy / telemetry** | Opt-in, minimal, documented | Make the update check the only default network call besides browsing. Publish a privacy policy. |
| **Extensions** | Users expect uBlock Origin, a password manager and Dark Reader | In Electron, plan **built-in** content blocking (e.g. `@ghostery/adblocker-electron`, or adblock-rust via napi) instead of promising extension parity. Chrome finished MV2 removal in Chrome 138 (July 2025) ([betanews](https://betanews.com/article/firefox-brave-ublock-origin-chrome-edge/)). |
| **Sync** | E2E-encrypted bookmarks, history and passwords | You can't use Google Sync. Build your own (Brave and Vivaldi run their own servers) or skip it and offer import/export first. |
| **Crash reporting** | Native minidumps and symbolication | Electron `crashReporter` → Sentry or Backtrace. It must be opt-in and named in the privacy policy. |
| **Accessibility** | Screen readers work for both UI and pages | Pages inherit Chromium AX. The HTML toolbar needs ARIA roles (`tablist`/`tab`), focus management and keyboard access to the permission bar. |
| **Passwords** | Save, fill and generate, with secure storage | Electron has no password manager. Use `safeStorage` (Keychain, DPAPI, libsecret), which requires a signed macOS app. Or recommend Bitwarden or 1Password integration first. |
| **Legal** | Licenses, trademarks, policy | Bundle Chromium/Electron third-party licenses (`LICENSES.chromium.html` ships with Electron). Don't use "Chrome" or "Google" marks. Have a privacy policy and EULA. Pick a product name and check trademarks; "Browser" isn't registrable. |
| **Distribution** | Store and package presence | **Microsoft Store 10.2.1:** browsers must use Chromium or Gecko and stay **within 2 major versions** of upstream, with security issues patched promptly ([policy v7.20, 2026-09](https://learn.microsoft.com/windows/apps/publish/store-policies)). With Chrome's 2-week milestones, Electron 44 (M152) is already 3 behind M155, so a Store listing may be at risk *(inference)*. Mac App Store sandboxing gets in the way of browser features, so major browsers ship outside it via direct DMG *(inference)*. Linux: Flatpak (Flathub needs the zypak wrapper for Chromium's sandbox), deb/rpm repos, AppImage. |

---

## 4. Concrete recommendations for this project

### What the code already does well

- `BaseWindow` + one `WebContentsView` per tab with `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` ([main.js:293](../main.js)).
- The preload only exposes `browserAPI` on `file:` pages, and **every IPC re-checks the sender** (`fromChrome`/`fromInternal`). This is the correct pattern.
- Permission prompts are deny-by-default with an allow-list. Prompts are dismissed on navigation. Storage uses atomic `.tmp` + rename.
- `setWindowOpenHandler` denies popups and opens them as tabs. The internal pages use strict CSPs.

### Gaps and risks found in the code

1. **Internal pages use `file://`.** Electron's checklist item #18 says to prefer custom protocols. Register a privileged `browser://` scheme with `protocol.handle` serving from `pages/`, then set the `GrantFileProtocolExtraPrivileges` fuse to off. It also makes `displayUrl` simpler.
2. **No fuses set.** Flip `RunAsNode`, `NodeOptions` and `NodeCliInspect` off, and turn `EnableCookieEncryption`, `EmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` on ([fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)).
3. **No `will-navigate` / `will-frame-navigate` policy on tabs.** Block navigation to `file://` from web origins and handle unknown schemes explicitly. Today `resolveInput` accepts typed `file://` URLs, so decide whether that is wanted.
4. **No `will-download` handler.** You get Electron's default save dialog, with no download UI, progress or "open folder", and no dangerous-file warning.
5. **No `certificate-error` / `select-client-certificate` / `login` (HTTP auth) handlers.** The defaults reject bad certificates, which is safe, but the error page shows a raw description. Add a clear TLS interstitial with no bypass by default.
6. **The toolbar loads favicons from arbitrary origins** (`img-src *` in `ui/index.html`, `img.src = t.favicon` in `ui/ui.js`). Fetch favicons in main, or via `capturePage`/`net` in the tab's session, and pass `data:` URLs, so the privileged UI never makes third-party requests.
7. **One `defaultSession` for everything.** There are no private windows, and site data, permissions and cache are shared. Add `session.fromPartition('incognito-…')` without `persist:` for private windows.
8. **JSON store growth.** The whole history (5,000 entries) is rewritten on every debounced save. Move to SQLite (`better-sqlite3` or `node:sqlite`) before adding full-text history search or sync.
9. **UA spoofing.** It's fine for now. Expect Google sign-in to break sometimes, and keep a test account and smoke test for it.
10. **Electron `^44.7.0` with a caret range.** Pin exact versions and bump deliberately each week, using Renovate/Dependabot with a CI smoke test.

### Prioritized next steps

**P0: before giving it to anyone else**
- [ ] Packaging with Electron Forge or electron-builder, plus **signing**: macOS Developer ID + notarization, Windows Artifact Signing or OV.
- [ ] **Auto-update** on macOS/Windows (update.electronjs.org or S3 static feed), and a Linux repo or Flatpak.
- [ ] Process for **weekly Electron patch bumps**, with a target of shipping security backports in 7 days or less, and an "update required" kill switch.
- [ ] Fuses + `app.enableSandbox()` + custom `browser://` protocol + a tab navigation policy (items 1–3).
- [ ] Downloads (manager UI, Mark-of-the-Web is Chromium's default), a TLS error interstitial, and HTTP auth.

**P1: what makes it a "solid basic browser"**
- [ ] Find in page (`findInPage`), context menu (`context-menu` event: open link in new tab, copy, save image, inspect), print, and session restore after crash or relaunch.
- [ ] Private windows using non-persistent partitions.
- [ ] Built-in content blocking (EasyList/EasyPrivacy) via `session.webRequest` or an Electron adblock library, with per-site toggles.
- [ ] Omnibox suggestions from history and bookmarks, a search engine picker, and import from Chrome/Firefox (bookmarks HTML).
- [ ] Phishing protection: Web Risk API, or ship without it but don't claim to have it.
- [ ] Accessibility pass on the toolbar (ARIA tablist, keyboard focus loop, `prefers-reduced-motion`).
- [ ] Opt-in crash reporting + privacy policy.

**P2: growth features**
- [ ] SQLite storage, then E2E-encrypted sync (your own server) or a file-based sync folder.
- [ ] Password manager via `safeStorage`, or integration guidance for Bitwarden/1Password.
- [ ] Limited extension support via `electron-chrome-extensions`, positioned as experimental.
- [ ] Widevine via castLabs ECS + EVS, only if streaming matters to your users and the budget allows.
- [ ] Tab sleeping and discarding, and memory pressure handling.

### When to migrate: Tauri/wry vs. Chromium fork

| Option | Verdict |
|---|---|
| **Tauri / wry (system webviews)** | **Not recommended for a general browser.** You'd get three engines with three behaviours (WKWebView, WebView2, WebKitGTK). Multi-webview per window is still behind an *unstable* feature flag ([Tauri](https://v2.tauri.app/blog/tauri-2-0-0-beta/)), and per-tab permission, download and devtools control is weaker. Orion's Linux/Windows retreat (Oct 2026) shows how costly WebKit outside Apple platforms is. It might fit a lightweight macOS-only or reader-style browser. |
| **Chromium fork (Brave-style `chromium_src` + patches)** | Makes sense **only when all of these are true:** (a) you have real users and revenue (search deal, subscription), (b) you need things Electron can't give you: Web Store extensions, native Chrome-parity autofill/passwords, a Chrome-level update cadence, or a Microsoft Store listing within 2 majors, (c) you can fund **at least 2–3 engineers** on rebases plus release engineering and very large build infrastructure. Brave runs a dedicated rebase team, and even Vivaldi in its early years needed a full-time rebase owner per 6-week cycle. |
| **Stay on Electron** | Right for the next 6–18 months. Keep UI and storage logic decoupled from Electron APIs (an IPC/service layer) so a later port to a Chromium shell (WebUI or Views) reuses the HTML toolbar, as Vivaldi does. |

---

## 5. Final prioritized checklist

1. [ ] Sign + notarize (macOS), sign (Windows), and package Linux (Flatpak/deb).
2. [ ] Auto-update on all three OSes, with staged rollout and forced update for critical CVEs.
3. [ ] Weekly Electron patch-bump routine with pinned versions; never fall outside the 3 supported majors.
4. [ ] Electron fuses + `app.enableSandbox()` + `browser://` custom protocol instead of `file://`.
5. [ ] Tab navigation policy (`will-navigate`, `will-frame-navigate`, external protocols) and a TLS interstitial.
6. [ ] Downloads manager, find-in-page, context menu, print, session restore.
7. [ ] Private windows (in-memory partitions) and built-in tracker/ad blocking.
8. [ ] Move favicon fetching out of the privileged UI, and move storage to SQLite.
9. [ ] Privacy policy, opt-in crash reporting, licenses bundle, product name/trademark check.
10. [ ] Decide on DRM (castLabs EVS), safe browsing (Web Risk) and search revenue partner, and revisit a Chromium fork only once there is revenue plus 2–3 engineers for rebases.
