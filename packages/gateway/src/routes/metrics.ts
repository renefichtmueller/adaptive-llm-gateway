import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getMetrics, getContentType } from '../observability/metrics.js';

export async function metricsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/metrics',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const metrics = await getMetrics();
      return reply
        .header('Content-Type', getContentType())
        .send(metrics);
    },
  );
}
