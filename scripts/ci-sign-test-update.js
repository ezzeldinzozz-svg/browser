'use strict';

// CI only: signs an update with a throwaway Ed25519 key for the end-to-end update test.
//   node scripts/ci-sign-test-update.js <platformKey> <manifestName> <updateFile> <serveDir>
// Writes <serveDir>/<manifestName>, copies the update file there, and writes the public key to
// <serveDir>/test-public-key.pem (the app under test is pointed at it via BROWSER_UPDATE_KEY).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { signManifest } = require('../update-format');

const [platformKey, manifestName, updateFile, serveDir] = process.argv.slice(2);
const { version } = require('../package.json');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

fs.mkdirSync(serveDir, { recursive: true });
const file = path.basename(updateFile);
fs.copyFileSync(updateFile, path.join(serveDir, file));
const manifest = signManifest({ platformKey, version, file, data: fs.readFileSync(updateFile), privateKey });
fs.writeFileSync(path.join(serveDir, manifestName), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(serveDir, 'test-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
console.log(`signed ${file} as ${platformKey} ${version} -> ${path.join(serveDir, manifestName)}`);
