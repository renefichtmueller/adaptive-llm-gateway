/**
 * Scorer fast-path
 *
 * The completion pipeline normally calls the LLM pre-classifier
 * (`classifyInput`) to pick a task_type before routing. That is an Ollama
 * round-trip on `qwen2.5:3b` — ~500-1000 ms of added latency plus a model slot
 * held for every request (the cold-start / latency cost noted in ADR-0002).
 *
 * For clearly-simple requests that round-trip is pure overhead: the keyword
 * `request-scorer` already classifies them into the `fast` tier
 * deterministically, in sub-millisecond time and without any inference. This
 * helper runs that scorer and — only when it is confident the request belongs
 * to a cheap tier — returns a task_type directly, so the caller can skip the
 * LLM classifier entirely.
 *
 * It is deliberately conservative:
 *   - opt-in, default OFF (behaviour is identical to before until enabled);
 *   - only short-circuits on the eligible tier(s) (default `fast`), where the
 *     LLM classifier would almost certainly return a generic task type routed
 *     to the same tier — specialised task types (code_review, translation, …)
 *     are left to the LLM classifier via the normal fall-through path;
 *   - never throws — any scorer error defers to the LLM classifier.
 *
 * Env:
 *   SCORER_FASTPATH_ENABLED         '1' to enable (default off)
 *   SCORER_FASTPATH_MIN_CONFIDENCE  min scorer confidence, 0..1 (default 0.7)
 *   SCORER_FASTPATH_TIERS           comma list of tiers allowed to short-circuit
 *                                   (default 'fast')
 *   SCORER_FASTPATH_TASK_TYPE       task_type to route to (default 'generic_qa')
 */
import { scoreRequest } from './request-scorer.js';
import { logger } from '../observability/logger.js';

export interface FastPathResult {
  /** task_type the caller should route with, skipping the LLM classifier. */
  taskType: string;
  /** Tier the scorer assigned (for logging / observability). */
  tier: string;
  /** Scorer confidence, 0..1 (for logging / observability). */
  confidence: number;
}

function isEnabled(): boolean {
  return process.env['SCORER_FASTPATH_ENABLED'] === '1';
}

function minConfidence(): number {
  const raw = parseFloat(process.env['SCORER_FASTPATH_MIN_CONFIDENCE'] ?? '0.7');
  return Number.isFinite(raw) ? raw : 0.7;
}

function allowedTiers(): ReadonlySet<string> {
  const raw = process.env['SCORER_FASTPATH_TIERS'] ?? 'fast';
  const tiers = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return new Set(tiers.length > 0 ? tiers : ['fast']);
}

function fastPathTaskType(): string {
  const raw = process.env['SCORER_FASTPATH_TASK_TYPE']?.trim();
  return raw && raw.length > 0 ? raw : 'generic_qa';
}

/**
 * Decide whether the cheap keyword scorer is confident enough to route `input`
 * without the LLM classifier.
 *
 * Returns a {@link FastPathResult} when the fast-path applies, or `null` when
 * it does not (disabled, empty input, scorer error, tier not eligible, or
 * confidence below the configured threshold). Never throws.
 */
export function tryScorerFastPath(input: string): FastPathResult | null {
  if (!isEnabled()) return null;
  if (typeof input !== 'string' || input.trim().length === 0) return null;

  let tier: string;
  let confidence: number;
  try {
    const scoring = scoreRequest({ messages: [{ role: 'user', content: input }] });
    tier = scoring.tier;
    confidence = scoring.confidence;
  } catch (err) {
    logger.debug({ err }, 'scorer-fastpath: scoreRequest threw, deferring to LLM classifier');
    return null;
  }

  if (!allowedTiers().has(tier)) return null;
  if (confidence < minConfidence()) return null;

  return { taskType: fastPathTaskType(), tier, confidence };
}
