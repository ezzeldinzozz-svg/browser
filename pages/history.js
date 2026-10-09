'use strict';

const list = document.getElementById('list');
const q = document.getElementById('q');
let items = [];

function dayLabel(time) {
  const d = new Date(time);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

const siteOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const PAGE = 300;
let more = false; // the last page was full, so older visits may exist

function render() {
  const shown = items;

  list.textContent = '';
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = q.value.trim() ? 'No matches.' : 'No history yet.';
    list.append(empty);
    return;
  }
  let lastDay = '';
  for (const h of shown) {
    const day = dayLabel(h.time);
    if (day !== lastDay) {
      const heading = document.createElement('h2');
      heading.className = 'day';
      heading.textContent = day;
      list.append(heading);
      lastDay = day;
    }
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
    time.textContent = new Date(h.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.title = 'Remove this page from history';
    remove.addEventListener('click', async () => {
      await browserAPI.removeHistoryEntry(h.url);
      load();
    });
    const site = siteOf(h.url);
    const removeSite = document.createElement('button');
    removeSite.textContent = 'Remove site';
    removeSite.title = `Remove every visit to ${site}`;
    removeSite.addEventListener('click', async () => {
      await browserAPI.removeHistorySite(site);
      load();
    });

    row.append(main, time, remove, removeSite);
    list.append(row);
  }
  if (more) {
    const button = document.createElement('button');
    button.className = 'more';
    button.textContent = 'Show older';
    button.addEventListener('click', () => load(true));
    list.append(button);
  }
}

// Full-text search and paging happen in the history database (main process).
let loadSeq = 0;
async function load(older = false) {
  const seq = ++loadSeq;
  const before = older && items.length ? items[items.length - 1].time : undefined;
  const page = await browserAPI.getHistory({ query: q.value, before, limit: PAGE });
  if (seq !== loadSeq) return; // a newer search started meanwhile
  items = older ? [...items, ...page] : page;
  more = page.length === PAGE;
  render();
}

let searchTimer = null;
q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load(), 150);
});
document.getElementById('clear').addEventListener('click', async () => {
  await browserAPI.clearHistory();
  load();
});
load();

// ---- import from another browser
browserAPI.bookmarkImportSources().then((sources) => {
  if (!sources.length) return;
  const select = document.getElementById('import-source');
  for (const name of sources) select.append(new Option(`From ${name}`, name));
  document.getElementById('import-bar').hidden = false;
});
document.getElementById('import').addEventListener('click', async () => {
  const button = document.getElementById('import');
  const result = document.getElementById('import-result');
  button.disabled = true;
  result.textContent = 'Importing\u2026';
  try {
    const r = await browserAPI.importHistory(document.getElementById('import-source').value);
    result.textContent = r ? `Imported ${r.count} visits from ${r.from}.` : 'Nothing to import.';
    load();
  } catch {
    result.textContent = "Couldn't read that browser's history. Close it and try again.";
  } finally {
    button.disabled = false;
  }
});
