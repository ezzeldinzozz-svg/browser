'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const desc = params.get('desc') || '';

if (desc === 'https-only') {
  document.title = 'Secure connection not available';
  document.getElementById('heading').textContent = "This site doesn't support a secure connection";
  document.getElementById('detail').textContent =
    'Operecs tried to open it over HTTPS, but the site only works over HTTP. Anyone on your network could see or ' +
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
} else if (desc === 'ERR_INTERNET_DISCONNECTED' || (!navigator.onLine && /^ERR_(NAME_NOT_RESOLVED|NETWORK_CHANGED|ADDRESS_UNREACHABLE)/.test(desc))) {
  document.title = 'No internet';
  document.getElementById('heading').textContent = "You're offline";
  document.getElementById('detail').textContent = 'Check your Wi-Fi or network cable. The page loads by itself when you are back online.';
  // retry as soon as the connection is back
  window.addEventListener('online', () => url && browserAPI.go(url));
} else if (desc === 'ERR_NAME_NOT_RESOLVED') {
  document.title = "Can't find this site";
  document.getElementById('heading').textContent = "This site can't be found";
  document.getElementById('detail').textContent = 'Check the address for typos. If it is right, the site may be down or your network may be blocking it.';
  showNetworkLogin();
} else if (/^ERR_PROXY_|^ERR_TUNNEL_CONNECTION_FAILED/.test(desc)) {
  document.title = 'Proxy problem';
  document.getElementById('heading').textContent = "Can't connect through the proxy";
  document.getElementById('detail').textContent = 'The proxy server isn\u2019t responding. Check Settings \u2192 Privacy \u2192 Proxy, or your system\u2019s network settings.';
} else if (/^ERR_CONNECTION_(TIMED_OUT|RESET|CLOSED|REFUSED)|^ERR_TIMED_OUT/.test(desc)) {
  document.getElementById('detail').textContent = 'The site took too long to respond or closed the connection.';
  showNetworkLogin();
} else if (/^ERR_(CERT_|SSL_|BAD_SSL)/.test(desc)) {
  document.title = 'Connection not private';
  document.getElementById('heading').textContent = "Your connection isn't private";
  document.getElementById('detail').textContent =
    "This site's security certificate couldn't be verified, so someone could be trying to steal " +
    'your passwords, messages or card details. The page was not loaded.';
  showNetworkLogin(); // public Wi-Fi sign-in pages often show up as certificate errors
}

// Captive portals: opening a plain-HTTP page lets the network redirect to its sign-in page.
function showNetworkLogin() {
  document.getElementById('network-login').hidden = false;
  document.getElementById('network-hint').hidden = false;
}
document.getElementById('network-login').addEventListener('click', () => browserAPI.go('http://neverssl.com/'));

document.getElementById('url').textContent = url;
if (desc !== 'crashed' && desc !== 'https-only') document.getElementById('desc').textContent = desc;
document.getElementById('retry').addEventListener('click', () =>
  desc === 'https-only' || !url ? history.back() : browserAPI.go(url),
);
