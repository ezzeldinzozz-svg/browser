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

  if (document.activeElement !== address) address.value = active ? active.url : '';

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

address.addEventListener('focus', () => address.select());
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    api.go(address.value);
    address.blur();
  } else if (e.key === 'Escape') {
    address.blur();
  }
});
// After blurring, restore the active tab's URL on the next update.
address.addEventListener('blur', () => {
  getSelection().removeAllRanges();
});
