// Tokenvault Integration Hooks
// Instruments LeanCTX and RTK compression tracking
// Updated: 2026-04-19

import { Pool } from 'pg';
import { logger } from '../observability/logger.js';

export interface CompressionMetric {
  filePath: string;
  mode: string;
  tokensBefore: number;
  tokensAfter: number;
  savingsPct: number;
  toolUsed: string;
}

export interface TokenCompressionContext {
  callId: string;
  agent: string;
  model: string;
  project: string;
  taskType: string;
}

/**
 * Log compression metrics to database
 */
export async function logCompressionMetric(
  db: Pool,
  metric: CompressionMetric
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO tokenvault_metrics
       (file_path, mode, tokens_before, tokens_after, savings_pct, tool_used)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        metric.filePath,
        metric.mode,
        metric.tokensBefore,
        metric.tokensAfter,
        metric.savingsPct,
        metric.toolUsed
      ]
    );

    logger.debug({
      savingsPct: metric.savingsPct
    }, `Compression logged: ${metric.filePath} via ${metric.mode}`);
  } catch (error) {
    logger.error({ error }, 'Failed to log compression metric');
  }
}

/**
 * Estimate tokens using simple character counting
 * Approximation: ~4 characters = 1 token (varies by model)
 */
export function estimateTokens(text: string | object): number {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(str.length / 4);
}

/**
 * Log compression ratio for RTK output
 */
export async function logRTKCompression(
  db: Pool,
  rawOutput: string,
  compressedOutput: string,
  toolUsed: string = 'rtk'
): Promise<CompressionMetric> {
  const tokensBefore = estimateTokens(rawOutput);
  const tokensAfter = estimateTokens(compressedOutput);
  const savingsPct =
    tokensBefore > 0
      ? parseFloat(
          (((tokensBefore - tokensAfter) / tokensBefore) * 100).toFixed(2)
        )
      : 0;

  const metric: CompressionMetric = {
    filePath: 'output',
    mode: toolUsed,
    tokensBefore,
    tokensAfter,
    savingsPct,
    toolUsed: 'gateway'
  };

  await logCompressionMetric(db, metric);
  return metric;
}

/**
 * Track LeanCTX file read operations
 */
export async function logLeanCTXRead(
  db: Pool,
  filePath: string,
  mode: string,
  rawTokens: number,
  compressedTokens: number
): Promise<void> {
  const savingsPct =
    rawTokens > 0
      ? parseFloat(
          (((rawTokens - compressedTokens) / rawTokens) * 100).toFixed(2)
        )
      : 0;

  const metric: CompressionMetric = {
    filePath,
    mode,
    tokensBefore: rawTokens,
    tokensAfter: compressedTokens,
    savingsPct,
    toolUsed: 'lean-ctx'
  };

  await logCompressionMetric(db, metric);
}

/**
 * Calculate and log cost impact
 */
export async function logCostImpact(
  db: Pool,
  callId: string,
  context: TokenCompressionContext,
  tokensIn: number,
  tokensOut: number,
  tokensCompressed: number,
  costUsd: number,
  costSavedUsd: number,
  confidenceScore: number
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO cost_analytics
       (call_id, project, task_type, model, agent_id, tokens_in, tokens_out,
        tokens_compressed, cost_usd, cost_saved_usd, provider, confidence_score, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
      [
        callId,
        context.project,
        context.taskType,
        context.model,
        context.agent,
        tokensIn,
        tokensOut,
        tokensCompressed,
        costUsd,
        costSavedUsd,
        extractProvider(context.model),
        confidenceScore
      ]
    );

    logger.info({
      project: context.project,
      task: context.taskType,
      model: context.model,
      cost: costUsd,
      saved: costSavedUsd,
      compression: `${tokensCompressed}/${tokensIn + tokensOut}`
    }, `Cost tracked [${callId}]`);
  } catch (error) {
    logger.error({ error }, 'Failed to log cost impact');
  }
}

/**
 * Extract provider from model identifier
 */
function extractProvider(model: string): string {
  if (model.startsWith('ollama:')) return 'ollama';
  if (model === 'claude-code') return 'claude';
  if (model.includes('qwen')) return 'ollama';
  if (model.includes('llama')) return 'ollama';
  if (model === 'cerebras') return 'cerebras';
  if (model === 'groq') return 'groq';
  if (model === 'mistral') return 'mistral';
  if (model.includes('nvidia')) return 'nvidia-nim';
  if (model.includes('cloudflare')) return 'cloudflare';
  return 'unknown';
}

/**
 * Get compression statistics for a time period
 */
export async function getCompressionStats(
  db: Pool,
  hoursBack: number = 24
): Promise<{
  totalTokensBefore: number;
  totalTokensAfter: number;
  avgSavingsPct: number;
  byTool: Record<string, { count: number; avgSavings: number }>;
}> {
  try {
    const result = await db.query(
      `SELECT
        SUM(tokens_before) as total_before,
        SUM(tokens_after) as total_after,
        AVG(savings_pct) as avg_savings,
        tool_used,
        COUNT(*) as count
       FROM tokenvault_metrics
       WHERE created_at > NOW() - INTERVAL $1 HOUR
       GROUP BY tool_used`,
      [hoursBack]
    );

    const totalBefore =
      result.rows[0]?.total_before || 0;
    const totalAfter =
      result.rows[0]?.total_after || 0;
    const byTool: Record<string, { count: number; avgSavings: number }> = {};

    for (const row of result.rows) {
      byTool[row.tool_used] = {
        count: row.count,
        avgSavings: parseFloat(row.avg_savings || 0)
      };
    }

    const avgSavingsPct =
      totalBefore > 0
        ? parseFloat(
            (((totalBefore - totalAfter) / totalBefore) * 100).toFixed(2)
          )
        : 0;

    return {
      totalTokensBefore: totalBefore,
      totalTokensAfter: totalAfter,
      avgSavingsPct,
      byTool
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get compression stats');
    return {
      totalTokensBefore: 0,
      totalTokensAfter: 0,
      avgSavingsPct: 0,
      byTool: {}
    };
  }
}

/**
 * Get cost summary for a time period
 */
export async function getCostSummary(
  db: Pool,
  hoursBack: number = 24
): Promise<{
  totalCost: number;
  totalSaved: number;
  taskCount: number;
  byProject: Record<string, { cost: number; saved: number; count: number }>;
}> {
  try {
    const result = await db.query(
      `SELECT
        SUM(cost_usd) as total_cost,
        SUM(cost_saved_usd) as total_saved,
        COUNT(*) as count,
        project,
        SUM(CASE WHEN cost_usd > 0 THEN 1 ELSE 0 END) as paid_tasks
       FROM cost_analytics
       WHERE created_at > NOW() - INTERVAL $1 HOUR
       GROUP BY project`,
      [hoursBack]
    );

    let totalCost = 0;
    let totalSaved = 0;
    let taskCount = 0;
    const byProject: Record<
      string,
      { cost: number; saved: number; count: number }
    > = {};

    for (const row of result.rows) {
      totalCost += row.total_cost || 0;
      totalSaved += row.total_saved || 0;
      taskCount += row.count || 0;

      byProject[row.project] = {
        cost: row.total_cost || 0,
        saved: row.total_saved || 0,
        count: row.count || 0
      };
    }

    return {
      totalCost: parseFloat(totalCost.toFixed(6)),
      totalSaved: parseFloat(totalSaved.toFixed(6)),
      taskCount,
      byProject
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get cost summary');
    return {
      totalCost: 0,
      totalSaved: 0,
      taskCount: 0,
      byProject: {}
    };
  }
}
