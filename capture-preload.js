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
