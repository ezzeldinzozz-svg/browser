'use strict';

// The list of saved addresses shown under a focused form field (see showAutofill in main.js).
const box = document.getElementById('box');

browserAPI.onAutofillList(({ items }) => {
  box.textContent = '';
  for (const item of items) {
    const row = document.createElement('button');
    row.className = 'row';
    row.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.label;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = item.detail;
    row.append(name, detail);
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => browserAPI.chooseAutofill(item.id));
    box.append(row);
  }
  const manage = document.createElement('button');
  manage.className = 'manage';
  manage.textContent = 'Manage addresses…';
  manage.addEventListener('click', () => browserAPI.manageAutofill());
  box.append(manage);
});
