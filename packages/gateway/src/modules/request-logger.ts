import { Pool } from 'pg';
import { globalRequestStream, type RequestEvent } from './request-stream.js';

/**
 * RequestLogger: Handles logging requests to database and emitting SSE events
 */
export class RequestLogger {
  constructor(private db: Pool) {}

  /**
   * Log a completion request to request_tracking table
   * Also emits event for real-time SSE subscribers
   */
  async logRequest(
    requestId: string,
    caller: string,
    taskType: string | undefined,
    model: string,
    status: 'approved' | 'warning' | 'pending_review' | 'rejected' | 'error',
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
    latencyMs: number,
    confidenceScore?: number,
    fallbackUsed?: boolean,
    errorMessage?: string
  ): Promise<void> {
    const now = new Date();
    const epochSeconds = Math.floor(now.getTime() / 1000);

    try {
      // Write to database
      await this.db.query(
        `
        INSERT INTO request_tracking (
          request_id,
          caller_id,
          task_type,
          model,
          status,
          confidence_score,
          tokens_in,
          tokens_out,
          cost_usd,
          latency_ms,
          fallback_used,
          error_message,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
        [
          requestId,
          caller,
          taskType || null,
          model,
          status,
          confidenceScore || null,
          tokensIn,
          tokensOut,
          costUsd,
          latencyMs,
          fallbackUsed || false,
          errorMessage || null,
          now
        ]
      );

      // Emit SSE event for real-time subscribers
      const event: RequestEvent = {
        request_id: requestId,
        caller,
        task_type: taskType,
        model,
        status,
        confidence_score: confidenceScore,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
        latency_ms: latencyMs,
        fallback_used: fallbackUsed || false,
        error_message: errorMessage,
        timestamp: epochSeconds
      };

      globalRequestStream.emitRequest(event);
    } catch (error) {
      console.error('Error logging request:', error);
      // Don't throw - logging failure shouldn't break request processing
    }
  }

  /**
   * Get recent requests from request_tracking
   * Used by /api/dashboard/requests endpoint
   */
  async getRecentRequests(
    limit: number = 100,
    offsetHours: number = 24
  ): Promise<
    Array<{
      request_id: string;
      caller: string;
      task_type?: string;
      model: string;
      status: string;
      confidence_score?: number;
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
      latency_ms: number;
      fallback_used: boolean;
      compression_mode?: string;
      compression_tokens_before?: number;
      compression_tokens_after?: number;
      compression_tokens_saved?: number;
      compression_savings_pct?: number;
      error_message?: string;
      created_at: string;
    }>
  > {
    const result = await this.db.query(
      `
      SELECT
        rt.request_id,
        rt.caller_id as caller,
        rt.task_type,
        rt.model,
        rt.status,
        rt.confidence_score,
        rt.tokens_in,
        rt.tokens_out,
        rt.cost_usd,
        rt.latency_ms,
        rt.fallback_used,
        tv.mode as compression_mode,
        tv.tokens_before as compression_tokens_before,
        tv.tokens_after as compression_tokens_after,
        GREATEST(COALESCE(tv.tokens_before, 0) - COALESCE(tv.tokens_after, 0), 0) as compression_tokens_saved,
        tv.savings_pct as compression_savings_pct,
        rt.error_message,
        rt.created_at
      FROM request_tracking rt
      LEFT JOIN LATERAL (
        SELECT mode, tokens_before, tokens_after, savings_pct
        FROM tokenvault_metrics
        WHERE tool_used = 'gateway'
          AND file_path = rt.request_id
        ORDER BY created_at DESC
        LIMIT 1
      ) tv ON true
      WHERE rt.created_at > NOW() - MAKE_INTERVAL(hours => $1)
      ORDER BY rt.created_at DESC
      LIMIT $2
      `,
      [offsetHours, limit]
    );

    return result.rows.map((row: any) => ({
      request_id: row.request_id,
      caller: row.caller,
      task_type: row.task_type,
      model: row.model,
      status: row.status,
      confidence_score: row.confidence_score,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      cost_usd: row.cost_usd,
      latency_ms: row.latency_ms,
      fallback_used: row.fallback_used,
      compression_mode: row.compression_mode,
      compression_tokens_before: row.compression_tokens_before ? parseInt(row.compression_tokens_before, 10) : undefined,
      compression_tokens_after: row.compression_tokens_after ? parseInt(row.compression_tokens_after, 10) : undefined,
      compression_tokens_saved: row.compression_tokens_saved ? parseInt(row.compression_tokens_saved, 10) : 0,
      compression_savings_pct: row.compression_savings_pct ? parseFloat(row.compression_savings_pct) : 0,
      error_message: row.error_message,
      created_at: row.created_at
    }));
  }

  /**
   * Get aggregated metrics for dashboard
   */
  async getMetrics(bucketMinutes: number = 60): Promise<{
    total_requests: number;
    total_cost: number;
    estimated_api_cost: number;
    estimated_api_cost_avoided: number;
    total_tokens_in: number;
    total_tokens_out: number;
    total_tokens: number;
    compression_operations: number;
    compression_tokens_before: number;
    compression_tokens_after: number;
    compression_tokens_saved: number;
    compression_rate: number;
    cache_hit_rate: number;
    avg_latency: number;
    success_rate: number;
    avg_confidence: number;
    fallback_percentage: number;
    top_callers: Array<{ caller: string; count: number }>;
    top_models: Array<{ model: string; count: number }>;
    recent_errors: Array<{
      request_id: string;
      caller: string;
      error_message: string;
      created_at: string;
    }>;
  }> {
    const metricsResult = await this.db.query(
      `
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(tokens_out), 0) as total_tokens_out,
        COALESCE(AVG(latency_ms), 0) as avg_latency,
        CASE WHEN COUNT(*) = 0 THEN 0 ELSE SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)::FLOAT / COUNT(*) END as success_rate,
        COALESCE(AVG(confidence_score), 0) as avg_confidence,
        CASE WHEN COUNT(*) = 0 THEN 0 ELSE SUM(CASE WHEN fallback_used = true THEN 1 ELSE 0 END)::FLOAT / COUNT(*) END as fallback_percentage
      FROM request_tracking
      WHERE created_at > NOW() - ($1 * INTERVAL '1 minute')
      `,
      [bucketMinutes]
    );

    const topCallersResult = await this.db.query(
      `
      SELECT caller_id as caller, COUNT(*) as count
      FROM request_tracking
      WHERE created_at > NOW() - ($1 * INTERVAL '1 minute')
      GROUP BY caller_id
      ORDER BY count DESC
      LIMIT 5
      `,
      [bucketMinutes]
    );

    const topModelsResult = await this.db.query(
      `
      SELECT model, COUNT(*) as count
      FROM request_tracking
      WHERE created_at > NOW() - ($1 * INTERVAL '1 minute')
      GROUP BY model
      ORDER BY count DESC
      LIMIT 5
      `,
      [bucketMinutes]
    );

    const recentErrorsResult = await this.db.query(
      `
      SELECT request_id, caller_id as caller, error_message, created_at
      FROM request_tracking
      WHERE status IN ('rejected', 'error')
        AND created_at > NOW() - ($1 * INTERVAL '1 minute')
      ORDER BY created_at DESC
      LIMIT 10
      `,
      [bucketMinutes]
    );

    const compressionResult = await this.db.query(
      `
      SELECT
        COUNT(*) as operations,
        COALESCE(SUM(tokens_before), 0) as tokens_before,
        COALESCE(SUM(tokens_after), 0) as tokens_after,
        COALESCE(SUM(GREATEST(tokens_before - tokens_after, 0)), 0) as tokens_saved
      FROM tokenvault_metrics
      WHERE tool_used = 'gateway'
        AND created_at > NOW() - ($1 * INTERVAL '1 minute')
      `,
      [bucketMinutes]
    );

    const metrics = metricsResult.rows[0];
    const totalTokensIn = parseInt(metrics.total_tokens_in, 10) || 0;
    const totalTokensOut = parseInt(metrics.total_tokens_out, 10) || 0;
    const totalTokens = totalTokensIn + totalTokensOut;
    const compression = compressionResult.rows[0] ?? {};
    const compressionTokensBefore = parseInt(compression.tokens_before, 10) || 0;
    const compressionTokensAfter = parseInt(compression.tokens_after, 10) || 0;
    const compressionTokensSaved = parseInt(compression.tokens_saved, 10) || 0;
    const referenceInputCostPer1k = parseFloat(process.env['REFERENCE_INPUT_COST_PER_1K'] ?? '0.005');
    const referenceOutputCostPer1k = parseFloat(process.env['REFERENCE_OUTPUT_COST_PER_1K'] ?? '0.015');
    const estimatedApiCost = (totalTokensIn / 1000) * referenceInputCostPer1k + (totalTokensOut / 1000) * referenceOutputCostPer1k;
    const totalCost = parseFloat(metrics.total_cost) || 0;

    return {
      total_requests: parseInt(metrics.total_requests) || 0,
      total_cost: totalCost,
      estimated_api_cost: estimatedApiCost,
      estimated_api_cost_avoided: Math.max(0, estimatedApiCost - totalCost),
      total_tokens_in: totalTokensIn,
      total_tokens_out: totalTokensOut,
      total_tokens: totalTokens,
      compression_operations: parseInt(compression.operations, 10) || 0,
      compression_tokens_before: compressionTokensBefore,
      compression_tokens_after: compressionTokensAfter,
      compression_tokens_saved: compressionTokensSaved,
      compression_rate: compressionTokensBefore > 0 ? compressionTokensSaved / compressionTokensBefore : 0,
      cache_hit_rate: 0,
      avg_latency: Math.round(parseFloat(metrics.avg_latency) || 0),
      success_rate: parseFloat(metrics.success_rate) || 0,
      avg_confidence: parseFloat(metrics.avg_confidence) || 0,
      fallback_percentage: parseFloat(metrics.fallback_percentage) || 0,
      top_callers: topCallersResult.rows.map((row: any) => ({
        caller: row.caller,
        count: parseInt(row.count)
      })),
      top_models: topModelsResult.rows.map((row: any) => ({
        model: row.model,
        count: parseInt(row.count)
      })),
      recent_errors: recentErrorsResult.rows.map((row: any) => ({
        request_id: row.request_id,
        caller: row.caller,
        error_message: row.error_message,
        created_at: row.created_at
      }))
    };
  }
}

export const createRequestLogger = (db: Pool): RequestLogger => {
  return new RequestLogger(db);
};
