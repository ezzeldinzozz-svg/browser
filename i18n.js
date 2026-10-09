'use strict';

// Interface translation. A locale file (locales/<lang>.json) maps the English text exactly as
// shown to the translation; keys with {name} parts match any text there and carry it over
// ("Close {n} Tabs"). Text without a translation stays in English.
//
// Used by main.js (menus, dialogs) and by preload.js, which translates the browser's own pages
// and toolbar in place (text, placeholders, titles, labels) and keeps doing so as they change.

const RTL = new Set(['ar', 'he', 'fa', 'ur']);

function compile(raw) {
  const exact = new Map();
  const patterns = [];
  for (const [key, value] of Object.entries(raw || {})) {
    if (key.startsWith('_') || typeof value !== 'string') continue;
    const k = key.trim();
    const v = value.trim();
    if (/\{\w+\}/.test(k)) {
      const names = [];
      const source = k
        .split(/(\{\w+\})/)
        .map((part) => {
          const m = part.match(/^\{(\w+)\}$/);
          if (m) {
            names.push(m[1]);
            return '([\\s\\S]+?)';
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
      patterns.push({ re: new RegExp(`^${source}$`), names, out: v });
    } else {
      exact.set(k, v);
    }
  }
  return { exact, patterns };
}

// Translates one string; leading/trailing whitespace is kept as it was.
function translate(dict, text) {
  if (!dict || typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed || !/[A-Za-z]/.test(trimmed)) return text;
  const start = text.indexOf(trimmed);
  const lead = text.slice(0, start);
  const tail = text.slice(start + trimmed.length);
  let hit = dict.exact.get(trimmed);
  if (hit === undefined) {
    for (const p of dict.patterns) {
      const m = trimmed.match(p.re);
      if (!m) continue;
      // captured parts are translated too when they are known phrases ("use your camera")
      hit = p.out.replace(/\{(\w+)\}/g, (all, name) => {
        const i = p.names.indexOf(name);
        if (i === -1) return all;
        const part = m[i + 1];
        return dict.exact.has(part.trim()) ? dict.exact.get(part.trim()) : part;
      });
      break;
    }
  }
  return hit === undefined ? text : lead + hit + tail;
}

// Default labels of Electron menu roles, so they can be translated like any other label.
const ROLE_LABELS = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteAndMatchStyle: 'Paste and Match Style',
  selectAll: 'Select All',
  delete: 'Delete',
  togglefullscreen: 'Toggle Full Screen',
  minimize: 'Minimize',
  zoom: 'Zoom',
  close: 'Close Window',
  front: 'Bring All to Front',
  hide: 'Hide',
  hideOthers: 'Hide Others',
  unhide: 'Show All',
  startSpeaking: 'Start Speaking',
  stopSpeaking: 'Stop Speaking',
  services: 'Services',
  window: 'Window',
  windowMenu: 'Window',
  help: 'Help',
  toggleDevTools: 'Toggle Developer Tools',
};

function translateMenuTemplate(dict, items) {
  if (!dict || !Array.isArray(items)) return items;
  return items.map((item) => {
    if (!item || typeof item !== 'object' || item.type === 'separator') return item;
    const copy = { ...item };
    const label = copy.label || (copy.role && ROLE_LABELS[copy.role]);
    if (label) copy.label = translate(dict, label);
    if (Array.isArray(copy.submenu)) copy.submenu = translateMenuTemplate(dict, copy.submenu);
    return copy;
  });
}

// ---- DOM (browser pages and toolbar)

// Text the user or a website wrote (tab titles, page titles, bookmark names, addresses) is
// never translated, even when it happens to match a phrase.
const USER_CONTENT = [
  '[data-no-i18n]',
  '.tab .title',
  '#bmbar',
  '#addrview',
  '#suggest .tt',
  '#suggest .uu',
  '.media-title',
  '#dlpanel .nm',
  '.row .t',
  '.row .u',
  '.tile .name',
  '#sites',
  '#tasks td',
  '.host',
  '#url',
  'code',
  'kbd',
  'pre',
].join(', ');
const ATTRIBUTES = ['placeholder', 'title', 'aria-label'];

function translateDom(dict, root) {
  if (!dict || !root) return;
  const doc = root.ownerDocument || root;
  const skip = (el) => !el || el.closest(USER_CONTENT) || el.closest('script, style, svg');
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const texts = [];
  for (let n = walker.currentNode.nodeType === 3 ? walker.currentNode : walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
  for (const node of texts) {
    if (skip(node.parentElement)) continue;
    const next = translate(dict, node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  const elements = root.nodeType === 1 ? [root, ...root.querySelectorAll('[placeholder], [title], [aria-label]')] : [...root.querySelectorAll('[placeholder], [title], [aria-label]')];
  for (const el of elements) {
    if (el.matches && el.matches(USER_CONTENT)) continue;
    for (const attr of ATTRIBUTES) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (!value) continue;
      const next = translate(dict, value);
      if (next !== value) el.setAttribute(attr, next);
    }
  }
}

function watchDom(dict, doc) {
  if (!dict) return;
  translateDom(dict, doc.documentElement);
  if (doc.title) doc.title = translate(dict, doc.title);
  const observer = new doc.defaultView.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1) translateDom(dict, n);
          else if (n.nodeType === 3 && n.parentElement && !n.parentElement.closest(USER_CONTENT)) {
            const next = translate(dict, n.nodeValue);
            if (next !== n.nodeValue) n.nodeValue = next;
          }
        }
      } else if (r.type === 'characterData') {
        const n = r.target;
        if (n.parentElement && !n.parentElement.closest(USER_CONTENT)) {
          const next = translate(dict, n.nodeValue);
          if (next !== n.nodeValue) n.nodeValue = next;
        }
      } else if (r.type === 'attributes') {
        const el = r.target;
        if (el.closest(USER_CONTENT)) continue;
        const value = el.getAttribute(r.attributeName);
        const next = translate(dict, value);
        if (value && next !== value) el.setAttribute(r.attributeName, next);
      }
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
}

module.exports = { RTL, compile, translate, translateMenuTemplate, translateDom, watchDom };
