'use strict';

// electron-builder afterPack hook, run before the DMG/zip are made:
//   1. flip Electron fuses (scripts/fuses.js)
//   2. on macOS, sign the app with our self-signed certificate
//
// A stable certificate keeps the app's code identity the same across versions, so macOS
// stops asking for keychain access ("Browser Safe Storage") after every update. Without the
// certificate (e.g. on a machine that doesn't have it), builds fall back to ad-hoc signing.

const { execFileSync } = require('child_process');
const path = require('path');
const flipAppFuses = require('./fuses').default;

const CERT_NAME = 'Browser Self-Signed Code Signing';

function findIdentity() {
  if (process.env.BROWSER_CODESIGN_IDENTITY) return process.env.BROWSER_CODESIGN_IDENTITY;
  try {
    const out = execFileSync('/usr/bin/security', ['find-certificate', '-c', CERT_NAME, '-Z'], { encoding: 'utf8' });
    const match = out.match(/SHA-1 hash:\s*([0-9A-F]{40})/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

exports.default = async function afterPack(context) {
  await flipAppFuses(context);
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = findIdentity();
  if (!identity) console.warn(`  • "${CERT_NAME}" not found in the keychain: ad-hoc signing (see HANDOFF.md)`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', identity || '-', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • signed ${path.basename(app)} with ${identity ? CERT_NAME : 'ad-hoc signature'}`);
};
