'use strict';

// Builds, signs and publishes a release for macOS, Windows and Linux.
//
//   npm run release            -> bumps the patch version (0.2.0 -> 0.2.1)
//   npm run release -- 0.3.0   -> releases that exact version (Apple silicon Mac)
//   npm run release -- 0.3.0 --all-platforms -> also Intel Mac, Windows (CI) and Linux (CI)
//
// 1. bumps the version, commits, tags and pushes; the tag makes GitHub Actions build the
//    Windows installer and Linux AppImage/.deb (and smoke-test them)
// 2. builds the Mac app here meanwhile (signed with the local code-signing certificate)
// 3. waits for that CI run, downloads its packages
// 4. signs each platform's update manifest with the local Ed25519 key (never uploaded anywhere)
// 5. creates the GitHub release with everything
//
// Needs: a clean git tree, the keys in ~/.browser-release (see HANDOFF.md), and the GitHub CLI
// logged in as the repo owner.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { signManifest } = require('../update-format');

const ROOT = path.join(__dirname, '..');
const OWNER = 'ezzeldinzozz-svg';
const REPO = `${OWNER}/operecs-browser`;
const PRIVATE_KEY = path.join(os.homedir(), '.browser-release', 'update-private-key.pem');
const CI_WAIT_MS = 45 * 60 * 1000;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function nextVersion(current, requested) {
  if (requested) {
    if (!/^\d+\.\d+\.\d+$/.test(requested)) throw new Error(`Not a version: ${requested}`);
    return requested;
  }
  const [major, minor, patch] = current.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

// The CI run for the release tag (pushing a tag starts its own run).
function waitForCi(tag, sha, env) {
  console.log(`\nWaiting for GitHub Actions to build Windows and Linux for ${tag}…`);
  const deadline = Date.now() + CI_WAIT_MS;
  let runId = null;
  while (Date.now() < deadline) {
    const runs = JSON.parse(
      out('gh', ['run', 'list', '--repo', REPO, '--workflow', 'build.yml', '--limit', '20', '--json', 'databaseId,headBranch,headSha,status,conclusion'], { env }),
    );
    const run = runs.find((r) => r.headBranch === tag && r.headSha === sha);
    if (run) {
      runId = run.databaseId;
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error(`CI run ${runId} finished with "${run.conclusion}": https://github.com/${REPO}/actions/runs/${runId}`);
        return runId;
      }
    }
    sleep(15000);
  }
  throw new Error(`Timed out waiting for CI${runId ? ` (run ${runId})` : ''}`);
}

function main() {
  if (!fs.existsSync(PRIVATE_KEY)) throw new Error(`Missing signing key ${PRIVATE_KEY}. Run: npm run keygen`);
  if (out('git', ['status', '--porcelain'])) throw new Error('Commit or stash your changes first.');
  const privateKey = fs.readFileSync(PRIVATE_KEY, 'utf8');

  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const args = process.argv.slice(2);
  // Focus is Apple silicon Mac (see CLAUDE.md); --all-platforms also ships Intel Mac, Windows and Linux.
  const ALL = args.includes('--all-platforms');
  // --critical: a security fix; installed copies ask to restart now and restart by themselves soon
  const CRITICAL = args.includes('--critical');
  const version = nextVersion(pkg.version, args.find((a) => !a.startsWith('--')));
  const tag = `v${version}`;
  const env = { ...process.env, GH_TOKEN: out('gh', ['auth', 'token', '--user', OWNER]) };

  // 1. version, commit, tag, push -> CI starts building Windows and Linux
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  sh('npm', ['install', '--package-lock-only', '--silent']);
  sh('git', ['commit', '-q', '-am', `Release ${tag}`]);
  sh('git', ['tag', tag]);
  sh('git', ['push', '-q', 'origin', 'HEAD', tag]);
  const sha = out('git', ['rev-parse', 'HEAD']);

  // 2. the Mac build, here
  const dist = path.join(ROOT, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  sh('npm', ['run', 'build']);
  sh('npx', ['electron-builder', '--mac', ...(ALL ? [] : ['--arm64']), '--publish', 'never']);
  // CI doesn't build the Mac app, so check it here before anything is published.
  sh('node', ['scripts/smoke-test.js', path.join(dist, 'mac-arm64', 'Operecs.app', 'Contents', 'MacOS', 'Operecs')]);

  // 3. Windows and Linux packages from CI (only with --all-platforms)
  const ciDir = path.join(dist, 'ci');
  if (ALL) {
    const runId = waitForCi(tag, sha, env);
    sh('gh', ['run', 'download', String(runId), '--repo', REPO, '--dir', ciDir], { env });
  }

  const find = (dir, test, what) => {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(test) : [];
    if (files.length !== 1) throw new Error(`Expected one ${what} in ${dir}, found ${files.length}`);
    return path.join(dir, files[0]);
  };
  // electron-builder names: Operecs-1.0.0-arm64.dmg / -arm64-mac.zip (Apple silicon) and
  // Operecs-1.0.0.dmg / -mac.zip (Intel)
  const mac = {
    zip: find(dist, (f) => f.endsWith(`${version}-arm64-mac.zip`), 'Apple silicon zip'),
    dmg: find(dist, (f) => f.endsWith(`${version}-arm64.dmg`), 'Apple silicon dmg'),
    zipX64: ALL && find(dist, (f) => f.endsWith(`${version}-mac.zip`) && !f.includes('arm64'), 'Intel Mac zip'),
    dmgX64: ALL && find(dist, (f) => f.endsWith(`${version}.dmg`) && !f.includes('arm64'), 'Intel Mac dmg'),
  };
  const win = ALL && find(path.join(ciDir, 'browser-windows'), (f) => f.endsWith('.exe') && f.includes(version), 'Windows installer');
  const appImage = ALL && find(path.join(ciDir, 'browser-linux'), (f) => f.endsWith('.AppImage') && f.includes(version), 'AppImage');
  const deb = ALL && find(path.join(ciDir, 'browser-linux'), (f) => f.endsWith('.deb') && f.includes(version), '.deb');

  // 4. update manifests, signed here
  const manifests = [
    ['latest-mac.json', 'mac-arm64', mac.zip, true],
    ['latest-mac-x64.json', 'mac-x64', mac.zipX64, false],
    ['latest-win.json', 'win-x64', win, false],
    ['latest-linux.json', 'linux-x64', appImage, false],
  ].filter(([, , file]) => file).map(([name, platformKey, file, legacySignature]) => {
    const manifest = signManifest({
      platformKey,
      version,
      file: path.basename(file),
      data: fs.readFileSync(file),
      privateKey,
      legacySignature,
      critical: CRITICAL,
    });
    const target = path.join(dist, name);
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2));
    return target;
  });

  // 5. publish
  const assets = [mac.dmg, mac.zip, mac.dmgX64, mac.zipX64, win, appImage, deb, ...manifests].filter(Boolean);
  console.log(`\nUploading ${assets.length} files (this can take a while)…`);
  try {
    sh('gh', ['release', 'create', tag, '--repo', REPO, '--title', tag, '--generate-notes', ...assets], { env });
  } catch (err) {
    console.error(
      '\nThe upload stopped. GitHub keeps the release as a draft, which installed apps never see.\n' +
        `Finish it with:\n  gh release upload ${tag} ${assets.map((a) => JSON.stringify(path.relative(ROOT, a))).join(' ')} --repo ${REPO} --clobber\n` +
        `  gh release edit ${tag} --repo ${REPO} --draft=false --latest`,
    );
    throw err;
  }
  console.log(`\nReleased ${tag}: https://github.com/${REPO}/releases/tag/${tag}`);
}

try {
  main();
} catch (err) {
  console.error(`\nRelease failed: ${err.message}`);
  process.exit(1);
}
