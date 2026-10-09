'use strict';

const list = document.getElementById('list');
let last = '';

function size(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function status(d) {
  switch (d.state) {
    case 'progressing': {
      const of = d.total ? ` of ${size(d.total)}` : '';
      const pct = d.total ? ` · ${Math.floor((d.received / d.total) * 100)}%` : '';
      return `${d.paused ? 'Paused · ' : ''}${size(d.received)}${of}${pct}`;
    }
    case 'completed':
      return `Completed · ${size(d.received)}`;
    case 'dangerous':
      return "Unconfirmed: this type of file can harm your computer";
    case 'cancelled':
      return d.discarded ? 'Discarded' : 'Cancelled';
    default:
      return 'Failed';
  }
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

async function refresh() {
  const items = await browserAPI.getDownloads();
  const snapshot = JSON.stringify(items);
  if (snapshot === last) return; // avoid rebuilding buttons under the cursor
  last = snapshot;

  list.textContent = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No downloads yet.';
    list.append(empty);
    return;
  }
  for (const d of items) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'main';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = d.filename;
    if (d.state !== 'completed') t.classList.add('muted');
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = `${status(d)} · ${d.url}`;
    u.title = d.url;
    main.append(t, u);
    row.append(main);

    if (d.state === 'progressing') {
      row.append(
        button(d.paused ? 'Resume' : 'Pause', () => browserAPI.pauseDownload(d.id)),
        button('Cancel', () => browserAPI.cancelDownload(d.id)),
      );
    } else if (d.state === 'dangerous') {
      row.append(
        button('Keep', () => browserAPI.decideDownload(d.id, 'keep')),
        button('Discard', () => browserAPI.decideDownload(d.id, 'discard')),
      );
    } else if (d.state === 'completed') {
      row.append(
        button('Open', () => browserAPI.openDownload(d.id)),
        button('Show in folder', () => browserAPI.showDownload(d.id)),
      );
    } else if (!d.discarded) {
      row.append(button('Retry', () => browserAPI.retryDownload(d.id)));
    }
    if (d.state !== 'progressing' && d.state !== 'dangerous') {
      row.append(button('\u00D7', () => browserAPI.removeDownloadEntry(d.id).then(refresh)));
    }
    list.append(row);
  }
}

document.getElementById('clear').addEventListener('click', async () => {
  await browserAPI.clearDownloads();
  refresh();
});
refresh();
setInterval(refresh, 500);
