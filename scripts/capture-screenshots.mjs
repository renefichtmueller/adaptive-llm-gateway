#!/usr/bin/env node
/**
 * Automated screenshot capture for docs/screenshots/.
 *
 * Usage:
 *   node scripts/capture-screenshots.mjs <gatewayUrl> <bearerToken>
 *
 * Requires `playwright` as a dev-dependency:
 *   npm install -D playwright
 *
 * Captures each dashboard tab at 1600×1000 and writes PNGs into
 * docs/screenshots/. Names match what the main README references.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'docs', 'screenshots');
const GATEWAY = process.argv[2] || 'http://localhost:3103';
const TOKEN = process.argv[3] || process.env.DASHBOARD_AUTH_TOKEN || '';

const CAPTURES = [
  { tab: 'overview',     file: '01-overview.png' },
  { tab: 'subscriptions', file: '02-subscriptions.png' },
  { tab: 'api',          file: '03-api-tab.png' },
  { tab: 'activity',     file: '04-activity.png' },
  { tab: 'savings',      file: '05-savings.png' },
  { tab: 'wallet',       file: '06-wallet.png' },
  { tab: 'memory',       file: '07-memory.png' },
  { tab: 'leaderboard',  file: '08-races.png' },
];

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

if (TOKEN) {
  // Pre-set the dashboard auth token in localStorage so the dashboard auto-loads
  await page.addInitScript(`localStorage.setItem('llmGatewayDashboardToken', '${TOKEN}');`);
}

await page.goto(GATEWAY, { waitUntil: 'networkidle' });

for (const c of CAPTURES) {
  console.log(`Capturing ${c.tab} → ${c.file}`);
  await page.click(`[data-tab="${c.tab}"]`).catch(() => console.warn(`  tab ${c.tab} not found, skipping`));
  await page.waitForTimeout(2000); // let charts render
  await page.screenshot({ path: resolve(OUT_DIR, c.file), fullPage: false });
}

await browser.close();
console.log(`\n✓ Done. PNGs written to ${OUT_DIR}`);
