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

let limit = 300;

function render() {
  const term = q.value.trim().toLowerCase();
  const matches = items.filter((h) => !term || h.title.toLowerCase().includes(term) || h.url.toLowerCase().includes(term));
  const shown = matches.slice(0, limit);

  list.textContent = '';
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = items.length ? 'No matches.' : 'No history yet.';
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
  if (matches.length > shown.length) {
    const more = document.createElement('button');
    more.className = 'more';
    more.textContent = `Show more (${matches.length - shown.length} older)`;
    more.addEventListener('click', () => {
      limit += 300;
      render();
    });
    list.append(more);
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
