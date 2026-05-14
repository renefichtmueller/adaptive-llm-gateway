#!/usr/bin/env node
/**
 * Build-drift guard for llm-gateway.
 *
 * Compares mtimes of every .ts file in src/ against the corresponding .js
 * in dist/. If ANY source file is newer than its compiled artifact, the
 * server REFUSES TO START. Run via `prestart` hook in package.json.
 *
 * Rationale: 2026-05-11 outage — compression integration was edited in src
 * but never re-built, so 3004 calls in 24h ran with stale compiled code and
 * the dashboard showed "not tracked" for every row. This guard catches
 * that class of bug at boot time, not in production.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');
const DIST = join(__dirname, '..', 'dist');

function walk(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) results.push(full);
  }
  return results;
}

const stale = [];
for (const srcFile of walk(SRC)) {
  const rel = relative(SRC, srcFile).replace(/\.ts$/, '.js');
  const distFile = join(DIST, rel);
  let distStat;
  try { distStat = statSync(distFile); } catch { continue; }
  const srcStat = statSync(srcFile);
  if (srcStat.mtimeMs > distStat.mtimeMs + 1000) {
    stale.push({ src: rel.replace(/\.js$/, '.ts'), srcMs: srcStat.mtimeMs, distMs: distStat.mtimeMs });
  }
}

if (stale.length > 0) {
  console.error('[build-drift] ⛔ REFUSING TO START — source files newer than compiled dist:');
  for (const s of stale.slice(0, 10)) {
    const age = Math.round((s.srcMs - s.distMs) / 1000);
    console.error(`  ${s.src}  (src is ${age}s newer than dist)`);
  }
  if (stale.length > 10) console.error(`  ... and ${stale.length - 10} more`);
  console.error('[build-drift] Run `npm run build` and try again.');
  process.exit(1);
}

console.log(`[build-drift] OK — all ${walk(SRC).length} src files match dist or older.`);
