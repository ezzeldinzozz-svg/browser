'use strict';

// Mirrors the menu accelerators in main.js. "Mod" is Cmd on macOS and Ctrl elsewhere.
const mac = navigator.platform.toUpperCase().includes('MAC');
const mod = mac ? '⌘' : 'Ctrl+';
const shift = mac ? '⇧' : 'Shift+';
const alt = mac ? '⌥' : 'Alt+';

const groups = [
  ['Tabs and windows', [
    [`${mod}T`, 'New tab', 'new-tab'],
    [`${mod}N`, 'New window', 'new-window'],
    [`${mod}${shift}N`, 'New private window', 'private-window'],
    [`${mod}W`, 'Close tab', 'close-tab'],
    [`${mod}${shift}W`, 'Close window'],
    [`${mod}${shift}T`, 'Reopen closed tab', 'reopen-tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    [`${mod}1 … ${mod}8, ${mod}9`, 'Go to tab 1–8, last tab'],
    [`${mod}${shift}A`, 'Search open tabs'],
    [`${alt}${mod}S`, 'Split view (side by side)', 'split-view'],
    [`${alt}${mod}V`, 'Vertical tabs sidebar', 'vertical-tabs'],
  ]],
  ['Pages', [
    [`${mod}L`, 'Focus the address bar'],
    ['F6', 'Switch between the toolbar and the page'],
    [mac ? '⌘[ / ⌘]' : 'Alt+Left / Alt+Right', 'Back / forward'],
    [`${mod}R`, 'Reload', 'reload'],
    [`${mod}${shift}R`, 'Reload without cache'],
    [`${mod}F`, 'Find in page', 'find'],
    [`${mod}G / ${mod}${shift}G`, 'Next / previous match'],
    [`${mod}+ / ${mod}- / ${mod}0`, 'Zoom in / out / actual size'],
    [`${alt}${mod}R`, 'Reader mode', 'reader'],
    [`${alt}${shift}S`, 'Read page aloud'],
    [`${alt}${shift}T`, 'Translate page'],
    [`${mod}${shift}S`, 'Take screenshot'],
    [`${mod}P`, 'Print'],
    [`${mod}S`, 'Save page as'],
    [mac ? '⌘⇧H' : 'Alt+Home', 'Home'],
    [mac ? '⌥⌘I' : 'F12', 'Developer tools', 'devtools'],
  ]],
  ['Bookmarks, history and downloads', [
    [`${mod}D`, 'Bookmark this page', 'bookmark'],
    [`${mod}${shift}D`, 'Bookmark all tabs'],
    [`${mod}${shift}B`, 'Show or hide the bookmarks bar'],
    [`${mod}${shift}O`, 'Bookmark manager'],
    [mac ? '⌘Y' : 'Ctrl+H', 'History', 'history'],
    [mac ? '⌥⌘L' : 'Ctrl+J', 'Downloads', 'downloads'],
    [`${mod}${shift}⌫`, 'Clear browsing data'],
  ]],
  ['Address bar', [
    ['↑ / ↓', 'Choose a suggestion'],
    [`${shift}Delete`, 'Remove a history suggestion'],
    ['Esc', 'Close suggestions / restore the address'],
  ]],
  ['Other', [
    [`${mod},`, 'Settings', 'settings'],
    [`${mod}/`, 'This page'],
  ]],
];

function formatAccelerator(acc) {
  if (!acc) return '';
  if (!mac) return acc.replace(/CmdOrCtrl/g, 'Ctrl');
  return acc
    .replace(/CmdOrCtrl\+/g, '⌘')
    .replace(/CommandOrControl\+/g, '⌘')
    .replace(/Cmd\+/g, '⌘')
    .replace(/Ctrl\+/g, '⌃')
    .replace(/Alt\+/g, '⌥')
    .replace(/Option\+/g, '⌥')
    .replace(/Shift\+/g, '⇧');
}

function eventToAccelerator(e) {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
  const parts = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('CmdOrCtrl');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (!parts.length && !/^F\d+$/.test(e.key)) return null;
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.code && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  parts.push(key);
  return parts.join('+');
}

let custom = {};
let recordingEl = null;
let recordingId = null;

const list = document.getElementById('list');
const resetBtn = document.getElementById('reset');

function render() {
  list.textContent = '';
  resetBtn.hidden = Object.keys(custom).length === 0;
  for (const [title, rows] of groups) {
    const h = document.createElement('h2');
    h.textContent = title;
    list.append(h);
    for (const [keys, what, id] of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      const k = document.createElement('kbd');
      k.textContent = id && custom[id] ? formatAccelerator(custom[id]) : keys;
      if (id) {
        k.classList.add('editable');
        k.title = 'Click to change shortcut';
        k.tabIndex = 0;
        k.addEventListener('click', () => startRecording(k, id, keys));
      }
      const t = document.createElement('div');
      t.className = 'main';
      t.textContent = what;
      row.append(t, k);
      list.append(row);
    }
  }
}

function startRecording(el, id, fallbackLabel) {
  if (recordingEl) recordingEl.classList.remove('recording');
  recordingEl = el;
  recordingId = id;
  el.classList.add('recording');
  el.textContent = 'Press keys…';
  el.dataset.fallback = fallbackLabel;
}

window.addEventListener(
  'keydown',
  async (e) => {
    if (!recordingId || !recordingEl) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      recordingId = null;
      recordingEl = null;
      render();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      delete custom[recordingId];
      recordingId = null;
      recordingEl = null;
      await browserAPI.setSetting('shortcuts', custom);
      render();
      return;
    }
    const acc = eventToAccelerator(e);
    if (!acc) return;
    custom[recordingId] = acc;
    recordingId = null;
    recordingEl = null;
    await browserAPI.setSetting('shortcuts', custom);
    render();
  },
  true,
);

resetBtn.addEventListener('click', async () => {
  custom = {};
  await browserAPI.setSetting('shortcuts', {});
  render();
});

(async () => {
  if (window.browserAPI && browserAPI.getSettings) {
    const s = await browserAPI.getSettings();
    document.documentElement.dataset.accent = s.accentColor || 'violet';
    custom = { ...(s.shortcuts || {}) };
  }
  render();
})();
