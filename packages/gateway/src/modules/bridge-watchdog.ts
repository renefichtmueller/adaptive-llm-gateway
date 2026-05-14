/**
 * Bridge Watchdog
 *
 * Periodically health-checks every running subscription bridge. If a bridge
 * stops responding for `STALE_THRESHOLD_MS`, the watchdog tries to respawn
 * it from the corresponding subscription descriptor. Designed to recover
 * from transient process crashes after an unexpected host reboot or OOM.
 *
 * Wired from server.ts; enable via WATCHDOG_ENABLED=1.
 */
import { logger } from '../observability/logger.js';
import { getRunningBridges, spawnBridge } from './bridge-spawner.js';
import { discoverSubscriptions } from './subscription-discovery.js';

const PROBE_INTERVAL_MS = parseInt(process.env['WATCHDOG_PROBE_INTERVAL_MS'] ?? '60000', 10);
const PROBE_TIMEOUT_MS = parseInt(process.env['WATCHDOG_PROBE_TIMEOUT_MS'] ?? '4000', 10);
const STALE_THRESHOLD_MS = parseInt(process.env['WATCHDOG_STALE_MS'] ?? '180000', 10);

type ProbeOutcome = { ok: boolean; latencyMs: number | null; status?: number };
type Health = { lastOkAt: number; consecutiveFailures: number };

const healthByBridge = new Map<string, Health>();
let timer: NodeJS.Timeout | null = null;

async function probeBridge(url: string): Promise<ProbeOutcome> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: ctrl.signal });
    return { ok: res.ok, latencyMs: Date.now() - t0, status: res.status };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    clearTimeout(t);
  }
}

async function tick(): Promise<void> {
  const running = getRunningBridges();
  for (const b of running) {
    const id = b.descriptor.id;
    const outcome = await probeBridge(b.url);
    const h = healthByBridge.get(id) ?? { lastOkAt: Date.now(), consecutiveFailures: 0 };

    if (outcome.ok) {
      h.lastOkAt = Date.now();
      h.consecutiveFailures = 0;
    } else {
      h.consecutiveFailures += 1;
      const ageMs = Date.now() - h.lastOkAt;
      if (ageMs > STALE_THRESHOLD_MS) {
        logger.warn(
          { id, url: b.url, ageMs, status: outcome.status, consecutiveFailures: h.consecutiveFailures },
          'Bridge stale beyond threshold — respawning',
        );
        try {
          await spawnBridge(b.descriptor);
          h.lastOkAt = Date.now();
          h.consecutiveFailures = 0;
        } catch (err) {
          logger.error({ err, id }, 'Bridge respawn failed');
        }
      }
    }

    healthByBridge.set(id, h);
  }
}

export function startBridgeWatchdog(): void {
  if (process.env['WATCHDOG_ENABLED'] !== '1') {
    logger.info('Bridge watchdog disabled (set WATCHDOG_ENABLED=1 to enable)');
    return;
  }
  if (timer) return; // already running
  // Seed lastOkAt for every bridge that's running at start
  for (const b of getRunningBridges()) {
    healthByBridge.set(b.descriptor.id, { lastOkAt: Date.now(), consecutiveFailures: 0 });
  }
  timer = setInterval(() => {
    void tick().catch((err) => logger.error({ err }, 'Watchdog tick failed'));
  }, PROBE_INTERVAL_MS);
  logger.info({ probeIntervalMs: PROBE_INTERVAL_MS, staleThresholdMs: STALE_THRESHOLD_MS }, 'Bridge watchdog started');
}

export function stopBridgeWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Optional one-shot recovery: scan installed-but-not-running subscriptions
 * and try to spawn them. Useful after a manual `pm2 reload` where some
 * inline bridges may have been lost.
 */
export async function recoverMissingBridges(): Promise<{ recovered: number }> {
  const statuses = await discoverSubscriptions();
  const runningIds = new Set(getRunningBridges().map((b) => b.descriptor.id));
  let recovered = 0;
  for (const s of statuses) {
    if (!s.installed) continue;
    if (runningIds.has(s.descriptor.id)) continue;
    try {
      await spawnBridge(s.descriptor);
      recovered += 1;
    } catch (err) {
      logger.warn({ err, id: s.descriptor.id }, 'Recovery spawn failed');
    }
  }
  return { recovered };
}

/**
 * Health snapshot for the dashboard. Returns per-bridge last-ok-at and
 * consecutive-failure count.
 */
export function getWatchdogHealth(): Record<string, { lastOkAt: number; ageMs: number; consecutiveFailures: number }> {
  const out: Record<string, { lastOkAt: number; ageMs: number; consecutiveFailures: number }> = {};
  for (const [id, h] of healthByBridge.entries()) {
    out[id] = { lastOkAt: h.lastOkAt, ageMs: Date.now() - h.lastOkAt, consecutiveFailures: h.consecutiveFailures };
  }
  return out;
}
