'use strict';

const CODE_TO_SHORTCUT_KEY = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Enter',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

const KEY_SYMBOL_MAP = {
  LEFT: '←',
  RIGHT: '→',
  UP: '↑',
  DOWN: '↓',
  BACKSPACE: '⌫',
  DELETE: '⌦',
  TAB: '⇥',
  ENTER: '↩',
  RETURN: '↩',
  ESC: '⎋',
  ESCAPE: '⎋',
  SPACE: 'Space',
  PLUS: '+',
};

function normalizeShortcutAcc(acc) {
  if (!acc || typeof acc !== 'string') return '';
  const parts = acc.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  let cmd = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].toLowerCase();
    if (p === 'cmdorctrl' || p === 'commandorcontrol' || p === 'cmd' || p === 'command' || p === 'meta' || p === 'super') {
      cmd = true;
    } else if (p === 'ctrl' || p === 'control') {
      ctrl = true;
    } else if (p === 'alt' || p === 'option') {
      alt = true;
    } else if (p === 'shift') {
      shift = true;
    } else {
      key = parts[i];
    }
  }
  if (!key) return '';
  const ku = key.toUpperCase();
  if (ku === 'ARROWLEFT') key = 'Left';
  else if (ku === 'ARROWRIGHT') key = 'Right';
  else if (ku === 'ARROWUP') key = 'Up';
  else if (ku === 'ARROWDOWN') key = 'Down';
  else if (ku === 'ESCAPE') key = 'Esc';
  else if (ku === 'RETURN') key = 'Enter';
  else if (ku === 'SPACEBAR' || key === ' ') key = 'Space';
  else if (ku === 'PLUS') key = '=';
  else if (key.length === 1) key = key.toUpperCase();
  const out = [];
  if (cmd) out.push('Cmd');
  if (ctrl) out.push('Ctrl');
  if (alt) out.push('Alt');
  if (shift) out.push('Shift');
  out.push(key);
  return out.join('+');
}

function formatShortcutBadge(acc) {
  const norm = normalizeShortcutAcc(acc);
  if (!norm) return '';
  const parts = norm.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  let out = '';
  if (mods.has('Ctrl')) out += '⌃';
  if (mods.has('Alt')) out += '⌥';
  if (mods.has('Shift')) out += '⇧';
  if (mods.has('Cmd')) out += '⌘';
  const keySym = KEY_SYMBOL_MAP[key.toUpperCase()] || key;
  return out + keySym;
}

function eventToShortcutAccelerator(e) {
  if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(e.key)) return null;
  const parts = [];
  if (e.metaKey) parts.push('CmdOrCtrl');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = '';
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3);
  } else if (/^Digit[0-9]$/.test(code)) {
    key = code.slice(5);
  } else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) {
    key = code;
  } else if (CODE_TO_SHORTCUT_KEY[code]) {
    key = CODE_TO_SHORTCUT_KEY[code];
  } else if (e.key && e.key.length === 1) {
    key = e.key.toUpperCase();
  } else if (e.key) {
    key = e.key;
  }
  if (!key) return null;
  if (!parts.length && !/^F([1-9]|1\d|2[0-4])$/.test(key)) return null;
  parts.push(key);
  return parts.join('+');
}

let shortcutGroups = [];
let custom = {};
let recordingEl = null;
let recordingId = null;

const list = document.getElementById('list');
const resetBtn = document.getElementById('reset');
const searchInput = document.getElementById('shortcuts-search');

function stopRecording() {
  if (!recordingId && !recordingEl) return;
  recordingId = null;
  if (recordingEl) {
    recordingEl.classList.remove('recording');
    recordingEl = null;
  }
  if (window.browserAPI && browserAPI.setShortcutRecording) {
    browserAPI.setShortcutRecording(false);
  }
}

function startRecording(el, id) {
  if (recordingId === id) {
    stopRecording();
    render();
    return;
  }
  stopRecording();
  recordingEl = el;
  recordingId = id;
  el.classList.add('recording');
  el.classList.remove('unassigned');
  el.textContent = 'Press shortcut…';
  if (window.browserAPI && browserAPI.setShortcutRecording) {
    browserAPI.setShortcutRecording(true);
  }
}

function getEffectiveShortcut(item) {
  if (Object.prototype.hasOwnProperty.call(custom, item.id)) {
    return custom[item.id] || '';
  }
  return item.defaultKey || '';
}

function render() {
  list.textContent = '';
  if (resetBtn) resetBtn.hidden = Object.keys(custom).length === 0;

  const byNormKey = new Map();
  for (const group of shortcutGroups) {
    for (const item of group.items || []) {
      if (item.fixed) continue;
      const eff = getEffectiveShortcut(item);
      const norm = normalizeShortcutAcc(eff);
      if (!norm) continue;
      if (!byNormKey.has(norm)) byNormKey.set(norm, []);
      byNormKey.get(norm).push(item);
    }
  }

  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
  let visibleCount = 0;

  for (const group of shortcutGroups) {
    const matchingItems = (group.items || []).filter((item) => {
      if (!query) return true;
      const eff = item.fixed ? item.displayKey : getEffectiveShortcut(item);
      const badge = item.fixed ? item.displayKey : formatShortcutBadge(eff);
      const haystack = `${group.title} ${item.label} ${badge} ${eff}`.toLowerCase();
      return query.split(/\s+/).every((w) => haystack.includes(w));
    });
    if (!matchingItems.length) continue;
    visibleCount += matchingItems.length;

    const card = document.createElement('div');
    card.className = 'settings-card shortcuts-group-card';

    const h = document.createElement('h2');
    h.textContent = group.title;
    card.append(h);

    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'shortcuts-rows';

    for (const item of matchingItems) {
      const row = document.createElement('div');
      row.className = 'row shortcut-row';

      const main = document.createElement('div');
      main.className = 'main shortcut-main';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = item.label;
      main.append(t);

      const actions = document.createElement('div');
      actions.className = 'shortcut-actions';

      if (item.fixed) {
        const kbd = document.createElement('kbd');
        kbd.className = 'shortcut-kbd fixed';
        kbd.textContent = item.displayKey;
        actions.append(kbd);
      } else {
        const isOverridden = Object.prototype.hasOwnProperty.call(custom, item.id);
        const eff = getEffectiveShortcut(item);
        const norm = normalizeShortcutAcc(eff);
        const conflicts = norm ? (byNormKey.get(norm) || []).filter((other) => other.id !== item.id) : [];

        if (conflicts.length > 0) {
          const conflictNote = document.createElement('div');
          conflictNote.className = 'shortcut-conflict';
          conflictNote.textContent = `Conflicts with: ${conflicts.map((c) => c.label).join(', ')}`;
          main.append(conflictNote);
        }

        if (isOverridden) {
          const restoreBtn = document.createElement('button');
          restoreBtn.type = 'button';
          restoreBtn.className = 'shortcut-restore';
          restoreBtn.textContent = 'Restore';
          restoreBtn.addEventListener('click', async () => {
            stopRecording();
            delete custom[item.id];
            await browserAPI.setSetting('shortcuts', custom);
            render();
          });
          actions.append(restoreBtn);
        }

        const k = document.createElement('kbd');
        k.className = 'editable shortcut-kbd';
        if (!eff) {
          k.classList.add('unassigned');
          k.textContent = 'Add New';
        } else {
          k.textContent = formatShortcutBadge(eff);
        }
        if (conflicts.length > 0) k.classList.add('conflict');
        if (recordingId === item.id) {
          k.classList.add('recording');
          k.classList.remove('unassigned');
          k.textContent = 'Press shortcut…';
          recordingEl = k;
        }
        k.title = 'Click to record a new shortcut (⌫ to disable, Esc to cancel)';
        k.tabIndex = 0;
        k.addEventListener('click', (e) => {
          e.stopPropagation();
          startRecording(k, item.id);
        });
        actions.append(k);
      }

      row.append(main, actions);
      rowsWrap.append(row);
    }

    card.append(rowsWrap);
    list.append(card);
  }

  if (visibleCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'settings-card empty';
    empty.textContent = 'No keyboard shortcuts match your search.';
    list.append(empty);
  }
}

searchInput?.addEventListener('input', () => {
  stopRecording();
  render();
});

window.addEventListener(
  'keydown',
  async (e) => {
    if (!recordingId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopRecording();
      render();
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const id = recordingId;
      stopRecording();
      custom[id] = '';
      await browserAPI.setSetting('shortcuts', custom);
      render();
      return;
    }
    const acc = eventToShortcutAccelerator(e);
    if (!acc) return;
    const id = recordingId;
    stopRecording();
    const groupItem = shortcutGroups.flatMap((g) => g.items || []).find((i) => i.id === id);
    if (groupItem && normalizeShortcutAcc(acc) === normalizeShortcutAcc(groupItem.defaultKey)) {
      delete custom[id];
    } else {
      custom[id] = acc;
    }
    await browserAPI.setSetting('shortcuts', custom);
    render();
  },
  true,
);

window.addEventListener('mousedown', (e) => {
  if (!recordingId) return;
  if (recordingEl && recordingEl.contains(e.target)) return;
  stopRecording();
  render();
});

window.addEventListener('blur', () => {
  if (recordingId) {
    stopRecording();
    render();
  }
});

resetBtn?.addEventListener('click', async () => {
  stopRecording();
  custom = {};
  await browserAPI.setSetting('shortcuts', {});
  render();
});

(async () => {
  if (window.browserAPI && browserAPI.getSettings) {
    const s = await browserAPI.getSettings();
    document.documentElement.dataset.accent = s.accentColor || 'violet';
    shortcutGroups = s.shortcutGroups || [];
    custom = { ...(s.shortcuts || {}) };
  }
  render();
})();

