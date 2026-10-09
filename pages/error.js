'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
document.getElementById('url').textContent = url;
document.getElementById('desc').textContent = params.get('desc') || '';
document.getElementById('retry').addEventListener('click', () => browserAPI.go(url));
