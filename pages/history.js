'use strict';

const list = document.getElementById('list');
const q = document.getElementById('q');
let items = [];

function render() {
  const term = q.value.trim().toLowerCase();
  const shown = items
    .filter((h) => !term || h.title.toLowerCase().includes(term) || h.url.toLowerCase().includes(term))
    .slice(0, 500);

  list.textContent = '';
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = items.length ? 'No matches.' : 'No history yet.';
    list.append(empty);
    return;
  }
  for (const h of shown) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'main';
    const a = document.createElement('a');
    a.className = 't';
    a.href = h.url;
    a.textContent = h.title || h.url;
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = h.url;
    main.append(a, u);

    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = new Date(h.time).toLocaleString();

    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.title = 'Remove this page from history';
    remove.addEventListener('click', async () => {
      await browserAPI.removeHistoryEntry(h.url);
      load();
    });

    row.append(main, time, remove);
    list.append(row);
  }
}

async function load() {
  items = await browserAPI.getHistory();
  render();
}

q.addEventListener('input', render);
document.getElementById('clear').addEventListener('click', async () => {
  await browserAPI.clearHistory();
  load();
});
load();
