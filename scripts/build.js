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
