/**
 * Internal endpoints for the learning engine (packages/learning).
 *
 * The learning service calls these to close the autonomy loop:
 *   - POST /internal/reload-config    → routing-optimizer applied a change to
 *                                       routing-rules.yaml; reload it live
 *   - POST /internal/learning-report  → daily learning report notification
 *
 * Guarded by the X-Internal-Secret header (INTERNAL_SECRET env on both
 * sides; keep the default only for single-host development setups).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { reloadConfigs } from '../pipeline/router.js';
import { logger } from '../observability/logger.js';

const INTERNAL_SECRET = process.env['INTERNAL_SECRET'] ?? 'internal-learning-secret';

function hasValidSecret(request: FastifyRequest): boolean {
  return request.headers['x-internal-secret'] === INTERNAL_SECRET;
}

export async function internalRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/internal/reload-config', async (request, reply) => {
    if (!hasValidSecret(request)) {
      return reply.code(401).send({ error: 'invalid internal secret' });
    }

    const body = (request.body ?? {}) as { reason?: string; taskType?: string };
    try {
      reloadConfigs();
      logger.info(
        { reason: body.reason ?? 'unspecified', taskType: body.taskType },
        'Routing/model config reloaded on internal request',
      );
      return { success: true, reloaded: ['models.yaml', 'routing-rules.yaml'] };
    } catch (err) {
      logger.error({ err }, 'Config reload failed');
      return reply.code(500).send({ success: false, error: 'reload failed' });
    }
  });

  fastify.post('/internal/learning-report', async (request, reply) => {
    if (!hasValidSecret(request)) {
      return reply.code(401).send({ error: 'invalid internal secret' });
    }

    const report = request.body as Record<string, unknown> | null;
    logger.info(
      {
        periodFrom: report?.['period_from'],
        periodTo: report?.['period_to'],
      },
      'Learning report received from learning engine',
    );
    return { success: true };
  });
}
