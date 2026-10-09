'use strict';

// Self-updater that needs no paid code-signing certificates.
//
// Each GitHub release carries a small manifest per platform (latest-mac.json, latest-win.json,
// latest-linux.json) naming the update file, plus that file:
//   macOS   a zip of the .app, swapped in place after the app quits
//   Windows the NSIS installer, run silently after the app quits
//   Linux   the AppImage, which replaces the running AppImage file
// Updates are signed with our own Ed25519 key (the public half ships inside the app).
// signature2 signs "platform + version + file name + SHA-256 of the file", so an older signed
// file can't be passed off as a newer version. Mac manifests also keep the original
// signature (over the zip bytes) for copies installed before v0.11.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { app, net } = require('electron');
const { signedPayload } = require('./update-format');

const run = promisify(execFile);

const REPO = 'ezzeldinzozz-svg/browser';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// CI's end-to-end update test serves updates from a local server, signed with a throwaway key.
// Both overrides only apply when BROWSER_UPDATE_TEST=1 is set as well.
const TEST = process.env.BROWSER_UPDATE_TEST === '1';
const TEST_BASE = TEST ? process.env.BROWSER_UPDATE_URL : null;
const PUBLIC_KEY = fs.readFileSync(
  TEST && process.env.BROWSER_UPDATE_KEY ? process.env.BROWSER_UPDATE_KEY : path.join(__dirname, 'update-public-key.pem'),
  'utf8',
);

const PLATFORM = {
  darwin: { key: `mac-${process.arch}`, manifest: process.arch === 'arm64' ? 'latest-mac.json' : `latest-mac-${process.arch}.json`, ext: /\.zip$/ },
  win32: { key: `win-${process.arch}`, manifest: 'latest-win.json', ext: /\.exe$/ },
  linux: { key: `linux-${process.arch}`, manifest: 'latest-linux.json', ext: /\.AppImage$/ },
}[process.platform];

const manifestUrl = () =>
  TEST_BASE ? `${TEST_BASE}/${PLATFORM.manifest}` : `https://github.com/${REPO}/releases/latest/download/${PLATFORM.manifest}`;
const fileUrl = (version, file) =>
  TEST_BASE ? `${TEST_BASE}/${file}` : `https://github.com/${REPO}/releases/download/v${version}/${file}`;

// status: idle | checking | downloading | ready | none | error | unsupported
let state = { status: 'idle' };
let ready = null; // { kind, path } of a verified update waiting to be installed
let listener = () => {};

function setState(next) {
  // checkedAt: when a check last finished (shown as "Last checked" in Settings)
  const finished = ['none', 'ready', 'error'].includes(next.status);
  state = { ...next, checkedAt: finished ? Date.now() : state.checkedAt };
  listener(state);
}

const bundlePath = () => path.resolve(process.execPath, '..', '..', '..'); // macOS .app

function writable(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function unsupportedReason() {
  if (!PLATFORM) return "Automatic updates aren't available on this system.";
  if (!app.isPackaged) return 'Updates are disabled in development builds.';
  if (process.platform === 'darwin') {
    const bundle = bundlePath();
    if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
      return 'Move Browser to your Applications folder to get updates.';
    }
    if (!writable(path.dirname(bundle)) || !writable(bundle)) {
      return "Browser can't update itself here because the folder isn't writable.";
    }
  } else if (process.platform === 'win32') {
    // Installed by our NSIS installer (it puts the uninstaller next to the app).
    if (!fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`))) {
      return 'Install Browser with its installer to get automatic updates.';
    }
  } else if (process.platform === 'linux') {
    const appImage = process.env.APPIMAGE;
    if (!appImage) return 'This package updates by installing the new .deb from the releases page.';
    if (!writable(path.dirname(appImage)) || !writable(appImage)) {
      return "Browser can't update itself here because the AppImage's folder isn't writable.";
    }
  }
  return null;
}

function isNewer(candidate, current) {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}


function verifySignature(manifest, data) {
  if (typeof manifest.signature2 === 'string') {
    const payload = signedPayload(PLATFORM.key, manifest.version, manifest.file, data);
    return crypto.verify(null, payload, PUBLIC_KEY, Buffer.from(manifest.signature2, 'base64'));
  }
  // Only macOS ever had the original signature format; the others require signature2.
  if (process.platform !== 'darwin' || typeof manifest.signature !== 'string') return false;
  return crypto.verify(null, data, PUBLIC_KEY, Buffer.from(manifest.signature, 'base64'));
}

async function plistValue(appPath, key) {
  const { stdout } = await run('/usr/bin/defaults', ['read', path.join(appPath, 'Contents', 'Info'), key]);
  return stdout.trim();
}

// The signing identity requirement of an app, or null for ad-hoc signatures (which only
// name a code hash that changes every build, so there's nothing stable to compare).
async function designatedRequirement(appPath) {
  const { stdout, stderr } = await run('/usr/bin/codesign', ['-d', '-r-', appPath]);
  const match = `${stdout}\n${stderr}`.match(/designated => (.+)/);
  if (!match || /cdhash/.test(match[1])) return null;
  return match[1].trim();
}

// Streams the download so the UI can show progress (0..1, or -1 when the size is unknown).
async function download(url, version) {
  setState({ status: 'downloading', version, progress: 0 });
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (Date.now() - lastReport > 250) {
      lastReport = Date.now();
      setState({ status: 'downloading', version, progress: total ? received / total : -1 });
    }
  }
  return Buffer.concat(chunks);
}

// ---- preparing a verified update, per platform

async function prepareMac(data, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-update-'));
  const zipPath = path.join(dir, manifest.file);
  fs.writeFileSync(zipPath, data);
  const extractDir = path.join(dir, 'app');
  await run('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
  fs.rmSync(zipPath);

  const appName = fs.readdirSync(extractDir).find((f) => f.endsWith('.app'));
  if (!appName) throw new Error('Update contains no app');
  const newApp = path.join(extractDir, appName);

  const [newId, curId, newVersion] = await Promise.all([
    plistValue(newApp, 'CFBundleIdentifier'),
    plistValue(bundlePath(), 'CFBundleIdentifier'),
    plistValue(newApp, 'CFBundleShortVersionString'),
  ]);
  if (newId !== curId) throw new Error('Update is for a different app');
  if (newVersion !== manifest.version) throw new Error('Update version does not match');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp]);
  // When this app is signed with our certificate, the update must be signed with it too.
  const requirement = await designatedRequirement(bundlePath());
  if (requirement) await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${requirement}`, newApp]);
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});
  return { kind: 'mac', path: newApp };
}

function prepareWindows(data, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-update-'));
  const installer = path.join(dir, manifest.file);
  fs.writeFileSync(installer, data);
  return { kind: 'win', path: installer };
}

function prepareLinux(data, manifest) {
  // Same folder as the running AppImage, so the final swap is an atomic rename.
  const target = process.env.APPIMAGE;
  const next = path.join(path.dirname(target), `.${path.basename(target)}.update-${manifest.version}`);
  fs.writeFileSync(next, data, { mode: 0o755 });
  return { kind: 'linux', path: next };
}

async function check() {
  if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
  const reason = unsupportedReason();
  if (reason) {
    setState({ status: 'unsupported', error: reason });
    return state;
  }

  setState({ status: 'checking' });
  try {
    const res = await net.fetch(manifestUrl(), { cache: 'no-store' });
    if (res.status === 404) {
      setState({ status: 'none' });
      return state;
    }
    if (!res.ok) throw new Error(`Update check failed (HTTP ${res.status})`);
    const manifest = await res.json();
    const { version, file } = manifest;
    if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[\w. ()-]+$/.test(file || '') || !PLATFORM.ext.test(file)) {
      throw new Error('Update information is malformed');
    }
    if (!isNewer(version, app.getVersion())) {
      setState({ status: 'none' });
      return state;
    }

    const data = await download(fileUrl(version, file), version);
    if (!verifySignature(manifest, data)) throw new Error('Update signature is invalid');

    if (process.platform === 'darwin') ready = await prepareMac(data, manifest);
    else if (process.platform === 'win32') ready = prepareWindows(data, manifest);
    else ready = prepareLinux(data, manifest);
    setState({ status: 'ready', version });
  } catch (err) {
    setState({ status: 'error', error: err.message });
  }
  return state;
}

// ---- installing, after this process exits

// Hands the install to a detached helper that waits for this process to exit, puts the new
// version in place (restoring the old one if that fails), and optionally relaunches.
// Returns false when nothing is ready. Caller is responsible for quitting.
function install(relaunch) {
  if (!ready) return false;
  const { kind, path: next } = ready;
  ready = null;
  const detached = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  if (kind === 'mac' || kind === 'linux') {
    const target = kind === 'mac' ? bundlePath() : process.env.APPIMAGE;
    const script = [
      'pid="$1"; new="$2"; target="$3"; relaunch="$4"; kind="$5"',
      'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
      'if [ "$kind" = linux ]; then',
      '  mv -f "$new" "$target" || rm -f "$new"', // an AppImage is one file: rename over it
      '  [ "$relaunch" = 1 ] && nohup "$target" >/dev/null 2>&1 &',
      'else',
      '  backup="$target.previous-$$"',
      '  if mv "$target" "$backup"; then',
      '    if mv "$new" "$target"; then rm -rf "$backup"; else mv "$backup" "$target"; fi',
      '  fi',
      '  [ "$relaunch" = 1 ] && open "$target"',
      'fi',
    ].join('\n');
    detached('/bin/sh', ['-c', script, 'browser-updater', String(process.pid), next, target, relaunch ? '1' : '0', kind]);
  } else {
    // Windows: once this process is gone, run the installer silently (per-user, no admin).
    // --force-run starts the new version afterwards.
    const ps1 = path.join(path.dirname(next), 'install-update.ps1');
    fs.writeFileSync(
      ps1,
      [
        'param([int]$ProcessId, [string]$Installer, [int]$Relaunch)',
        'Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue',
        '$installArgs = @("/S", "--updated")',
        'if ($Relaunch -eq 1) { $installArgs += "--force-run" }',
        'Start-Process -FilePath $Installer -ArgumentList $installArgs -Wait',
      ].join('\r\n'),
    );
    detached('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', ps1, '-ProcessId', String(process.pid), '-Installer', next, '-Relaunch', relaunch ? '1' : '0',
    ]);
  }
  return true;
}

function start(onChange) {
  listener = onChange;
  if (unsupportedReason()) {
    setState({ status: 'unsupported', error: unsupportedReason() });
    return;
  }
  setTimeout(check, TEST ? 3000 : 10 * 1000);
  setInterval(check, CHECK_EVERY_MS).unref();
}

module.exports = { start, check, install, download, getState: () => state };
