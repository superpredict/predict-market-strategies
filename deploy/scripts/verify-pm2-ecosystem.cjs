#!/usr/bin/env node
/**
 * Preflight checks for `takerbot/ecosystem.config.cjs` before deploy / push.
 * Run from repo root: `node deploy/scripts/verify-pm2-ecosystem.cjs`
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const ECOSYSTEM = path.join(ROOT, 'takerbot', 'ecosystem.config.cjs');

function main() {
  if (!fs.existsSync(ECOSYSTEM)) {
    console.error('ERROR: missing', ECOSYSTEM);
    process.exit(1);
  }

  const mod = require(ECOSYSTEM);
  const apps = mod.apps || [];

  if (apps.length === 0) {
    console.error('ERROR: ecosystem has no apps');
    process.exit(1);
  }

  let failed = false;

  for (const app of apps) {
    const label = app.name || '(unnamed)';
    const script = app.script != null ? String(app.script) : '';
    const args = app.args != null ? String(app.args).trim() : '';
    const cwd = app.cwd != null ? String(app.cwd) : '';

    if (!script) {
      console.error(`ERROR: [${label}] missing script`);
      failed = true;
      continue;
    }

    if (script.includes('/.bin/tsx')) {
      console.error(
        `ERROR: [${label}] script must not be node_modules/.bin/tsx (shell shim). Got:`,
        script,
      );
      failed = true;
    }

    if (!script.endsWith('cli.mjs')) {
      console.error(`ERROR: [${label}] script must end with cli.mjs (tsx CLI). Got:`, script);
      failed = true;
    }

    if (!fs.existsSync(script)) {
      console.error(`ERROR: [${label}] script file does not exist:`, script);
      failed = true;
    }

    if (!path.isAbsolute(script)) {
      console.error(`ERROR: [${label}] script must be an absolute path (PM2 + VPS clarity). Got:`, script);
      failed = true;
    }

    if (app.interpreter !== 'node') {
      console.error(`ERROR: [${label}] interpreter must be "node" for tsx cli.mjs. Got:`, app.interpreter);
      failed = true;
    }

    if (app.exec_mode !== 'fork') {
      console.error(`ERROR: [${label}] exec_mode must be "fork" (avoid cluster shim issues). Got:`, app.exec_mode);
      failed = true;
    }

    if (!args) {
      console.error(`ERROR: [${label}] missing args (entry .ts path)`);
      failed = true;
    } else if (!fs.existsSync(args)) {
      console.error(`ERROR: [${label}] entry file does not exist:`, args);
      failed = true;
    }

    if (cwd && path.resolve(cwd) !== path.resolve(ROOT)) {
      console.error(`ERROR: [${label}] cwd must be repo ROOT for consistent resolution. Expected:`, ROOT, 'Got:', cwd);
      failed = true;
    }
  }

  if (failed) {
    console.error('\nFix ecosystem.config.cjs, run `pnpm install`, then re-run this script.');
    process.exit(1);
  }

  console.log(`OK: ${apps.length} PM2 app(s) — tsx CLI and entry files exist; fork + interpreter checks passed.`);
  console.log('    Repo:', ROOT);
}

main();
