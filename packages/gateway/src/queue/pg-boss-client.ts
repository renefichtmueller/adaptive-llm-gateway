import PgBoss from 'pg-boss';
import { logger } from '../observability/logger.js';
import { costStream } from '../observability/cost-stream.js';

const QUEUE_NAME = 'llm-batch';
const CONCURRENCY = 4;
const MAX_RETRIES = 3;

let boss: PgBoss | null = null;

interface BatchJobData {
  caller: string;
  tasks: Array<{
    task_type: string;
    input: string;
    language?: 'de' | 'en';
    context?: Record<string, unknown>;
  }>;
  webhook_url?: string;
  batch_db_id: string;
}

interface TaskResult {
  task_type: string;
  status: 'approved' | 'warning' | 'pending_review' | 'rejected' | 'error';
  output?: string;
  confidence?: number;
  cost_usd?: number;
  cost_saved_usd?: number;
  error?: string;
}

export async function initPgBoss(): Promise<void> {
  if (boss) return;

  const connectionString =
    process.env['DATABASE_URL'] ??
    `postgresql://${process.env['DB_USER'] ?? 'llm_gateway'}:${process.env['DB_PASSWORD'] ?? ''}@${process.env['DB_HOST'] ?? 'localhost'}:${process.env['DB_PORT'] ?? '5432'}/${process.env['DB_NAME'] ?? 'llm_gateway'}`;

  boss = new PgBoss({
    connectionString,
    max: 5,
    retryLimit: MAX_RETRIES,
    retryDelay: 30,
    retryBackoff: true,
    deleteAfterDays: 7,
    archiveCompletedAfterSeconds: 3600,
  });

  boss.on('error', (err) => {
    logger.error({ err }, 'pg-boss error');
  });

  await boss.start();
  await boss.createQueue(QUEUE_NAME, { name: QUEUE_NAME,
    retryLimit: MAX_RETRIES,
    retryBackoff: true,
  });

  await (boss as unknown as { work: Function }).work(
    QUEUE_NAME,
    { concurrency: CONCURRENCY },
    processJob,
  );

  logger.info({ queue: QUEUE_NAME, concurrency: CONCURRENCY }, 'pg-boss initialized');
}

async function processJob(job: PgBoss.Job<BatchJobData>): Promise<void> {
  const { caller, tasks, webhook_url, batch_db_id } = job.data;
  logger.info({ jobId: job.id, caller, taskCount: tasks.length }, 'Processing batch job');

  const results: TaskResult[] = [];
  const GATEWAY_URL = `http://localhost:${process.env['PORT'] ?? '3100'}`;

  for (const task of tasks) {
    try {
      const response = await fetch(`${GATEWAY_URL}/v1/completion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Caller-ID': caller,
        },
        body: JSON.stringify({
          caller,
          task_type: task.task_type,
          input: task.input,
          language: task.language,
          context: task.context,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        results.push({
          task_type: task.task_type,
          status: 'error',
          error: `HTTP ${response.status}: ${errorBody}`,
        });
        continue;
      }

      const result = await response.json() as {
        status: 'approved' | 'warning' | 'pending_review' | 'rejected';
        output: string;
        confidence: number;
        cost?: { usd: number; saved_usd: number };
      };

      results.push({
        task_type: task.task_type,
        status: result.status,
        output: result.output,
        confidence: result.confidence,
        cost_usd: result.cost?.usd,
        cost_saved_usd: result.cost?.saved_usd,
      });
    } catch (err) {
      results.push({
        task_type: task.task_type,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Update batch job in DB
  if (batch_db_id) {
    const { query } = await import('../db/client.js');
    const completed = results.filter((r) => r.status !== 'error').length;
    const failed = results.filter((r) => r.status === 'error').length;
    const totalCostUsd = results.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
    const totalCostSavedUsd = results.reduce((sum, r) => sum + (r.cost_saved_usd ?? 0), 0);

    await query(
      `UPDATE batch_jobs
       SET completed_at = NOW(), status = 'completed', results = $1,
           completed_count = $2, failed_count = $3,
           total_cost_usd = $4, total_saved_usd = $5
       WHERE id = $6`,
      [JSON.stringify(results), completed, failed, totalCostUsd, totalCostSavedUsd, batch_db_id],
    ).catch((err) => logger.warn({ err }, 'Failed to update batch job'));

    logger.info(
      { batch_db_id, totalCostUsd, totalCostSavedUsd, taskCount: results.length },
      'Batch job cost tracked',
    );

    costStream.broadcast({
      callId: batch_db_id,
      project: 'llm-gateway',
      taskType: 'batch',
      model: 'batch-aggregated',
      costUsd: totalCostUsd,
      costSavedUsd: totalCostSavedUsd,
      tokensIn: 0,
      tokensOut: 0,
      confidence: completed > 0 ? completed / results.length : 0,
      timestamp: new Date().toISOString(),
    });
  }

  // Deliver to webhook
  if (webhook_url) {
    try {
      await fetch(webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_id: batch_db_id,
          caller,
          completed_at: new Date().toISOString(),
          results,
        }),
      });
      logger.info({ webhook_url, batch_db_id }, 'Batch webhook delivered');
    } catch (err) {
      logger.error({ err, webhook_url }, 'Failed to deliver batch webhook');
    }
  }
}

export async function submitBatchJob(
  caller: string,
  tasks: BatchJobData['tasks'],
  webhookUrl?: string,
  batchDbId?: string,
  priority = 0,
): Promise<string | null> {
  if (!boss) {
    throw new Error('pg-boss not initialized');
  }

  const jobId = await boss.send(
    QUEUE_NAME,
    {
      caller,
      tasks,
      webhook_url: webhookUrl,
      batch_db_id: batchDbId ?? '',
    } satisfies BatchJobData,
    {
      priority,
      retryLimit: MAX_RETRIES,
      retryBackoff: true,
      expireInSeconds: 3600,
    },
  );

  return jobId;
}

export function getPgBoss(): PgBoss | null {
  return boss;
}
