'use strict';

// The link-hover URL bubble in the bottom-left corner of the page.
window.browserAPI.onStatus((text) => {
  document.getElementById('status').textContent = text;
});
