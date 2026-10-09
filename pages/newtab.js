'use strict';

document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  browserAPI.go(document.getElementById('q').value);
});

browserAPI.getSettings().then((s) => {
  document.getElementById('q').placeholder = `Search ${s.searchEngineName} or enter address`;
});

browserAPI.getBookmarks().then((list) => {
  // bookmarks only (folders are skipped), most recently added first
  list = list.filter((b) => b.type !== 'folder');
  const sites = document.getElementById('sites');
  for (const b of list.slice(0, 12)) {
    const a = document.createElement('a');
    a.href = b.url;
    a.textContent = b.title || b.url;
    a.title = b.url;
    sites.append(a);
  }
});
