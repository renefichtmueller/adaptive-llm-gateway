import { getPool } from '../db/client.js';
import { recordFallbackStep } from './fallback-tracker.js';
import { logger } from './logger.js';
import type { OllamaResponse } from '../pipeline/llm-client.js';

export interface RoutingDecision {
  callId: string;
  taskType: string;
  caller: string;
  routingModel: string;
  routingTier: string;
  actualModelUsed: string;
  wasFallback: boolean;
  success: boolean;
  confidenceFinal: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
}

export async function recordRoutingDecision(decision: RoutingDecision): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO routing_decisions
        (call_id, task_type, caller, routing_model, routing_tier, actual_model_used, was_fallback, success, confidence_final, tokens_in, tokens_out, latency_ms, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        decision.callId,
        decision.taskType,
        decision.caller,
        decision.routingModel,
        decision.routingTier,
        decision.actualModelUsed,
        decision.wasFallback,
        decision.success,
        decision.confidenceFinal,
        decision.tokensIn,
        decision.tokensOut,
        decision.latencyMs,
        decision.costUsd,
      ],
    );
  } catch (err) {
    logger.error({ err, callId: decision.callId }, 'Failed to record routing decision');
  }
}

export async function trackFallbackChain(
  callId: string,
  taskType: string,
  primaryModel: string,
  fallbackChain: string[],
  results: Array<{ model: string; response?: OllamaResponse; error?: Error; latencyMs: number }>,
): Promise<void> {
  let fallbackStep = 0;
  let lastSuccessIndex = -1;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const isSuccess = !!result.response;

    if (isSuccess) {
      lastSuccessIndex = i;
    }

    if (i > 0) {
      fallbackStep++;
      const reasonSwitched =
        i === 0
          ? undefined
          : results[i - 1].error?.message?.includes('timeout')
            ? 'timeout'
            : results[i - 1].error?.message?.includes('circuit')
              ? 'circuit_breaker'
              : 'model_failure';

      await recordFallbackStep({
        callId,
        taskType,
        primaryModel,
        fallbackStep,
        fallbackModel: result.model,
        success: isSuccess,
        tokensIn: result.response?.prompt_eval_count ?? 0,
        tokensOut: result.response?.eval_count ?? 0,
        latencyMs: result.latencyMs,
        reasonSwitched,
      });
    }
  }
}

export async function getModelSuccessRate(
  model: string,
  taskType?: string,
  daysBack: number = 7,
): Promise<number> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT
        SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*) as success_rate
       FROM routing_decisions
       WHERE actual_model_used = $1
         AND created_at > NOW() - INTERVAL '1 day' * $2
         ${taskType ? 'AND task_type = $3' : ''}`,
      taskType ? [model, daysBack, taskType] : [model, daysBack],
    );

    return parseFloat(result.rows[0]?.success_rate ?? '0');
  } catch (err) {
    logger.error({ err }, 'Failed to get model success rate');
    return 0;
  }
}

export async function updateModelRankings(): Promise<void> {
  const pool = getPool();
  try {
    const updates = await pool.query(
      `UPDATE model_performance
       SET
         success_rate = (
           SELECT ROUND(SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*) * 100, 2)
           FROM routing_decisions
           WHERE actual_model_used = model_performance.model
             AND (model_performance.task_type IS NULL OR task_type = model_performance.task_type)
             AND created_at > NOW() - INTERVAL '7 day'
         ),
         avg_latency_ms = (
           SELECT AVG(latency_ms)::int
           FROM routing_decisions
           WHERE actual_model_used = model_performance.model
             AND (model_performance.task_type IS NULL OR task_type = model_performance.task_type)
             AND created_at > NOW() - INTERVAL '7 day'
         ),
         total_calls = (
           SELECT COUNT(*)
           FROM routing_decisions
           WHERE actual_model_used = model_performance.model
             AND (model_performance.task_type IS NULL OR task_type = model_performance.task_type)
             AND created_at > NOW() - INTERVAL '7 day'
         ),
         last_updated = NOW()
       WHERE last_updated < NOW() - INTERVAL '1 hour'`,
    );

    logger.info({ updated: updates.rowCount }, 'Model rankings updated');
  } catch (err) {
    logger.error({ err }, 'Failed to update model rankings');
  }
}
