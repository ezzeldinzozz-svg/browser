'use strict';

// Feature regression test for the Mac dev build. Starts Operecs from this checkout on a
// throwaway profile, drives it over DevTools (pages) and the inspector (main process), and
// prints ok / FAIL per check. Needs the network (example.com, badssl.com, httpbin.org).
//
//   npm run build && node scripts/feature-test.js
//
// Dialogs are answered by stubbing dialog.showMessageBox in the main process. Native dialogs
// a page triggers by itself (a real "Leave site?") can't be answered, so the tests avoid them.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'operecs-feature-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- DevTools / inspector helpers
const targets = async () => (await fetch('http://127.0.0.1:9333/json')).json();
async function cdp(wsUrl, method, params) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  return new Promise((res) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) {
        ws.close();
        res(d.result);
      }
    };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
}
async function evalIn(match, expr) {
  const t = (await targets()).find((x) => (match === 'browser://ui' ? x.url === 'browser://ui/' : x.url.startsWith(match)));
  if (!t) return `NO TARGET ${match}`;
  const r = await cdp(t.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  return r.result?.value ?? `ERROR ${r.exceptionDetails?.exception?.description || JSON.stringify(r.result)}`;
}
async function main(expr) {
  const list = await (await fetch('http://127.0.0.1:9229/json')).json();
  const r = await cdp(list[0].webSocketDebuggerUrl, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.value ?? `ERROR ${r.exceptionDetails?.exception?.description || ''}`;
}
const ui = (e) => evalIn('browser://ui', e);
// A trusted mouse click on an element (Input.dispatchMouseEvent), which also focuses the page.
async function clickIn(match, selector) {
  const t = (await targets()).find((x) => x.url.startsWith(match));
  const rect = JSON.parse(await evalIn(match, `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`));
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  for (const type of ['mousePressed', 'mouseReleased']) await cdp(t.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
const go = async (url, wait = 2500) => {
  await ui(`browserAPI.go(${JSON.stringify(url)})`);
  await sleep(wait);
};
const address = () => ui("document.getElementById('address').value");
const stubDialogs = (response) =>
  main(`(() => { const d = process.mainModule.require('electron').dialog; globalThis.__asked = []; d.showMessageBox = async (w, o) => { const opt = o || w; globalThis.__asked.push(opt.message); return { response: ${response}, checkboxChecked: false }; }; return 1 })()`);

// ---- a local site for forms
const FORM = `<!doctype html><title>Checkout</title><form action="/thanks" method="post">
<label>First name <input name="fname"></label><label>Last name <input name="lname"></label>
<label>Email <input type="email" name="email"></label><label>Street address <input name="address1"></label>
<label>City <input name="city"></label><label>Card number <input name="cardnumber"></label><button>Pay</button></form>`;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'text/html');
    if (req.url.startsWith('/thanks')) return res.end(`<title>Thanks</title><pre id="got">${body.replace(/</g, '&lt;')} ${Date.now()}</pre>`);
    res.end(FORM);
  });
});

(async () => {
  await new Promise((r) => server.listen(8798, r));
  const app = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), ['--inspect=9229', '.', '--remote-debugging-port=9333'], {
    cwd: ROOT,
    env: { ...process.env, BROWSER_PROFILE_DIR: PROFILE },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await targets();
      break;
    } catch {
      await sleep(500);
    }
  }
  await sleep(3500);
  try {
    // welcome page on a fresh profile; open a normal tab
    await ui('browserAPI.newTab()');
    await sleep(800);

    console.log('Browsing');
    await go('https://example.com/?utm_source=x&fbclid=y&id=7', 3500);
    check('loads a site, strips tracking parameters', (await address()) === 'https://example.com/?id=7', await address());
    check('lock icon on https', (await ui("document.getElementById('site').title")).includes('secure'));
    const tabs0 = Number(await ui("document.querySelectorAll('.tab').length"));
    await ui('browserAPI.newTab()');
    await sleep(600);
    check('new tab opens', Number(await ui("document.querySelectorAll('.tab').length")) === tabs0 + 1);
    await go('https://example.org/', 3000);
    await ui("browserAPI.closeTab(Number(document.querySelector('.tab.active').dataset.id))");
    await sleep(1200);
    check('closing a tab', Number(await ui("document.querySelectorAll('.tab').length")) === tabs0);

    console.log('Address bar');
    const typeIn = async (t) => {
      await ui(`(() => { const a = document.getElementById('address'); a.focus(); a.value = ${JSON.stringify(t)}; a.dispatchEvent(new InputEvent('input', { inputType: 'insertText' })); return 1 })()`);
      await sleep(900);
      const rows = await ui("[...document.querySelectorAll('#suggest .sg')].map(r => r.innerText.replace(/\\s+/g, ' ')).join(' | ')");
      await ui("document.getElementById('address').blur(); 1");
      return rows;
    };
    check('history suggestion', (await typeIn('examp')).toLowerCase().includes('example'), await typeIn('examp'));
    check('calculator', (await typeIn('12*7+3')).includes('87'));
    check('unit conversion', (await typeIn('10 km in miles')).includes('6.21'));
    check('command', (await typeIn('settings')).toLowerCase().includes('settings'));

    console.log('History');
    await go('browser://history', 1500);
    check('history page lists visits', Number(await evalIn('browser://history', "document.querySelectorAll('#list .row').length")) >= 1);
    await evalIn('browser://history', "(() => { const q = document.getElementById('q'); q.value = 'exampl'; q.dispatchEvent(new Event('input')); return 1 })()");
    await sleep(800);
    check('full-text history search', (await evalIn('browser://history', "document.getElementById('list').innerText")).includes('Example'));

    console.log('Bookmarks');
    await go('https://example.com/', 3000);
    await ui('browserAPI.starPage()');
    await sleep(800);
    await ui("document.getElementById('bm-done') && document.getElementById('bm-done').click(); 1");
    await sleep(800);
    check('bookmark added', (await ui("document.getElementById('star').classList.contains('on')")) === true);

    console.log('Reader mode');
    await go('https://en.wikipedia.org/wiki/Web_browser', 6000);
    await ui('browserAPI.toggleReader()');
    await sleep(3000);
    check('reader view opens', Number(await evalIn('browser://reader', "document.getElementById('article').srcdoc.length")) > 5000);

    console.log('Forms');
    await stubDialogs(0); // "Resubmit" / first button
    await go('http://localhost:8798/', 2000);
    await evalIn('http://localhost:8798', "document.querySelector('[name=fname]').value = 'A'; document.querySelector('form').submit(); 1");
    await sleep(2000);
    const before = await evalIn('http://localhost:8798/thanks', "document.getElementById('got').textContent");
    await ui('browserAPI.reload()');
    await sleep(2500);
    const after = await evalIn('http://localhost:8798/thanks', "document.getElementById('got').textContent");
    check('reload after a form asks and resubmits', (await main('globalThis.__asked.join("|")')).includes('Resubmit') && before !== after && after.includes('fname=A'));

    console.log('Autofill');
    await go('browser://settings', 1500);
    await evalIn('browser://settings', "browserAPI.saveAddress({ name: 'Test Person', street: '1 Test St', city: 'Testville', email: 't@example.com' })");
    await go('http://localhost:8798/', 2000);
    await clickIn('http://localhost:8798', '[name=fname]'); // a real click, as a user would
    await sleep(1200);
    await evalIn('browser://ui/autofill.html', "document.querySelector('.row') && document.querySelector('.row').click(); 1");
    await sleep(800);
    const filled = JSON.parse(await evalIn('http://localhost:8798', "JSON.stringify(Object.fromEntries([...document.querySelectorAll('input')].map(e => [e.name, e.value])))"));
    check('address autofill fills, skips the card field', filled.fname === 'Test' && filled.lname === 'Person' && filled.city === 'Testville' && !filled.cardnumber, JSON.stringify(filled));

    console.log('Unsaved changes');
    await stubDialogs(1); // Cancel
    await go('https://example.com/', 3000);
    await evalIn('https://example.com', "window.__warn = (e) => { e.preventDefault(); e.returnValue = ''; }; addEventListener('beforeunload', window.__warn); 1");
    await main("process.mainModule.require('electron').BaseWindow.getAllWindows()[0].close()");
    await sleep(1500);
    check('closing a window with unsaved changes asks, Cancel keeps it', (await main('globalThis.__asked.join("|")')).includes('Leave site') && (await main("process.mainModule.require('electron').BaseWindow.getAllWindows().length")) >= 1);
    // take the handler away again, so leaving the page doesn't open a real (native) "Leave site?"
    await evalIn('https://example.com', "removeEventListener('beforeunload', window.__warn); 1");

    console.log('Pages');
    await go('browser://newtab', 1500);
    check('new tab page', (await evalIn('browser://newtab', "document.getElementById('q') ? 'ok' : 'missing'")) === 'ok');
    await go('browser://settings', 1500);
    check('settings page', (await evalIn('browser://settings', 'document.title')) === 'Settings');
    await go('browser://downloads', 1200);
    check('downloads page', !String(await evalIn('browser://downloads', 'document.body.innerText')).startsWith('NO TARGET'));
    await go('browser://whatsnew', 1200);
    check("what's new page", /version \d/i.test(await evalIn('browser://whatsnew', 'document.body.innerText')));

    console.log('Layouts');
    await go('https://example.com/', 2500);
    const visibleViews = () => main("process.mainModule.require('electron').BaseWindow.getAllWindows()[0].contentView.children.filter(v => v.getVisible() && v.webContents && !v.webContents.getURL().startsWith('browser://ui/')).length");
    await ui('browserAPI.toggleSplit()');
    await sleep(2500);
    check('split view shows two pages', (await visibleViews()) >= 2, `visible pages: ${await visibleViews()}`);
    await ui('browserAPI.toggleSplit()');
    await sleep(1500);
    check('split view closes', (await visibleViews()) === 1);
    await go('browser://settings', 1200);
    await evalIn('browser://settings', "browserAPI.setSetting('verticalTabs', true)");
    await sleep(1200);
    check('vertical tabs turn on', (await ui('document.body.className')).includes('vertical'), await ui('document.body.className'));
    await evalIn('browser://settings', "browserAPI.setSetting('verticalTabs', false)");
    await sleep(800);

    console.log('Security');
    check('web pages cannot reach the browser API', (await evalIn('https://', 'typeof window.browserAPI').catch(() => 'undefined')) !== 'object');
    await go('https://expired.badssl.com/', 5000);
    check('certificate errors are blocked', (await address()).includes('expired.badssl.com') && !String(await evalIn('https://expired.badssl.com', '1')).startsWith('1'));
  } catch (err) {
    failures++;
    console.log(`  FAIL test run stopped: ${err.message}`);
  } finally {
    app.kill();
    server.close();
    try {
      execSync(`pkill -f -- "--remote-debugging-port=9333" || true`);
    } catch {
      // gone already
    }
    await sleep(1000);
    fs.rmSync(PROFILE, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll feature checks passed.');
    process.exit(failures ? 1 : 0);
  }
})();
