'use strict';

// Runs in every frame of web pages (registered as a session preload), in an isolated world.
//
// 1. Camera/mic/screen indicator: wraps getUserMedia/getDisplayMedia in the page so the browser
//    can show which tabs are capturing, and stop them (Electron has no capture events).
//    Best effort: the OS indicators (macOS menu bar, Windows taskbar) are the authoritative ones.
// 2. Passwords: notices submitted logins (the browser then offers to save them) and fills a
//    saved login the user picks from the browser's own dropdown. Usernames and passwords never
//    enter the page until the user chooses one.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  let stopAll = null;
  try {
    stopAll = contextBridge.executeInMainWorld({
      func: (report) => {
        const devices = navigator.mediaDevices;
        if (!devices) return () => {};
        const live = new Set();
        const send = () => {
          const state = { camera: false, microphone: false, screen: false };
          for (const t of [...live]) {
            if (t.readyState !== 'live') {
              live.delete(t);
              continue;
            }
            if (t.__screen) state.screen = true;
            else if (t.kind === 'video') state.camera = true;
            else if (t.kind === 'audio') state.microphone = true;
          }
          report(state);
        };
        const watch = (stream, screen) => {
          for (const track of stream.getTracks()) {
            if (screen) Object.defineProperty(track, '__screen', { value: true });
            live.add(track);
            track.addEventListener('ended', send);
            const stop = track.stop.bind(track);
            Object.defineProperty(track, 'stop', { value: () => (stop(), send()), configurable: true });
          }
          send();
          return stream;
        };
        for (const [name, screen] of [['getUserMedia', false], ['getDisplayMedia', true]]) {
          const original = devices[name] && devices[name].bind(devices);
          if (original) devices[name] = (...args) => original(...args).then((stream) => watch(stream, screen));
        }
        return () => {
          for (const t of live) t.stop();
          send();
        };
      },
      args: [(state) => ipcRenderer.send('capture:state', state)],
    });
  } catch {
    stopAll = null;
  }
  ipcRenderer.on('capture:stop', () => stopAll && stopAll());
}

// ---- passwords

if (/^https?:$/.test(location.protocol)) {
  const TEXTY = new Set(['text', 'email', 'tel', '']);
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const passwordFields = (scope) => [...scope.querySelectorAll('input[type=password]')].filter(visible);

  // The username for a password field: an autocomplete=username/email field in the same form,
  // otherwise the last visible text-like field before it.
  function usernameFor(pw) {
    const scope = pw.form || pw.closest('form') || document;
    const inputs = [...scope.querySelectorAll('input')].filter((i) => TEXTY.has(i.type) && visible(i));
    const tagged = inputs.find((i) => /username|email/.test(i.autocomplete));
    if (tagged) return tagged;
    const before = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || null;
  }

  function isLoginField(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type === 'password') return !/new-password/.test(el.autocomplete);
    if (!TEXTY.has(el.type)) return false;
    const pw = passwordFields(el.form || document)[0];
    return !!pw && usernameFor(pw) === el;
  }

  let lastSent = '';
  function report(pw) {
    if (!pw || !pw.value) return;
    const user = usernameFor(pw);
    const username = user ? user.value.trim() : '';
    const key = `${username}\u0000${pw.value}`;
    if (key === lastSent) return;
    lastSent = key;
    ipcRenderer.send('pw:submitted', { username, password: pw.value });
  }

  // A login is "submitted" by a form submit, Enter in a field, or clicking a button near it.
  document.addEventListener('submit', (e) => report(passwordFields(e.target)[0]), true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
        report(e.target.type === 'password' ? e.target : passwordFields(e.target.form || document)[0]);
      }
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target instanceof Element && e.target.closest('button, input[type=submit], [role=button]');
      if (btn) report(passwordFields(btn.closest('form') || document)[0]);
    },
    true,
  );

  // Focusing a login field asks the browser to show saved usernames next to it (top frame only).
  let focused = null;
  if (window === window.top) {
    document.addEventListener(
      'focusin',
      (e) => {
        if (!isLoginField(e.target)) return;
        focused = e.target;
        const r = focused.getBoundingClientRect();
        const z = webFrame.getZoomFactor();
        ipcRenderer.send('pw:focus', { x: r.left * z, y: r.bottom * z, width: r.width * z });
      },
      true,
    );
    document.addEventListener(
      'focusout',
      (e) => {
        if (e.target === focused) ipcRenderer.send('pw:blur');
      },
      true,
    );
  }

  const setValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  ipcRenderer.on('pw:fill', (_e, { username, password }) => {
    const anchor = focused && document.contains(focused) ? focused : document.activeElement;
    const pw = anchor && anchor.type === 'password' ? anchor : passwordFields((anchor && anchor.form) || document)[0];
    if (!pw) return;
    const user = usernameFor(pw);
    if (user && username) setValue(user, username);
    setValue(pw, password);
    lastSent = `${username}\u0000${password}`; // filling isn't a new login to offer to save
    pw.focus();
  });
}
