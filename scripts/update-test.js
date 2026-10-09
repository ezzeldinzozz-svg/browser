'use strict';

// CI only: starts an installed old build pointed at a local update server, waits until the
// toolbar offers "Restart to update", clicks it and waits for the app to exit. The workflow
// then checks that the new version is in place and running.
//   node scripts/update-test.js <executable> <serveDir>

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [exe, serveDir] = process.argv.slice(2);
const PORT = 9341;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-update-test-'));
fs.writeFileSync(path.join(profile, 'browser-data.json'), JSON.stringify({ welcomed: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function toolbar(expression) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const t = list.find((x) => x.url === 'browser://ui/');
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return new Promise((resolve) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) {
        ws.close();
        resolve(d.result.result ? d.result.result.value : undefined);
      }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { version: expectedVersion } = require('../package.json');

function poll(what, test, seconds) {
  return (async () => {
    for (let i = 0; i < seconds; i++) {
      try {
        const result = test();
        if (result) return result;
      } catch {
        // not yet
      }
      await sleep(1000);
    }
    throw new Error(`timed out waiting for: ${what}`);
  })();
}

async function verifyUpdated() {
  if (process.platform === 'win32') {
    const installed = await poll('the new version to be installed', () => {
      const v = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
      return v.startsWith(expectedVersion) ? v : null;
    }, 180);
    console.log(`installed version is now ${installed}`);
    await poll('the new version to start', () => /Operecs\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Operecs.exe'], { encoding: 'utf8' })), 60);
  } else {
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const update = fs.readdirSync(serveDir).find((f) => f.endsWith('.AppImage'));
    const expected = sha(path.join(serveDir, update));
    await poll('the AppImage to be replaced', () => sha(exe) === expected, 120);
    console.log('the AppImage was replaced with the new version');
    await poll('the new version to start', () => execFileSync('pgrep', ['-f', exe], { encoding: 'utf8' }).trim(), 60);
  }
  console.log('the new version is running');
}

async function main() {
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, '--use-mock-keychain'], {
    env: {
      ...process.env,
      BROWSER_PROFILE_DIR: profile,
      BROWSER_UPDATE_TEST: '1',
      BROWSER_UPDATE_URL: 'http://127.0.0.1:8780',
      BROWSER_UPDATE_KEY: path.resolve(serveDir, 'test-public-key.pem'),
    },
    // Pipes rather than inherited output: helper processes the old app leaves behind (crash
    // reporter, the relaunched new version) must not hold the CI step's output open.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  let exited = false;
  child.on('exit', () => (exited = true));

  let last = '';
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const text = await toolbar(
      "(b => b.hidden ? 'hidden' : b.textContent)(document.getElementById('update'))",
    ).catch(() => undefined);
    if (text && text !== last) console.log(`toolbar update button: ${text}`);
    last = text || last;
    if (text === 'Restart to update') {
      await toolbar("document.getElementById('update').click()");
      console.log('clicked Restart to update');
      for (let j = 0; j < 60 && !exited; j++) await sleep(1000);
      if (!exited) throw new Error('app did not exit after Restart to update');
      console.log('old version exited; the updater takes over');
      // Stay in this step until the new version is in place and running: CI runners (Windows
      // job objects) kill whatever a step started once it ends, which would kill the updater.
      await verifyUpdated();
      process.exit(0); // don't wait on anything the apps leave running
    }
  }
  child.kill();
  throw new Error('no update was offered within 3 minutes');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
