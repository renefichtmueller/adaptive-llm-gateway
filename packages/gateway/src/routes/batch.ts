import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { submitBatchJob } from '../queue/pg-boss-client.js';
import { query } from '../db/client.js';
import { logger } from '../observability/logger.js';

const BatchTaskSchema = z.object({
  task_type: z.string().min(1),
  input: z.string().min(1).max(50_000),
  language: z.enum(['de', 'en']).optional(),
  context: z.record(z.unknown()).optional(),
});

const BatchRequestSchema = z.object({
  caller: z.string().min(1).max(100),
  tasks: z.array(BatchTaskSchema).min(1).max(100),
  webhook_url: z.string().url().optional(),
  priority: z.number().int().min(0).max(10).optional().default(0),
});

type BatchRequest = z.infer<typeof BatchRequestSchema>;

export async function batchRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/batch',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let body: BatchRequest;
      try {
        body = BatchRequestSchema.parse(request.body);
      } catch (err) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: err instanceof z.ZodError ? err.errors[0]?.message : 'Invalid request body',
        });
      }

      const { caller, tasks, webhook_url, priority } = body;

      // Insert batch job record
      let batchDbId: string;
      try {
        const result = await query<{ id: string }>(
          `INSERT INTO batch_jobs (caller, task_count, webhook_url, status, pg_boss_id)
           VALUES ($1, $2, $3, 'queued', '')
           RETURNING id`,
          [caller, tasks.length, webhook_url ?? null],
        );
        batchDbId = result.rows[0]?.id ?? '';
      } catch (err) {
        logger.error({ err, caller }, 'Failed to create batch job record');
        return reply.status(500).send({ statusCode: 500, error: 'Internal Error', message: 'Failed to create batch job' });
      }

      // Submit to pg-boss queue
      let pgBossId: string | null;
      try {
        pgBossId = await submitBatchJob(
          caller,
          tasks.map((t) => ({
            task_type: t.task_type,
            input: t.input,
            language: t.language,
            context: t.context,
          })),
          webhook_url,
          batchDbId,
          priority,
        );
      } catch (err) {
        logger.error({ err, caller, batchDbId }, 'Failed to submit batch job to queue');
        await query(
          `UPDATE batch_jobs SET status = 'failed' WHERE id = $1`,
          [batchDbId],
        ).catch(() => {});
        return reply.status(500).send({ statusCode: 500, error: 'Queue Error', message: 'Failed to enqueue batch job' });
      }

      // Update with pg-boss ID
      if (pgBossId) {
        await query(
          `UPDATE batch_jobs SET pg_boss_id = $1 WHERE id = $2`,
          [pgBossId, batchDbId],
        ).catch((err) => logger.warn({ err }, 'Failed to update pg_boss_id'));
      }

      logger.info({ batchDbId, pgBossId, caller, taskCount: tasks.length }, 'Batch job submitted');

      return reply.status(202).send({
        batch_id: batchDbId,
        pg_boss_id: pgBossId,
        status: 'queued',
        task_count: tasks.length,
        caller,
        webhook_url: webhook_url ?? null,
        estimated_completion_ms: tasks.length * 5000, // rough estimate
        check_status_url: `/v1/batch/${batchDbId}`,
      });
    },
  );

  // GET batch status
  fastify.get(
    '/batch/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      try {
        const result = await query<{
          id: string;
          created_at: string;
          completed_at: string | null;
          caller: string;
          task_count: number;
          completed_count: number;
          failed_count: number;
          webhook_url: string | null;
          status: string;
          results: unknown;
        }>(
          `SELECT id, created_at, completed_at, caller, task_count, completed_count,
                  failed_count, webhook_url, status, results
           FROM batch_jobs WHERE id = $1`,
          [id],
        );

        const job = result.rows[0];
        if (!job) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Batch job not found' });
        }

        return reply.send(job);
      } catch (err) {
        logger.error({ err, id }, 'Failed to fetch batch job');
        return reply.status(500).send({ statusCode: 500, error: 'Internal Error', message: 'Failed to fetch batch job' });
      }
    },
  );
}
