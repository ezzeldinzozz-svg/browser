'use strict';

// Mirrors the menu accelerators in main.js. "Mod" is Cmd on macOS and Ctrl elsewhere.
const mac = navigator.platform.toUpperCase().includes('MAC');
const mod = mac ? '⌘' : 'Ctrl+';
const shift = mac ? '⇧' : 'Shift+';
const alt = mac ? '⌥' : 'Alt+';

const groups = [
  ['Tabs and windows', [
    [`${mod}T`, 'New tab'],
    [`${mod}N`, 'New window'],
    [`${mod}${shift}N`, 'New private window'],
    [`${mod}W`, 'Close tab'],
    [`${mod}${shift}W`, 'Close window'],
    [`${mod}${shift}T`, 'Reopen closed tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    [`${mod}1 … ${mod}8, ${mod}9`, 'Go to tab 1–8, last tab'],
    [`${mod}${shift}A`, 'Search open tabs'],
  ]],
  ['Pages', [
    [`${mod}L`, 'Focus the address bar'],
    ['F6', 'Switch between the toolbar and the page'],
    [mac ? '⌘[ / ⌘]' : 'Alt+Left / Alt+Right', 'Back / forward'],
    [`${mod}R`, 'Reload'],
    [`${mod}${shift}R`, 'Reload without cache'],
    [`${mod}F`, 'Find in page'],
    [`${mod}G / ${mod}${shift}G`, 'Next / previous match'],
    [`${mod}+ / ${mod}- / ${mod}0`, 'Zoom in / out / actual size'],
    [`${mod}P`, 'Print'],
    [`${mod}S`, 'Save page as'],
    [mac ? '⌘⇧H' : 'Alt+Home', 'Home'],
    [mac ? '⌥⌘I' : 'F12', 'Developer tools'],
  ]],
  ['Bookmarks, history and downloads', [
    [`${mod}D`, 'Bookmark this page'],
    [`${mod}${shift}D`, 'Bookmark all tabs'],
    [`${mod}${shift}B`, 'Show or hide the bookmarks bar'],
    [`${mod}${shift}O`, 'Bookmark manager'],
    [mac ? '⌘Y' : 'Ctrl+H', 'History'],
    [mac ? '⌥⌘L' : 'Ctrl+J', 'Downloads'],
    [`${mod}${shift}⌫`, 'Clear browsing data'],
  ]],
  ['Address bar', [
    ['↑ / ↓', 'Choose a suggestion'],
    [`${shift}Delete`, 'Remove a history suggestion'],
    ['Esc', 'Close suggestions / restore the address'],
  ]],
  ['Other', [
    [`${mod},`, 'Settings'],
    [`${mod}/`, 'This page'],
  ]],
];

const list = document.getElementById('list');
for (const [title, rows] of groups) {
  const h = document.createElement('h2');
  h.textContent = title;
  list.append(h);
  for (const [keys, what] of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('kbd');
    k.textContent = keys;
    const t = document.createElement('div');
    t.className = 'main';
    t.textContent = what;
    row.append(t, k);
    list.append(row);
  }
}
