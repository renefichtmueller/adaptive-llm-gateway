import { getPool } from '../db/client.js';
import { logger } from './logger.js';

export interface FallbackStep {
  callId: string;
  taskType: string;
  primaryModel: string;
  fallbackStep: number;
  fallbackModel?: string;
  provider?: string;
  success: boolean;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  reasonSwitched?: string;
}

export async function recordFallbackStep(step: FallbackStep): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO fallback_chain_metrics
        (call_id, task_type, primary_model, fallback_step, fallback_model, provider, success, tokens_in, tokens_out, latency_ms, reason_switched)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        step.callId,
        step.taskType,
        step.primaryModel,
        step.fallbackStep,
        step.fallbackModel,
        step.provider,
        step.success,
        step.tokensIn,
        step.tokensOut,
        step.latencyMs,
        step.reasonSwitched,
      ],
    );
  } catch (err) {
    logger.error({ err, callId: step.callId }, 'Failed to record fallback step');
  }
}

export async function getFallbackChainStats(
  primaryModel: string,
  taskType?: string,
  daysBack: number = 7,
): Promise<{
  totalAttempts: number;
  successRate: number;
  avgLatencyMs: number;
  modelFallbackRates: Record<string, number>;
}> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT
        COUNT(*) as total_attempts,
        SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*) as success_rate,
        AVG(latency_ms)::int as avg_latency_ms,
        fallback_model,
        COUNT(*) as fallback_count
       FROM fallback_chain_metrics
       WHERE primary_model = $1
         AND created_at > NOW() - INTERVAL '1 day' * $2
         ${taskType ? 'AND task_type = $3' : ''}
       GROUP BY fallback_model
       ORDER BY fallback_count DESC`,
      taskType ? [primaryModel, daysBack, taskType] : [primaryModel, daysBack],
    );

    const totalRow = result.rows[0];
    const modelRates: Record<string, number> = {};

    result.rows.forEach((row) => {
      if (row.fallback_model) {
        modelRates[row.fallback_model] = row.fallback_count / (totalRow?.total_attempts ?? 1);
      }
    });

    return {
      totalAttempts: parseInt(totalRow?.total_attempts ?? '0'),
      successRate: parseFloat(totalRow?.success_rate ?? '0'),
      avgLatencyMs: totalRow?.avg_latency_ms ?? 0,
      modelFallbackRates: modelRates,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to get fallback chain stats');
    return { totalAttempts: 0, successRate: 0, avgLatencyMs: 0, modelFallbackRates: {} };
  }
}
