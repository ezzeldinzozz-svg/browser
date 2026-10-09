'use strict';

browserAPI
  .getLicenses()
  .then((packages) => {
    const list = document.getElementById('list');
    for (const p of packages) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${p.name} ${p.version} — ${p.license}`;
      details.append(summary);
      if (p.text) {
        const pre = document.createElement('pre');
        pre.textContent = p.text;
        details.append(pre);
      }
      list.append(details);
    }
  })
  .catch(() => {
    document.getElementById('list').textContent = "The list of packages couldn't be loaded.";
  });
