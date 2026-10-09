'use strict';

// Runs in every frame of web pages (registered as a session preload). It wraps
// getUserMedia/getDisplayMedia in the page so the browser can show which tabs are using the
// camera, microphone or screen, and stop them. Electron has no capture events of its own.
//
// Best effort: a page could capture through an untracked path. The OS (macOS menu bar,
// Windows taskbar) still shows its own indicators, which pages can't affect.

const { contextBridge, ipcRenderer } = require('electron');

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

// ---- Global Privacy Control: navigator.globalPrivacyControl matches the Sec-GPC header

if (/^https?:$/.test(location.protocol)) {
  let gpc = false;
  try {
    gpc = ipcRenderer.sendSync('gpc:enabled') === true;
  } catch {
    gpc = false;
  }
  if (gpc) {
    try {
      contextBridge.executeInMainWorld({
        func: () => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true }),
      });
    } catch {
      // page world not available
    }
  }
}

// ---- Notifications: name the site (like Chrome's attribution line) and bring its tab forward
// when the user clicks one. Electron shows them as native notifications but knows nothing of tabs.
// Notifications sent from service workers (registration.showNotification) aren't covered.

// Until the user has decided for the site, Chromium reports "denied" (Electron's permission
// check is yes/no); pages then hide their "turn on notifications" button. Report "default" /
// "prompt" instead while the site hasn't been asked.
if (/^https?:$/.test(location.protocol) && typeof window.Notification === 'function') {
  let undecided = false;
  try {
    undecided = ipcRenderer.sendSync('notification:undecided') === true;
  } catch {
    undecided = false;
  }
  try {
    contextBridge.executeInMainWorld({
      func: (report, host, undecided) => {
        const Native = window.Notification;
        class Notification extends Native {
          constructor(title, options) {
            const opts = { ...(options || {}) };
            opts.body = opts.body ? `${opts.body}\n${host}` : host;
            super(title, opts);
            this.addEventListener('click', () => report());
          }
          static get permission() {
            const real = Native.permission;
            return real === 'denied' && undecided ? 'default' : real;
          }
          static requestPermission(cb) {
            return Native.requestPermission().then((result) => {
              undecided = false;
              if (typeof cb === 'function') cb(result);
              return result;
            });
          }
        }
        window.Notification = Notification;
        const query = Permissions.prototype.query;
        Permissions.prototype.query = function (desc) {
          return query.call(this, desc).then((status) => {
            if (!undecided || !desc || (desc.name !== 'notifications' && desc.name !== 'push') || status.state !== 'denied') return status;
            return Object.create(status, { state: { get: () => 'prompt' } });
          });
        };
      },
      args: [() => ipcRenderer.send('notification:click'), location.hostname.replace(/^www\./, ''), undecided],
    });
  } catch {
    // page world not available
  }
}

// ---- Unsaved changes: Electron can only run a page's beforeunload by actually closing it, so
// on quit / window close the browser asks this instead: would the page's beforeunload handlers
// warn? (Same idea as Chrome's check; only after the user has interacted with the page.)

if (/^https?:$/.test(location.protocol)) {
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        const handlers = new Set();
        const add = EventTarget.prototype.addEventListener;
        const remove = EventTarget.prototype.removeEventListener;
        EventTarget.prototype.addEventListener = function (type, fn, options) {
          if (this === window && type === 'beforeunload' && fn) handlers.add(fn);
          return add.call(this, type, fn, options);
        };
        EventTarget.prototype.removeEventListener = function (type, fn, options) {
          if (this === window && type === 'beforeunload') handlers.delete(fn);
          return remove.call(this, type, fn, options);
        };
        Object.defineProperty(window, Symbol.for('operecs.wouldWarnOnUnload'), {
          value: () => {
            if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
            let warn = false;
            const event = {
              type: 'beforeunload',
              target: window,
              currentTarget: window,
              preventDefault() {
                warn = true;
              },
              stopPropagation() {},
              stopImmediatePropagation() {},
              get returnValue() {
                return '';
              },
              set returnValue(value) {
                if (value !== undefined && value !== null && value !== false) warn = true;
              },
            };
            for (const fn of handlers) {
              try {
                const result = typeof fn === 'function' ? fn.call(window, event) : fn.handleEvent(event);
                if (typeof result === 'string') warn = true;
              } catch {
                // a broken handler doesn't block quitting
              }
            }
            if (typeof window.onbeforeunload === 'function') {
              try {
                const result = window.onbeforeunload(event);
                if (result !== undefined && result !== null && result !== false) warn = true;
              } catch {
                // as above
              }
            }
            return warn;
          },
        });
      },
    });
  } catch {
    // page world not available
  }
}

// ---- Address & contact autofill. Runs in this isolated world: the page never sees saved
// addresses until the user picks one. Focusing an address field asks the browser to show its
// list under the field (drawn by the browser, outside the page); picking one fills the visible
// address fields of that form. Submitting a form with an address offers to save it.

if (/^https?:$/.test(location.protocol) && window === window.top) {
  const AUTOCOMPLETE = {
    name: 'name', 'given-name': 'given-name', 'family-name': 'family-name', organization: 'organization',
    'street-address': 'address-line1', 'address-line1': 'address-line1', 'address-line2': 'address-line2',
    'address-level2': 'city', 'address-level1': 'region', 'postal-code': 'postal', country: 'country',
    'country-name': 'country', email: 'email', tel: 'tel', 'tel-national': 'tel',
  };
  const PATTERNS = [
    ['email', /e-?mail/i],
    ['tel', /phone|\btel\b|mobile|cell/i],
    ['given-name', /first.?name|given.?name|\bfname\b|forename/i],
    ['family-name', /last.?name|family.?name|surname|\blname\b/i],
    ['organization', /company|organi[sz]ation|business.?name/i],
    ['address-line2', /address.?(line)?.?2|\bapt\b|apartment|suite|\bunit\b|\bflat\b/i],
    ['address-line1', /address|street|\baddr\b|line.?1/i],
    ['city', /\bcity\b|\btown\b|locality/i],
    ['region', /\bstate\b|province|region|county/i],
    ['postal', /\bzip\b|postal|postcode|post.?code/i],
    ['country', /country/i],
    ['name', /full.?name|your.?name|^\s*name\s*$/i],
  ];
  const SKIP = /password|card|\bcvv\b|\bcvc\b|security.?code|captcha|coupon|promo|search|username|login|otp|verification/i;

  function fieldType(el) {
    const isInput = el instanceof HTMLInputElement;
    if (!isInput && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement)) return null;
    if (isInput && !['text', 'email', 'tel', ''].includes(el.type)) return null;
    if (el.disabled || el.readOnly) return null;
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.some((t) => t.startsWith('cc-') || t.endsWith('password') || t === 'one-time-code' || t === 'username')) return null;
    for (const t of tokens) if (AUTOCOMPLETE[t]) return AUTOCOMPLETE[t];
    const labels = el.labels ? [...el.labels].map((l) => l.textContent).join(' ') : '';
    const text = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labels].filter(Boolean).join(' ');
    if (!text || SKIP.test(text)) return null;
    for (const [type, re] of PATTERNS) if (re.test(text)) return type;
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'tel';
    return null;
  }

  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const fieldsIn = (scope) => [...scope.querySelectorAll('input, select, textarea')].map((el) => [el, fieldType(el)]).filter(([el, t]) => t && visible(el));

  function valueFor(type, a) {
    const parts = (a.name || '').trim().split(/\s+/);
    switch (type) {
      case 'name': return a.name;
      case 'given-name': return parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
      case 'family-name': return parts.length > 1 ? parts[parts.length - 1] : '';
      case 'organization': return a.organization;
      case 'address-line1': return a.street;
      case 'address-line2': return a.street2;
      case 'city': return a.city;
      case 'region': return a.region;
      case 'postal': return a.postal;
      case 'country': return a.country;
      case 'email': return a.email;
      case 'tel': return a.phone;
      default: return '';
    }
  }

  function setValue(el, value) {
    if (el instanceof HTMLSelectElement) {
      const want = value.toLowerCase();
      const option = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) ||
        [...el.options].find((o) => o.text.trim().toLowerCase().startsWith(want));
      if (!option) return;
      el.value = option.value;
    } else {
      // the prototype's setter, so frameworks (React, Vue…) notice the change
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let current = null;
  let available = false;
  try {
    available = ipcRenderer.sendSync('autofill:available') === true;
  } catch {
    available = false;
  }
  ipcRenderer.on('autofill:available', (_e, value) => (available = value === true));

  const show = (el, type) => {
    const r = el.getBoundingClientRect();
    ipcRenderer.send('autofill:show', { type, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  };
  document.addEventListener('focusin', (e) => {
    const type = available && fieldType(e.target);
    if (!type) return;
    current = e.target;
    if (!e.target.value) show(e.target, type);
  }, true);
  document.addEventListener('focusout', () => ipcRenderer.send('autofill:hide'), true);
  document.addEventListener('input', (e) => {
    if (e.target === current && e.isTrusted) ipcRenderer.send('autofill:hide'); // typing: get out of the way
  }, true);
  window.addEventListener('scroll', () => current && ipcRenderer.send('autofill:hide'), { passive: true, capture: true });

  ipcRenderer.on('autofill:fill', (_e, address) => {
    if (!current || !address) return;
    const scope = current.closest('form') || document;
    for (const [el, type] of fieldsIn(scope)) {
      const value = valueFor(type, address);
      if (value) setValue(el, value);
    }
  });

  // Offer to save what was typed into an address form.
  document.addEventListener('submit', (e) => {
    if (!(e.target instanceof HTMLFormElement)) return;
    const a = {};
    for (const [el, type] of fieldsIn(e.target)) {
      const v = (el instanceof HTMLSelectElement ? el.selectedOptions[0]?.text : el.value || '').trim();
      if (!v) continue;
      const key = { 'address-line1': 'street', 'address-line2': 'street2', tel: 'phone' }[type] || type;
      if (key === 'given-name') a.name = `${v} ${a.name || ''}`.trim();
      else if (key === 'family-name') a.name = `${a.name || ''} ${v}`.trim();
      else a[key] = v;
    }
    if (a.name && (a.street || a.email || a.phone)) ipcRenderer.send('autofill:offer', a);
  }, true);
}
