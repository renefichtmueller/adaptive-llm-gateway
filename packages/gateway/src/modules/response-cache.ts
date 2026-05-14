/**
 * Response Cache
 *
 * Two-tier cache:
 *   • Tier 1 (exact)    — sha256 of canonical request → instant lookup, $0 cost
 *   • Tier 2 (semantic) — embedding cosine similarity, served via in-process
 *                          rerank when threshold is met. Implemented in v1 as
 *                          a string-similarity heuristic until pgvector is
 *                          provisioned. The interface is forward-compatible.
 *
 * Cache hits skip the entire LLM pipeline. Each hit increments the saved-cost
 * counter so the dashboard can show real savings in real time.
 */

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { logger } from '../observability/logger.js';
import { embed, vectorToPgLiteral, EMBEDDING_DIMENSION } from './embedding-client.js';

export interface CacheableRequest {
  caller: string;
  task_type?: string;
  model?: string;
  system?: string;
  input: string;
}

export interface CachedResponse {
  id: number;
  cacheKey: string;
  responseJson: Record<string, unknown>;
  costWhenCached: number;
  tokensIn: number;
  tokensOut: number;
  hitCount: number;
  ageSeconds: number;
}

/**
 * Compute a stable cache key for a request. Whitespace is collapsed and
 * lowercase used for the hash so functionally identical requests collide.
 */
export function computeCacheKey(req: CacheableRequest): string {
  const canonical = [
    `caller=${req.caller.trim().toLowerCase()}`,
    `task=${(req.task_type ?? '').trim().toLowerCase()}`,
    `model=${(req.model ?? '').trim().toLowerCase()}`,
    `system=${(req.system ?? '').trim().replace(/\s+/g, ' ').slice(0, 4096)}`,
    `input=${req.input.trim().replace(/\s+/g, ' ').slice(0, 16_384)}`,
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Look up an exact cache hit. Returns null when no fresh entry exists. */
export async function getCachedResponse(
  db: Pool,
  cacheKey: string
): Promise<CachedResponse | null> {
  try {
    const result = await db.query(
      `
      SELECT id, cache_key, response_json, cost_when_cached, tokens_in, tokens_out,
             hit_count, EXTRACT(EPOCH FROM (NOW() - created_at))::INT AS age_seconds,
             ttl_seconds
      FROM response_cache
      WHERE cache_key = $1
        AND (created_at + (ttl_seconds * INTERVAL '1 second')) > NOW()
      LIMIT 1
      `,
      [cacheKey]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      cacheKey: row.cache_key,
      responseJson: row.response_json,
      costWhenCached: parseFloat(row.cost_when_cached) || 0,
      tokensIn: parseInt(row.tokens_in, 10) || 0,
      tokensOut: parseInt(row.tokens_out, 10) || 0,
      hitCount: parseInt(row.hit_count, 10) || 0,
      ageSeconds: parseInt(row.age_seconds, 10) || 0,
    };
  } catch (err) {
    logger.warn({ err }, 'response-cache: getCachedResponse failed (table missing?)');
    return null;
  }
}

/**
 * Look up a fuzzy/semantic match using pgvector cosine similarity.
 * Returns null when:
 *   • embedding generation fails (Ollama down, model missing)
 *   • no entry crosses the similarity threshold
 *   • the table doesn't yet have the embedding column
 */
export async function getSemanticCachedResponse(
  db: Pool,
  caller: string,
  taskType: string | undefined,
  inputText: string,
  similarityThreshold: number = 0.92
): Promise<(CachedResponse & { similarity: number }) | null> {
  const vec = await embed(inputText);
  if (!vec) return null;

  try {
    const result = await db.query(
      `
      SELECT id, cache_key, response_json, cost_when_cached, tokens_in, tokens_out,
             hit_count, EXTRACT(EPOCH FROM (NOW() - created_at))::INT AS age_seconds,
             1 - (embedding <=> $1::vector) AS similarity
      FROM response_cache
      WHERE caller_id = $2
        AND ($3::TEXT IS NULL OR task_type = $3)
        AND embedding IS NOT NULL
        AND (created_at + (ttl_seconds * INTERVAL '1 second')) > NOW()
      ORDER BY embedding <=> $1::vector ASC
      LIMIT 1
      `,
      [vectorToPgLiteral(vec), caller.trim().toLowerCase(), taskType ?? null]
    );
    const row = result.rows[0];
    if (!row) return null;
    const sim = parseFloat(row.similarity);
    if (isNaN(sim) || sim < similarityThreshold) return null;
    return {
      id: Number(row.id),
      cacheKey: row.cache_key,
      responseJson: row.response_json,
      costWhenCached: parseFloat(row.cost_when_cached) || 0,
      tokensIn: parseInt(row.tokens_in, 10) || 0,
      tokensOut: parseInt(row.tokens_out, 10) || 0,
      hitCount: parseInt(row.hit_count, 10) || 0,
      ageSeconds: parseInt(row.age_seconds, 10) || 0,
      similarity: sim,
    };
  } catch (err) {
    logger.debug({ err }, 'response-cache: getSemanticCachedResponse failed (extension missing?)');
    return null;
  }
}

/** Persist a response. Idempotent on conflict — increments TTL window instead. */
export async function setCachedResponse(
  db: Pool,
  req: CacheableRequest,
  response: Record<string, unknown>,
  meta: { cost: number; tokensIn: number; tokensOut: number; ttlSeconds?: number }
): Promise<void> {
  const cacheKey = computeCacheKey(req);
  const ttl = meta.ttlSeconds ?? 86_400;
  // Generate embedding async — fire & forget compatible
  const vec = await embed(req.input);
  const embedLiteral = vec && vec.length === EMBEDDING_DIMENSION ? vectorToPgLiteral(vec) : null;
  try {
    await db.query(
      `
      INSERT INTO response_cache
        (cache_key, caller_id, task_type, model, input_preview,
         response_json, cost_when_cached, tokens_in, tokens_out, ttl_seconds, embedding)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
      ON CONFLICT (cache_key) DO UPDATE SET
        response_json    = EXCLUDED.response_json,
        cost_when_cached = EXCLUDED.cost_when_cached,
        tokens_in        = EXCLUDED.tokens_in,
        tokens_out       = EXCLUDED.tokens_out,
        ttl_seconds      = EXCLUDED.ttl_seconds,
        embedding        = COALESCE(EXCLUDED.embedding, response_cache.embedding),
        created_at       = NOW()
      `,
      [
        cacheKey,
        req.caller.trim().toLowerCase(),
        req.task_type ?? null,
        req.model ?? null,
        req.input.slice(0, 1024),
        JSON.stringify(response),
        meta.cost,
        meta.tokensIn,
        meta.tokensOut,
        ttl,
        embedLiteral,
      ]
    );
  } catch (err) {
    // Retry without embedding column when the extension hasn't migrated yet
    logger.debug({ err }, 'response-cache: setCachedResponse with embedding failed, retrying without');
    try {
      await db.query(
        `
        INSERT INTO response_cache
          (cache_key, caller_id, task_type, model, input_preview,
           response_json, cost_when_cached, tokens_in, tokens_out, ttl_seconds)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (cache_key) DO UPDATE SET
          response_json    = EXCLUDED.response_json,
          cost_when_cached = EXCLUDED.cost_when_cached,
          tokens_in        = EXCLUDED.tokens_in,
          tokens_out       = EXCLUDED.tokens_out,
          ttl_seconds      = EXCLUDED.ttl_seconds,
          created_at       = NOW()
        `,
        [
          cacheKey,
          req.caller.trim().toLowerCase(),
          req.task_type ?? null,
          req.model ?? null,
          req.input.slice(0, 1024),
          JSON.stringify(response),
          meta.cost,
          meta.tokensIn,
          meta.tokensOut,
          ttl,
        ]
      );
    } catch (err2) {
      logger.warn({ err: err2 }, 'response-cache: setCachedResponse failed');
    }
  }
}

/** Record a cache hit (atomic increment). */
export async function recordCacheHit(db: Pool, cachedId: number): Promise<void> {
  try {
    await db.query(
      `
      UPDATE response_cache
      SET hit_count    = hit_count + 1,
          cost_saved   = cost_saved + cost_when_cached,
          tokens_saved = tokens_saved + tokens_in + tokens_out,
          last_hit_at  = NOW()
      WHERE id = $1
      `,
      [cachedId]
    );
  } catch (err) {
    logger.warn({ err }, 'response-cache: recordCacheHit failed');
  }
}

/** Aggregate savings across all cache entries for the dashboard. */
export async function getCacheSavings(
  db: Pool,
  hoursBack: number = 24
): Promise<{
  totalHits: number;
  totalCostSaved: number;
  totalTokensSaved: number;
  uniqueEntries: number;
  topCallers: Array<{ caller: string; hits: number; saved: number }>;
  hitRatePercent: number;
}> {
  try {
    const [totalRow, callerRows, ratioRow] = await Promise.all([
      db.query(
        `SELECT
            COALESCE(SUM(hit_count), 0)::INT     AS total_hits,
            COALESCE(SUM(cost_saved), 0)::NUMERIC AS total_cost_saved,
            COALESCE(SUM(tokens_saved), 0)::BIGINT AS total_tokens_saved,
            COUNT(*)::INT                         AS unique_entries
         FROM response_cache
         WHERE last_hit_at > NOW() - MAKE_INTERVAL(hours => $1)
            OR created_at  > NOW() - MAKE_INTERVAL(hours => $1)`,
        [hoursBack]
      ),
      db.query(
        `SELECT caller_id, SUM(hit_count)::INT AS hits, SUM(cost_saved)::NUMERIC AS saved
         FROM response_cache
         WHERE last_hit_at > NOW() - MAKE_INTERVAL(hours => $1)
         GROUP BY caller_id
         ORDER BY hits DESC
         LIMIT 5`,
        [hoursBack]
      ),
      // Cache hit-rate = hits / (hits + new requests in same window)
      db.query(
        `SELECT
            COALESCE((SELECT SUM(hit_count) FROM response_cache
                      WHERE last_hit_at > NOW() - MAKE_INTERVAL(hours => $1)), 0)::INT AS hits,
            (SELECT COUNT(*) FROM request_tracking
              WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1))::INT             AS total_requests`,
        [hoursBack]
      ),
    ]);

    const t = totalRow.rows[0];
    const r = ratioRow.rows[0];
    const totalReq = parseInt(r?.total_requests ?? '0', 10);
    const hits = parseInt(t?.total_hits ?? '0', 10);
    const hitRate = totalReq > 0 ? (hits / (totalReq + hits)) * 100 : 0;

    return {
      totalHits: hits,
      totalCostSaved: parseFloat(t?.total_cost_saved ?? '0'),
      totalTokensSaved: parseInt(t?.total_tokens_saved ?? '0', 10),
      uniqueEntries: parseInt(t?.unique_entries ?? '0', 10),
      topCallers: callerRows.rows.map((row: any) => ({
        caller: row.caller_id,
        hits: parseInt(row.hits, 10) || 0,
        saved: parseFloat(row.saved) || 0,
      })),
      hitRatePercent: parseFloat(hitRate.toFixed(2)),
    };
  } catch (err) {
    logger.warn({ err }, 'response-cache: getCacheSavings failed (table missing?)');
    return {
      totalHits: 0,
      totalCostSaved: 0,
      totalTokensSaved: 0,
      uniqueEntries: 0,
      topCallers: [],
      hitRatePercent: 0,
    };
  }
}

/** Time-series buckets of cache savings for sparkline visualization. */
export async function getSavingsTimeSeries(
  db: Pool,
  hoursBack: number = 24,
  bucketMinutes: number = 60
): Promise<Array<{ ts: string; costSaved: number; hits: number; tokensSaved: number }>> {
  try {
    const buckets = Math.ceil((hoursBack * 60) / bucketMinutes);
    const result = await db.query(
      `
      WITH gs AS (
        SELECT generate_series(
          DATE_TRUNC('hour', NOW()) - ($1 || ' minutes')::INTERVAL * (s),
          DATE_TRUNC('hour', NOW()),
          ($1 || ' minutes')::INTERVAL
        ) AS bucket_ts
        FROM generate_series(0, $2 - 1) s
      )
      SELECT
        gs.bucket_ts,
        COALESCE(COUNT(rc.id), 0)::INT             AS hits,
        COALESCE(SUM(rc.cost_when_cached), 0)::NUMERIC AS cost_saved,
        COALESCE(SUM(rc.tokens_in + rc.tokens_out), 0)::INT AS tokens_saved
      FROM gs
      LEFT JOIN response_cache rc
        ON DATE_TRUNC('hour', rc.last_hit_at) = gs.bucket_ts
       AND rc.last_hit_at > NOW() - ($1 || ' minutes')::INTERVAL * $2
      GROUP BY gs.bucket_ts
      ORDER BY gs.bucket_ts ASC
      `,
      [bucketMinutes, buckets]
    );
    return result.rows.map((row: any) => ({
      ts: row.bucket_ts.toISOString(),
      costSaved: parseFloat(row.cost_saved) || 0,
      hits: parseInt(row.hits, 10) || 0,
      tokensSaved: parseInt(row.tokens_saved, 10) || 0,
    }));
  } catch (err) {
    logger.warn({ err }, 'response-cache: getSavingsTimeSeries failed');
    return [];
  }
}

/** Drop entries older than max-age days. Run from a periodic job. */
export async function pruneStaleCacheEntries(db: Pool, maxAgeDays: number = 7): Promise<number> {
  try {
    const result = await db.query(
      `DELETE FROM response_cache
       WHERE created_at < NOW() - MAKE_INTERVAL(days => $1)
         AND (last_hit_at IS NULL OR last_hit_at < NOW() - MAKE_INTERVAL(days => $1))`,
      [maxAgeDays]
    );
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, 'response-cache: prune failed');
    return 0;
  }
}

/** Manual cache invalidation, e.g. when a caller hits "clear my cache". */
export async function clearCacheForCaller(db: Pool, callerId: string): Promise<number> {
  try {
    const result = await db.query(
      `DELETE FROM response_cache WHERE caller_id = $1`,
      [callerId.trim().toLowerCase()]
    );
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, 'response-cache: clearCacheForCaller failed');
    return 0;
  }
}
