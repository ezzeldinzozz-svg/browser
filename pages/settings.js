'use strict';

const NAMES = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard',
  midi: 'MIDI devices',
  midiSysex: 'MIDI full control',
  openExternal: 'Open apps',
};

const list = document.getElementById('list');

async function load() {
  const sites = await browserAPI.getPermissions();
  const origins = Object.keys(sites).sort();
  list.textContent = '';
  if (origins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No site permissions saved yet.';
    list.append(empty);
    return;
  }
  for (const origin of origins) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'main';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = origin;
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = Object.entries(sites[origin])
      .map(([k, v]) => `${NAMES[k] || k}: ${v === 'allow' ? 'Allowed' : 'Blocked'}`)
      .join(' · ');
    main.append(t, u);

    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.addEventListener('click', async () => {
      await browserAPI.resetPermissions(origin);
      load();
    });

    row.append(main, reset);
    list.append(row);
  }
}
load();
