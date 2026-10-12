/**
 * Per-Caller Deep Dive
 *
 * Aggregates everything we know about ONE caller — its volume, models used,
 * cache effectiveness, cost, latency distribution, recent activity, and
 * stored memory facts. Powers the modal that opens when a user clicks on
 * a caller chip in the dashboard.
 */
import type { Pool } from 'pg';
import { logger } from '../observability/logger.js';

export interface CallerDeepDive {
  caller: string;
  firstSeen: string | null;
  lastSeen: string | null;
  totalRequests: number;
  successRate: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  avgLatencyMs: number;
  /** distribution: p50, p95 */
  latencyP50: number;
  latencyP95: number;
  cacheHits: number;
  cacheTokensSaved: number;
  topModels: Array<{ model: string; count: number; share: number }>;
  topTaskTypes: Array<{ taskType: string; count: number }>;
  recentRequests: Array<{
    request_id: string;
    model: string;
    status: string;
    tokens_in: number;
    tokens_out: number;
    latency_ms: number;
    cost_usd: number;
    created_at: string;
  }>;
  storedFacts: Array<{ key: string; value: string; confidence: number; source: string }>;
  hourlyHeatmap: Array<{ hour: number; count: number }>;
}

export async function getCallerDeepDive(db: Pool, caller: string): Promise<CallerDeepDive | null> {
  const c = caller.trim().toLowerCase();
  try {
    // Headline aggregates
    const head = await db.query(`
      SELECT
        COUNT(*)::INT AS total,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*),0) AS success_rate,
        COALESCE(SUM(tokens_in), 0)::BIGINT AS tok_in,
        COALESCE(SUM(tokens_out), 0)::BIGINT AS tok_out,
        COALESCE(SUM(cost_usd), 0)::NUMERIC AS cost,
        COALESCE(AVG(latency_ms), 0)::INT AS avg_lat,
        COALESCE(PERCENTILE_DISC(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::INT AS p50,
        COALESCE(PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::INT AS p95
      FROM request_tracking
      WHERE caller_id = $1
    `, [c]);
    const h = head.rows[0];
    if (!h || parseInt(h.total, 10) === 0) {
      return null;
    }

    const total = parseInt(h.total, 10) || 0;

    // Top models by this caller
    const models = await db.query(`
      SELECT model, COUNT(*)::INT AS cnt
      FROM request_tracking
      WHERE caller_id = $1
      GROUP BY model
      ORDER BY cnt DESC
      LIMIT 10
    `, [c]);

    const topModels = models.rows.map((r: any) => ({
      model: r.model,
      count: parseInt(r.cnt, 10) || 0,
      share: total > 0 ? parseFloat(((parseInt(r.cnt, 10) / total) * 100).toFixed(1)) : 0,
    }));

    // Top task types
    const tasks = await db.query(`
      SELECT task_type, COUNT(*)::INT AS cnt
      FROM request_tracking
      WHERE caller_id = $1
      GROUP BY task_type
      ORDER BY cnt DESC
      LIMIT 8
    `, [c]);
    const topTaskTypes = tasks.rows.map((r: any) => ({
      taskType: r.task_type ?? '(unknown)',
      count: parseInt(r.cnt, 10) || 0,
    }));

    // Cache stats for this caller
    const cache = await db.query(`
      SELECT
        COALESCE(SUM(hit_count), 0)::INT AS hits,
        COALESCE(SUM(tokens_saved), 0)::BIGINT AS tokens
      FROM response_cache
      WHERE caller_id = $1
    `, [c]);
    const cacheHits = parseInt(cache.rows[0]?.hits ?? '0', 10);
    const cacheTokens = parseInt(cache.rows[0]?.tokens ?? '0', 10);

    // Recent requests (15 latest)
    const recent = await db.query(`
      SELECT request_id, model, status, tokens_in, tokens_out, latency_ms, cost_usd, created_at
      FROM request_tracking
      WHERE caller_id = $1
      ORDER BY created_at DESC
      LIMIT 15
    `, [c]);

    // Stored facts
    let storedFacts: any[] = [];
    try {
      const facts = await db.query(`
        SELECT fact_key, fact_value, confidence, source
        FROM caller_knowledge
        WHERE caller_id = $1 AND superseded_by IS NULL
          AND (valid_until IS NULL OR valid_until > NOW())
        ORDER BY confidence DESC
        LIMIT 20
      `, [c]);
      storedFacts = facts.rows.map((r: any) => ({
        key: r.fact_key, value: r.fact_value,
        confidence: parseFloat(r.confidence), source: r.source ?? '',
      }));
    } catch {
      // caller_knowledge table may not exist yet — stats stay empty
    }

    // Hourly heatmap (24h)
    const hourly = await db.query(`
      SELECT EXTRACT(HOUR FROM created_at)::INT AS hr, COUNT(*)::INT AS cnt
      FROM request_tracking
      WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY hr
      ORDER BY hr ASC
    `, [c]);
    const hourlyMap = new Map<number, number>(hourly.rows.map((r: any): [number, number] => [parseInt(r.hr, 10), parseInt(r.cnt, 10)]));
    const hourlyHeatmap = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: hourlyMap.get(i) ?? 0 }));

    return {
      caller: c,
      firstSeen: h.first_seen ? new Date(h.first_seen).toISOString() : null,
      lastSeen: h.last_seen ? new Date(h.last_seen).toISOString() : null,
      totalRequests: total,
      successRate: parseFloat(h.success_rate) || 0,
      totalTokensIn: parseInt(h.tok_in, 10) || 0,
      totalTokensOut: parseInt(h.tok_out, 10) || 0,
      totalCost: parseFloat(h.cost) || 0,
      avgLatencyMs: parseInt(h.avg_lat, 10) || 0,
      latencyP50: parseInt(h.p50, 10) || 0,
      latencyP95: parseInt(h.p95, 10) || 0,
      cacheHits,
      cacheTokensSaved: cacheTokens,
      topModels,
      topTaskTypes,
      recentRequests: recent.rows.map((r: any) => ({
        request_id: r.request_id,
        model: r.model,
        status: r.status,
        tokens_in: parseInt(r.tokens_in, 10) || 0,
        tokens_out: parseInt(r.tokens_out, 10) || 0,
        latency_ms: parseInt(r.latency_ms, 10) || 0,
        cost_usd: parseFloat(r.cost_usd) || 0,
        created_at: new Date(r.created_at).toISOString(),
      })),
      storedFacts,
      hourlyHeatmap,
    };
  } catch (err) {
    logger.warn({ err, caller: c }, 'caller-stats: deep dive failed');
    return null;
  }
}
