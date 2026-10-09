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
  el.className = 'tab' + (isActive ? ' active' : '') + (t.pinned ? ' pinned' : '') + (t.sleeping ? ' sleeping' : '');
  el.title = t.url && t.url !== t.title ? `${t.title}\n${t.url}` : t.title;
  el.setAttribute('role', 'tab');
  el.setAttribute('aria-selected', String(isActive));
  el.tabIndex = isActive ? 0 : -1;
  el.setAttribute('aria-label', t.title + (t.audible ? ', playing audio' : '') + (t.muted ? ', muted' : ''));
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

  if (t.capture) {
    const rec = document.createElement('span');
    rec.className = 'rec';
    rec.title = 'Using ' + [t.capture.camera && 'camera', t.capture.microphone && 'microphone', t.capture.screen && 'screen'].filter(Boolean).join(', ');
    el.append(rec);
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
  // extension buttons follow the active tab; private windows have no extensions
  const ext = $('extensions');
  ext.hidden = state.private;
  if (state.activeWebContentsId && ext.getAttribute('tab') !== String(state.activeWebContentsId)) {
    ext.setAttribute('tab', String(state.activeWebContentsId));
  }
  $('private-badge').hidden = !state.private;

  const shield = state.shield;
  $('shield').hidden = !shield.available;
  $('shield').classList.toggle('off', !shield.on);
  $('shield-count').textContent = shield.on && shield.blocked ? String(shield.blocked) : '';
  $('shield').title = shield.on
    ? `Blocked ${shield.blocked} ads and trackers on ${shield.site}. Click to turn off for this site.`
    : `Ad blocking is off for ${shield.site}. Click to turn it on.`;

  const focusedTab = tablist.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  tablist.textContent = '';
  for (const t of state.tabs) tablist.append(renderTab(t, t.id === state.activeId));
  if (focusedTab) tablist.querySelector(`.tab[data-id="${focusedTab}"]`)?.focus(); // keep keyboard focus across re-renders
  const activeEl = tablist.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  $('back').disabled = !active || !active.canGoBack;
  $('forward').disabled = !active || !active.canGoForward;
  $('reload').textContent = active && active.loading ? '✕' : '↻';
  $('reload').title = active && active.loading ? 'Stop' : 'Reload';
  $('star').disabled = !state.canBookmark;
  $('star').classList.toggle('on', state.bookmarked);
  $('star').textContent = state.bookmarked ? '★' : '☆';

  renderBookmarkBar(state.bookmarkBar);
  const cap = state.capture;
  $('capture').hidden = !cap;
  if (cap) {
    const what = [cap.camera && 'Camera', cap.microphone && 'Microphone', cap.screen && 'Screen'].filter(Boolean).join(' + ');
    $('capture').textContent = `\u25CF ${what} \u00B7 Stop`;
    $('capture').title = `This page is using your ${what.toLowerCase()}. Click to stop.`;
  }
  $('zoom').hidden = state.zoom === 100;
  $('zoom').textContent = `${state.zoom}%`;

  shownUrl = active ? active.url : '';
  if (document.activeElement !== address) address.value = shownUrl;
  renderAddressView();
  if (!$('dlpanel').hidden) renderDownloadPanel();
  renderSiteButton(state.security);

  $('restorebar').hidden = !state.restoreOffer;
  $('home').hidden = !state.showHome;

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
$('star').addEventListener('click', () => api.starPage());

// ---- overlay: the toolbar view stretches over the page while a dropdown or popup is open

let overlayOpen = false;
function setOverlay() {
  const open = ['suggest', 'sitepopup', 'screenpicker', 'dlpanel', 'bmpopup'].some((id) => !$(id).hidden);
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
    } else if (r.kind === 'tab') {
      icon.textContent = '\u29C9';
      title.textContent = r.title;
      url.textContent = `\u2014 Switch to tab`;
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
let inlineUrl = null;
async function updateSuggestions(allowInline) {
  const seq = ++suggestSeq;
  const text = typed;
  if (!text.trim()) return closeSuggest();
  const res = await api.suggest(text);
  if (seq !== suggestSeq || document.activeElement !== address) return; // stale
  lastEngine = res.engine;
  inlineUrl = null;
  if (allowInline && res.inline && res.inline.toLowerCase().startsWith(text.toLowerCase())) {
    address.value = text + res.inline.slice(text.length);
    address.setSelectionRange(text.length, address.value.length);
    inlineUrl = res.items[0] ? res.items[0].url : null; // the page the completion came from
  }
  rows = [
    { kind: 'typed', text: address.value },
    ...(res.tabs || []).map((t) => ({ kind: 'tab', ...t })),
    ...res.items.map((p) => ({ kind: 'page', ...p })),
  ];
  // don't list the inline-completed page twice
  rows = rows.filter((r, i) => i === 0 || !sameAddress(r.url, rows[0].text));
  selected = 0;
  renderSuggest(res.engine);
}

const bare = (u) => String(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();
const sameAddress = (url, text) => bare(url) === bare(text);

function navigate(row) {
  if (row.kind === 'tab') api.switchToTab(row.tabId);
  else api.go(row.kind === 'page' ? row.url : row.text);
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
    address.value = r.kind === 'page' ? r.url : r.kind === 'tab' ? r.display : r.text;
    renderSuggest(lastEngine);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && rows[selected] && rows[selected].kind !== 'typed') navigate(rows[selected]);
    else navigate({ kind: 'typed', text: address.value });
  } else if (e.key === 'Escape') {
    if (open) {
      closeSuggest();
      address.value = typed;
    } else {
      address.value = shownUrl;
      address.blur();
    }
  } else if (e.key === 'Delete' && e.shiftKey && open && rows[selected] && (rows[selected].kind === 'page' ? !rows[selected].bookmarked : selected === 0 && inlineUrl)) {
    // Shift+Delete removes the selected history suggestion (or the page behind the inline completion)
    e.preventDefault();
    api.removeSuggestion(rows[selected].kind === 'page' ? rows[selected].url : inlineUrl);
    address.value = typed;
    updateSuggestions(false);
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

// ---- back/forward: right-click or long-press shows the history list

for (const [id, dir] of [['back', 'back'], ['forward', 'forward']]) {
  const btn = $(id);
  let pressTimer = null;
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.historyMenu(dir);
  });
  btn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pressTimer = setTimeout(() => {
      pressTimer = 'fired';
      api.historyMenu(dir);
    }, 450);
  });
  btn.addEventListener('mouseup', () => {
    if (pressTimer !== 'fired') clearTimeout(pressTimer);
  });
  btn.addEventListener('mouseleave', () => {
    if (pressTimer !== 'fired') clearTimeout(pressTimer);
  });
  // a long press opens the list instead of navigating
  btn.addEventListener('click', (e) => {
    if (pressTimer === 'fired') e.stopImmediatePropagation();
    pressTimer = null;
  }, true);
}

$('zoom').addEventListener('click', () => api.resetZoom());
$('capture').addEventListener('click', () => api.stopCapture());

// ---- unfocused address bar: show "example.com/path" with the site highlighted

function renderAddressView() {
  const view = $('addrview');
  const omni = $('omnibox');
  let parsed = null;
  try {
    parsed = /^https?:\/\//i.test(shownUrl) ? new URL(shownUrl) : null;
  } catch {
    parsed = null;
  }
  const show = !!parsed && document.activeElement !== address;
  view.hidden = !show;
  omni.classList.toggle('formatted', show);
  if (!show) return;
  const host = parsed.host.replace(/^www\./, '');
  let rest = shownUrl.slice(shownUrl.indexOf(parsed.host) + parsed.host.length);
  if (rest === '/') rest = '';
  view.textContent = '';
  view.append(el('span', 'host', host), el('span', 'rest', rest));
}
address.addEventListener('focus', renderAddressView);
address.addEventListener('blur', renderAddressView);

// ---- downloads panel

function sizeText(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function renderDownloadPanel() {
  const items = await api.recentDownloads();
  const panel = $('dlpanel');
  panel.textContent = '';
  if (items.length === 0) panel.append(el('div', 'empty', 'No downloads yet.'));
  for (const d of items) {
    const row = el('div', 'dl');
    const main = el('div', 'main');
    main.append(el('div', 'nm', d.filename));
    const action = (label, name) => {
      const b = el('button', '', label);
      b.addEventListener('click', async () => {
        await api.downloadAction(d.id, name);
        renderDownloadPanel();
      });
      return b;
    };
    if (d.state === 'progressing') {
      const pct = d.total ? Math.floor((d.received / d.total) * 100) : null;
      main.append(el('div', 'st', `${sizeText(d.received)}${d.total ? ` of ${sizeText(d.total)}` : ''}`));
      const bar = el('div', 'bar');
      const fill = document.createElement('span');
      fill.style.width = `${pct ?? 30}%`;
      bar.append(fill);
      main.append(bar);
      row.append(main, action('Cancel', 'cancel'));
    } else if (d.state === 'dangerous') {
      main.append(el('div', 'st bad', 'Can harm your computer'));
      row.append(main, action('Keep', 'keep'), action('Discard', 'discard'));
    } else if (d.state === 'completed') {
      main.append(el('div', 'st', sizeText(d.received)));
      row.append(main, action('Open', 'open'), action('Show', 'show'));
    } else {
      main.append(el('div', 'st', d.discarded ? 'Discarded' : d.state === 'cancelled' ? 'Cancelled' : 'Failed'));
      row.append(main);
    }
    panel.append(row);
  }
  const foot = el('div', 'foot');
  const all = el('button', 'all', 'Show all downloads');
  all.addEventListener('click', () => {
    closeDownloadPanel();
    api.openDownloads();
  });
  foot.append(all);
  panel.append(foot);
}

function closeDownloadPanel() {
  $('dlpanel').hidden = true;
  $('backdrop').hidden = $('sitepopup').hidden;
  setOverlay();
}

$('downloads').addEventListener('click', async () => {
  if (!$('dlpanel').hidden) return closeDownloadPanel();
  await renderDownloadPanel();
  $('dlpanel').hidden = false;
  $('backdrop').hidden = false;
  setOverlay();
});
$('backdrop').addEventListener('mousedown', () => {
  if (!$('dlpanel').hidden) closeDownloadPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('dlpanel').hidden) closeDownloadPanel();
});
api.onDownloadStarted(() => {
  const b = $('downloads');
  b.classList.remove('pulse');
  void b.offsetWidth; // restart the animation
  b.classList.add('pulse');
});

// ---- bookmarks bar

let bmDragId = null;
let lastBarJson = '';

function renderBookmarkBar(items) {
  const bar = $('bmbar');
  bar.hidden = !items;
  if (!items) return;
  const json = JSON.stringify(items);
  if (json === lastBarJson) return; // don't rebuild under the cursor on every tab update
  lastBarJson = json;
  bar.textContent = '';
  if (items.length === 0) {
    bar.append(el('span', 'hint', 'Bookmarks you add to the bookmarks bar appear here.'));
  }
  items.forEach((b, i) => {
    const item = el('button', 'bm');
    item.title = b.type === 'folder' ? b.title : `${b.title}\n${b.url}`;
    item.draggable = true;
    item.dataset.id = b.id;
    item.append(el('span', 'ic', b.type === 'folder' ? '▸' : '★'), el('span', '', b.title));
    item.addEventListener('mousedown', (e) => {
      if (e.button === 1 && b.type === 'bookmark') {
        e.preventDefault();
        api.openBookmark(b.id, 'background');
      }
    });
    item.addEventListener('click', (e) => {
      if (b.type === 'folder') return api.bookmarkFolderMenu(b.id);
      api.openBookmark(b.id, e.metaKey || e.ctrlKey ? 'background' : e.shiftKey ? 'window' : 'current');
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.bookmarkContextMenu(b.id);
    });
    // drag to reorder, or drop onto a folder's middle to move it inside
    item.addEventListener('dragstart', (e) => {
      bmDragId = b.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      bmDragId = null;
      for (const x of bar.querySelectorAll('.bm')) x.classList.remove('drop-before', 'drop-after', 'drop-into');
    });
    item.addEventListener('dragover', (e) => {
      if (!bmDragId || bmDragId === b.id) return;
      e.preventDefault();
      const r = e.offsetX / item.offsetWidth;
      const into = b.type === 'folder' && r > 0.25 && r < 0.75;
      item.classList.toggle('drop-into', into);
      item.classList.toggle('drop-before', !into && r <= 0.5);
      item.classList.toggle('drop-after', !into && r > 0.5);
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after', 'drop-into'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!bmDragId || bmDragId === b.id) return;
      if (item.classList.contains('drop-into')) api.moveBookmark(bmDragId, b.id);
      else api.moveBookmark(bmDragId, 'bar', i + (item.classList.contains('drop-after') ? 1 : 0));
    });
    bar.append(item);
  });
}
$('bmbar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.bookmarkContextMenu(null);
});

// ---- star / edit bookmark popup

let bmEditing = null;

function showBookmarkPopup(info) {
  if (!info) return;
  bmEditing = info;
  $('bm-heading').textContent = info.isNew ? 'Bookmark added' : info.type === 'folder' ? 'Edit folder' : 'Edit bookmark';
  $('bm-name').value = info.title;
  const select = $('bm-folder');
  select.textContent = '';
  for (const f of info.folders) select.append(new Option(' '.repeat(f.depth) + f.title, f.id));
  select.value = info.parentId || 'bar';
  $('bm-folder-row').hidden = !info.parentId;
  $('bm-remove').textContent = info.type === 'folder' ? 'Delete' : 'Remove';
  $('bmpopup').hidden = false;
  $('backdrop').hidden = false;
  setOverlay();
  $('bm-name').focus();
  $('bm-name').select();
}

function closeBookmarkPopup(save) {
  if (bmEditing && save) {
    api.updateBookmark(bmEditing.id, { title: $('bm-name').value, parentId: $('bm-folder').value });
  }
  bmEditing = null;
  $('bmpopup').hidden = true;
  $('backdrop').hidden = $('sitepopup').hidden && $('dlpanel').hidden;
  setOverlay();
}

api.onBookmarkEdit(showBookmarkPopup);
$('bmpopup').addEventListener('submit', (e) => {
  e.preventDefault();
  closeBookmarkPopup(true);
});
$('bm-remove').addEventListener('click', () => {
  if (bmEditing) api.removeBookmarkNode(bmEditing.id);
  closeBookmarkPopup(false);
});
$('backdrop').addEventListener('mousedown', () => {
  if (!$('bmpopup').hidden) closeBookmarkPopup(true); // clicking away keeps the changes, like other browsers
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('bmpopup').hidden) closeBookmarkPopup(false);
});

// ---- keyboard: arrows move between tabs, Enter/Space selects, Delete closes

tablist.addEventListener('keydown', (e) => {
  const tabs = [...tablist.querySelectorAll('.tab')];
  const i = tabs.indexOf(document.activeElement);
  if (i === -1) return;
  const id = Number(tabs[i].dataset.id);
  const move = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (move !== undefined) {
    e.preventDefault();
    tabs[(move + tabs.length) % tabs.length].focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    api.selectTab(id);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    api.closeTab(id);
  }
});

// F6 from the address bar goes to the page (the menu shortcut handles page -> address bar)
document.addEventListener('keydown', (e) => {
  if (e.key === 'F6') {
    e.preventDefault();
    api.focusPage();
  }
});

$('home').addEventListener('click', () => api.goHome());
$('restore-yes').addEventListener('click', () => api.restorePages());
$('restore-no').addEventListener('click', () => api.dismissRestore());

// Right-click in the address bar: edit menu with Paste and Go (built by the main process).
address.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.addressMenu();
});

// Dropping a link (or text) onto the tab strip opens it in a new tab.
$('tabstrip').addEventListener('dragover', (e) => {
  if (dragId !== null) return; // reordering tabs is handled per tab
  if ([...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) e.preventDefault();
});
$('tabstrip').addEventListener('drop', (e) => {
  if (dragId !== null) return;
  const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
  if (!text) return;
  e.preventDefault();
  api.openInNewTab(text);
});
