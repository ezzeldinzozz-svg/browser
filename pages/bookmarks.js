'use strict';

const list = document.getElementById('list');

async function load() {
  const items = await browserAPI.getBookmarks();
  list.textContent = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No bookmarks yet. Press the star in the toolbar to add one.';
    list.append(empty);
    return;
  }
  for (const b of items) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'main';
    const a = document.createElement('a');
    a.className = 't';
    a.style.display = 'block';
    a.href = b.url;
    a.textContent = b.title || b.url;
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = b.url;
    main.append(a, u);

    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await browserAPI.removeBookmark(b.url);
      load();
    });

    row.append(main, del);
    list.append(row);
  }
}
load();
