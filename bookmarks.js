'use strict';

// Bookmark tree: two fixed root folders, "bar" (shown in the bookmarks bar) and "other".
//   folder:   { id, type: 'folder', title, children: [...] }
//   bookmark: { id, type: 'bookmark', title, url, added }
// Stored in store.data.bookmarkTree; v0.5 and older kept a flat array in store.data.bookmarks.

let data = null; // store.data
let changed = () => {};

const ROOT_TITLES = { bar: 'Bookmarks bar', other: 'Other bookmarks' };

function init(storeData, onChange) {
  data = storeData;
  changed = onChange;
  if (!data.bookmarkTree) {
    const bar = { id: 'bar', type: 'folder', title: ROOT_TITLES.bar, children: [] };
    const other = { id: 'other', type: 'folder', title: ROOT_TITLES.other, children: [] };
    data.bookmarkNextId = 1;
    data.bookmarkTree = { bar, other };
    for (const b of Array.isArray(data.bookmarks) ? data.bookmarks : []) {
      bar.children.push({ id: newId(), type: 'bookmark', title: b.title || b.url, url: b.url, added: b.added || Date.now() });
    }
    delete data.bookmarks;
  }
}

function newId() {
  return `b${data.bookmarkNextId++}`;
}

const roots = () => [data.bookmarkTree.bar, data.bookmarkTree.other];

// Visits every node: fn(node, parent, depth). Returning true stops the walk.
function walk(fn) {
  const visit = (node, parent, depth) => {
    if (fn(node, parent, depth)) return true;
    return node.type === 'folder' && node.children.some((c) => visit(c, node, depth + 1));
  };
  roots().some((r) => visit(r, null, 0));
}

function find(id) {
  let found = null;
  walk((node, parent) => {
    if (node.id === id) found = { node, parent };
    return !!found;
  });
  return found;
}

function all() {
  const list = [];
  walk((node) => {
    if (node.type === 'bookmark') list.push(node);
  });
  return list;
}

const findByUrl = (url) => all().find((b) => b.url === url) || null;

function folders() {
  const list = [];
  walk((node, _parent, depth) => {
    if (node.type === 'folder') list.push({ id: node.id, title: node.title, depth });
  });
  return list;
}

function folderNode(id) {
  const f = find(id);
  return f && f.node.type === 'folder' ? f.node : null;
}

function insert(node, parentId, index) {
  const parent = folderNode(parentId) || data.bookmarkTree.bar;
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, parent.children.length)) : parent.children.length;
  parent.children.splice(at, 0, node);
  changed();
  return node;
}

function add({ url, title, parentId = 'bar', index }) {
  return insert({ id: newId(), type: 'bookmark', title: title || url, url, added: Date.now() }, parentId, index);
}

function addFolder(title, parentId = 'bar', index) {
  return insert({ id: newId(), type: 'folder', title: title || 'New folder', children: [] }, parentId, index);
}

function update(id, { title, url }) {
  const f = find(id);
  if (!f || !f.parent) return; // roots can't be renamed
  if (typeof title === 'string' && title.trim()) f.node.title = title.trim();
  if (f.node.type === 'bookmark' && typeof url === 'string' && /^(https?|file):/i.test(url)) f.node.url = url;
  changed();
}

function isInside(folder, id) {
  return folder.children.some((c) => c.id === id || (c.type === 'folder' && isInside(c, id)));
}

function move(id, parentId, index) {
  const f = find(id);
  const target = folderNode(parentId);
  if (!f || !f.parent || !target) return;
  if (f.node.type === 'folder' && (f.node.id === target.id || isInside(f.node, target.id))) return; // not into itself
  const from = f.parent.children.indexOf(f.node);
  f.parent.children.splice(from, 1);
  let at = Number.isInteger(index) ? index : target.children.length;
  if (f.parent === target && from < at) at -= 1; // it left its old slot first
  target.children.splice(Math.max(0, Math.min(at, target.children.length)), 0, f.node);
  changed();
}

function remove(id) {
  const f = find(id);
  if (!f || !f.parent) return;
  f.parent.children.splice(f.parent.children.indexOf(f.node), 1);
  changed();
}

// What the toolbar and pages need: no deep copies of whole subtrees.
const summary = (node) =>
  node.type === 'folder'
    ? { id: node.id, type: 'folder', title: node.title, count: node.children.length }
    : { id: node.id, type: 'bookmark', title: node.title, url: node.url, icon: node.icon || '' };

// The site icon (small data: URL) for every bookmark of `url`; returns true if anything changed.
function setIcon(url, icon) {
  let touched = false;
  const visit = (n) => {
    if (n.type === 'folder') return n.children.forEach(visit);
    if (n.url === url && n.icon !== icon) {
      n.icon = icon;
      touched = true;
    }
  };
  visit(data.bookmarkTree.bar);
  visit(data.bookmarkTree.other);
  if (touched) changed();
  return touched;
}

function tree() {
  return data.bookmarkTree;
}

// ---- import / export

// Chrome-family "Bookmarks" JSON (Chrome, Brave, Edge, Vivaldi, Arc).
function importChromeJson(json, label) {
  const convert = (n) =>
    n.type === 'folder'
      ? { id: newId(), type: 'folder', title: n.name || 'Folder', children: (n.children || []).map(convert).filter(Boolean) }
      : /^(https?|file):/i.test(n.url || '')
        ? { id: newId(), type: 'bookmark', title: n.name || n.url, url: n.url, added: Date.now() }
        : null;
  const r = json.roots || {};
  const children = [];
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    if (!r[key] || !(r[key].children || []).length) continue;
    const folder = convert(r[key]);
    folder.title = key === 'bookmark_bar' ? 'Bookmarks bar' : key === 'other' ? 'Other bookmarks' : 'Mobile bookmarks';
    children.push(folder);
  }
  return addImported(label, children);
}

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Netscape bookmark HTML, which every browser can export (Safari, Firefox, Chrome…).
function importHtml(html, label) {
  const top = { children: [] };
  const stack = [top];
  let pendingFolder = null;
  const tokens = html.match(/<DT><H3[^>]*>[\s\S]*?<\/H3>|<DT><A [^>]*>[\s\S]*?<\/A>|<DL>|<\/DL>/gi) || [];
  for (const t of tokens) {
    const current = stack[stack.length - 1];
    if (/^<DT><H3/i.test(t)) {
      pendingFolder = { id: newId(), type: 'folder', title: decode(t.replace(/<[^>]+>/g, '').trim()) || 'Folder', children: [] };
      current.children.push(pendingFolder);
    } else if (/^<DT><A /i.test(t)) {
      const href = (t.match(/HREF="([^"]*)"/i) || [])[1];
      const url = href && decode(href);
      if (url && /^(https?|file):/i.test(url)) {
        current.children.push({ id: newId(), type: 'bookmark', title: decode(t.replace(/<[^>]+>/g, '').trim()) || url, url, added: Date.now() });
      }
    } else if (/^<DL>/i.test(t)) {
      if (pendingFolder) {
        stack.push(pendingFolder);
        pendingFolder = null;
      } else if (stack.length > 1 || top.children.length) {
        stack.push(stack[stack.length - 1]); // stray list: keep adding to the current folder
      }
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  return addImported(label, top.children);
}

function addImported(label, children) {
  let count = 0;
  const countAll = (nodes) => nodes.forEach((n) => (n.type === 'folder' ? countAll(n.children) : count++));
  countAll(children);
  if (count === 0) return 0;
  data.bookmarkTree.bar.children.push({ id: newId(), type: 'folder', title: label, children });
  changed();
  return count;
}

function exportHtml() {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const write = (node, indent) => {
    const pad = '    '.repeat(indent);
    if (node.type === 'folder') {
      const bar = node.id === 'bar' ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
      lines.push(`${pad}<DT><H3${bar}>${encode(node.title)}</H3>`, `${pad}<DL><p>`);
      node.children.forEach((c) => write(c, indent + 1));
      lines.push(`${pad}</DL><p>`);
    } else {
      const added = Math.floor((node.added || Date.now()) / 1000);
      lines.push(`${pad}<DT><A HREF="${encode(node.url)}" ADD_DATE="${added}">${encode(node.title)}</A>`);
    }
  };
  roots().forEach((r) => write(r, 1));
  lines.push('</DL><p>');
  return lines.join('\n');
}

module.exports = {
  init,
  all,
  find,
  findByUrl,
  folders,
  add,
  addFolder,
  update,
  move,
  remove,
  summary,
  setIcon,
  tree,
  importChromeJson,
  importHtml,
  exportHtml,
};
