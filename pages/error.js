'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const desc = params.get('desc') || '';

if (desc === 'crashed') {
  document.title = 'Page crashed';
  document.getElementById('heading').textContent = 'This page crashed';
  document.getElementById('detail').textContent = 'Something went wrong while showing this page.';
  document.getElementById('retry').textContent = 'Reload';
  document.getElementById('desc').textContent = '';
} else if (/^ERR_(CERT_|SSL_|BAD_SSL)/.test(desc)) {
  document.title = 'Connection not private';
  document.getElementById('heading').textContent = "Your connection isn't private";
  document.getElementById('detail').textContent =
    "This site's security certificate couldn't be verified, so someone could be trying to steal " +
    'your passwords, messages or card details. The page was not loaded.';
}

document.getElementById('url').textContent = url;
if (desc !== 'crashed') document.getElementById('desc').textContent = desc;
document.getElementById('retry').addEventListener('click', () => (url ? browserAPI.go(url) : history.back()));
