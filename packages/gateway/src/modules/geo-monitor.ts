/**
 * GEO Monitor — default LLM runner + scheduled ranking tests
 * ----------------------------------------------------------
 * Wires the transport-agnostic geo-ranking module to the gateway's own LLM
 * pipeline (callOllama → circuit breakers → model fallbacks → external
 * providers) and schedules recurring runs, so brand visibility in generative
 * answers is tracked automatically over time.
 *
 * Env knobs:
 *   GEO_RANKING_SCHEDULE_ENABLED=1     enable the recurring ranking test
 *   GEO_RANKING_INTERVAL_MS=86400000   run interval (default 24 h)
 *   GEO_RANKING_BOOT_DELAY_MS=180000   first run after boot (default 3 min)
 *   GEO_RANKING_MODELS=a,b             override models from geo-targets.yaml
 *   GEO_OPTIMIZER_MODEL=qwen2.5:32b    model for /v1/geo/optimize rewrites
 */

import { callOllama } from '../pipeline/llm-client.js';
import { logger } from '../observability/logger.js';
import { loadGeoTargets, runRankingTest, persistRankingRun, type GeoAnswerRunner } from './geo-ranking.js';
import type { GeoLlmCaller } from './geo-optimizer.js';

const SCHEDULE_ENABLED = process.env['GEO_RANKING_SCHEDULE_ENABLED'] === '1';
const INTERVAL_MS = parseInt(process.env['GEO_RANKING_INTERVAL_MS'] ?? '86400000', 10); // 24 h
const BOOT_DELAY_MS = parseInt(process.env['GEO_RANKING_BOOT_DELAY_MS'] ?? '180000', 10); // 3 min
const OPTIMIZER_MODEL = process.env['GEO_OPTIMIZER_MODEL'] ?? 'qwen2.5:32b';
const OPTIMIZER_FALLBACKS = ['qwen2.5:14b', 'llama3.1:8b'];

/**
 * A generative engine simulated through the gateway: the model answers a user
 * question the way an assistant would, brands and products included. Low
 * temperature keeps runs comparable over time (we measure the model's stable
 * preference, not sampling noise).
 */
const RANKING_SYSTEM_PROMPT =
  'You are a helpful AI assistant. Answer the user\'s question the way you would in a chat: ' +
  'concise, concrete, and with specific product, tool or brand recommendations where they help. ' +
  'Answer in the language of the question.';

export function buildRankingRunner(): GeoAnswerRunner {
  return async (model, promptText) => {
    const result = await callOllama(
      {
        model,
        prompt: promptText,
        system: RANKING_SYSTEM_PROMPT,
        options: { temperature: 0.2, num_predict: 700 },
        stream: false,
      },
      'medium',
    );
    return result.response;
  };
}

/** LLM caller for the GEO optimizer, routed through the gateway pipeline. */
export function buildGeoLlm(model?: string): GeoLlmCaller {
  const chosenModel = model && model.trim().length > 0 ? model : OPTIMIZER_MODEL;
  return async (req) => {
    const result = await callOllama(
      {
        model: chosenModel,
        prompt: req.prompt,
        system: req.system,
        options: req.options ?? { temperature: 0.3, num_predict: 4_000 },
        stream: false,
      },
      'large',
      OPTIMIZER_FALLBACKS,
    );
    return { response: result.response, model: result.model };
  };
}

// ─── Scheduler (adaptive-routing pattern) ──────────────────────────────────

type PgClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

let bootTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let runInProgress = false;

export async function runScheduledRankingTest(db: PgClient): Promise<void> {
  if (runInProgress) {
    logger.warn('geo-monitor: previous ranking test still running, skipping this tick');
    return;
  }
  const config = loadGeoTargets();
  if (!config) {
    logger.warn('geo-monitor: no geo-targets.yaml found or invalid — skipping ranking test');
    return;
  }
  const envModels = (process.env['GEO_RANKING_MODELS'] ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  runInProgress = true;
  try {
    const summary = await runRankingTest(config, buildRankingRunner(), envModels.length > 0 ? { models: envModels } : {});
    await persistRankingRun(db, summary, 'scheduled');
    logger.info(
      {
        brand: summary.brand,
        models: summary.models,
        mentionRate: summary.mentionRate,
        shareOfVoice: summary.shareOfVoice,
        avgVisibility: summary.avgVisibility,
      },
      'geo-monitor: scheduled ranking test finished',
    );
  } catch (err) {
    logger.error({ err }, 'geo-monitor: scheduled ranking test failed');
  } finally {
    runInProgress = false;
  }
}

export function scheduleGeoRankingMonitor(db: PgClient): void {
  if (!SCHEDULE_ENABLED) {
    logger.info('GEO ranking monitor disabled (set GEO_RANKING_SCHEDULE_ENABLED=1 to enable)');
    return;
  }
  if (intervalTimer) return;

  bootTimer = setTimeout(() => {
    void runScheduledRankingTest(db);
  }, BOOT_DELAY_MS);
  intervalTimer = setInterval(() => {
    void runScheduledRankingTest(db);
  }, INTERVAL_MS);
  logger.info({ intervalMs: INTERVAL_MS, bootDelayMs: BOOT_DELAY_MS }, 'GEO ranking monitor scheduled');
}

export function stopGeoRankingMonitor(): void {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
}
