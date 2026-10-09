'use strict';

// What an update's signature2 signs. Shared by the app's updater and the release scripts, so
// the two can't drift apart. Plain Node (no Electron).

const crypto = require('crypto');

function signedPayload(platformKey, version, file, data) {
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  return Buffer.from(`browser-update-v2\n${platformKey}\n${version}\n${file}\n${sha}`);
}

// manifest for one platform; legacySignature: also sign the raw bytes (macOS copies before v0.11)
function signManifest({ platformKey, version, file, data, privateKey, legacySignature = false }) {
  const manifest = {
    version,
    file,
    signature2: crypto.sign(null, signedPayload(platformKey, version, file, data), privateKey).toString('base64'),
    date: new Date().toISOString(),
  };
  if (legacySignature) manifest.signature = crypto.sign(null, data, privateKey).toString('base64');
  return manifest;
}

module.exports = { signedPayload, signManifest };
