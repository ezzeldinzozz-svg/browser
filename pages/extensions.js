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
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => render(await browserAPI.removeExtension(e.id)));
    row.append(main, remove);
    list.append(row);
  }
}

document.getElementById('store').addEventListener('click', () => browserAPI.openWebStore());
browserAPI.listExtensions().then(render);
setInterval(async () => render(await browserAPI.listExtensions()), 3000);
