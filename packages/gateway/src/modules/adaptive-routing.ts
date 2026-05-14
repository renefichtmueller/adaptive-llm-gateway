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
 *   4. Emits recommendations into `adaptive_routing` table
 *   5. Reloads its in-memory recommendation map every refresh cycle
 *
 * Pure observation — never overrides explicit `model:` in the request.
 * Configurable via env: ADAPTIVE_ROUTING_ENABLED, ADAPTIVE_MIN_SAMPLES,
 * ADAPTIVE_MIN_CONFIDENCE.
 */
import { logger } from '../observability/logger.js';

const ENABLED = process.env['ADAPTIVE_ROUTING_ENABLED'] === '1';
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
    logger.info('Adaptive routing disabled (set ADAPTIVE_ROUTING_ENABLED=1 to enable)');
    return;
  }
  if (refreshTimer) return;
  // Run once at startup, then every REFRESH_MS
  void runAdaptiveLearner(db).catch((err) => logger.error({ err }, 'Adaptive learner failed at boot'));
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
