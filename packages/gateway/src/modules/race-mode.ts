/**
 * Multi-Model Race Mode
 *
 * Sends the same prompt to N models in parallel and returns according to
 * the chosen strategy:
 *
 *   • 'first'     — first non-error response wins. Cancels in-flight losers.
 *   • 'best'      — wait for all (or timeout), pick highest confidence score.
 *   • 'consensus' — wait for all, return majority answer + agreement score.
 *
 * All candidate runs are audited to `race_mode_results` for analysis —
 * which model is actually fastest, which gives the highest confidence, etc.
 */
import type { Pool } from 'pg';
import { logger } from '../observability/logger.js';

export type RaceStrategy = 'first' | 'best' | 'consensus';

export interface RaceCandidateResult {
  model: string;
  status: 'ok' | 'error';
  output?: string;
  confidence?: number;
  cost?: number;
  latencyMs: number;
  errorMessage?: string;
}

export interface RaceOutcome {
  strategy: RaceStrategy;
  selected: RaceCandidateResult;
  candidates: readonly RaceCandidateResult[];
  agreementScore?: number; // for consensus mode
}

/**
 * Run N parallel completions and resolve according to `strategy`.
 * The `runner` callback is responsible for actually invoking the gateway
 * pipeline — this module is strategy-only and stays decoupled.
 */
export async function runRace<R extends RaceCandidateResult>(
  models: readonly string[],
  runner: (model: string, signal: AbortSignal) => Promise<R>,
  strategy: RaceStrategy,
  opts: { timeoutMs?: number } = {}
): Promise<{ outcome: RaceOutcome; results: R[] }> {
  if (models.length === 0) throw new Error('runRace: no candidates');

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const promises: Array<Promise<R>> = models.map((model) =>
    runner(model, controller.signal).catch(
      (err): R =>
        ({
          model,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs: 0,
        } as unknown as R)
    )
  );

  let results: R[];
  let outcome: RaceOutcome;

  if (strategy === 'first') {
    // Custom race: pick the first OK response, cancel rest.
    const firstOk = await new Promise<R>((resolve, reject) => {
      let pending = promises.length;
      let firstError: R | null = null;
      promises.forEach((p) => {
        p.then((r) => {
          if (r.status === 'ok') {
            resolve(r);
          } else {
            if (!firstError) firstError = r;
            pending -= 1;
            if (pending === 0) reject(new Error('all candidates errored'));
          }
        });
      });
      // Backstop on overall timeout
      setTimeout(() => {
        if (firstError) resolve(firstError);
        else reject(new Error('race timeout'));
      }, timeoutMs);
    });
    results = await Promise.all(promises);
    controller.abort();
    outcome = { strategy, selected: firstOk, candidates: results };
  } else if (strategy === 'best') {
    results = await Promise.all(promises);
    const ok = results.filter((r) => r.status === 'ok');
    const winner = ok.length > 0
      ? ok.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
      : results[0];
    outcome = { strategy, selected: winner, candidates: results };
  } else {
    // 'consensus' — group identical normalised outputs, pick majority
    results = await Promise.all(promises);
    const ok = results.filter((r) => r.status === 'ok');
    const buckets = new Map<string, R[]>();
    for (const r of ok) {
      const key = (r.output ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 256);
      const arr = buckets.get(key);
      if (arr) arr.push(r); else buckets.set(key, [r]);
    }
    const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
    const winnerBucket = sorted[0]?.[1];
    const winner = winnerBucket && winnerBucket.length > 0
      ? winnerBucket.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
      : results[0];
    const agreementScore = ok.length > 0 ? (winnerBucket?.length ?? 0) / ok.length : 0;
    outcome = { strategy, selected: winner, candidates: results, agreementScore };
  }

  clearTimeout(timeout);
  return { outcome, results };
}

/** Audit all race candidates to the `race_mode_results` table. */
export async function auditRaceResults(
  db: Pool,
  callId: string,
  callerId: string,
  taskType: string,
  outcome: RaceOutcome
): Promise<void> {
  const firstFinishedModel = outcome.strategy === 'first'
    ? outcome.selected.model
    : outcome.candidates.reduce(
        (best: RaceCandidateResult, c: RaceCandidateResult) =>
          c.status === 'ok' && c.latencyMs < (best.latencyMs || Infinity) ? c : best,
        outcome.candidates[0]
      ).model;

  for (const c of outcome.candidates) {
    try {
      await db.query(
        `
        INSERT INTO race_mode_results (
          call_id, caller_id, task_type, strategy,
          candidate_model, finished_first, selected,
          latency_ms, confidence, cost_usd, error_message, output_preview
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `,
        [
          callId,
          callerId.toLowerCase(),
          taskType,
          outcome.strategy,
          c.model,
          c.model === firstFinishedModel,
          c.model === outcome.selected.model,
          c.latencyMs,
          c.confidence ?? null,
          c.cost ?? null,
          c.errorMessage ?? null,
          c.output?.slice(0, 512) ?? null,
        ]
      );
    } catch (err) {
      logger.warn({ err, model: c.model }, 'race-mode: audit insert failed');
    }
  }
}

/** Aggregate race statistics for the dashboard. */
export async function getRaceStats(
  db: Pool,
  hoursBack: number = 24
): Promise<{
  totalRaces: number;
  byStrategy: Record<string, number>;
  fastestModel: { model: string; wins: number } | null;
  highestConfidenceModel: { model: string; avg: number } | null;
}> {
  try {
    const [total, byStrategy, fastest, byConfidence] = await Promise.all([
      db.query(
        `SELECT COUNT(DISTINCT call_id)::INT AS n FROM race_mode_results
         WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)`,
        [hoursBack]
      ),
      db.query(
        `SELECT strategy, COUNT(DISTINCT call_id)::INT AS n FROM race_mode_results
         WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
         GROUP BY strategy`,
        [hoursBack]
      ),
      db.query(
        `SELECT candidate_model AS model, COUNT(*)::INT AS wins FROM race_mode_results
         WHERE finished_first = true AND created_at > NOW() - MAKE_INTERVAL(hours => $1)
         GROUP BY candidate_model ORDER BY wins DESC LIMIT 1`,
        [hoursBack]
      ),
      db.query(
        `SELECT candidate_model AS model, AVG(confidence)::NUMERIC(4,2) AS avg
         FROM race_mode_results
         WHERE confidence IS NOT NULL AND created_at > NOW() - MAKE_INTERVAL(hours => $1)
         GROUP BY candidate_model ORDER BY avg DESC LIMIT 1`,
        [hoursBack]
      ),
    ]);

    const byStrategyMap: Record<string, number> = {};
    for (const row of byStrategy.rows) byStrategyMap[row.strategy] = parseInt(row.n, 10) || 0;

    return {
      totalRaces: parseInt(total.rows[0]?.n ?? '0', 10),
      byStrategy: byStrategyMap,
      fastestModel: fastest.rows[0] ? { model: fastest.rows[0].model, wins: parseInt(fastest.rows[0].wins, 10) } : null,
      highestConfidenceModel: byConfidence.rows[0]
        ? { model: byConfidence.rows[0].model, avg: parseFloat(byConfidence.rows[0].avg) }
        : null,
    };
  } catch (err) {
    logger.warn({ err }, 'race-mode: stats failed (table missing?)');
    return { totalRaces: 0, byStrategy: {}, fastestModel: null, highestConfidenceModel: null };
  }
}
