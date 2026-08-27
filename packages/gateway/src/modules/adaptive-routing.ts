/**
 * Cost-aware Adaptive Routing
 *
 * Learns from the audit log which (task_type, model) pairs produce
 * high-confidence outputs at the lowest cost, then publishes a
 * recommendation map that the router consults before falling back to
 * the static routing-rules.yaml.
 *
 * The learner is a periodic scheduler that:
 *   1. Reads recent `llm_calls` rows grouped by task_type + model
 *   2. Computes the success rate (confidence ≥ MIN_CONFIDENCE) and the
 *      mean cost per call
 *   3. Finds the Pareto frontier (best success-rate per cost bucket)
 *   4. Persists recommendations into the `adaptive_routing` table and
 *      reloads its in-memory recommendation map every refresh cycle
 *   5. Warm-starts from `adaptive_routing` at boot, so learned routing
 *      survives restarts even before fresh samples accumulate
 *
 * Pure observation — never overrides explicit `model:` in the request.
 * Enabled by default; set ADAPTIVE_ROUTING_ENABLED=0 to disable.
 * Configurable via env: ADAPTIVE_MIN_SAMPLES, ADAPTIVE_MIN_CONFIDENCE,
 * ADAPTIVE_REFRESH_MS, ADAPTIVE_LOOKBACK_DAYS.
 */
import { logger } from '../observability/logger.js';

const ENABLED = process.env['ADAPTIVE_ROUTING_ENABLED'] !== '0';
const MIN_SAMPLES = parseInt(process.env['ADAPTIVE_MIN_SAMPLES'] ?? '100', 10);
const MIN_CONFIDENCE = parseFloat(process.env['ADAPTIVE_MIN_CONFIDENCE'] ?? '7.0');
const REFRESH_MS = parseInt(process.env['ADAPTIVE_REFRESH_MS'] ?? '900000', 10); // 15 min
const LOOKBACK_DAYS = parseInt(process.env['ADAPTIVE_LOOKBACK_DAYS'] ?? '7', 10);

export interface ModelPerformance {
  taskType: string;
  model: string;
  samples: number;
  successRate: number;       // 0..1 (calls with confidence ≥ MIN_CONFIDENCE)
  avgCostUsd: number;
  avgLatencyMs: number;
  /** Score: success / cost — higher is better */
  score: number;
}

export interface AdaptiveRecommendation {
  taskType: string;
  preferredModel: string;
  fallbackChain: string[];
  rationale: {
    samples: number;
    successRate: number;
    avgCostUsd: number;
    avgLatencyMs: number;
    alternativesConsidered: number;
  };
  updatedAt: string;
}

// ─── In-memory recommendation cache ──────────────────────────────────────────

let recommendations = new Map<string, AdaptiveRecommendation>();
let refreshTimer: NodeJS.Timeout | null = null;

/**
 * Get an adaptive recommendation for a given task_type, if one exists.
 * Returns null when no learned data is available — caller should fall
 * back to the static routing-rules.yaml entry.
 */
export function getAdaptiveRecommendation(taskType: string): AdaptiveRecommendation | null {
  if (!ENABLED) return null;
  return recommendations.get(taskType) ?? null;
}

export function getAllRecommendations(): AdaptiveRecommendation[] {
  return Array.from(recommendations.values());
}

// ─── Learner ─────────────────────────────────────────────────────────────────

type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Load persisted recommendations from the adaptive_routing table into the
 * in-memory map. Called once at boot so learned routing survives restarts.
 */
export async function loadPersistedRecommendations(db: PgClient): Promise<{ loaded: number }> {
  if (!ENABLED) return { loaded: 0 };

  try {
    const result = await db.query(
      `SELECT task_type, preferred_model, fallback_chain, samples, success_rate,
              avg_cost_usd, avg_latency_ms, alternatives, updated_at
       FROM adaptive_routing`,
    );

    const loaded = new Map<string, AdaptiveRecommendation>();
    for (const r of result.rows) {
      const taskType = String(r['task_type']);
      loaded.set(taskType, {
        taskType,
        preferredModel: String(r['preferred_model']),
        fallbackChain: (r['fallback_chain'] as string[]) ?? [],
        rationale: {
          samples: Number(r['samples']),
          successRate: Number(r['success_rate']),
          avgCostUsd: Number(r['avg_cost_usd']),
          avgLatencyMs: Number(r['avg_latency_ms']),
          alternativesConsidered: Number(r['alternatives']),
        },
        updatedAt: new Date(r['updated_at'] as string).toISOString(),
      });
    }

    if (loaded.size > 0) {
      recommendations = loaded;
      logger.info({ taskTypes: loaded.size }, 'Adaptive routing warm-started from adaptive_routing table');
    }
    return { loaded: loaded.size };
  } catch (err) {
    logger.warn({ err }, 'Adaptive routing warm-start failed (table missing or unreadable)');
    return { loaded: 0 };
  }
}

async function persistRecommendations(
  db: PgClient,
  recos: Map<string, AdaptiveRecommendation>,
): Promise<void> {
  for (const reco of recos.values()) {
    await db.query(
      `INSERT INTO adaptive_routing
         (task_type, preferred_model, fallback_chain, samples, success_rate,
          avg_cost_usd, avg_latency_ms, alternatives, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (task_type) DO UPDATE SET
         preferred_model = EXCLUDED.preferred_model,
         fallback_chain = EXCLUDED.fallback_chain,
         samples = EXCLUDED.samples,
         success_rate = EXCLUDED.success_rate,
         avg_cost_usd = EXCLUDED.avg_cost_usd,
         avg_latency_ms = EXCLUDED.avg_latency_ms,
         alternatives = EXCLUDED.alternatives,
         updated_at = NOW()`,
      [
        reco.taskType,
        reco.preferredModel,
        reco.fallbackChain,
        reco.rationale.samples,
        reco.rationale.successRate,
        reco.rationale.avgCostUsd,
        reco.rationale.avgLatencyMs,
        reco.rationale.alternativesConsidered,
      ],
    );
  }

  // Drop rows for task types the learner no longer recommends
  await db.query(
    `DELETE FROM adaptive_routing WHERE NOT (task_type = ANY($1::text[]))`,
    [[...recos.keys()]],
  );
}

/**
 * Run the learner once: read llm_calls, compute performance, update recos.
 * The Pg client is injected so this module stays decoupled from db/client.
 */
export async function runAdaptiveLearner(db: PgClient): Promise<{ updated: number }> {
  if (!ENABLED) return { updated: 0 };
  const t0 = Date.now();

  let rows: Record<string, unknown>[] = [];
  try {
    const result = await db.query(
      `
      SELECT
        task_type,
        model_used,
        COUNT(*) AS samples,
        AVG(CASE WHEN confidence >= $1 THEN 1.0 ELSE 0.0 END) AS success_rate,
        AVG(latency_ms) AS avg_latency_ms,
        AVG(COALESCE((metadata->'cost_usd')::float, 0)) AS avg_cost_usd
      FROM llm_calls
      WHERE created_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
        AND status IN ('approved', 'warning')
      GROUP BY task_type, model_used
      HAVING COUNT(*) >= $2
      `,
      [MIN_CONFIDENCE, MIN_SAMPLES],
    );
    rows = result.rows;
  } catch (err) {
    logger.warn({ err }, 'Adaptive learner: db query failed');
    return { updated: 0 };
  }

  // Group by task_type → compute Pareto frontier (max success_rate ÷ avg_cost)
  const byTask = new Map<string, ModelPerformance[]>();
  for (const r of rows) {
    const perf: ModelPerformance = {
      taskType: String(r['task_type']),
      model: String(r['model_used']),
      samples: Number(r['samples']),
      successRate: Number(r['success_rate']),
      avgCostUsd: Number(r['avg_cost_usd']) || 0.000001, // avoid /0
      avgLatencyMs: Math.round(Number(r['avg_latency_ms']) || 0),
      score: 0,
    };
    perf.score = perf.successRate / Math.max(perf.avgCostUsd, 0.000001);
    const list = byTask.get(perf.taskType) ?? [];
    list.push(perf);
    byTask.set(perf.taskType, list);
  }

  // No fresh data (e.g. right after a restart or a quiet period): keep the
  // current map — which may be warm-started — instead of wiping it.
  if (byTask.size === 0) {
    logger.info({ durationMs: Date.now() - t0 }, 'Adaptive learner: no fresh samples, keeping current recommendations');
    return { updated: 0 };
  }

  const updated = new Map<string, AdaptiveRecommendation>();
  for (const [taskType, perfs] of byTask.entries()) {
    perfs.sort((a, b) => b.score - a.score);
    const best = perfs[0]!;
    const fallback = perfs.slice(1, 4).map((p) => p.model);
    updated.set(taskType, {
      taskType,
      preferredModel: best.model,
      fallbackChain: fallback,
      rationale: {
        samples: best.samples,
        successRate: Math.round(best.successRate * 1000) / 1000,
        avgCostUsd: Math.round(best.avgCostUsd * 100000) / 100000,
        avgLatencyMs: best.avgLatencyMs,
        alternativesConsidered: perfs.length,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  recommendations = updated;

  try {
    await persistRecommendations(db, updated);
  } catch (err) {
    logger.warn({ err }, 'Adaptive learner: persisting recommendations failed (in-memory map still active)');
  }

  logger.info(
    { taskTypes: updated.size, durationMs: Date.now() - t0 },
    'Adaptive learner completed',
  );
  return { updated: updated.size };
}

/**
 * Start the periodic learner. Idempotent.
 */
export function scheduleAdaptiveLearner(db: PgClient): void {
  if (!ENABLED) {
    logger.info('Adaptive routing disabled (ADAPTIVE_ROUTING_ENABLED=0)');
    return;
  }
  if (refreshTimer) return;
  // Warm-start from the table, then run once at startup, then every REFRESH_MS
  void loadPersistedRecommendations(db)
    .then(() => runAdaptiveLearner(db))
    .catch((err) => logger.error({ err }, 'Adaptive learner failed at boot'));
  refreshTimer = setInterval(() => {
    void runAdaptiveLearner(db).catch((err) => logger.error({ err }, 'Adaptive learner failed on schedule'));
  }, REFRESH_MS);
  logger.info({ refreshMs: REFRESH_MS, minSamples: MIN_SAMPLES }, 'Adaptive routing learner scheduled');
}

export function stopAdaptiveLearner(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
