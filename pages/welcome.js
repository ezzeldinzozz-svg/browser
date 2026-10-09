'use strict';

const $ = (id) => document.getElementById(id);

async function refreshDefault() {
  const { supported, isDefault } = await browserAPI.getDefaultBrowser();
  $('default-status').textContent = !supported
    ? 'Available in the installed app.'
    : isDefault
      ? 'Browser is your default browser.'
      : 'Links you open in other apps will open here.';
  $('default-set').hidden = !supported || isDefault;
}

async function init() {
  const s = await browserAPI.getSettings();
  for (const e of s.searchEngines) $('engine').append(new Option(e.name, e.id));
  $('engine').value = s.searchEngine;
  $('adblock').checked = s.adblock;
  $('tpc').checked = s.blockThirdPartyCookies;

  const sources = await browserAPI.bookmarkImportSources();
  const box = $('import-buttons');
  for (const source of [...sources, 'html']) {
    const b = document.createElement('button');
    b.textContent = source === 'html' ? 'From a file (Safari, Firefox…)' : `From ${source}`;
    b.addEventListener('click', async () => {
      try {
        const r = await browserAPI.importBookmarks(source);
        if (r) $('import-result').textContent = r.count ? `Imported ${r.count} bookmarks from ${r.from}.` : `No bookmarks found in ${r.from}.`;
      } catch (err) {
        $('import-result').textContent = `Import failed: ${err.message}`;
      }
    });
    box.append(b);
  }
  refreshDefault();
}

$('default-set').addEventListener('click', async () => {
  await browserAPI.setDefaultBrowser();
  setTimeout(refreshDefault, 1500);
});
window.addEventListener('focus', refreshDefault);
$('engine').addEventListener('change', () => browserAPI.setSetting('searchEngine', $('engine').value));
$('adblock').addEventListener('change', () => browserAPI.setSetting('adblock', $('adblock').checked));
$('tpc').addEventListener('change', () => browserAPI.setSetting('blockThirdPartyCookies', $('tpc').checked));
$('start').addEventListener('click', () => browserAPI.go('browser://newtab'));

init();
