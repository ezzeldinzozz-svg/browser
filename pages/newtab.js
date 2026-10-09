'use strict';

document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  browserAPI.go(document.getElementById('q').value);
});

browserAPI.getSettings().then((s) => {
  document.getElementById('q').placeholder = `Search ${s.searchEngineName} or enter address`;
});

// Most-visited sites as tiles; the × hides a site from here for good.
async function loadTiles() {
  const tiles = document.getElementById('tiles');
  tiles.textContent = '';
  for (const t of await browserAPI.getTopSites()) {
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = t.url;
    a.title = t.url;
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = t.site.charAt(0).toUpperCase();
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.title;
    const hide = document.createElement('button');
    hide.className = 'hide';
    hide.textContent = '\u00D7';
    hide.title = `Don't show ${t.site} here`;
    hide.addEventListener('click', async (e) => {
      e.preventDefault();
      await browserAPI.hideTile(t.site);
      loadTiles();
    });
    a.append(letter, name, hide);
    tiles.append(a);
  }
}
loadTiles();

browserAPI.getBookmarks().then((list) => {
  // bookmarks only (folders are skipped), most recently added first
  list = list.filter((b) => b.type !== 'folder');
  document.getElementById('bookmarks-heading').hidden = list.length === 0;
  const sites = document.getElementById('sites');
  for (const b of list.slice(0, 12)) {
    const a = document.createElement('a');
    a.href = b.url;
    a.textContent = b.title || b.url;
    a.title = b.url;
    sites.append(a);
  }
});
