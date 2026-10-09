'use strict';

const list = document.getElementById('list');

function render(items) {
  list.textContent = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No extensions installed.';
    list.append(empty);
    return;
  }
  for (const e of items) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    main.className = 'main';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = `${e.name} ${e.version}`;
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = e.description;
    main.append(t, u);
    if (!e.enabled) t.classList.add('muted');
    const toggles = document.createElement('div');
    toggles.className = 'ext-toggles';
    const on = document.createElement('label');
    on.className = 'check';
    const onBox = document.createElement('input');
    onBox.type = 'checkbox';
    onBox.checked = e.enabled;
    onBox.addEventListener('change', async () => render(await browserAPI.setExtensionEnabled(e.id, onBox.checked)));
    on.append(onBox, ' On');
    toggles.append(on);
    if (e.enabled && e.hasAction) {
      const show = document.createElement('label');
      show.className = 'check';
      const showBox = document.createElement('input');
      showBox.type = 'checkbox';
      showBox.checked = !e.hidden;
      showBox.addEventListener('change', async () => render(await browserAPI.setExtensionHidden(e.id, !showBox.checked)));
      show.append(showBox, ' Show in toolbar');
      toggles.append(show);
    }
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (confirm(`Remove ${e.name}? Its data is deleted too.`)) render(await browserAPI.removeExtension(e.id));
    });
    row.append(main, toggles, remove);
    list.append(row);
  }
}

document.getElementById('store').addEventListener('click', () => browserAPI.openWebStore());
browserAPI.listExtensions().then(render);
// refresh when something changes elsewhere (e.g. an install from the web store), but not while
// the user is clicking a checkbox here
setInterval(async () => {
  if (!document.activeElement || document.activeElement === document.body) render(await browserAPI.listExtensions());
}, 3000);
