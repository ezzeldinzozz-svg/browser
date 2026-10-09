'use strict';

// Self-updater for macOS that needs no paid Apple certificate.
//
// Each GitHub release carries latest-mac.json ({ version, file, signature }) and a zip of
// the app. The zip is signed with our own Ed25519 key; the public half ships inside the app.
// An update is installed only if the signature verifies, the bundle id matches, the version
// is newer, and macOS's own code-signature check passes. The swap happens after the app quits.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { app, net } = require('electron');

const run = promisify(execFile);

const REPO = 'ezzeldinzozz-svg/browser';
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/latest-mac.json`;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, 'update-public-key.pem'), 'utf8');

// status: idle | checking | downloading | ready | none | error | unsupported
let state = { status: 'idle' };
let readyApp = null; // extracted, verified new .app waiting to replace the running one
let listener = () => {};

function setState(next) {
  // checkedAt: when a check last finished (shown as "Last checked" in Settings)
  const finished = ['none', 'ready', 'error'].includes(next.status);
  state = { ...next, checkedAt: finished ? Date.now() : state.checkedAt };
  listener(state);
}

const bundlePath = () => path.resolve(process.execPath, '..', '..', '..');

// Updating needs a packaged mac app in a writable folder (not the DMG, not quarantined/translocated).
function unsupportedReason() {
  if (process.platform !== 'darwin') return 'Automatic updates are only available on macOS for now.';
  if (!app.isPackaged) return 'Updates are disabled in development builds.';
  const bundle = bundlePath();
  if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return 'Move Browser to your Applications folder to get updates.';
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    return "Browser can't update itself here because the folder isn't writable.";
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

async function check() {
  if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
  const reason = unsupportedReason();
  if (reason) {
    setState({ status: 'unsupported', error: reason });
    return state;
  }

  setState({ status: 'checking' });
  try {
    const res = await net.fetch(MANIFEST_URL, { cache: 'no-store' });
    if (res.status === 404) {
      setState({ status: 'none' });
      return state;
    }
    if (!res.ok) throw new Error(`Update check failed (HTTP ${res.status})`);
    const manifest = await res.json();
    const { version, file, signature } = manifest;
    if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[\w.-]+\.zip$/.test(file || '') || typeof signature !== 'string') {
      throw new Error('Update information is malformed');
    }
    if (!isNewer(version, app.getVersion())) {
      setState({ status: 'none' });
      return state;
    }

    const zip = await download(`https://github.com/${REPO}/releases/download/v${version}/${file}`, version);
    if (!crypto.verify(null, zip, PUBLIC_KEY, Buffer.from(signature, 'base64'))) {
      throw new Error('Update signature is invalid');
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-update-'));
    const zipPath = path.join(dir, file);
    fs.writeFileSync(zipPath, zip);
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
    if (newVersion !== version) throw new Error('Update version does not match');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp]);
    // When this app is signed with our certificate, the update must be signed with it too.
    const requirement = await designatedRequirement(bundlePath());
    if (requirement) await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${requirement}`, newApp]);
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});

    readyApp = newApp;
    setState({ status: 'ready', version });
  } catch (err) {
    setState({ status: 'error', error: err.message });
  }
  return state;
}

// Hands the swap to a detached shell that waits for this process to exit, replaces the
// bundle (restoring the old one if the move fails), and optionally relaunches.
// Returns false when nothing is ready. Caller is responsible for quitting.
function install(relaunch) {
  if (!readyApp) return false;
  const script = [
    'pid="$1"; new="$2"; target="$3"; relaunch="$4"',
    'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
    'backup="$target.previous-$$"',
    'if mv "$target" "$backup"; then',
    '  if mv "$new" "$target"; then rm -rf "$backup"; else mv "$backup" "$target"; fi',
    'fi',
    '[ "$relaunch" = 1 ] && open "$target"',
  ].join('\n');
  spawn('/bin/sh', ['-c', script, 'browser-updater', String(process.pid), readyApp, bundlePath(), relaunch ? '1' : '0'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  readyApp = null;
  return true;
}

function start(onChange) {
  listener = onChange;
  if (unsupportedReason()) {
    setState({ status: 'unsupported', error: unsupportedReason() });
    return;
  }
  setTimeout(check, 10 * 1000);
  setInterval(check, CHECK_EVERY_MS).unref();
}

module.exports = { start, check, install, download, getState: () => state };
