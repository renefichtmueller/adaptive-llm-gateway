/**
 * Federated Stats
 *
 * Multiple gateway instances can opt in to share **anonymized** routing
 * quality stats with each other, so each instance gets the benefit of a
 * larger sample for its adaptive-routing learner without exposing any
 * prompts, responses, or caller identities.
 *
 * What we send:
 *   - hashed task_type fingerprint (not the task_type itself)
 *   - model_used (since model IDs are public)
 *   - sample counts, success rate, avg latency
 *   - gateway version + opt-in node ID (random per install)
 *
 * What we NEVER send:
 *   - prompts, responses, prompt hashes, caller names
 *   - DATABASE_URL, hostnames, IPs, env vars
 *
 * Disabled by default. Enable with FEDERATION_ENABLED=1 + set
 * FEDERATION_PEERS=https://peer1/v1/federation,https://peer2/v1/federation.
 */
import { createHash, randomBytes } from 'crypto';
import { logger } from '../observability/logger.js';

const ENABLED = process.env['FEDERATION_ENABLED'] === '1';
const PEERS = (process.env['FEDERATION_PEERS'] ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const NODE_ID_FILE_HINT = process.env['FEDERATION_NODE_ID']; // optional persistent ID; otherwise we generate per process
const PUBLISH_INTERVAL_MS = parseInt(process.env['FEDERATION_PUBLISH_INTERVAL_MS'] ?? '900000', 10); // 15 min
const VERSION = '0.2.0';

function nodeId(): string {
  if (NODE_ID_FILE_HINT) return NODE_ID_FILE_HINT;
  const buf = randomBytes(8);
  return `node-${buf.toString('hex')}`;
}
const NODE_ID = nodeId();

export interface FederatedStat {
  taskTypeHash: string;     // sha256(task_type).slice(0, 12)
  model: string;
  samples: number;
  successRate: number;
  avgLatencyMs: number;
  gatewayVersion: string;
  nodeId: string;
  emittedAt: string;
}

let publishTimer: NodeJS.Timeout | null = null;

function hashTaskType(taskType: string): string {
  return createHash('sha256').update(taskType).digest('hex').slice(0, 12);
}

/**
 * Collect per-(task_type, model) stats from the local audit log and
 * publish them to every configured peer. Returns the publish summary.
 */
export async function publishToPeers(stats: FederatedStat[]): Promise<{ peer: string; ok: boolean; status?: number; error?: string }[]> {
  if (!ENABLED || PEERS.length === 0) return [];
  return Promise.all(PEERS.map(async (peer) => {
    try {
      const res = await fetch(`${peer}/v1/federation/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stats, nodeId: NODE_ID, gatewayVersion: VERSION }),
      });
      return { peer, ok: res.ok, status: res.status };
    } catch (err) {
      return { peer, ok: false, error: err instanceof Error ? err.message : 'unknown' };
    }
  }));
}

/**
 * Build a FederatedStat[] from an adaptive-routing learner output, without
 * exposing any private info.
 */
export function buildStats(rows: Array<{ task_type: string; model_used: string; samples: number; success_rate: number; avg_latency_ms: number }>): FederatedStat[] {
  const now = new Date().toISOString();
  return rows.map((r) => ({
    taskTypeHash: hashTaskType(r.task_type),
    model: r.model_used,
    samples: r.samples,
    successRate: r.success_rate,
    avgLatencyMs: r.avg_latency_ms,
    gatewayVersion: VERSION,
    nodeId: NODE_ID,
    emittedAt: now,
  }));
}

/**
 * Periodic publisher. Wire from server.ts at boot.
 */
export function scheduleFederationPublisher(getStats: () => Promise<FederatedStat[]>): void {
  if (!ENABLED) {
    logger.info('Federation disabled (set FEDERATION_ENABLED=1 to opt in)');
    return;
  }
  if (PEERS.length === 0) {
    logger.warn('FEDERATION_ENABLED=1 but no FEDERATION_PEERS set — nothing to do');
    return;
  }
  if (publishTimer) return;
  const tick = async (): Promise<void> => {
    try {
      const stats = await getStats();
      if (stats.length === 0) return;
      const results = await publishToPeers(stats);
      const okCount = results.filter((r) => r.ok).length;
      logger.info({ statCount: stats.length, peersOk: okCount, peersTotal: results.length }, 'Federation publish complete');
    } catch (err) {
      logger.error({ err }, 'Federation tick failed');
    }
  };
  // First publish after 5 min boot grace, then every interval
  setTimeout(() => { void tick(); }, 300_000);
  publishTimer = setInterval(() => { void tick(); }, PUBLISH_INTERVAL_MS);
  logger.info({ peers: PEERS.length, intervalMs: PUBLISH_INTERVAL_MS, nodeId: NODE_ID }, 'Federation publisher scheduled');
}

/**
 * Express/Fastify ingest endpoint for incoming peer stats.
 * Wire as `POST /v1/federation/ingest`.
 */
export interface FederationIngestPayload {
  stats: FederatedStat[];
  nodeId: string;
  gatewayVersion: string;
}

const receivedFromPeers: FederatedStat[] = [];

export function ingestPeerStats(payload: FederationIngestPayload): { stored: number } {
  if (!ENABLED) return { stored: 0 };
  if (!Array.isArray(payload?.stats)) return { stored: 0 };
  // Light validation only — discard malformed entries
  let stored = 0;
  for (const s of payload.stats.slice(0, 500)) {
    if (typeof s.taskTypeHash === 'string' && typeof s.model === 'string' && typeof s.samples === 'number') {
      receivedFromPeers.push(s);
      stored += 1;
    }
  }
  // Cap memory at 10k entries; drop oldest
  if (receivedFromPeers.length > 10_000) {
    receivedFromPeers.splice(0, receivedFromPeers.length - 10_000);
  }
  return { stored };
}

export function getPeerStats(): readonly FederatedStat[] {
  return receivedFromPeers;
}

export function getFederationState(): { enabled: boolean; peerCount: number; nodeId: string; receivedFromPeers: number } {
  return {
    enabled: ENABLED,
    peerCount: PEERS.length,
    nodeId: NODE_ID,
    receivedFromPeers: receivedFromPeers.length,
  };
}
