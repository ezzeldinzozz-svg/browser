'use strict';

// The saved-login dropdown shown under a focused login field. It's a separate small view, so
// the page itself never sees the list of usernames.
window.browserAPI.onPasswordItems((items) => {
  const list = document.getElementById('list');
  list.textContent = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'item';
    row.setAttribute('role', 'option');
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = '\u{1F511}︎';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.username;
    row.append(key, name);
    // mousedown: before the page field's blur hides this view
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      window.browserAPI.choosePassword(item.id);
    });
    list.append(row);
  }
});
