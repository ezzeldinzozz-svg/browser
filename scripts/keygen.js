'use strict';

// One-time setup: creates the Ed25519 key pair that signs releases.
//   private key -> ~/.browser-release/update-private-key.pem (never commit; back it up!)
//   public key  -> update-public-key.pem (committed and shipped inside the app)
// Losing the private key means installed copies can no longer auto-update.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const keyDir = path.join(os.homedir(), '.browser-release');
const privatePath = path.join(keyDir, 'update-private-key.pem');
const publicPath = path.join(__dirname, '..', 'update-public-key.pem');

if (fs.existsSync(privatePath)) {
  console.error(`Refusing to overwrite existing key: ${privatePath}`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));

console.log(`Private key: ${privatePath}  (back this up somewhere safe)`);
console.log(`Public key:  ${publicPath}`);
