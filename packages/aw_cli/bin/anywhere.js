#!/usr/bin/env node
/**
 * anywhere — the Anywhere CLI bootstrap.
 *
 * Tries the compiled build first; when running from a source checkout with
 * TypeScript present it falls back to on-the-fly compilation (ts-node).
 * Nothing native, nothing compiled ahead of time required.
 */
'use strict';

const path = require('path');

const candidates = [
  path.join(__dirname, '..', 'dist', 'index.js'),
  path.join(__dirname, '..', 'packages', 'aw_cli', 'dist', 'index.js'),
];

let entry = null;
for (const c of candidates) {
  try {
    require.resolve(c);
    entry = c;
    break;
  } catch (_e) {
    /* keep looking */
  }
}

if (!entry) {
  const src = path.join(__dirname, '..', 'packages', 'aw_cli', 'src', 'index.ts');
  try {
    require.resolve('ts-node');
    require('ts-node').register({
      transpileOnly: true,
      compilerOptions: { module: 'commonjs', target: 'es2019', esModuleInterop: true },
    });
    entry = src;
  } catch (_e) {
    console.error(
      'anywhere: no build found. Run `npm run build` in the repository root first,\n' +
        'or install ts-node to run from source.'
    );
    process.exit(1);
  }
}

const mod = require(entry);

// The dist entry self-runs only when it is the main module; here we are the
// main module, so drive runCli ourselves and honour its exit code.
if (mod && typeof mod.runCli === 'function') {
  mod.runCli(process.argv)
    .then((r) => {
      if (r && r.output) console.log(r.output);
      process.exit(r ? r.code : 0);
    })
    .catch((e) => {
      console.error('anywhere:', e && e.message ? e.message : String(e));
      process.exit(1);
    });
}
