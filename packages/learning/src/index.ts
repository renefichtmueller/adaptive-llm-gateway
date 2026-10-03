/**
 * LLM Gateway — Learning Engine
 *
 * Standalone service that runs alongside the gateway and permanently improves it
 * through 4 mechanisms:
 *   1. Ban-list learner  (every 30 min)  — detects new banned phrases
 *   2. Few-shot curator  (every 1 hour)  — promotes high-quality examples
 *   3. Routing optimizer (every 6 hours) — adjusts model routing
 *   4. Prompt optimizer  (every 12 hours) — generates improved prompts
 *
 * Plus:
 *   - Daily at 02:00: full learning report
 *   - Sunday 03:00:  fine-tuning trigger check
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import cron from 'node-cron';
import { logger } from './observability/logger.js';
import { closePool, query } from './db/client.js';
import { runBanLearner } from './ban-learner/index.js';
import { runFewShotCurator } from './few-shot-curator/index.js';
import { runRoutingOptimizer } from './routing-optimizer/index.js';
import { runPromptOptimizer } from './prompt-optimizer/index.js';
import { runLearningReport } from './learning-report/index.js';

// ─── Job wrapper ─────────────────────────────────────────────────────────────

const runningJobs = new Set<string>();

async function safeRun(name: string, fn: () => Promise<void>): Promise<void> {
  if (runningJobs.has(name)) {
    logger.warn({ name }, 'Job still running from previous schedule — skipping');
    return;
  }

  runningJobs.add(name);
  const start = Date.now();

  try {
    logger.info({ name }, 'Starting learning job');
    await fn();
    logger.info({ name, durationMs: Date.now() - start }, 'Learning job completed successfully');
  } catch (err) {
    logger.error({ err, name, durationMs: Date.now() - start }, 'Learning job failed');
  } finally {
    runningJobs.delete(name);
  }
}

// ─── Health check ────────────────────────────────────────────────────────────

async function healthCheck(): Promise<void> {
  try {
    await query('SELECT 1');
    logger.debug('DB health check passed');
  } catch (err) {
    logger.error({ err }, 'DB health check failed — learning engine cannot reach database');
    process.exit(1);
  }
}

// ─── Fine-tuning trigger ──────────────────────────────────────────────────────

const FINE_TUNING_EXPORT_DIR = process.env['FINE_TUNING_EXPORT_DIR'] ?? './fine-tuning-exports';
const FINE_TUNING_MIN_EXAMPLES = parseInt(process.env['FINE_TUNING_MIN_EXAMPLES'] ?? '500', 10);

export async function checkFineTuningTrigger(): Promise<void> {
  // Count high-quality unprocessed examples in learning_corpus
  const result = await query<{ count: string; task_type: string }>(
    `SELECT task_type, COUNT(*)::int as count
     FROM learning_corpus
     WHERE included_in_run IS NULL
       AND quality_score >= 8.0
     GROUP BY task_type
     HAVING COUNT(*) >= ${FINE_TUNING_MIN_EXAMPLES}
     ORDER BY count DESC`,
  );

  if (result.rows.length === 0) {
    logger.info(
      { minExamples: FINE_TUNING_MIN_EXAMPLES },
      'Fine-tuning check: not enough training examples yet',
    );
    return;
  }

  for (const row of result.rows) {
    const taskType = row.task_type;
    const count = parseInt(row.count);
    logger.info({ taskType, count }, 'Fine-tuning threshold reached — triggering run');

    // Record the fine-tuning run
    const runResult = await query<{ id: string }>(
      `INSERT INTO fine_tuning_runs (base_model, sample_count, task_types, status, metrics)
       VALUES ('qwen2.5:14b', $1, $2, 'queued', $3)
       RETURNING id`,
      [
        count,
        [taskType],
        JSON.stringify({
          training_examples: Math.floor(count * 0.9),
          validation_examples: Math.floor(count * 0.1),
          epochs: 3,
          lora_rank: 16,
        }),
      ],
    );
    const runId = runResult.rows[0]?.id;
    if (!runId) continue;

    // Export the training set as JSONL, ready for external fine-tuning
    // tooling (e.g. LoRA on the base model), and mark the examples as used.
    try {
      const examples = await query<{ id: string; prompt_text: string; completion_text: string }>(
        `SELECT id, prompt_text, completion_text
         FROM learning_corpus
         WHERE task_type = $1 AND included_in_run IS NULL AND quality_score >= 8.0
         ORDER BY quality_score DESC`,
        [taskType],
      );

      mkdirSync(FINE_TUNING_EXPORT_DIR, { recursive: true });
      const exportPath = join(FINE_TUNING_EXPORT_DIR, `${taskType.replace(/[^a-z0-9_-]/gi, '_')}-${runId}.jsonl`);
      const jsonl = examples.rows
        .map((e) => JSON.stringify({ prompt: e.prompt_text, completion: e.completion_text }))
        .join('\n');
      writeFileSync(exportPath, jsonl + '\n', 'utf-8');

      await query(
        `UPDATE learning_corpus SET included_in_run = $1 WHERE id = ANY($2::uuid[])`,
        [runId, examples.rows.map((e) => e.id)],
      );
      await query(
        `UPDATE fine_tuning_runs SET status = 'exported', notes = $2 WHERE id = $1`,
        [runId, `training set exported to ${exportPath}`],
      );

      logger.info(
        { taskType, runId, examples: examples.rows.length, exportPath },
        'Fine-tuning training set exported',
      );
    } catch (err) {
      logger.error({ err, taskType, runId }, 'Fine-tuning export failed (run stays queued)');
    }
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ version: '1.0.0' }, 'LLM Gateway Learning Engine starting');

  // DB connectivity check
  await healthCheck();
  logger.info('Database connection established');

  // ── Every 30 minutes: ban-list learner ──────────────────────────────────
  cron.schedule('*/30 * * * *', () => {
    void safeRun('ban-learner', runBanLearner);
  });

  // ── Every hour: few-shot curator ─────────────────────────────────────────
  cron.schedule('0 * * * *', () => {
    void safeRun('few-shot-curator', runFewShotCurator);
  });

  // ── Every 6 hours: routing optimizer ─────────────────────────────────────
  cron.schedule('0 */6 * * *', () => {
    void safeRun('routing-optimizer', runRoutingOptimizer);
  });

  // ── Every 12 hours: prompt optimizer ─────────────────────────────────────
  cron.schedule('0 */12 * * *', () => {
    void safeRun('prompt-optimizer', runPromptOptimizer);
  });

  // ── Daily at 02:00: learning report ──────────────────────────────────────
  cron.schedule('0 2 * * *', () => {
    void safeRun('learning-report', async () => {
      await runLearningReport();
    });
  });

  // ── Sunday at 03:00: fine-tuning trigger ─────────────────────────────────
  cron.schedule('0 3 * * 0', () => {
    void safeRun('fine-tuning-trigger', checkFineTuningTrigger);
  });

  logger.info(
    {
      jobs: [
        'ban-learner (*/30 min)',
        'few-shot-curator (hourly)',
        'routing-optimizer (6h)',
        'prompt-optimizer (12h)',
        'learning-report (daily 02:00)',
        'fine-tuning-trigger (Sunday 03:00)',
      ],
    },
    'All learning jobs scheduled',
  );

  // Run initial pass on startup (staggered to avoid overloading)
  setTimeout(() => void safeRun('ban-learner-init', runBanLearner), 5_000);
  setTimeout(() => void safeRun('few-shot-curator-init', runFewShotCurator), 30_000);
  setTimeout(() => void safeRun('routing-optimizer-init', runRoutingOptimizer), 60_000);
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down learning engine');

  // Wait for running jobs to complete (max 30s)
  const deadline = Date.now() + 30_000;
  while (runningJobs.size > 0 && Date.now() < deadline) {
    logger.info({ running: [...runningJobs] }, 'Waiting for jobs to finish');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (runningJobs.size > 0) {
    logger.warn({ still_running: [...runningJobs] }, 'Forced shutdown with jobs still running');
  }

  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

void main();
