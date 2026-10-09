'use strict';

// Reader mode: shows the article that main extracted with Readability. The article HTML comes
// from the website, so it goes into a sandboxed srcdoc frame (no scripts, unique origin) and
// never touches this privileged page's DOM.

const frame = document.getElementById('article');
let data = null;
let prefs = null;

const escapeHtml = (t) => String(t || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function themeClass() {
  if (prefs.theme !== 'auto') return prefs.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function render() {
  const a = data.article;
  document.body.className = `theme-${themeClass()}`;
  for (const id of ['font', 'width', 'theme']) document.getElementById(id).value = prefs[id];
  const site = a.siteName || new URL(data.url).hostname.replace(/^www\./, '');
  const minutes = a.length ? Math.max(1, Math.round(a.length / 1100)) : 0; // ~1100 characters a minute
  const meta = [a.byline, minutes ? `${minutes} min read` : ''].filter(Boolean).join(' · ');
  frame.srcdoc = `<!doctype html><html lang="${escapeHtml(a.lang)}" dir="${a.dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<base href="${escapeHtml(data.url)}" target="_blank"><link rel="stylesheet" href="${location.origin}/reader-article.css"></head>
<body class="theme-${themeClass()} font-${prefs.font} size-${prefs.size} width-${prefs.width}"><div class="page">
<header><p class="site">${escapeHtml(site)}</p><h1>${escapeHtml(a.title)}</h1>${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}</header>
<article>${a.content}</article></div></body></html>`;
  document.title = a.title || 'Reader';
}

function save(change) {
  prefs = { ...prefs, ...change };
  render();
  browserAPI.setReaderPrefs(prefs);
}

(async () => {
  data = await browserAPI.getReaderArticle();
  prefs = data.prefs;
  if (!data.article) {
    document.getElementById('bar').hidden = true;
    document.getElementById('missing').hidden = false;
    document.getElementById('open-original').hidden = !data.url;
    return;
  }
  frame.hidden = false;
  render();
})();

const SIZES = [14, 16, 18, 20, 22, 24, 26, 28];
document.getElementById('smaller').addEventListener('click', () => save({ size: SIZES[Math.max(0, SIZES.indexOf(prefs.size) - 1)] }));
document.getElementById('bigger').addEventListener('click', () => save({ size: SIZES[Math.min(SIZES.length - 1, SIZES.indexOf(prefs.size) + 1)] }));
for (const id of ['font', 'width', 'theme']) document.getElementById(id).addEventListener('change', (e) => save({ [id]: e.target.value }));
document.getElementById('exit').addEventListener('click', () => {
  speechSynthesis.cancel();
  browserAPI.exitReader();
});
document.getElementById('open-original').addEventListener('click', () => browserAPI.exitReader());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => data && data.article && prefs.theme === 'auto' && render());

// Read aloud in Reader Mode
const listenBtn = document.getElementById('listen');
const rateSelect = document.getElementById('rate');
let speaking = false;

function startSpeech() {
  if (!data || !data.article) return;
  speechSynthesis.cancel();
  const doc = new DOMParser().parseFromString(data.article.content || '', 'text/html');
  const text = `${data.article.title || ''}.\n\n${doc.body.textContent || ''}`.trim();
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = Number(rateSelect.value) || 1;
  if (data.article.lang) u.lang = data.article.lang;
  u.onend = u.onerror = () => {
    speaking = false;
    listenBtn.textContent = 'Listen';
    rateSelect.hidden = true;
  };
  speaking = true;
  listenBtn.textContent = 'Stop';
  rateSelect.hidden = false;
  speechSynthesis.speak(u);
}

function toggleReaderSpeech() {
  if (speaking || speechSynthesis.speaking) {
    speechSynthesis.cancel();
    speaking = false;
    listenBtn.textContent = 'Listen';
    rateSelect.hidden = true;
  } else {
    startSpeech();
  }
}

window.__toggleReaderSpeech = toggleReaderSpeech;
listenBtn.addEventListener('click', toggleReaderSpeech);
rateSelect.addEventListener('change', () => {
  if (speaking) startSpeech();
});
window.addEventListener('beforeunload', () => speechSynthesis.cancel());
