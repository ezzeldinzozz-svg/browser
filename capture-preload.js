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

// ---- Privacy & site features: fingerprinting protection, per-site autoplay, cookie-banner
// auto-reject, registerProtocolHandler, two-finger swipe back/forward, selection screenshot,
// and read aloud.

if (/^https?:$/.test(location.protocol)) {
  let siteFeatures = null;
  try {
    siteFeatures = ipcRenderer.sendSync('site:features');
  } catch {
    siteFeatures = null;
  }

  // 1. Fingerprinting protection (canvas, WebGL, AudioContext, hardware concurrency) +
  //    per-site autoplay blocking + navigator.registerProtocolHandler
  if (siteFeatures) {
    try {
      contextBridge.executeInMainWorld({
        func: (fpOn, seed, blockAutoplay, reportProtocol) => {
          if (fpOn) {
            // Deterministic per-session, per-origin byte tweak on canvas readbacks
            let h = seed ^ 0x811c9dc5;
            for (let i = 0; i < location.origin.length; i++) {
              h ^= location.origin.charCodeAt(i);
              h = Math.imul(h, 0x01000193);
            }
            const getImageData = CanvasRenderingContext2D.prototype.getImageData;
            CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh, ...rest) {
              const img = getImageData.call(this, sx, sy, sw, sh, ...rest);
              if (img && img.data && img.data.length >= 16) {
                const idx = ((Math.abs(h) % 4) * 4) + 2;
                img.data[idx] = img.data[idx] ^ 1;
              }
              return img;
            };
            const toDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function (...args) {
              try {
                const ctx = this.getContext('2d');
                if (ctx && this.width > 1 && this.height > 1) {
                  const p = getImageData.call(ctx, 0, 0, 1, 1);
                  p.data[2] ^= 1;
                  ctx.putImageData(p, 0, 0);
                  const res = toDataURL.apply(this, args);
                  p.data[2] ^= 1;
                  ctx.putImageData(p, 0, 0);
                  return res;
                }
              } catch {}
              return toDataURL.apply(this, args);
            };
            for (const Proto of [ window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype ]) {
              if (!Proto || !Proto.getParameter) continue;
              const orig = Proto.getParameter;
              Proto.getParameter = function (param) {
                if (param === 0x9245) return 'Apple Inc.';
                if (param === 0x9246) return 'Apple GPU';
                return orig.call(this, param);
              };
            }
            if (window.AudioBuffer?.prototype?.getChannelData) {
              const origChannel = AudioBuffer.prototype.getChannelData;
              AudioBuffer.prototype.getChannelData = function (ch) {
                const data = origChannel.call(this, ch);
                if (data && data.length > 0 && !data.__operecsNoised) {
                  Object.defineProperty(data, '__operecsNoised', { value: true });
                  const step = Math.max(1, Math.floor(data.length / 16));
                  for (let i = 0; i < data.length; i += step) data[i] += ((h & 1) ? 1e-7 : -1e-7);
                }
                return data;
              };
            }
            try {
              Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true });
              if ('deviceMemory' in Navigator.prototype) {
                Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true });
              }
            } catch {}
          }

          if (blockAutoplay) {
            const origPlay = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function (...args) {
              const active = navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
              if (!active && !this.muted && this.volume > 0) {
                return Promise.reject(new DOMException('Autoplay is blocked for this site.', 'NotAllowedError'));
              }
              return origPlay.apply(this, args);
            };
          }

          const SAFE_SCHEMES = new Set(['bitcoin', 'geo', 'im', 'irc', 'ircs', 'magnet', 'mailto', 'Matrix', 'mms', 'news', 'nntp', 'openpgp4fpr', 'sftp', 'sip', 'sms', 'smsto', 'ssh', 'tel', 'urn', 'webcal', 'wtai', 'xmpp']);
          Navigator.prototype.registerProtocolHandler = function (scheme, url) {
            const s = String(scheme || '').trim().toLowerCase();
            if (!SAFE_SCHEMES.has(s) && !/^web\+[a-z]+$/.test(s)) {
              throw new DOMException(`Scheme "${s}" is not allowed.`, 'SecurityError');
            }
            const resolved = new URL(String(url || ''), location.href);
            if (resolved.origin !== location.origin || !resolved.href.includes('%s')) {
              throw new DOMException('Handler URL must be on the same site and include "%s".', 'SyntaxError');
            }
            reportProtocol(s, resolved.href);
          };
        },
        args: [
          !!siteFeatures.fingerprintingProtection,
          siteFeatures.seed || 12345,
          !!siteFeatures.blockAutoplay,
          (scheme, url) => ipcRenderer.send('protocol:register', { scheme, url }),
        ],
      });
    } catch {
      // page world not available
    }
  }

  // 2. Cookie banner auto-reject (top frame)
  if (siteFeatures && siteFeatures.rejectCookies && window === window.top) {
    const REJECT_SELECTORS = [
      '#onetrust-reject-all-handler',
      '#CybotCookiebotDialogBodyButtonDecline',
      '#didomi-notice-disagree-button',
      '.qc-cmp2-summary-buttons button[mode="secondary"]',
      '#truste-consent-required',
      '.cmplz-deny',
      '.cm-btn-decline',
      '.osano-cm-deny',
      '.osano-cm-button--type_deny',
      '[data-cookie-refuse]',
      'button[data-testid="uc-deny-all-button"]',
      'button[id*="reject-all" i]',
      'button[class*="reject-all" i]',
    ];
    const REJECT_TEXT = /^(reject all|decline all|deny all|refuse all|only necessary|necessary only|essential only|use necessary cookies only|reject optional cookies|do not accept|continue without accepting)$/i;

    const tryRejectCookieBanner = () => {
      for (const sel of REJECT_SELECTORS) {
        const btn = document.querySelector(sel);
        if (btn && btn instanceof HTMLElement && btn.getClientRects().length > 0) {
          btn.click();
          return true;
        }
      }
      const containers = document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [aria-label*="cookie" i], [aria-label*="consent" i]');
      for (const box of containers) {
        for (const btn of box.querySelectorAll('button, a[role="button"], input[type="button"]')) {
          const label = (btn.textContent || btn.getAttribute('aria-label') || btn.value || '').trim();
          if (REJECT_TEXT.test(label) && btn.getClientRects().length > 0) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    };

    const startCookieWatcher = () => {
      if (tryRejectCookieBanner()) return;
      const obs = new MutationObserver(() => {
        if (tryRejectCookieBanner()) obs.disconnect();
      });
      if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 8000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startCookieWatcher, { once: true });
    else startCookieWatcher();
  }
}

// ---- Two-finger horizontal swipe back/forward with an arrow indicator (top frame)
if ((/^https?:$/.test(location.protocol) || /^browser:$/.test(location.protocol)) && window === window.top && location.href !== 'browser://ui/') {
  let swipeX = 0;
  let swipeTimer = null;
  let arrowHost = null;
  let arrowEl = null;

  function canScrollH(target, dx) {
    for (let el = target instanceof Element ? target : document.scrollingElement; el && el !== document; el = el.parentElement) {
      const st = getComputedStyle(el);
      const ox = st.overflowX;
      if ((ox === 'auto' || ox === 'scroll' || el === document.scrollingElement || el === document.documentElement) && el.scrollWidth > el.clientWidth + 2) {
        if (dx < 0 && el.scrollLeft > 0) return true;
        if (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
      }
    }
    return false;
  }

  function ensureArrow() {
    if (arrowHost && document.documentElement?.contains(arrowHost)) return arrowEl;
    arrowHost = document.createElement('div');
    const root = arrowHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .arrow {
        position: fixed; top: 50%; z-index: 2147483647; width: 42px; height: 42px; margin-top: -21px;
        border-radius: 50%; background: rgba(20, 17, 28, 0.92); color: #f3f1f7;
        border: 1px solid rgba(155, 108, 255, 0.45); box-shadow: 0 10px 28px rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center; pointer-events: none;
        font: 600 18px/1 -apple-system, sans-serif; opacity: 0; transition: opacity 0.12s;
      }
      .arrow.ready { background: linear-gradient(135deg, #9b6cff 0%, #6e3ce0 100%); color: #fff; }
    `;
    arrowEl = document.createElement('div');
    arrowEl.className = 'arrow';
    root.append(style, arrowEl);
    document.documentElement?.append(arrowHost);
    return arrowEl;
  }

  window.addEventListener('wheel', (e) => {
    if (!e.isTrusted) return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.3 || Math.abs(e.deltaX) < 1.5) return;
    if (canScrollH(e.target, e.deltaX)) {
      swipeX = 0;
      return;
    }
    swipeX += -e.deltaX;
    const dir = swipeX > 0 ? 'back' : 'forward';
    const dist = Math.min(Math.abs(swipeX), 140);
    if (dist > 18) {
      const el = ensureArrow();
      el.textContent = dir === 'back' ? '←' : '→';
      el.style.opacity = String(Math.min(1, (dist - 18) / 60));
      const offset = Math.round(Math.min(24, (dist - 18) * 0.45));
      el.style.left = dir === 'back' ? `${offset - 12}px` : 'auto';
      el.style.right = dir === 'forward' ? `${offset - 12}px` : 'auto';
      el.classList.toggle('ready', dist >= 100);
    }
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(() => {
      const trigger = Math.abs(swipeX) >= 100 ? (swipeX > 0 ? 'back' : 'forward') : null;
      swipeX = 0;
      if (arrowEl) {
        arrowEl.style.opacity = '0';
        arrowEl.classList.remove('ready');
      }
      if (trigger) ipcRenderer.send('swipe:navigate', trigger);
    }, 130);
  }, { passive: true });
}

// ---- Selection screenshot & Read aloud (top frame)
if (window === window.top && location.href !== 'browser://ui/') {
  ipcRenderer.on('screenshot:select-start', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .ov { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; background: rgba(12, 10, 17, 0.28); user-select: none; }
      .box { position: fixed; border: 2px solid #9b6cff; background: rgba(155, 108, 255, 0.12); box-shadow: 0 0 0 9999px rgba(12, 10, 17, 0.42); pointer-events: none; display: none; border-radius: 4px; }
      .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: rgba(20, 17, 28, 0.92); color: #f3f1f7; padding: 6px 14px; border-radius: 999px; font: 500 12.5px/1.3 -apple-system, sans-serif; border: 1px solid rgba(155, 108, 255, 0.35); pointer-events: none; }
    `;
    const ov = document.createElement('div');
    ov.className = 'ov';
    const box = document.createElement('div');
    box.className = 'box';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Drag to capture an area · Esc to cancel';
    ov.append(box, hint);
    root.append(style, ov);
    document.documentElement.append(host);

    let startX = 0, startY = 0, dragging = false;
    const cleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      host.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      }
    };
    window.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', (e) => {
      if (!e.isTrusted) return; // only the user's own mouse, never events the page makes up
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      box.style.display = 'block';
      hint.style.display = 'none';
    });
    ov.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
    });
    ov.addEventListener('mouseup', (e) => {
      if (!dragging || !e.isTrusted) return;
      dragging = false;
      const x = Math.round(Math.min(startX, e.clientX));
      const y = Math.round(Math.min(startY, e.clientY));
      const width = Math.round(Math.abs(e.clientX - startX));
      const height = Math.round(Math.abs(e.clientY - startY));
      cleanup();
      if (width > 8 && height > 8) {
        requestAnimationFrame(() => {
          setTimeout(() => ipcRenderer.send('screenshot:rect', { x, y, width, height }), 40);
        });
      }
    });
  });

  // Read aloud controller
  let speechHost = null;
  let speechRate = 1;
  ipcRenderer.on('speech:toggle', () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (speechHost && document.documentElement.contains(speechHost)) {
      synth.cancel();
      speechHost.remove();
      speechHost = null;
      return;
    }
    const sel = String(window.getSelection() || '').trim();
    const rootEl = document.querySelector('article, main, [role="main"]') || document.body;
    const text = (sel || rootEl?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 18000);
    if (!text) return;

    speechHost = document.createElement('div');
    const root = speechHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .bar { position: fixed; bottom: 18px; right: 18px; z-index: 2147483647; display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: rgba(20, 17, 28, 0.94); color: #f3f1f7; border: 1px solid rgba(155, 108, 255, 0.4); box-shadow: 0 12px 32px rgba(0,0,0,0.5); font: 500 12.5px/1 -apple-system, sans-serif; }
      button { border: 0; background: rgba(255,255,255,0.08); color: #f3f1f7; padding: 5px 10px; border-radius: 999px; cursor: pointer; font: inherit; }
      button:hover { background: rgba(155, 108, 255, 0.28); }
      .lbl { padding: 0 4px; color: #c3a6ff; }
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Reading aloud';
    const pauseBtn = document.createElement('button');
    pauseBtn.textContent = 'Pause';
    const rateBtn = document.createElement('button');
    rateBtn.textContent = '1×';
    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Stop';
    bar.append(lbl, pauseBtn, rateBtn, stopBtn);
    root.append(style, bar);
    document.documentElement.append(speechHost);

    const speakFrom = () => {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = speechRate;
      u.onend = () => {
        speechHost?.remove();
        speechHost = null;
      };
      synth.speak(u);
    };
    pauseBtn.addEventListener('click', () => {
      if (synth.paused) {
        synth.resume();
        pauseBtn.textContent = 'Pause';
      } else {
        synth.pause();
        pauseBtn.textContent = 'Resume';
      }
    });
    rateBtn.addEventListener('click', () => {
      speechRate = speechRate === 1 ? 1.25 : speechRate === 1.25 ? 1.5 : 1;
      rateBtn.textContent = `${speechRate}×`;
      speakFrom();
    });
    stopBtn.addEventListener('click', () => {
      synth.cancel();
      speechHost?.remove();
      speechHost = null;
    });
    speakFrom();
  });

  // In-page translation controller
  let translateHost = null;
  const originalNodes = new Map();
  ipcRenderer.on('translate:toggle', async (_e, targetLang = 'en') => {
    if (translateHost && document.documentElement.contains(translateHost)) {
      for (const [node, orig] of originalNodes) node.nodeValue = orig;
      originalNodes.clear();
      translateHost.remove();
      translateHost = null;
      return;
    }
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA|INPUT|SVG)$/i.test(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
        const t = n.nodeValue.trim();
        return t.length >= 3 && /\p{L}/u.test(t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode() && nodes.length < 180) nodes.push(walker.currentNode);
    if (!nodes.length) return;

    translateHost = document.createElement('div');
    const root = translateHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .bar { position: fixed; bottom: 18px; left: 18px; z-index: 2147483647; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: rgba(20, 17, 28, 0.94); color: #f3f1f7; border: 1px solid rgba(155, 108, 255, 0.4); box-shadow: 0 12px 32px rgba(0,0,0,0.5); font: 500 12.5px/1 -apple-system, sans-serif; }
      button { border: 0; background: rgba(255,255,255,0.08); color: #f3f1f7; padding: 5px 10px; border-radius: 999px; cursor: pointer; font: inherit; }
      button:hover { background: rgba(155, 108, 255, 0.28); }
      .lbl { color: #c3a6ff; }
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Translating page…';
    const revertBtn = document.createElement('button');
    revertBtn.textContent = 'Show Original';
    bar.append(lbl, revertBtn);
    root.append(style, bar);
    document.documentElement.append(translateHost);

    revertBtn.addEventListener('click', () => {
      for (const [node, orig] of originalNodes) node.nodeValue = orig;
      originalNodes.clear();
      translateHost?.remove();
      translateHost = null;
    });

    try {
      for (let i = 0; i < nodes.length; i += 30) {
        if (!translateHost) break;
        const batch = nodes.slice(i, i + 30);
        const texts = batch.map((n) => n.nodeValue.trim());
        const out = await ipcRenderer.invoke('translate:batch', { texts, to: targetLang });
        if (Array.isArray(out)) {
          batch.forEach((n, idx) => {
            if (out[idx] && typeof out[idx] === 'string') {
              if (!originalNodes.has(n)) originalNodes.set(n, n.nodeValue);
              n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), out[idx]);
            }
          });
        }
      }
      if (lbl) lbl.textContent = `Translated to ${targetLang.toUpperCase()}`;
    } catch {
      if (lbl) lbl.textContent = 'Translation unavailable';
    }
  });
}

