'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const desc = params.get('desc') || '';

if (desc === 'https-only') {
  document.title = 'Secure connection not available';
  document.getElementById('heading').textContent = "This site doesn't support a secure connection";
  document.getElementById('detail').textContent =
    'Browser tried to open it over HTTPS, but the site only works over HTTP. Anyone on your network could see or ' +
    "change what you send and receive there, so don't enter passwords or card details.";
  document.getElementById('retry').textContent = 'Go back';
  document.getElementById('continue-http').hidden = false;
  document.getElementById('continue-http').addEventListener('click', () => browserAPI.allowHttp(url));
} else if (desc === 'crashed') {
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
if (desc !== 'crashed' && desc !== 'https-only') document.getElementById('desc').textContent = desc;
document.getElementById('retry').addEventListener('click', () =>
  desc === 'https-only' || !url ? history.back() : browserAPI.go(url),
);
