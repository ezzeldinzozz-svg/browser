'use strict';

// Starts a built browser on a throwaway profile and checks the basics work, over the Chrome
// DevTools Protocol. Used by CI on Windows and Linux (and works on macOS too).
//
//   node scripts/smoke-test.js <path to the app's executable>

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = process.argv[2];
const PORT = 9339;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-smoke-'));
fs.writeFileSync(path.join(profile, 'browser-data.json'), JSON.stringify({ welcomed: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
}

async function evaluate(match, expression) {
  const t = (await targets()).find((x) => (typeof match === 'function' ? match(x.url) : x.url === match));
  if (!t) throw new Error(`no page for ${match}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return new Promise((resolve) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== 1) return;
      ws.close();
      resolve(d.result.result ? d.result.result.value : undefined);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

async function check(name, fn) {
  try {
    const result = await fn();
    if (result === false || result === undefined) throw new Error(`got ${result}`);
    console.log(`  ok   ${name}${result === true ? '' : `: ${result}`}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

async function main() {
  if (!exe || !fs.existsSync(exe)) throw new Error(`executable not found: ${exe}`);
  console.log(`Smoke test: ${exe}`);
  const args = [
    ...(exe.includes('Electron.app') || exe.endsWith('electron') ? [path.join(__dirname, '..')] : []),
    `--remote-debugging-port=${PORT}`,
    '--use-mock-keychain',
  ];
  const child = spawn(exe, args, {
    env: { ...process.env, BROWSER_PROFILE_DIR: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  // wait for the toolbar page to exist
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000);
    try {
      up = (await targets()).some((t) => t.url === 'browser://ui/');
    } catch {
      // not listening yet
    }
  }

  await check('browser starts and shows its toolbar', () => up);
  if (up) {
    await check('toolbar API is available', () => evaluate('browser://ui/', 'typeof browserAPI === "object"'));
    await check('new tab page loads', async () => (await targets()).some((t) => t.url.startsWith('browser://newtab')));
    await check('extension toolbar element is defined', () =>
      evaluate('browser://ui/', "!!customElements.get('browser-action-list')"),
    );
    await check('navigates to a website', async () => {
      await evaluate('browser://ui/', "browserAPI.go('https://example.com/')");
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const title = await evaluate((u) => u.startsWith('https://example.com'), 'document.title').catch(() => null);
        if (title) return title;
      }
      return false;
    });
    await check('websites cannot reach the browser API', () =>
      evaluate((u) => u.startsWith('https://example.com'), 'typeof browserAPI === "undefined"'),
    );
    await check('settings page loads', async () => {
      await evaluate('browser://ui/', "browserAPI.go('browser://settings')");
      await sleep(2000);
      return evaluate((u) => u.startsWith('browser://settings'), "document.querySelector('h1').textContent");
    });
    await check('bookmarks overflow button is in DOM', () =>
      evaluate('browser://ui/', '!!document.getElementById("bmbar-overflow") && !!document.getElementById("bmbar-items")'),
    );
    await check('settings page has compact toolbar and bookmarks hover options', () =>
      evaluate((u) => u.startsWith('browser://settings'), '!!document.getElementById("compact-toolbar") && !!document.getElementById("bookmarks-bar-hover")'),
    );
    await check('settings page can enable compact toolbar', async () => {
      await evaluate((u) => u.startsWith('browser://settings'), 'browserAPI.setSetting("compactToolbar", true)');
      await sleep(500);
      return evaluate('browser://ui/', 'document.body.classList.contains("compact-toolbar")');
    });
    await check('settings page can enable bookmarks hover mode', async () => {
      await evaluate((u) => u.startsWith('browser://settings'), 'browserAPI.setSetting("bookmarksBarHover", true)');
      await sleep(500);
      const isHoverMode = await evaluate('browser://ui/', 'document.body.classList.contains("bmbar-hover-mode")');
      const isFixed = await evaluate('browser://ui/', 'getComputedStyle(document.getElementById("bmbar")).position === "fixed"');
      // trigger hover
      await evaluate('browser://ui/', 'document.getElementById("toolbar").dispatchEvent(new MouseEvent("mouseenter"))');
      await sleep(100);
      const isHovered = await evaluate('browser://ui/', 'document.body.classList.contains("bmbar-hovered")');
      // leave hover
      await evaluate('browser://ui/', 'document.getElementById("toolbar").dispatchEvent(new MouseEvent("mouseleave"))');
      return isHoverMode && isFixed && isHovered;
    });
    await check('page frame exists with balanced outer frame in both horizontal and vertical modes', async () => {
      const hasHorizontalFrame = await evaluate('browser://ui/', 'document.querySelectorAll(".page-frame").length > 0');
      await evaluate((u) => u.startsWith('browser://settings'), 'browserAPI.setSetting("verticalTabs", true)');
      await sleep(600);
      const isVertical = await evaluate('browser://ui/', 'document.body.classList.contains("vertical")');
      const verticalFrameCount = await evaluate('browser://ui/', 'document.querySelectorAll(".page-frame").length');
      const verticalFrameLeft = parseInt(await evaluate('browser://ui/', 'document.querySelector(".page-frame")?.style.left || "0"'), 10);
      // restore setting
      await evaluate((u) => u.startsWith('browser://settings'), 'browserAPI.setSetting("verticalTabs", false)');
      await sleep(400);
      return hasHorizontalFrame && isVertical && verticalFrameCount > 0 && verticalFrameLeft >= 208;
    });
    await check('ad-block lists downloaded', async () => {
      for (let i = 0; i < 20; i++) {
        if (fs.existsSync(path.join(profile, 'adblock-engine.bin'))) return true;
        await sleep(1000);
      }
      return false;
    });
  }

  child.kill();
  await sleep(1500);
  if (failures.length) {
    console.log('\n--- app output ---\n' + output.slice(-4000));
    throw new Error(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  }
  console.log('All smoke checks passed.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(profile, { recursive: true, force: true });
  });
