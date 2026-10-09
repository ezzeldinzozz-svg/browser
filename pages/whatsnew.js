'use strict';

// Release notes from changelog.json (bundled with the app): the running version first, then
// a few older ones.
(async () => {
  const [log, info] = await Promise.all([browserAPI.getChangelog(), browserAPI.getAbout()]);
  const versions = Object.keys(log).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  document.getElementById('version').textContent = `You're on version ${info.version}.`;
  const box = document.getElementById('notes');
  for (const v of versions.slice(0, 6)) {
    const card = document.createElement('section');
    card.className = 'card';
    const h = document.createElement('h2');
    h.textContent = v === info.version ? `Version ${v} (this one)` : `Version ${v}`;
    const ul = document.createElement('ul');
    for (const line of log[v]) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.append(li);
    }
    card.append(h, ul);
    box.append(card);
  }
})();
