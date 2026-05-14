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

async function checkFineTuningTrigger(): Promise<void> {
  // Count high-quality unprocessed examples in learning_corpus
  const result = await query<{ count: string; task_type: string }>(
    `SELECT task_type, COUNT(*)::int as count
     FROM learning_corpus
     WHERE included_in_run IS NULL
       AND quality_score >= 8.0
     GROUP BY task_type
     HAVING COUNT(*) >= 500
     ORDER BY count DESC`,
  );

  if (result.rows.length === 0) {
    logger.info('Fine-tuning check: not enough training examples yet (need >= 500 per task_type)');
    return;
  }

  for (const row of result.rows) {
    logger.info(
      { taskType: row.task_type, count: parseInt(row.count) },
      'Fine-tuning threshold reached — triggering run',
    );

    // Record the fine-tuning run intent
    await query(
      `INSERT INTO fine_tuning_runs
         (base_model, task_type, training_examples, validation_examples, epochs, lora_rank, status)
       VALUES ('qwen2.5:14b', $1, $2, $3, 3, 16, 'queued')`,
      [
        row.task_type,
        Math.floor(parseInt(row.count) * 0.9),
        Math.floor(parseInt(row.count) * 0.1),
      ],
    );

    // The actual fine-tuner package picks this up separately
    logger.info({ taskType: row.task_type }, 'Fine-tuning run queued');
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
