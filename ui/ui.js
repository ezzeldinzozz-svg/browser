'use strict';

const api = window.browserAPI;
const $ = (id) => document.getElementById(id);
const tablist = $('tablist');
const address = $('address');

const SPEAKER =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a5 5 0 0 1 0 7"/></svg>';
const SPEAKER_MUTED =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6M21 9l-5 6"/></svg>';

let dragId = null;

function renderTab(t, isActive) {
  const el = document.createElement('div');
  el.className = 'tab' + (isActive ? ' active' : '') + (t.pinned ? ' pinned' : '');
  el.title = t.title;
  el.draggable = true;

  if (t.loading) {
    const s = document.createElement('div');
    s.className = 'spinner';
    el.append(s);
  } else if (t.favicon) {
    const img = document.createElement('img');
    img.src = t.favicon;
    img.onerror = () => img.remove();
    el.append(img);
  } else if (t.pinned) {
    const dot = document.createElement('span');
    dot.className = 'letter';
    dot.textContent = (t.title || '?').trim().charAt(0).toUpperCase();
    el.append(dot);
  }

  if (!t.pinned) {
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    el.append(title);
  }

  if (t.audible || t.muted) {
    const audio = document.createElement('button');
    audio.className = 'audio' + (t.muted ? ' muted' : '');
    audio.innerHTML = t.muted ? SPEAKER_MUTED : SPEAKER;
    audio.title = t.muted ? 'Unmute tab' : 'Mute tab';
    audio.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button === 0) api.muteTab(t.id);
    });
    el.append(audio);
  }

  if (!t.pinned) {
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button === 0) api.closeTab(t.id);
    });
    el.append(close);
  }

  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      api.closeTab(t.id);
    } else if (e.button === 0) {
      api.selectTab(t.id);
    }
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.tabMenu(t.id);
  });

  // Drag to reorder: drop before or after a tab depending on which half the cursor is over.
  el.addEventListener('dragstart', (e) => {
    dragId = t.id;
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    dragId = null;
    el.classList.remove('dragging');
    for (const x of tablist.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('dragover', (e) => {
    if (dragId === null || dragId === t.id) return;
    e.preventDefault();
    const after = e.offsetX > el.offsetWidth / 2;
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragId === null || dragId === t.id) return;
    const ids = [...tablist.children].map((x) => Number(x.dataset.id));
    const from = ids.indexOf(dragId);
    let to = ids.indexOf(t.id) + (el.classList.contains('drop-after') ? 1 : 0);
    if (from < to) to -= 1; // the dragged tab leaves its old slot first
    api.moveTab(dragId, to);
  });
  el.dataset.id = String(t.id);
  return el;
}

function render(state) {
  const active = state.tabs.find((t) => t.id === state.activeId);
  document.body.classList.toggle('private', state.private);
  $('private-badge').hidden = !state.private;

  const shield = state.shield;
  $('shield').hidden = !shield.available;
  $('shield').classList.toggle('off', !shield.on);
  $('shield-count').textContent = shield.on && shield.blocked ? String(shield.blocked) : '';
  $('shield').title = shield.on
    ? `Blocked ${shield.blocked} ads and trackers on ${shield.site}. Click to turn off for this site.`
    : `Ad blocking is off for ${shield.site}. Click to turn it on.`;

  tablist.textContent = '';
  for (const t of state.tabs) tablist.append(renderTab(t, t.id === state.activeId));

  $('back').disabled = !active || !active.canGoBack;
  $('forward').disabled = !active || !active.canGoForward;
  $('reload').textContent = active && active.loading ? '✕' : '↻';
  $('reload').title = active && active.loading ? 'Stop' : 'Reload';
  $('star').disabled = !state.canBookmark;
  $('star').classList.toggle('on', state.bookmarked);
  $('star').textContent = state.bookmarked ? '★' : '☆';

  shownUrl = active ? active.url : '';
  if (document.activeElement !== address) address.value = shownUrl;
  renderSiteButton(state.security);

  currentWarning = state.downloadWarning;
  $('dlwarn').hidden = !currentWarning;
  $('dlwarn-text').textContent = currentWarning
    ? `“${currentWarning.filename}” can harm your computer if it isn't from a source you trust. Keep it?`
    : '';

  currentPrompt = state.prompt;
  $('prompt').hidden = !currentPrompt;
  $('prompt-text').textContent = currentPrompt ? currentPrompt.text : '';

  const find = state.find || { open: false, text: '', active: 0, matches: 0 };
  $('findbar').hidden = !find.open;
  if (document.activeElement !== findInput) findInput.value = find.text;
  $('find-count').textContent = find.text ? `${find.active} of ${find.matches}` : '';
  findInput.classList.toggle('none', !!find.text && find.matches === 0);

  const dl = state.downloads;
  const btn = $('downloads');
  btn.classList.toggle('active', dl.active > 0);
  btn.dataset.badge = dl.progress >= 0 ? `${Math.floor(dl.progress * 100)}%` : String(dl.active);
  btn.title = dl.active ? `Downloads (${dl.active} in progress)` : 'Downloads';

  const auth = state.auth;
  if ((auth && auth.id) !== (currentAuth && currentAuth.id)) {
    $('auth-user').value = '';
    $('auth-pass').value = '';
  }
  currentAuth = auth;
  $('authbar').hidden = !auth;
  const authText = $('auth-text');
  authText.textContent = '';
  if (auth) {
    authText.append(`Sign in to ${auth.host}${auth.realm ? ` (“${auth.realm}”)` : ''}`);
    if (auth.insecure) {
      const warn = document.createElement('span');
      warn.className = 'warn';
      warn.textContent = ' · not secure: your password will be sent unencrypted';
      authText.append(warn);
    }
  }

  // Quiet while checking; a small pill while downloading; a button once it's ready.
  const update = state.update || {};
  const pill = $('update');
  const downloading = update.status === 'downloading';
  pill.hidden = !(downloading || update.status === 'ready');
  pill.disabled = downloading;
  pill.classList.toggle('downloading', downloading);
  pill.textContent = downloading
    ? `Updating… ${update.progress >= 0 ? Math.floor(update.progress * 100) + '%' : ''}`.trim()
    : 'Restart to update';
  pill.title = downloading
    ? `Downloading Browser ${update.version}`
    : update.version ? `Browser ${update.version} is ready. Restart to finish updating.` : '';
}

const findInput = $('find-input');
api.onFocusFind(() => {
  findInput.focus();
  findInput.select();
});
findInput.addEventListener('input', () => api.find(findInput.value, { newSession: true }));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') api.find(findInput.value, { forward: !e.shiftKey });
  else if (e.key === 'Escape') api.closeFind();
});
$('find-next').addEventListener('click', () => api.find(findInput.value, { forward: true }));
$('find-prev').addEventListener('click', () => api.find(findInput.value, { forward: false }));
$('find-close').addEventListener('click', () => api.closeFind());
$('downloads').addEventListener('click', () => api.openDownloads());
$('update').addEventListener('click', () => api.installUpdate());
$('shield').addEventListener('click', () => api.toggleSiteBlocking());

let currentAuth = null;
api.onFocusAuth(() => $('auth-user').focus());
$('authbar').addEventListener('submit', (e) => {
  e.preventDefault();
  if (currentAuth) api.respondAuth(currentAuth.id, $('auth-user').value, $('auth-pass').value);
});
$('auth-cancel').addEventListener('click', () => currentAuth && api.respondAuth(currentAuth.id, null));
$('authbar').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentAuth) api.respondAuth(currentAuth.id, null);
});

let currentWarning = null;
$('dlwarn-keep').addEventListener('click', () => currentWarning && api.decideDownloadWarning(currentWarning.id, 'keep'));
$('dlwarn-discard').addEventListener('click', () => currentWarning && api.decideDownloadWarning(currentWarning.id, 'discard'));

let currentPrompt = null;
const respond = (decision) => currentPrompt && api.respondPermission(currentPrompt.id, decision);
$('prompt-allow').addEventListener('click', () => respond('allow'));
$('prompt-block').addEventListener('click', () => respond('block'));
$('prompt-close').addEventListener('click', () => respond('dismiss'));

api.onTabs(render);
api.onFocusAddress(() => {
  address.focus();
  address.select();
});

$('newtab').addEventListener('click', () => api.newTab());
$('back').addEventListener('click', () => api.back());
$('forward').addEventListener('click', () => api.forward());
$('reload').addEventListener('click', () => api.reload());
$('star').addEventListener('click', () => api.toggleBookmark());

// ---- overlay: the toolbar view stretches over the page while a dropdown or popup is open

let overlayOpen = false;
function setOverlay() {
  const open = !$('suggest').hidden || !$('sitepopup').hidden || !$('screenpicker').hidden;
  if (open !== overlayOpen) {
    overlayOpen = open;
    api.setOverlay(open);
  }
}

// ---- address bar: suggestions from history and bookmarks, inline completion

let shownUrl = '';
let typed = ''; // what the user actually typed (without inline completion)
let rows = []; // [{ kind: 'typed' | 'page', url?, ... }]
let selected = 0;
let suggestSeq = 0;

const looksLikeAddress = (t) =>
  /^[a-z][\w+.-]*:\/\//i.test(t) || /^(localhost|(\d{1,3}\.){3}\d{1,3}|([\w-]+\.)+[a-z]{2,})(:\d+)?([/?#]\S*)?$/i.test(t);

function closeSuggest() {
  $('suggest').hidden = true;
  rows = [];
  setOverlay();
}

function renderSuggest(engine) {
  const box = $('suggest');
  box.textContent = '';
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'sg' + (i === selected ? ' sel' : '');
    const icon = document.createElement('span');
    icon.className = 'ic';
    const title = document.createElement('span');
    title.className = 'tt';
    const url = document.createElement('span');
    url.className = 'uu';
    if (r.kind === 'typed') {
      const go = looksLikeAddress(r.text);
      icon.textContent = go ? '↗' : '⌕';
      title.textContent = go ? r.text : `${r.text}`;
      url.textContent = go ? '' : `— Search ${engine}`;
      url.style.color = 'var(--fg-dim)';
    } else {
      icon.textContent = r.bookmarked ? '★' : '◷';
      title.textContent = r.title;
      url.textContent = r.display;
    }
    row.append(icon, title, url);
    // mousedown (not click) so the address bar doesn't blur first
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      navigate(r);
    });
    row.addEventListener('mousemove', () => {
      if (selected !== i) {
        selected = i;
        renderSuggest(engine);
      }
    });
    box.append(row);
  });
  box.hidden = rows.length === 0;
  setOverlay();
}

let lastEngine = '';
async function updateSuggestions(allowInline) {
  const seq = ++suggestSeq;
  const text = typed;
  if (!text.trim()) return closeSuggest();
  const res = await api.suggest(text);
  if (seq !== suggestSeq || document.activeElement !== address) return; // stale
  lastEngine = res.engine;
  if (allowInline && res.inline && res.inline.toLowerCase().startsWith(text.toLowerCase())) {
    address.value = text + res.inline.slice(text.length);
    address.setSelectionRange(text.length, address.value.length);
  }
  rows = [{ kind: 'typed', text: address.value }, ...res.items.map((p) => ({ kind: 'page', ...p }))];
  // don't list the inline-completed page twice
  rows = rows.filter((r, i) => i === 0 || !sameAddress(r.url, rows[0].text));
  selected = 0;
  renderSuggest(res.engine);
}

const bare = (u) => String(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();
const sameAddress = (url, text) => bare(url) === bare(text);

function navigate(row) {
  api.go(row.kind === 'page' ? row.url : row.text);
  closeSuggest();
  address.blur();
}

address.addEventListener('focus', () => address.select());
address.addEventListener('input', (e) => {
  typed = address.value;
  // only complete inline while typing forward at the end, never while deleting
  const atEnd = address.selectionStart === address.value.length;
  updateSuggestions(atEnd && e.inputType === 'insertText');
});
address.addEventListener('keydown', (e) => {
  const open = !$('suggest').hidden && rows.length > 0;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) return;
    e.preventDefault();
    selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    const r = rows[selected];
    address.value = r.kind === 'page' ? r.url : r.text;
    renderSuggest(lastEngine);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && rows[selected] && rows[selected].kind === 'page') navigate(rows[selected]);
    else navigate({ kind: 'typed', text: address.value });
  } else if (e.key === 'Escape') {
    if (open) {
      closeSuggest();
      address.value = typed;
    } else {
      address.value = shownUrl;
      address.blur();
    }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    // first Backspace removes the inline completion, like other browsers
    if (address.selectionStart !== address.selectionEnd && address.selectionEnd === address.value.length && address.value !== typed) {
      e.preventDefault();
      address.value = typed;
      updateSuggestions(false);
    }
  }
});
function leaveAddressBar() {
  getSelection().removeAllRanges();
  closeSuggest();
  address.value = shownUrl;
}
address.addEventListener('blur', leaveAddressBar);
// While the dropdown is open the toolbar covers the page, so a click "on the page" lands here.
document.addEventListener('mousedown', (e) => {
  if (!$('suggest').hidden && !$('omnibox').contains(e.target)) {
    leaveAddressBar();
    address.blur();
  }
});
window.addEventListener('blur', () => {
  if (!$('suggest').hidden) leaveAddressBar();
});

// ---- site info popup (lock icon)

const LOCK =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm2 0h6V7a3 3 0 0 0-6 0z"/></svg>';
const INFO =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M11 10h2v7h-2zm0-4h2v2h-2z"/></svg>';

function renderSiteButton(security) {
  const btn = $('site');
  const omni = $('omnibox');
  const show = security === 'secure' || security === 'insecure' || security === 'internal';
  btn.hidden = !show;
  omni.classList.toggle('has-site', show);
  omni.classList.toggle('insecure', security === 'insecure');
  btn.classList.toggle('insecure', security === 'insecure');
  if (security === 'secure') {
    btn.innerHTML = LOCK;
    btn.title = 'Connection is secure. Click for site settings.';
  } else if (security === 'insecure') {
    btn.innerHTML = INFO + '<span>Not secure</span>';
    btn.title = 'Connection is not secure. Click for site settings.';
  } else if (security === 'internal') {
    btn.innerHTML = INFO;
    btn.title = 'Browser page';
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function closeSitePopup() {
  $('sitepopup').hidden = true;
  $('backdrop').hidden = true;
  setOverlay();
}

async function openSitePopup() {
  const info = await api.siteInfo();
  if (!info) return;
  const pop = $('sitepopup');
  pop.textContent = '';
  if (info.kind !== 'web') {
    pop.append(el('h3', '', info.title), el('div', 'line', "This is one of the browser's own pages."));
  } else {
    pop.append(el('h3', '', info.host));
    if (info.secure) {
      const cert = info.certificate;
      pop.append(el('div', cert && !cert.ok ? 'line bad' : 'line', cert && !cert.ok ? 'Certificate problem' : 'Connection is secure'));
      if (cert) {
        pop.append(
          el('div', 'line', `Certificate issued by ${cert.issuer}`),
          el('div', 'line', `Valid until ${new Date(cert.validExpiry).toLocaleDateString()}`),
        );
      } else {
        pop.append(el('div', 'line', 'Certificate details are shown after the site is loaded over a new connection.'));
      }
    } else {
      pop.append(el('div', 'line bad', "Connection is not secure. Don't enter passwords or card details on this site."));
    }

    const perms = el('div', 'sec');
    perms.append(el('div', 'sec-title', 'Permissions'));
    for (const p of info.permissions) {
      const row = el('div', 'perm');
      const select = document.createElement('select');
      for (const [v, label] of [['ask', 'Ask'], ['allow', 'Allow'], ['block', 'Block']]) select.append(new Option(label, v));
      select.value = p.value;
      select.addEventListener('change', () => api.setSitePermission(info.origin, p.key, select.value));
      row.append(el('span', '', p.name), select);
      perms.append(row);
    }
    pop.append(perms);

    if (info.adblock.available) {
      const ab = el('div', 'sec');
      const row = el('div', 'perm');
      const btn = el('button', 'btn', info.adblock.on ? 'Turn off' : 'Turn on');
      btn.addEventListener('click', () => {
        api.toggleSiteBlocking();
        closeSitePopup();
      });
      row.append(el('span', '', info.adblock.on ? `Ad blocking: on (${info.adblock.blocked} blocked)` : 'Ad blocking: off'), btn);
      ab.append(row);
      pop.append(ab);
    }

    const data = el('div', 'sec');
    const clear = el('button', 'btn', 'Clear cookies and site data');
    clear.addEventListener('click', async () => {
      await api.clearSiteData();
      closeSitePopup();
    });
    data.append(clear);
    if (info.private) data.append(el('div', 'note', 'Changes here last until this private window closes.'));
    pop.append(data);
  }
  pop.hidden = false;
  $('backdrop').hidden = false;
  setOverlay();
}

$('site').addEventListener('mousedown', (e) => e.preventDefault()); // keep address bar focus logic out of it
$('site').addEventListener('click', () => ($('sitepopup').hidden ? openSitePopup() : closeSitePopup()));
$('backdrop').addEventListener('mousedown', closeSitePopup);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sitepopup').hidden) closeSitePopup();
});

// ---- screen-sharing picker (Windows/Linux; macOS 15+ uses the system picker)

let screenPick = null;
let screenChoice = null;

function closeScreenPicker(sourceId) {
  if (screenPick) api.chooseScreen(screenPick.id, sourceId);
  screenPick = null;
  $('screenpicker').hidden = true;
  setOverlay();
}

api.onScreenPicker((pick) => {
  screenPick = pick;
  screenChoice = null;
  if (!pick) {
    $('screenpicker').hidden = true;
    return setOverlay();
  }
  $('sp-title').textContent = `Choose what to share with ${pick.site}`;
  const grid = $('sp-grid');
  grid.textContent = '';
  for (const s of pick.sources) {
    const item = el('div', 'sp-item');
    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail;
      item.append(img);
    } else {
      item.append(el('div', 'ph'));
    }
    item.append(el('div', 'nm', s.kind === 'screen' ? `Screen: ${s.name}` : s.name));
    item.addEventListener('click', () => {
      screenChoice = s.id;
      for (const x of grid.children) x.classList.toggle('sel', x === item);
      $('sp-share').disabled = false;
    });
    item.addEventListener('dblclick', () => closeScreenPicker(s.id));
    grid.append(item);
  }
  $('sp-share').disabled = true;
  $('screenpicker').hidden = false;
  setOverlay();
});
$('sp-cancel').addEventListener('click', () => closeScreenPicker(null));
$('sp-share').addEventListener('click', () => screenChoice && closeScreenPicker(screenChoice));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && screenPick) closeScreenPicker(null);
});
