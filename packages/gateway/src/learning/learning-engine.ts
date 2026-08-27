import { getPool } from '../db/client.js';
import { logger } from '../observability/logger.js';
import { getFallbackChainStats } from '../observability/fallback-tracker.js';

export interface ImprovementInsight {
  type: 'model_underperforming' | 'fallback_overused' | 'slow_model' | 'confidence_drift';
  model: string;
  taskType?: string;
  metric: string;
  current: number;
  threshold: number;
  recommendation: string;
  severity: 'low' | 'medium' | 'high';
}

export async function runLearningCycle(
  duration: '6h' | '12h' | '24h' = '12h',
): Promise<{ improvements: ImprovementInsight[]; changes: number }> {
  const pool = getPool();
  const cycleId = `cycle-${Date.now()}`;

  try {
    await pool.query('BEGIN');

    const changes = await analyzeAndImprove(pool, duration);
    const improvements = await detectImprovements(pool, duration);

    await logCycle(pool, cycleId, duration, improvements, changes);
    await pool.query('COMMIT');

    logger.info(
      { cycleId, duration, improvements: improvements.length, changes },
      'Learning cycle completed',
    );

    return { improvements, changes };
  } catch (err) {
    await pool.query('ROLLBACK');
    logger.error({ err, cycleId, duration }, 'Learning cycle failed');
    return { improvements: [], changes: 0 };
  }
}

async function detectImprovements(
  pool: any,
  duration: string,
): Promise<ImprovementInsight[]> {
  const insights: ImprovementInsight[] = [];
  const daysBack = duration === '6h' ? 0.25 : duration === '12h' ? 0.5 : 1;

  // Check model underperformance
  const perfResult = await pool.query(
    `SELECT model, task_type, success_rate, avg_latency_ms, total_calls
     FROM model_performance
     WHERE (success_rate < 0.75 OR avg_latency_ms > 30000)
       AND total_calls > 10
     ORDER BY success_rate ASC
     LIMIT 10`,
  );

  for (const row of perfResult.rows) {
    if (row.success_rate < 0.75) {
      insights.push({
        type: 'model_underperforming',
        model: row.model,
        taskType: row.task_type,
        metric: 'success_rate',
        current: row.success_rate,
        threshold: 0.75,
        recommendation: `Route ${row.task_type} away from ${row.model} (${(row.success_rate * 100).toFixed(1)}% success)`,
        severity: row.success_rate < 0.5 ? 'high' : 'medium',
      });
    }

    if (row.avg_latency_ms > 30000) {
      insights.push({
        type: 'slow_model',
        model: row.model,
        taskType: row.task_type,
        metric: 'latency_ms',
        current: row.avg_latency_ms,
        threshold: 30000,
        recommendation: `${row.model} is slow (${row.avg_latency_ms}ms). Consider using faster fallback for ${row.task_type}.`,
        severity: row.avg_latency_ms > 60000 ? 'high' : 'medium',
      });
    }
  }

  // Check fallback overuse
  const routingResult = await pool.query(
    `SELECT routing_model, task_type, COUNT(*) as total, SUM(CASE WHEN was_fallback THEN 1 ELSE 0 END) as fallback_count
     FROM routing_decisions
     WHERE created_at > NOW() - MAKE_INTERVAL(days => $1)
     GROUP BY routing_model, task_type
     HAVING SUM(CASE WHEN was_fallback THEN 1 ELSE 0 END)::float / COUNT(*) > 0.3
     ORDER BY fallback_count DESC
     LIMIT 10`,
    [daysBack],
  );

  for (const row of routingResult.rows) {
    const fallbackRate = row.fallback_count / row.total;
    if (fallbackRate > 0.5) {
      insights.push({
        type: 'fallback_overused',
        model: row.routing_model,
        taskType: row.task_type,
        metric: 'fallback_rate',
        current: fallbackRate,
        threshold: 0.3,
        recommendation: `${row.routing_model} fails ${(fallbackRate * 100).toFixed(1)}% for ${row.task_type}. Reconsider routing or model.`,
        severity: 'high',
      });
    }
  }

  return insights;
}

async function analyzeAndImprove(pool: any, duration: string): Promise<number> {
  let changes = 0;

  // 1. Update model_performance aggregates.
  // success_rate is stored as a fraction 0–1 (matching detectImprovements
  // and the learning-insights route), NOT as a percentage.
  const updatePerf = await pool.query(
    `UPDATE model_performance mp
     SET
       success_rate = (SELECT ROUND((SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0))::numeric, 4)
                       FROM routing_decisions rd
                       WHERE rd.routing_model = mp.model
                         AND (mp.task_type IS NULL OR rd.task_type = mp.task_type)
                         AND rd.created_at > NOW() - INTERVAL '1 day'),
       avg_latency_ms = (SELECT AVG(latency_ms)::int
                         FROM routing_decisions rd
                         WHERE rd.routing_model = mp.model
                           AND (mp.task_type IS NULL OR rd.task_type = mp.task_type)
                           AND rd.created_at > NOW() - INTERVAL '1 day'),
       total_calls = (SELECT COUNT(*)
                      FROM routing_decisions rd
                      WHERE rd.routing_model = mp.model
                        AND (mp.task_type IS NULL OR rd.task_type = mp.task_type)
                        AND rd.created_at > NOW() - INTERVAL '1 day'),
       confidence_avg = (SELECT AVG(confidence_final)
                         FROM routing_decisions rd
                         WHERE rd.routing_model = mp.model
                           AND (mp.task_type IS NULL OR rd.task_type = mp.task_type)
                           AND rd.created_at > NOW() - INTERVAL '1 day'),
       last_updated = NOW()
     WHERE last_updated < NOW() - INTERVAL '1 hour'`,
  );

  changes += updatePerf.rowCount ?? 0;

  // 2. Identify best-performing models per task type and insert recommendations
  const bestModels = await pool.query(
    `SELECT DISTINCT ON (task_type)
       task_type,
       routing_model,
       ROUND((SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*))::numeric, 4) as success_rate,
       AVG(latency_ms)::int as avg_latency_ms
     FROM routing_decisions rd
     WHERE created_at > NOW() - INTERVAL '1 day'
     GROUP BY task_type, routing_model
     ORDER BY task_type, (SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*)) DESC, AVG(latency_ms) ASC`,
  );

  for (const row of bestModels.rows) {
    const insert = await pool.query(
      `INSERT INTO model_performance (model, task_type, success_rate, avg_latency_ms, total_calls)
       VALUES ($1, $2, $3, $4, (SELECT COUNT(*) FROM routing_decisions WHERE routing_model = $1 AND task_type = $2))
       ON CONFLICT (model, task_type) DO UPDATE
       SET success_rate = EXCLUDED.success_rate, avg_latency_ms = EXCLUDED.avg_latency_ms`,
      [row.routing_model, row.task_type, row.success_rate, row.avg_latency_ms],
    );

    changes += insert.rowCount ?? 0;
  }

  return changes;
}

async function logCycle(
  pool: any,
  cycleId: string,
  duration: string,
  improvements: ImprovementInsight[],
  changes: number,
): Promise<void> {
  const severeCounts = improvements.filter((i) => i.severity === 'high').length;

  await pool.query(
    `INSERT INTO learning_cycles (cycle_id, cycle_duration, improvements_found, routing_changes, model_rankings_updated, status, started_at, completed_at, metrics)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7)`,
    [
      cycleId,
      duration,
      improvements.length,
      changes,
      changes > 0,
      severeCounts > 0 ? 'needs_review' : 'completed',
      JSON.stringify({
        highSeverity: severeCounts,
        improvementsByType: improvements.reduce(
          (acc, i) => {
            acc[i.type] = (acc[i.type] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
      }),
    ],
  );
}

export async function scheduleLearningCycles(): Promise<void> {
  // Initial cycle shortly after boot so learning starts immediately instead
  // of waiting six hours for the first interval to elapse.
  setTimeout(() => {
    void runLearningCycle('6h');
  }, 2 * 60 * 1000);

  // Run cycles at intervals
  setInterval(async () => {
    await runLearningCycle('6h');
  }, 6 * 60 * 60 * 1000);

  setInterval(async () => {
    await runLearningCycle('12h');
  }, 12 * 60 * 60 * 1000);

  setInterval(async () => {
    await runLearningCycle('24h');
  }, 24 * 60 * 60 * 1000);

  logger.info('Learning cycles scheduled (6h, 12h, 24h; first cycle in 2 min)');
}
