#!/usr/bin/env node
/**
 * scripts/clean.js — remove build artifacts and TypeScript incremental state.
 * Usage: node scripts/clean.js [target...]
 *   default: dist/ + *.tsbuildinfo under the repo
 *   `all`: also node_modules
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = process.argv.slice(2);
const cleanAll = targets.includes('all');

function walk(dir, cb) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch (_e) {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      walk(p, cb);
    } else {
      cb(p);
    }
  }
}

function rm(p) {
  try {
    fs.unlinkSync(p);
  } catch (_e) {
    /* best effort */
  }
}

walk(root, (p) => {
  const rel = path.relative(root, p);
  if (/\.tsbuildinfo$/.test(p)) {
    rm(p);
    console.log('rm ' + rel);
  }
});

for (const pkg of ['aw_core', 'aw_ffmpeg', 'aw_python', 'aw_edge_llm', 'aw_cli']) {
  const dist = path.join(root, 'packages', pkg, 'dist');
  if (fs.existsSync(dist)) {
    fs.rmSync(dist, { recursive: true, force: true });
    console.log('rm packages/' + pkg + '/dist');
  }
}

if (cleanAll) {
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) {
    fs.rmSync(nm, { recursive: true, force: true });
    console.log('rm node_modules');
  }
}

console.log('clean.');
