'use strict';

// Bundles preload.js (and what it imports, e.g. the extension toolbar element) into
// gen/preload.js. Sandboxed preloads can only require('electron'), so npm packages used
// there have to be bundled in.

const path = require('path');
const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'preload.js')],
  outfile: path.join(__dirname, '..', 'gen', 'preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'chrome140',
  external: ['electron'],
  logLevel: 'warning',
});
console.log('built gen/preload.js');

// gen/licenses.json: name, version, license and license text of every production dependency,
// shown at browser://licenses (required for redistribution, e.g. GPL and MIT notices).
const fs = require('fs');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const tree = JSON.parse(
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '--omit=dev', '--all', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const seen = new Map();
const visit = (deps) => {
  for (const [name, info] of Object.entries(deps || {})) {
    const key = `${name}@${info.version}`;
    if (seen.has(key) || !info.version) continue;
    const dir = path.join(root, 'node_modules', name);
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      // not installed at the top level
    }
    let text = '';
    try {
      const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f));
      if (file) text = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 40000);
    } catch {
      // no license file
    }
    seen.set(key, { name, version: info.version, license: typeof pkg.license === 'string' ? pkg.license : 'see text', text });
    visit(info.dependencies);
  }
};
visit(tree.dependencies);
const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(root, 'gen', 'licenses.json'), JSON.stringify(list));
console.log(`built gen/licenses.json (${list.length} packages)`);
