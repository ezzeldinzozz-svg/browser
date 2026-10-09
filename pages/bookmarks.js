'use strict';

const $ = (id) => document.getElementById(id);
let tree = null;
let current = 'bar'; // folder being shown
let dragId = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function walk(fn) {
  const visit = (n, parent, depth) => {
    fn(n, parent, depth);
    if (n.type === 'folder') n.children.forEach((c) => visit(c, n, depth + 1));
  };
  visit(tree.bar, null, 0);
  visit(tree.other, null, 0);
}

function findNode(id) {
  let found = null;
  walk((n, parent) => {
    if (n.id === id) found = { node: n, parent };
  });
  return found;
}

function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

async function load() {
  tree = await browserAPI.getBookmarkTree();
  if (!findNode(current)) current = 'bar';
  renderFolders();
  renderList();
}

function renderFolders() {
  const nav = $('folders');
  nav.textContent = '';
  walk((n, _parent, depth) => {
    if (n.type !== 'folder') return;
    const item = el('button', 'folder' + (n.id === current ? ' sel' : ''), n.title);
    item.style.paddingLeft = `${10 + depth * 14}px`;
    item.addEventListener('click', () => {
      current = n.id;
      $('q').value = '';
      renderFolders();
      renderList();
    });
    // drop a bookmark or folder onto a folder in the sidebar to move it there
    item.addEventListener('dragover', (e) => {
      if (dragId && dragId !== n.id) {
        e.preventDefault();
        item.classList.add('drop');
      }
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop'));
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drop');
      if (dragId && dragId !== n.id) await browserAPI.moveBookmark(dragId, n.id);
      load();
    });
    nav.append(item);
  });
}

function folderOptions(select, excludeId) {
  walk((n, _p, depth) => {
    if (n.type === 'folder' && n.id !== excludeId) select.append(new Option(' '.repeat(depth) + n.title, n.id));
  });
}

function renderRow(n, parent, index, searching) {
  const row = el('div', 'row');
  row.draggable = !searching;
  const main = el('div', 'main');
  if (n.type === 'folder') {
    const open = el('a', 't', `▸ ${n.title}`);
    open.href = '#';
    open.addEventListener('click', (e) => {
      e.preventDefault();
      current = n.id;
      renderFolders();
      renderList();
    });
    main.append(open, el('div', 'u', `${n.children.length} item${n.children.length === 1 ? '' : 's'}`));
  } else {
    const a = el('a', 't', n.title);
    a.href = n.url;
    main.append(a, el('div', 'u', n.url));
  }

  const edit = el('button', '', n.type === 'folder' ? 'Rename' : 'Edit');
  edit.addEventListener('click', () => {
    // inline editor: name (and URL for bookmarks) plus folder
    main.textContent = '';
    const name = el('input');
    name.type = 'text';
    name.value = n.title;
    main.append(name);
    let url = null;
    if (n.type === 'bookmark') {
      url = el('input');
      url.type = 'text';
      url.value = n.url;
      main.append(url);
    }
    const folder = el('select');
    folderOptions(folder, n.type === 'folder' ? n.id : null);
    folder.value = parent.id;
    main.append(folder);
    edit.textContent = 'Save';
    edit.onclick = async () => {
      await browserAPI.updateBookmark(n.id, { title: name.value, url: url ? url.value : undefined, parentId: folder.value });
      load();
    };
    name.focus();
  });

  const del = el('button', '', 'Delete');
  del.addEventListener('click', async () => {
    await browserAPI.removeBookmarkNode(n.id);
    load();
  });

  row.append(main, edit, del);

  if (!searching) {
    row.addEventListener('dragstart', (e) => {
      dragId = n.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => (dragId = null));
    row.addEventListener('dragover', (e) => {
      if (dragId && dragId !== n.id) {
        e.preventDefault();
        row.classList.add('drop-line');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-line'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop-line');
      if (dragId && dragId !== n.id) await browserAPI.moveBookmark(dragId, parent.id, index);
      load();
    });
  }
  return row;
}

function renderList() {
  const list = $('list');
  list.textContent = '';
  const term = $('q').value.trim().toLowerCase();
  if (term) {
    let matches = 0;
    walk((n, parent) => {
      if (n.type !== 'bookmark') return;
      if (!n.title.toLowerCase().includes(term) && !n.url.toLowerCase().includes(term)) return;
      list.append(renderRow(n, parent, 0, true));
      matches++;
    });
    if (!matches) list.append(el('div', 'empty', 'No matches.'));
    return;
  }
  const f = findNode(current);
  const folder = f.node;
  const crumbs = [];
  for (let x = f; x; x = x.parent ? findNode(x.parent.id) : null) crumbs.unshift(x.node.title);
  list.append(el('div', 'crumbs', crumbs.join(' › ')));
  if (folder.children.length === 0) list.append(el('div', 'empty', 'This folder is empty. Drag bookmarks here or use the star in the toolbar.'));
  folder.children.forEach((n, i) => list.append(renderRow(n, folder, i, false)));
}

$('q').addEventListener('input', renderList);
$('new-folder').addEventListener('click', async () => {
  await browserAPI.addBookmarkFolder('New folder', current);
  load();
});
$('export').addEventListener('click', async () => {
  const file = await browserAPI.exportBookmarks();
  if (file) notice(`Exported to ${file}`);
});
$('import').addEventListener('change', async (e) => {
  const source = e.target.value;
  e.target.value = '';
  if (!source) return;
  try {
    const result = await browserAPI.importBookmarks(source);
    if (result) notice(result.count ? `Imported ${result.count} bookmarks from ${result.from} into the bookmarks bar.` : `No bookmarks found in ${result.from}.`);
  } catch (err) {
    notice(`Import failed: ${err.message}`);
  }
  load();
});

browserAPI.bookmarkImportSources().then((sources) => {
  const select = $('import');
  for (const s of sources) select.append(new Option(`From ${s}`, s));
  select.append(new Option('From an HTML file (Safari, Firefox, …)', 'html'));
});

load();
