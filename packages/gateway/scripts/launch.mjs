#!/usr/bin/env node
/**
 * PM2 entry point for llm-gateway.
 *
 * Runs the build-drift guard FIRST, then imports the compiled server.
 * PM2's `script:` directive bypasses npm scripts, so this wrapper is the
 * only place the guard can run before traffic hits the gateway.
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, 'check-build-drift.mjs');
const SERVER = join(__dirname, '..', 'dist', 'server.js');

try {
  execSync(`node ${GUARD}`, { stdio: 'inherit' });
} catch {
  console.error('[launch] build-drift guard failed — refusing to start');
  process.exit(1);
}

// Drift OK → start the gateway
await import(SERVER);
