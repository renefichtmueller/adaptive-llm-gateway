/**
 * Knowledge Memory
 *
 * Per-caller persistent facts that get auto-injected into prompts.
 * Each fact has a confidence, a source, and optional valid-until window.
 * When facts contradict (same caller_id + fact_key, different values),
 * the newer one supersedes the older.
 */
import type { Pool } from 'pg';
import { logger } from '../observability/logger.js';

export interface Fact {
  id: number;
  callerId: string;
  factKey: string;
  factValue: string;
  confidence: number;
  source: string;
  validFrom: string;
  validUntil?: string;
}

/** Set or update a fact for a caller. Older value (if any) is superseded. */
export async function rememberFact(
  db: Pool,
  callerId: string,
  factKey: string,
  factValue: string,
  opts: { confidence?: number; source?: string; validUntil?: Date } = {}
): Promise<void> {
  const caller = callerId.trim().toLowerCase();
  const key = factKey.trim().toLowerCase();
  const conf = opts.confidence ?? 0.8;
  const src = opts.source ?? 'user-set';
  try {
    // Mark previous active fact as superseded
    await db.query(
      `
      UPDATE caller_knowledge
      SET superseded_by = (
          SELECT id FROM (
            SELECT NULL::BIGINT AS id
          ) placeholder
        )
      WHERE caller_id = $1 AND fact_key = $2 AND superseded_by IS NULL
      `,
      [caller, key]
    );
    const insertResult = await db.query(
      `
      INSERT INTO caller_knowledge (caller_id, fact_key, fact_value, confidence, source, valid_until)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
      `,
      [caller, key, factValue, conf, src, opts.validUntil ?? null]
    );
    const newId = insertResult.rows[0]?.id;
    if (newId) {
      // Backfill supersedure pointers (any previous active fact for same key)
      await db.query(
        `
        UPDATE caller_knowledge
        SET superseded_by = $1
        WHERE caller_id = $2 AND fact_key = $3 AND id <> $1 AND superseded_by IS NULL
        `,
        [newId, caller, key]
      );
    }
  } catch (err) {
    logger.warn({ err, caller, key }, 'knowledge-memory: rememberFact failed');
  }
}

/** Recall the active facts for a caller. Returns at most `limit`. */
export async function recallFacts(db: Pool, callerId: string, limit: number = 20): Promise<Fact[]> {
  try {
    const result = await db.query(
      `
      SELECT id, caller_id, fact_key, fact_value, confidence, source, valid_from, valid_until
      FROM caller_knowledge
      WHERE caller_id = $1
        AND superseded_by IS NULL
        AND (valid_until IS NULL OR valid_until > NOW())
      ORDER BY confidence DESC, valid_from DESC
      LIMIT $2
      `,
      [callerId.trim().toLowerCase(), limit]
    );
    return result.rows.map((row: any) => ({
      id: Number(row.id),
      callerId: row.caller_id,
      factKey: row.fact_key,
      factValue: row.fact_value,
      confidence: parseFloat(row.confidence),
      source: row.source,
      validFrom: new Date(row.valid_from).toISOString(),
      validUntil: row.valid_until ? new Date(row.valid_until).toISOString() : undefined,
    }));
  } catch (err) {
    logger.warn({ err, callerId }, 'knowledge-memory: recallFacts failed');
    return [];
  }
}

/** Render facts as a system-prompt fragment to inject. */
export function factsToSystemFragment(facts: Fact[]): string {
  if (facts.length === 0) return '';
  return [
    '── Caller Context (from memory) ──',
    ...facts.map((f) => `• ${f.factKey}: ${f.factValue}`),
    '──────────────────────────────────',
  ].join('\n');
}

/** Forget all facts for a caller (used by clear-memory endpoint). */
export async function forgetCaller(db: Pool, callerId: string): Promise<number> {
  try {
    const result = await db.query(
      `DELETE FROM caller_knowledge WHERE caller_id = $1`,
      [callerId.trim().toLowerCase()]
    );
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err, callerId }, 'knowledge-memory: forgetCaller failed');
    return 0;
  }
}
