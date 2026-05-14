import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  listPendingReviews,
  processDecision,
} from '../observability/review-queue.js';
import { logger } from '../observability/logger.js';

const DecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'edited']),
  edited_output: z.string().optional(),
  reviewer_notes: z.string().optional(),
});

export async function reviewRoute(fastify: FastifyInstance): Promise<void> {
  // List pending review items
  fastify.get(
    '/review',
    async (
      request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
      reply: FastifyReply,
    ) => {
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 100);
      const offset = Math.max(parseInt(request.query.offset ?? '0', 10), 0);

      try {
        const items = await listPendingReviews(limit, offset);
        return reply.send({
          items,
          count: items.length,
          limit,
          offset,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to list review queue');
        return reply.status(500).send({ statusCode: 500, error: 'Internal Error', message: 'Failed to list review items' });
      }
    },
  );

  // Submit decision for a review item
  fastify.post(
    '/review/:id/decide',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      let body;
      try {
        body = DecisionSchema.parse(request.body);
      } catch (err) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: err instanceof z.ZodError ? err.errors[0]?.message : 'Invalid request',
        });
      }

      if (body.decision === 'edited' && !body.edited_output) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'edited_output is required when decision is "edited"',
        });
      }

      try {
        const updated = await processDecision(id, body);
        if (!updated) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Review item not found' });
        }
        logger.info({ id, decision: body.decision }, 'Review decision submitted');
        return reply.send(updated);
      } catch (err) {
        logger.error({ err, id }, 'Failed to process review decision');
        return reply.status(500).send({ statusCode: 500, error: 'Internal Error', message: 'Failed to process decision' });
      }
    },
  );
}
