'use strict';

const api = window.browserAPI;
const $ = (id) => document.getElementById(id);
const tablist = $('tablist');
const address = $('address');

// The tab strip doubles as the title bar: room for the macOS traffic lights / Windows buttons.
document.body.classList.add(navigator.platform.startsWith('Mac') ? 'mac' : navigator.platform.startsWith('Win') ? 'win' : 'linux');
api.onWindowFullscreen((on) => document.body.classList.toggle('fullscreen', !!on));

const SPEAKER =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a5 5 0 0 1 0 7"/></svg>';
const SPEAKER_MUTED =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6M21 9l-5 6"/></svg>';

let dragId = null;
const TAB_DRAG_TYPE = 'application/x-operecs-tab';

// Stroke icons for the address bar suggestions (same family as the toolbar's).
const icon = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  go: icon('<path d="M7 17L17 7M9 7h8v8"/>'),
  search: icon('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  tab: icon('<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M3.5 9.5h17"/>'),
  star: icon('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),
  history: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  answer: icon('<path d="M5 9h14M5 15h14"/>'),
  command: icon('<polyline points="7 8 11 12 7 16"/><path d="M13 16h4"/>'),
};

let previewTimer = null;
let renamingGroupId = null;

function hideTabPreview() {
  clearTimeout(previewTimer);
  previewTimer = null;
  const box = $('tabpreview');
  if (box && !box.hidden) {
    box.hidden = true;
    setOverlay();
  }
}

function scheduleTabPreview(tabEl, tabId) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!tabEl.isConnected) return;
    const info = await api.tabPreview(tabId);
    if (!info || !tabEl.matches(':hover')) return;
    const box = $('tabpreview');
    const img = $('tp-img');
    if (info.image) {
      img.src = info.image;
      img.hidden = false;
    } else {
      img.hidden = true;
    }
    $('tp-title').textContent = info.title || 'New Tab';
    let domain = info.url || '';
    try {
      if (/^https?:\/\//i.test(domain)) domain = new URL(domain).hostname.replace(/^www\./, '');
    } catch {}
    $('tp-domain').textContent = domain + (info.sleeping ? ' · Sleeping' : '');
    const r = tabEl.getBoundingClientRect();
    if (document.body.classList.contains('vertical')) {
      box.style.left = `${Math.round(r.right + 8)}px`;
      box.style.top = `${Math.max(8, Math.min(innerHeight - 190, Math.round(r.top)))}px`;
    } else {
      box.style.top = `${Math.round(r.bottom + 6)}px`;
      box.style.left = `${Math.max(8, Math.min(innerWidth - 232, Math.round(r.left)))}px`;
    }
    box.hidden = false;
    setOverlay();
  }, 350);
}

document.addEventListener('mousemove', (e) => {
  if (!$('tabpreview').hidden && !e.target.closest('.tab')) hideTabPreview();
});

function renderGroupHeader(g) {
  const chip = document.createElement('div');
  chip.className = 'tab-group' + (g.collapsed ? ' collapsed' : '');
  chip.style.setProperty('--group-color', g.color || '#9b6cff');
  chip.dataset.groupId = g.id;
  const dot = document.createElement('span');
  dot.className = 'dot';
  chip.append(dot);
  if (renamingGroupId === g.id) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = g.name || '';
    input.placeholder = 'Group name';
    const commit = () => {
      if (renamingGroupId !== g.id) return;
      renamingGroupId = null;
      api.updateGroup(g.id, { name: input.value.trim() || 'Group' });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') {
        renamingGroupId = null;
        api.updateGroup(g.id, {});
      }
    });
    input.addEventListener('blur', commit);
    chip.append(input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else {
    const label = document.createElement('span');
    label.textContent = g.name || 'Group';
    chip.append(label);
  }
  chip.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    api.toggleGroup(g.id);
  });
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.groupMenu(g.id);
  });
  return chip;
}

api.onGroupRename((groupId) => {
  renamingGroupId = groupId;
  const chip = tablist.querySelector(`.tab-group[data-group-id="${groupId}"]`);
  if (!chip) return;
  const currentName = chip.querySelector('span:not(.dot)')?.textContent || '';
  const merged = renderGroupHeader({
    id: groupId,
    name: currentName,
    color: chip.style.getPropertyValue('--group-color') || '#9b6cff',
    collapsed: chip.classList.contains('collapsed'),
  });
  chip.replaceWith(merged);
});

function renderPageFrames(frames) {
  const container = $('page-frames');
  if (!container) return;
  container.textContent = '';
  if (!frames || !frames.length) return;
  for (const f of frames) {
    const el = document.createElement('div');
    el.className = 'page-frame';
    el.style.left = `${f.x}px`;
    el.style.top = `${f.y}px`;
    el.style.width = `${f.width}px`;
    el.style.height = `${f.height}px`;
    container.append(el);
  }
}
if (api.onPageFrames) api.onPageFrames(renderPageFrames);

function renderTab(t, isActive, groupColor) {
  const el = document.createElement('div');
  el.className =
    'tab' +
    (isActive ? ' active' : '') +
    (t.pinned ? ' pinned' : '') +
    (t.sleeping ? ' sleeping' : '') +
    (t.multi ? ' multi' : '') +
    (t.split ? ' split' : '') +
    (t.groupId ? ' grouped' : '');
  if (groupColor) el.style.setProperty('--group-color', groupColor);
  el.setAttribute('role', 'tab');
  el.setAttribute('aria-selected', String(isActive || !!t.multi));
  el.tabIndex = isActive ? 0 : -1;
  el.setAttribute('aria-label', t.title + (t.audible ? ', playing audio' : '') + (t.muted ? ', muted' : ''));
  el.draggable = true;

  const makeLetter = () => {
    const dot = document.createElement('span');
    dot.className = 'letter';
    dot.textContent = (t.title || '?').trim().charAt(0).toUpperCase();
    return dot;
  };
  if (t.loading) {
    const s = document.createElement('div');
    s.className = 'spinner';
    el.append(s);
  } else if (t.favicon) {
    const img = document.createElement('img');
    img.src = t.favicon;
    img.onerror = () => img.replaceWith(makeLetter());
    el.append(img);
  } else {
    el.append(makeLetter());
  }

  if (!t.pinned) {
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    el.append(title);
  }

  if (t.split) {
    const badge = document.createElement('span');
    badge.className = 'split-badge';
    badge.textContent = 'SPLIT';
    badge.title = 'Side-by-side split view';
    el.append(badge);
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
    close.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.title = 'Close tab';
    close.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button === 0) api.closeTab(t.id);
    });
    el.append(close);
  }

  el.addEventListener('mouseenter', () => scheduleTabPreview(el, t.id));
  el.addEventListener('mouseleave', () => hideTabPreview());

  el.addEventListener('mousedown', (e) => {
    hideTabPreview();
    if (e.button === 1) {
      e.preventDefault();
      api.closeTab(t.id);
    } else if (e.button === 0) {
      // Cmd (Mac) / Ctrl-click adds or removes a tab from the selection; Shift-click selects a range
      api.selectTab(t.id, { toggle: navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey, range: e.shiftKey });
    }
  });
  el.addEventListener('contextmenu', (e) => {
    hideTabPreview();
    e.preventDefault();
    api.tabMenu(t.id);
  });

  // Drag to reorder: drop before or after a tab depending on which half the cursor is over.
  el.addEventListener('dragstart', (e) => {
    hideTabPreview();
    dragId = t.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(TAB_DRAG_TYPE, String(t.id)); // lets another Operecs window take it
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', (e) => {
    // dropped where nothing took it (outside the tab strip): open the tab in a new window
    if (e.dataTransfer.dropEffect === 'none') api.tearOffTab(t.id);
    dragId = null;
    el.classList.remove('dragging');
    for (const x of tablist.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('dragover', (e) => {
    const isVert = document.body.classList.contains('vertical');
    if (dragId === null && [...e.dataTransfer.types].includes(TAB_DRAG_TYPE)) {
      // a tab from another window
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = isVert ? e.offsetY > el.offsetHeight / 2 : e.offsetX > el.offsetWidth / 2;
      el.classList.toggle('drop-after', after);
      el.classList.toggle('drop-before', !after);
      return;
    }
    if (dragId === null || dragId === t.id) return;
    e.preventDefault();
    const after = isVert ? e.offsetY > el.offsetHeight / 2 : e.offsetX > el.offsetWidth / 2;
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const tabEls = [...tablist.querySelectorAll('.tab')];
    if (dragId === null && [...e.dataTransfer.types].includes(TAB_DRAG_TYPE)) {
      const index = tabEls.indexOf(el) + (el.classList.contains('drop-after') ? 1 : 0);
      el.classList.remove('drop-before', 'drop-after');
      api.adoptTab(e.dataTransfer.getData(TAB_DRAG_TYPE), index);
      return;
    }
    if (dragId === null || dragId === t.id) return;
    const ids = tabEls.map((x) => Number(x.dataset.id));
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
  const tb = (state.uiPrefs && state.uiPrefs.toolbarButtons) || {};
  if (state.uiPrefs) {
    document.documentElement.dataset.accent = state.uiPrefs.accentColor || 'violet';
    document.body.classList.toggle('compact', !!state.uiPrefs.compactMode);
    document.body.classList.toggle('compact-toolbar', !!(state.uiPrefs.compactToolbar || state.uiPrefs.compactMode));
    isBookmarksHoverMode = !!state.uiPrefs.bookmarksBarHover;
    document.body.classList.toggle('bmbar-hover-mode', isBookmarksHoverMode);
    if (!isBookmarksHoverMode) {
      isBookmarksCurrentlyHovered = false;
      document.body.classList.remove('bmbar-hovered');
    }
    const vert = !!state.uiPrefs.verticalTabs;
    const collapsed = vert && !!state.uiPrefs.verticalTabsCollapsed;
    const expandHover = state.uiPrefs.verticalTabsExpandOnHover !== false;
    const newtabUnder = state.uiPrefs.verticalNewTabUnderTabs !== false;
    document.body.classList.toggle('vertical', vert);
    document.body.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('expand-on-hover', expandHover);
    document.body.classList.toggle('newtab-under', newtabUnder);
    if (!collapsed || !expandHover) {
      document.body.classList.remove('sidebar-hover');
      setOverlay();
    }
    const toggleBtn = $('sidebar-toggle');
    if (toggleBtn) {
      toggleBtn.title = collapsed ? 'Expand vertical tabs' : 'Collapse vertical tabs to icons';
      toggleBtn.ariaLabel = toggleBtn.title;
    }
  }
  if (state.pageFrames) renderPageFrames(state.pageFrames);
  // extension buttons follow the active tab; private windows have no extensions
  const ext = $('extensions');
  ext.hidden = state.private;
  if (state.activeWebContentsId && ext.getAttribute('tab') !== String(state.activeWebContentsId)) {
    ext.setAttribute('tab', String(state.activeWebContentsId));
  }
  hideExtensionButtons(state.hiddenActions || []);
  $('private-badge').hidden = !state.private;

  const shield = state.shield;
  $('shield').hidden = !shield.available || tb.shield === false;
  $('shield').classList.toggle('off', !shield.on);
  $('shield-count').textContent = shield.on && shield.blocked ? String(shield.blocked) : '';
  $('shield').title = $('shield').ariaLabel = shield.on
    ? `Blocked ${shield.blocked} ads and trackers on ${shield.site}. Click for details.`
    : `Ad blocking is off for ${shield.site}. Click for details.`;

  const focusedTab = tablist.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  tablist.textContent = '';
  const groupsById = new Map((state.groups || []).map((g) => [g.id, g]));
  const renderedGroups = new Set();
  for (const t of state.tabs) {
    const g = t.groupId ? groupsById.get(t.groupId) : null;
    if (g && !renderedGroups.has(g.id)) {
      renderedGroups.add(g.id);
      tablist.append(renderGroupHeader(g));
    }
    if (g && g.collapsed && t.id !== state.activeId && t.id !== state.splitId) continue;
    tablist.append(renderTab(t, t.id === state.activeId, g ? g.color : null));
  }
  if (focusedTab) tablist.querySelector(`.tab[data-id="${focusedTab}"]`)?.focus(); // keep keyboard focus across re-renders
  const activeEl = tablist.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  $('back').disabled = !active || !active.canGoBack;
  $('forward').disabled = !active || !active.canGoForward;
  $('reload').classList.toggle('loading', !!(active && active.loading));
  $('reload').title = active && active.loading ? 'Stop' : 'Reload';
  lastMedia = state.media || [];
  $('media').hidden = lastMedia.length === 0 || tb.media === false;
  $('media').classList.toggle('on', lastMedia.some((m) => m.playing));
  if (!$('sitepopup').hidden && $('sitepopup').classList.contains('media')) renderMediaPopup();
  if (state.profile) {
    $('profile-initial').textContent = state.profile.initial;
    $('profile').style.setProperty('--profile-color', state.profile.color);
    $('profile').title = `Profile: ${state.profile.name}`;
    $('profile').ariaLabel = `Profile ${state.profile.name}. Switch or add profiles`;
  }
  $('reader').hidden = !state.reader || !tb.reader;
  $('reader').classList.toggle('on', state.reader === 'on');
  $('reader').title = state.reader === 'on' ? 'Leave reader mode' : 'Reader mode';
  $('star').hidden = tb.star === false;
  $('star').disabled = !state.canBookmark;
  $('star').classList.toggle('on', state.bookmarked);
  $('split-btn').hidden = !tb.split;
  $('split-btn').classList.toggle('on', !!state.splitId);
  $('screenshot-btn').hidden = !tb.screenshot;
  $('translate-btn').hidden = !tb.translate;
  $('readaloud-btn').hidden = !tb.readAloud;
  $('bookmarks-btn').hidden = !tb.bookmarks;
  $('history-btn').hidden = !tb.history;
  $('downloads').hidden = tb.downloads === false;
  $('profile').hidden = tb.profile === false;
  $('settings-btn').hidden = tb.settings === false;

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
  $('home').hidden = !(tb.home !== undefined ? tb.home : state.showHome);

  currentWarning = state.downloadWarning;
  $('dlwarn').hidden = !currentWarning;
  $('dlwarn-text').textContent = currentWarning
    ? `“${currentWarning.filename}” can harm your computer if it isn't from a source you trust. Keep it?`
    : '';

  currentPrompt = state.prompt;
  $('prompt').hidden = !currentPrompt;
  $('prompt-text').textContent = currentPrompt ? currentPrompt.text : '';
  $('prompt-allow').textContent = (currentPrompt && currentPrompt.allowLabel) || 'Allow';
  $('prompt-block').textContent = (currentPrompt && currentPrompt.blockLabel) || 'Block';

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
    authText.append(`Sign in to ${auth.proxy ? 'proxy ' : ''}${auth.host}${auth.realm ? ` (“${auth.realm}”)` : ''}`);
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
    ? `Downloading Operecs ${update.version}`
    : update.version ? `Operecs ${update.version} is ready. Restart to finish updating.` : '';
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
$('shield').addEventListener('mousedown', (e) => e.preventDefault());
$('shield').addEventListener('click', () => ($('sitepopup').hidden ? openShieldPopup() : closeSitePopup()));

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

let ignoreSidebarHoverUntilLeave = false;
$('sidebar-toggle').addEventListener('click', () => {
  if (!document.body.classList.contains('collapsed')) ignoreSidebarHoverUntilLeave = true;
  document.body.classList.remove('sidebar-hover');
  setOverlay();
  hideTabPreview();
  api.toggleSidebarCollapse();
});
$('tabstrip').addEventListener('mouseenter', () => {
  if (ignoreSidebarHoverUntilLeave) return;
  if (
    document.body.classList.contains('vertical') &&
    document.body.classList.contains('collapsed') &&
    document.body.classList.contains('expand-on-hover')
  ) {
    document.body.classList.add('sidebar-hover');
    setOverlay();
  }
});
$('tabstrip').addEventListener('mouseleave', () => {
  ignoreSidebarHoverUntilLeave = false;
  if (document.body.classList.contains('sidebar-hover') && !renamingGroupId) {
    document.body.classList.remove('sidebar-hover');
    hideTabPreview();
    setOverlay();
  }
});
$('tabstrip').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.tab, .tab-group, #workspace')) return;
  e.preventDefault();
  api.tabstripMenu();
});

$('newtab').addEventListener('click', () => api.newTab());
$('back').addEventListener('click', () => api.back());
$('forward').addEventListener('click', () => api.forward());
$('reload').addEventListener('click', () => api.reload());
$('star').addEventListener('click', () => api.starPage());
$('reader').addEventListener('click', () => api.toggleReader());
$('split-btn').addEventListener('click', () => api.toggleSplit());
$('screenshot-btn').addEventListener('click', () => api.takeScreenshot('ask'));
$('translate-btn').addEventListener('click', () => api.translatePage());
$('readaloud-btn').addEventListener('click', () => api.readAloud());
$('bookmarks-btn').addEventListener('click', () => api.openPage('bookmarks'));
$('history-btn').addEventListener('click', () => api.openPage('history'));
$('settings-btn').addEventListener('click', () => api.openPage('settings'));
$('toolbar').addEventListener('contextmenu', (e) => {
  if (e.target.closest('#omnibox, #back, #forward, browser-action-list')) return;
  e.preventDefault();
  api.toolbarMenu();
});

// ---- overlay: the toolbar view stretches over the page while a dropdown or popup is open

let overlayOpen = false;
function setOverlay() {
  const open =
    document.body.classList.contains('sidebar-hover') ||
    document.body.classList.contains('bmbar-hovered') ||
    ['suggest', 'sitepopup', 'screenpicker', 'devicepicker', 'dlpanel', 'bmpopup', 'tabpreview'].some((id) => !$(id).hidden);
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
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === selected));
    const icon = document.createElement('span');
    icon.className = 'ic';
    const title = document.createElement('span');
    title.className = 'tt';
    const url = document.createElement('span');
    url.className = 'uu';
    if (r.kind === 'typed') {
      const go = looksLikeAddress(r.text);
      icon.innerHTML = go ? ICONS.go : ICONS.search;
      title.textContent = go ? r.text : `${r.text}`;
      url.textContent = go ? '' : `— Search ${engine}`;
      url.style.color = 'var(--fg-dim)';
    } else if (r.kind === 'search') {
      icon.innerHTML = ICONS.search;
      title.textContent = r.text;
    } else if (r.kind === 'answer') {
      icon.innerHTML = ICONS.answer;
      title.textContent = r.title;
      url.textContent = `\u2014 Copy`;
      url.style.color = 'var(--fg-dim)';
    } else if (r.kind === 'command') {
      icon.innerHTML = ICONS.command;
      title.textContent = r.label;
      url.textContent = `\u2014 Operecs`;
      url.style.color = 'var(--fg-dim)';
    } else if (r.kind === 'tab') {
      icon.innerHTML = ICONS.tab;
      title.textContent = r.title;
      url.textContent = `\u2014 Switch to tab`;
      url.style.color = 'var(--fg-dim)';
    } else {
      icon.innerHTML = r.bookmarked ? ICONS.star : ICONS.history;
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
    ...(res.answer ? [res.answer] : []),
    ...(res.command ? [{ kind: 'command', id: res.command.id, label: res.command.label, text }] : []),
    ...(res.tabs || []).map((t) => ({ kind: 'tab', ...t })),
    ...res.items.map((p) => ({ kind: 'page', ...p })),
  ];
  // don't list the inline-completed page twice
  rows = rows.filter((r, i) => i === 0 || !sameAddress(r.url, rows[0].text));
  selected = 0;
  renderSuggest(res.engine);

  // Search engine suggestions arrive later (when turned on); add them below the typed row.
  if (looksLikeAddress(text.trim())) return;
  const extra = await api.suggestSearch(text);
  if (seq !== suggestSeq || document.activeElement !== address || !extra.length) return;
  const have = new Set(rows.map((r) => (r.text || '').toLowerCase()));
  const searches = extra.filter((q) => !have.has(q.toLowerCase())).map((q) => ({ kind: 'search', text: q }));
  rows.splice(1, 0, ...searches);
  if (selected > 0) selected += searches.length;
  renderSuggest(res.engine);
}

const bare = (u) => String(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();
const sameAddress = (url, text) => bare(url) === bare(text);

function navigate(row) {
  if (row.kind === 'tab') api.switchToTab(row.tabId);
  else if (row.kind === 'command') api.runCommand(row.id);
  else if (row.kind === 'answer') {
    navigator.clipboard?.writeText(row.text).catch(() => {});
    address.value = row.text;
    typed = row.text;
    closeSuggest();
    return;
  } else if (row.kind === 'search') api.search(row.text);
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
    if (open && rows[selected] && rows[selected].kind !== 'typed' && !(rows[selected].kind === 'search' && address.value !== rows[selected].text)) navigate(rows[selected]);
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
  const show = security === 'secure' || security === 'mixed' || security === 'insecure' || security === 'internal';
  btn.hidden = !show;
  omni.classList.toggle('has-site', show);
  omni.classList.toggle('insecure', security === 'insecure');
  btn.classList.toggle('insecure', security === 'insecure');
  btn.classList.toggle('mixed', security === 'mixed');
  if (security === 'secure') {
    btn.innerHTML = LOCK;
    btn.title = 'Connection is secure. Click for site settings.';
  } else if (security === 'mixed') {
    btn.innerHTML = INFO;
    btn.title = 'Parts of this page are not secure. Click for details.';
  } else if (security === 'insecure') {
    btn.innerHTML = INFO + '<span>Not secure</span>';
    btn.title = 'Connection is not secure. Click for site settings.';
  } else if (security === 'internal') {
    btn.innerHTML = INFO;
    btn.title = 'Operecs page';
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
  pop.classList.remove('right', 'media');
  if (info.kind !== 'web') {
    pop.append(el('h3', '', info.title), el('div', 'line', "This is one of the browser's own pages."));
  } else {
    pop.append(el('h3', '', info.host));
    if (info.secure) {
      const cert = info.certificate;
      pop.append(el('div', cert && !cert.ok ? 'line bad' : 'line', cert && !cert.ok ? 'Certificate problem' : 'Connection is secure'));
      if (info.mixedContent) pop.append(el('div', 'line bad', 'Parts of this page (such as images or media) were loaded without encryption, so others on your network could see or change them.'));
      if (cert) {
        pop.append(
          el('div', 'line', `Certificate issued by ${cert.issuer}`),
          el('div', 'line', `Valid until ${new Date(cert.validExpiry).toLocaleDateString()}`),
        );
        if (cert.details) pop.append(certificateSection(cert));
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

    const tools = el('div', 'sec');
    tools.append(el('div', 'sec-title', 'Page tools'));
    const grid = el('div', 'actions-grid');
    const addTool = (label, fn) => {
      const b = el('button', 'btn', label);
      b.addEventListener('click', () => {
        closeSitePopup();
        fn();
      });
      grid.append(b);
    };
    addTool('Translate', () => api.translatePage());
    addTool('Read aloud', () => api.readAloud());
    addTool('Screenshot', () => api.takeScreenshot('visible'));
    addTool('Install as app', () => api.installSiteAsApp());
    if (info.qr) {
      const qrBtn = el('button', 'btn', 'QR code');
      const qrBox = el('div', 'qr-box');
      qrBox.hidden = true;
      qrBox.innerHTML = info.qr;
      qrBtn.addEventListener('click', () => {
        qrBox.hidden = !qrBox.hidden;
      });
      grid.append(qrBtn);
      tools.append(grid, qrBox);
    } else {
      tools.append(grid);
    }
    pop.append(tools);

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
  anchorPopup(pop, $('site'));
  pop.hidden = false;
  $('backdrop').hidden = false;
  setOverlay();
}

// "sha256/<base64>" -> "AB:CD:…", the way certificate viewers show it
function hexFingerprint(fp) {
  try {
    return [...atob(String(fp).replace(/^sha256\//, ''))].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(':').toUpperCase();
  } catch {
    return String(fp || '');
  }
}

// Site popup: the full certificate, shown on request.
function certificateSection(cert) {
  const d = cert.details;
  const box = el('div', 'sec cert');
  const toggle = el('button', 'linkish', 'Show certificate');
  const body = el('div', 'cert-body');
  body.hidden = true;
  const name = (n) => (n ? [n.commonName, ...(n.organizations || [])].filter(Boolean).join(', ') : '');
  const fmt = (t) => new Date(t).toLocaleString();
  const rows = [
    ['Issued to', name(d.subject) || cert.subject],
    ['Issued by', name(d.issuer) || cert.issuer],
    ['Valid from', fmt(cert.validStart)],
    ['Valid until', fmt(cert.validExpiry)],
    ['Check', cert.ok ? 'Trusted' : cert.verification || 'Not trusted'],
    ['Chain', d.chain.length ? d.chain.join(' \u2192 ') : '(none sent)'],
    ['Serial number', d.serialNumber],
    ['SHA-256 fingerprint', hexFingerprint(d.fingerprint)],
  ];
  for (const [k, v] of rows) {
    const row = el('div', 'cert-row');
    row.append(el('div', 'k', k), el('div', 'v', v || '\u2014'));
    body.append(row);
  }
  const exp = el('button', 'btn', 'Export…');
  exp.addEventListener('click', () => api.exportCertificate());
  body.append(exp);
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? 'Show certificate' : 'Hide certificate';
  });
  box.append(toggle, body);
  return box;
}

// Extension buttons the user chose to hide (Extensions page). The list element's shadow root is
// open; its buttons carry the extension id.
function hideExtensionButtons(ids) {
  const root = $('extensions').shadowRoot;
  if (!root) return;
  let style = root.getElementById('operecs-hidden');
  if (!style) {
    style = document.createElement('style');
    style.id = 'operecs-hidden';
    root.append(style);
  }
  const css = ids.filter((id) => /^[a-p]{32}$/.test(id)).map((id) => `#${id}`).join(', ');
  style.textContent = css ? `${css} { display: none !important; }` : '';
}

// Popups open under the button that opened them, on whichever side it is (the toolbar is
// mirrored in right-to-left languages).
function anchorPopup(pop, button) {
  const r = button && button.getBoundingClientRect();
  if (!r || !r.width) return;
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  if (r.left + r.width / 2 > innerWidth / 2) {
    pop.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
    pop.style.left = 'auto';
  } else {
    pop.style.left = `${Math.max(8, Math.round(r.left))}px`;
    pop.style.right = 'auto';
  }
}

// Media hub: every tab playing (or paused) audio/video, with play/pause and a jump to the tab.
let lastMedia = [];
const PLAY = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
const PIP = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/></svg>';
function renderMediaPopup() {
  const pop = $('sitepopup');
  pop.textContent = '';
  pop.append(el('div', 'sec-title', 'Playing'));
  if (!lastMedia.length) pop.append(el('div', 'line', 'Nothing is playing.'));
  for (const m of lastMedia) {
    const row = el('div', 'media-row');
    const info = el('button', 'media-info');
    info.title = 'Go to this tab';
    info.append(el('span', 'media-title', m.title), el('span', 'media-site', m.site + (m.current ? ' \u00b7 this tab' : '')));
    info.addEventListener('click', () => {
      api.switchToTab(m.id);
      closeSitePopup();
    });
    const pip = el('button', 'media-btn');
    pip.innerHTML = PIP;
    pip.title = 'Picture in Picture';
    pip.addEventListener('click', () => api.togglePip(m.id));
    const btn = el('button', 'media-btn');
    btn.innerHTML = m.playing ? PAUSE : PLAY;
    btn.title = m.playing ? 'Pause' : 'Play';
    btn.addEventListener('click', () => api.toggleMedia(m.id));
    row.append(info, pip, btn);
    pop.append(row);
  }
}
function openMediaPopup() {
  const pop = $('sitepopup');
  pop.classList.add('right', 'media');
  renderMediaPopup();
  anchorPopup(pop, $('media'));
  pop.hidden = false;
  $('backdrop').hidden = false;
  setOverlay();
}
$('media').addEventListener('mousedown', (e) => e.preventDefault());
$('media').addEventListener('click', () => ($('sitepopup').hidden ? openMediaPopup() : closeSitePopup()));

// Shield: what was blocked on this page, and the switch for the site.
async function openShieldPopup() {
  const info = await api.adblockDetails();
  if (!info) return;
  const pop = $('sitepopup');
  pop.textContent = '';
  pop.classList.add('right');
  pop.classList.remove('media');
  pop.append(el('h3', '', info.site));
  if (!info.available) {
    pop.append(el('div', 'line', 'Ad and tracker blocking is turned off in Settings.'));
  } else {
    pop.append(el('div', 'line', info.on ? `Blocked ${info.blocked} ad and tracker request${info.blocked === 1 ? '' : 's'} on this page` : 'Blocking is off for this site'));
    if (info.on && info.hosts.length) {
      const list = el('div', 'sec blocked-list');
      list.append(el('div', 'sec-title', 'Blocked from'));
      for (const [host, count] of info.hosts) {
        const row = el('div', 'perm');
        row.append(el('span', 'host', host), el('span', 'count', String(count)));
        list.append(row);
      }
      if (info.more) list.append(el('div', 'note', `and ${info.more} more`));
      pop.append(list);
    }
    const sec = el('div', 'sec');
    const btn = el('button', 'btn', info.on ? `Turn off for ${info.site}` : `Turn on for ${info.site}`);
    btn.addEventListener('click', () => {
      api.toggleSiteBlocking();
      closeSitePopup();
    });
    sec.append(btn, el('div', 'note', info.on ? 'Turn off if the site doesn\u2019t work right. The page reloads.' : 'The page reloads.'));
    pop.append(sec);
  }
  anchorPopup(pop, $('shield'));
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
    item.append(el('div', 'nm', s.kind === 'screen' ? `Screen: ${s.name}` : s.kind === 'tab' ? `Tab: ${s.name}` : s.name));
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
  anchorPopup($('dlpanel'), $('downloads'));
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
let isBookmarksHoverMode = false;
let isBookmarksCurrentlyHovered = false;
let bmHoverLeaveTimer = null;
let isBookmarkMenuOpen = false;
let overflowBookmarkIds = [];

function triggerBookmarksHover(hovered) {
  if (!isBookmarksHoverMode) return;
  clearTimeout(bmHoverLeaveTimer);
  if (hovered) {
    if (!isBookmarksCurrentlyHovered) {
      isBookmarksCurrentlyHovered = true;
      document.body.classList.add('bmbar-hovered');
      setOverlay();
    }
  } else {
    if (isBookmarkMenuOpen) return;
    bmHoverLeaveTimer = setTimeout(() => {
      if (isBookmarkMenuOpen) return;
      isBookmarksCurrentlyHovered = false;
      document.body.classList.remove('bmbar-hovered');
      setTimeout(() => {
        if (!isBookmarksCurrentlyHovered) setOverlay();
      }, 180);
    }, 280);
  }
}

function updateBookmarkOverflow() {
  const bar = $('bmbar');
  const itemsWrap = $('bmbar-items');
  const overflowBtn = $('bmbar-overflow');
  if (!bar || bar.hidden || !itemsWrap) return;

  const itemEls = Array.from(itemsWrap.children).filter((el) => el.classList.contains('bm'));
  if (itemEls.length === 0) {
    if (overflowBtn) overflowBtn.hidden = true;
    overflowBookmarkIds = [];
    return;
  }

  // Restore visibility to measure true widths
  for (const el of itemEls) el.style.display = '';
  if (overflowBtn) overflowBtn.hidden = true;

  const availWidth = bar.clientWidth - 16;
  const totalWidth = itemsWrap.scrollWidth;

  if (totalWidth <= availWidth) {
    if (overflowBtn) overflowBtn.hidden = true;
    overflowBookmarkIds = [];
    return;
  }

  if (overflowBtn) overflowBtn.hidden = false;
  const btnWidth = (overflowBtn && overflowBtn.offsetWidth) || 24;
  const maxW = availWidth - btnWidth - 4;

  let currentW = 0;
  let overflowing = false;
  const overflowIds = [];

  for (let i = 0; i < itemEls.length; i++) {
    const el = itemEls[i];
    const elW = el.offsetWidth + 2;
    if (!overflowing && currentW + elW <= maxW) {
      currentW += elW;
      el.style.display = '';
    } else {
      overflowing = true;
      el.style.display = 'none';
      if (el.dataset.id) overflowIds.push(el.dataset.id);
    }
  }

  overflowBookmarkIds = overflowIds;
  if (overflowBtn) overflowBtn.hidden = overflowIds.length === 0;
}

function renderBookmarkBar(items) {
  const bar = $('bmbar');
  const itemsWrap = $('bmbar-items') || bar;
  bar.hidden = !items;
  if (!items) return;
  const json = JSON.stringify(items);
  if (json === lastBarJson) {
    updateBookmarkOverflow();
    return; // don't rebuild under the cursor on every tab update
  }
  lastBarJson = json;
  itemsWrap.textContent = '';
  if (items.length === 0) {
    itemsWrap.append(el('span', 'hint', 'Bookmarks you add to the bookmarks bar appear here.'));
    if ($('bmbar-overflow')) $('bmbar-overflow').hidden = true;
    overflowBookmarkIds = [];
    return;
  }
  items.forEach((b, i) => {
    const item = el('button', 'bm');
    item.title = b.type === 'folder' ? b.title : `${b.title}\n${b.url}`;
    item.draggable = true;
    item.dataset.id = b.id;
    if (b.type !== 'folder' && b.icon && /^data:image\//.test(b.icon)) {
      const img = document.createElement('img');
      img.src = b.icon;
      img.width = img.height = 14;
      img.alt = '';
      item.append(img, el('span', '', b.title));
    } else {
      item.append(el('span', 'ic', b.type === 'folder' ? '▸' : '★'), el('span', '', b.title));
    }
    item.addEventListener('mousedown', (e) => {
      if (e.button === 1 && b.type === 'bookmark') {
        e.preventDefault();
        api.openBookmark(b.id, 'background');
      }
    });
    item.addEventListener('click', (e) => {
      if (b.type === 'folder') {
        isBookmarkMenuOpen = true;
        setTimeout(() => { isBookmarkMenuOpen = false; }, 1200);
        return api.bookmarkFolderMenu(b.id);
      }
      api.openBookmark(b.id, e.metaKey || e.ctrlKey ? 'background' : e.shiftKey ? 'window' : 'current');
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isBookmarkMenuOpen = true;
      api.bookmarkContextMenu(b.id);
      setTimeout(() => { isBookmarkMenuOpen = false; }, 1200);
    });
    // drag to reorder, or drop onto a folder's middle to move it inside
    item.addEventListener('dragstart', (e) => {
      bmDragId = b.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      bmDragId = null;
      for (const x of itemsWrap.querySelectorAll('.bm')) x.classList.remove('drop-before', 'drop-after', 'drop-into');
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
    itemsWrap.append(item);
  });
  updateBookmarkOverflow();
}

$('bmbar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  isBookmarkMenuOpen = true;
  api.bookmarkContextMenu(null);
  setTimeout(() => { isBookmarkMenuOpen = false; }, 1200);
});

$('bmbar-overflow')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!overflowBookmarkIds.length) return;
  const rect = $('bmbar-overflow').getBoundingClientRect();
  isBookmarkMenuOpen = true;
  api.bookmarkOverflowMenu(overflowBookmarkIds, {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    bottom: rect.bottom,
  });
  setTimeout(() => { isBookmarkMenuOpen = false; }, 1200);
});

if (window.ResizeObserver && $('bmbar')) {
  new ResizeObserver(() => requestAnimationFrame(updateBookmarkOverflow)).observe($('bmbar'));
}

$('toolbar').addEventListener('mouseenter', () => triggerBookmarksHover(true));
$('toolbar').addEventListener('mouseleave', (e) => {
  if (e.relatedTarget && ($('bmbar').contains(e.relatedTarget) || e.relatedTarget === $('bmbar') || $('tabstrip').contains(e.relatedTarget))) return;
  triggerBookmarksHover(false);
});

$('bmbar').addEventListener('mouseenter', () => triggerBookmarksHover(true));
$('bmbar').addEventListener('mouseleave', (e) => {
  if (e.relatedTarget && ($('toolbar').contains(e.relatedTarget) || e.relatedTarget === $('toolbar') || $('tabstrip').contains(e.relatedTarget))) return;
  triggerBookmarksHover(false);
});

$('tabstrip').addEventListener('mouseenter', () => {
  if (isBookmarksCurrentlyHovered) triggerBookmarksHover(true);
});
$('tabstrip').addEventListener('mouseleave', (e) => {
  if (e.relatedTarget && ($('toolbar').contains(e.relatedTarget) || $('bmbar').contains(e.relatedTarget))) return;
  if (isBookmarksCurrentlyHovered) triggerBookmarksHover(false);
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
  anchorPopup($('bmpopup'), $('star'));
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
  if (dragId !== null) {
    e.preventDefault(); // dropping on the strip's empty space isn't a tear-off
    return;
  }
  if ([...e.dataTransfer.types].includes(TAB_DRAG_TYPE)) {
    e.preventDefault(); // another window's tab: goes to the end
    e.dataTransfer.dropEffect = 'move';
    return;
  }
  if ([...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) e.preventDefault();
});
$('tabstrip').addEventListener('drop', (e) => {
  if (dragId !== null) return;
  if ([...e.dataTransfer.types].includes(TAB_DRAG_TYPE)) {
    e.preventDefault();
    if (!e.target.closest('.tab')) api.adoptTab(e.dataTransfer.getData(TAB_DRAG_TYPE), tablist.querySelectorAll('.tab').length);
    return;
  }
  const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
  if (!text) return;
  e.preventDefault();
  api.openInNewTab(text);
});

// ---- device chooser (WebHID / Serial / USB / Bluetooth)

let devicePick = null;
let deviceChoice = null;
function closeDevicePicker(deviceId) {
  if (devicePick) api.chooseDevice(devicePick.id, deviceId);
  devicePick = null;
  $('devicepicker').hidden = true;
  setOverlay();
}
api.onDevicePicker((pick) => {
  if (!pick) {
    devicePick = null;
    $('devicepicker').hidden = true;
    return setOverlay();
  }
  if (!devicePick || devicePick.id !== pick.id) deviceChoice = null;
  devicePick = pick;
  $('dp-title').textContent = pick.title;
  const list = $('dp-list');
  list.textContent = '';
  for (const d of pick.devices) {
    const item = el('button', 'dp-item' + (d.id === deviceChoice ? ' sel' : ''), d.name);
    item.setAttribute('role', 'option');
    item.addEventListener('click', () => {
      deviceChoice = d.id;
      for (const x of list.children) x.classList.toggle('sel', x === item);
      $('dp-connect').disabled = false;
    });
    item.addEventListener('dblclick', () => closeDevicePicker(d.id));
    list.append(item);
  }
  if (!pick.devices.some((d) => d.id === deviceChoice)) deviceChoice = null;
  $('dp-connect').disabled = !deviceChoice;
  $('dp-status').textContent = pick.devices.length ? (pick.scanning ? 'Still looking for devices\u2026' : '') : pick.scanning ? 'Looking for devices\u2026' : 'No compatible devices found.';
  $('devicepicker').hidden = false;
  setOverlay();
});
$('dp-cancel').addEventListener('click', () => closeDevicePicker(null));
$('dp-connect').addEventListener('click', () => deviceChoice && closeDevicePicker(deviceChoice));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && devicePick) closeDevicePicker(null);
});

$('profile').addEventListener('click', () => api.profileMenu());
