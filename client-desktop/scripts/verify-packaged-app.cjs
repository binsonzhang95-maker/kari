#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function usage() {
  console.error('usage: node scripts/verify-packaged-app.cjs --asar <app.asar> --resource <resources-dir> --asar-entry <path> [--runtime <path> ...]');
  process.exit(2);
}

const args = process.argv.slice(2);
let asarPath = '';
let resourceDir = '';
const asarEntries = [];
const runtimeEntries = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const next = () => {
    i += 1;
    if (i >= args.length) usage();
    return args[i];
  };
  if (arg === '--asar') asarPath = next();
  else if (arg === '--resource') resourceDir = next();
  else if (arg === '--asar-entry') asarEntries.push(next());
  else if (arg === '--runtime') runtimeEntries.push(next());
  else usage();
}

if (!asarPath || !resourceDir || asarEntries.length === 0) usage();

function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const prelude = Buffer.alloc(16);
    fs.readSync(fd, prelude, 0, prelude.length, 0);
    const jsonSize = prelude.readUInt32LE(12);
    if (!jsonSize || jsonSize > 64 * 1024 * 1024) {
      throw new Error(`invalid asar header size ${jsonSize}`);
    }
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    return JSON.parse(json.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function hasAsarEntry(header, entry) {
  const parts = String(entry || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    if (!node || !node.files || !node.files[part]) return false;
    node = node.files[part];
  }
  return true;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(asarPath)) {
  fail(`app.asar not found: ${asarPath}`);
} else {
  let header = null;
  try {
    header = readAsarHeader(asarPath);
  } catch (err) {
    fail(`cannot read app.asar header: ${err && err.message ? err.message : err}`);
  }
  if (header) {
    for (const entry of asarEntries) {
      if (!hasAsarEntry(header, entry)) {
        fail(`packaged asar is missing ${entry}`);
      }
    }
  }
}

for (const rel of runtimeEntries) {
  const full = path.join(resourceDir, rel);
  if (!fs.existsSync(full)) {
    fail(`packaged runtime is missing ${rel}`);
  }
}

if (process.exitCode) {
  console.error('Renderer/runtime verification failed. Rebuild before packaging and check package.json build.files/extraResources.');
  process.exit(process.exitCode);
}

console.log('Renderer + runtime confirmed inside packaged app.');
