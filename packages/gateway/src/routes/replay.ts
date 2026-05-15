/**
 * Time-travel debugging — replay any past `llm_calls` row through the
 * gateway with different parameters (different model, prompt, options).
 *
 *   POST /v1/replay
 *     { call_id, overrides?: { model?, temperature?, task_type?, input?, compression? } }
 *   → returns the new completion result alongside the original for diff.
 *
 * Useful for:
 *   - debugging routing decisions ("did GPT-4o handle this better?")
 *   - A/B-testing model swaps
 *   - regression-checking before promoting a routing-rules.yaml change
 */
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db/client.js';
import { logger } from '../observability/logger.js';

const ReplayRequestSchema = z.object({
  call_id: z.string().uuid(),
  overrides: z.object({
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    task_type: z.string().optional(),
    input: z.string().optional(),
    compression: z.object({
      enabled: z.boolean().optional(),
      mode: z.enum(['auto', 'off', 'aggressive']).optional(),
    }).optional(),
  }).optional(),
  include_original: z.boolean().optional().default(true),
});

export async function replayRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/replay', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = ReplayRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { message: parsed.error.errors[0]?.message ?? 'Invalid replay request', type: 'invalid_request' },
      });
    }
    const { call_id, overrides, include_original } = parsed.data;

    const db = getPool();
    const rows = (await db.query(
      `SELECT id, caller, task_type, model_used, prompt_id, output_text, token_count_in, token_count_out, latency_ms, confidence, status, metadata
       FROM llm_calls WHERE id = $1`,
      [call_id],
    )).rows as Array<Record<string, unknown>>;
    const original = rows[0];
    if (!original) {
      return reply.status(404).send({ error: { message: 'call_id not found', type: 'not_found' } });
    }

    // The original prompt's full text isn't in audit-log (only the hash),
    // so the caller must provide it via overrides.input when replaying.
    const replayInput = overrides?.input;
    if (!replayInput) {
      return reply.status(400).send({
        error: {
          message: 'Original prompt text is not retained in audit-log; provide overrides.input to replay',
          type: 'missing_input',
        },
      });
    }

    // Build a fresh request envelope and forward to /v1/completion locally
    const payload = {
      caller: `replay:${original['caller']}`,
      task_type: overrides?.task_type ?? original['task_type'],
      input: replayInput,
      options: {
        model: overrides?.model,
        temperature: overrides?.temperature,
        compression: overrides?.compression,
      },
    };

    try {
      const baseUrl = process.env['INTERNAL_GATEWAY_URL'] ?? `http://localhost:${process.env['PORT'] ?? '0000'}`;
      const res = await fetch(`${baseUrl}/v1/completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const replayed = await res.json();
      return reply.send({
        original: include_original ? original : null,
        replayed,
        diff: {
          model: { from: original['model_used'], to: (replayed as any)?.model ?? overrides?.model },
          confidence: { from: original['confidence'], to: (replayed as any)?.confidence },
          tokens_out: { from: original['token_count_out'], to: (replayed as any)?.tokens?.out },
          latency_ms: { from: original['latency_ms'], to: (replayed as any)?.latency_ms },
        },
      });
    } catch (err) {
      logger.error({ err, call_id }, 'Replay forwarding failed');
      return reply.status(502).send({ error: { message: 'Replay forwarding failed', type: 'upstream_error' } });
    }
  });
}
