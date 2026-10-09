'use strict';

// Builds, signs and publishes a macOS release that installed copies will auto-update to.
//
//   npm run release            -> bumps the patch version (0.2.0 -> 0.2.1)
//   npm run release -- 0.3.0   -> releases that exact version
//
// Needs: a clean git tree, the private key from `npm run keygen`, and the GitHub CLI
// logged in as the repo owner.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OWNER = 'ezzeldinzozz-svg';
const REPO = `${OWNER}/browser`;
const PRIVATE_KEY = path.join(os.homedir(), '.browser-release', 'update-private-key.pem');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();

function nextVersion(current, requested) {
  if (requested) {
    if (!/^\d+\.\d+\.\d+$/.test(requested)) throw new Error(`Not a version: ${requested}`);
    return requested;
  }
  const [major, minor, patch] = current.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  if (!fs.existsSync(PRIVATE_KEY)) throw new Error(`Missing signing key ${PRIVATE_KEY}. Run: npm run keygen`);
  if (out('git', ['status', '--porcelain'])) throw new Error('Commit or stash your changes first.');

  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = nextVersion(pkg.version, process.argv[2]);
  const tag = `v${version}`;
  const env = { ...process.env, GH_TOKEN: out('gh', ['auth', 'token', '--user', OWNER]) };

  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  sh('npm', ['install', '--package-lock-only', '--silent']);

  fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
  sh('npx', ['electron-builder', '--mac', '--publish', 'never']);

  const dist = path.join(ROOT, 'dist');
  const files = fs.readdirSync(dist);
  const zip = files.find((f) => f.endsWith('.zip') && f.includes(version));
  const dmg = files.find((f) => f.endsWith('.dmg') && f.includes(version));
  if (!zip || !dmg) throw new Error(`Build output missing in ${dist}`);

  const signature = crypto
    .sign(null, fs.readFileSync(path.join(dist, zip)), fs.readFileSync(PRIVATE_KEY, 'utf8'))
    .toString('base64');
  const manifest = path.join(dist, 'latest-mac.json');
  fs.writeFileSync(manifest, JSON.stringify({ version, file: zip, signature, date: new Date().toISOString() }, null, 2));

  sh('git', ['commit', '-q', '-am', `Release ${tag}`]);
  sh('git', ['tag', tag]);
  sh('git', ['push', '-q', 'origin', 'HEAD', tag]);
  sh(
    'gh',
    ['release', 'create', tag, '--repo', REPO, '--title', tag, '--generate-notes',
      path.join(dist, dmg), path.join(dist, zip), manifest],
    { env },
  );
  console.log(`\nReleased ${tag}: https://github.com/${REPO}/releases/tag/${tag}`);
}

try {
  main();
} catch (err) {
  console.error(`\nRelease failed: ${err.message}`);
  process.exit(1);
}
