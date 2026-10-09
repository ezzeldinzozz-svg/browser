'use strict';

const api = window.browserAPI;
const $ = (id) => document.getElementById(id);
const tablist = $('tablist');
const address = $('address');

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
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.activeId ? ' active' : '');
    el.title = t.title;

    if (t.loading) {
      const s = document.createElement('div');
      s.className = 'spinner';
      el.append(s);
    } else if (t.favicon) {
      const img = document.createElement('img');
      img.src = t.favicon;
      img.onerror = () => img.remove();
      el.append(img);
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button === 0) api.closeTab(t.id);
    });

    el.append(title, close);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        api.closeTab(t.id);
      } else if (e.button === 0) {
        api.selectTab(t.id);
      }
    });
    tablist.append(el);
  }

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

  const update = state.update || {};
  $('update').hidden = update.status !== 'ready';
  $('update').title = update.version ? `Install Browser ${update.version}` : '';
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
