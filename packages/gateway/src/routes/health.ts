import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { getOllamaBaseUrl } from '../pipeline/router.js';
import { getAllBreakerStates } from '../circuit-breaker/ollama-breaker.js';
import { query } from '../db/client.js';
import { getPgBoss } from '../queue/pg-boss-client.js';
import { logger } from '../observability/logger.js';

interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  checks: {
    ollama: { status: 'ok' | 'down'; latency_ms?: number; error?: string };
    database: { status: 'ok' | 'down'; error?: string };
    queue: { status: 'ok' | 'down' | 'unknown'; depth?: number; error?: string };
    review_queue: { unreviewed_count: number };
    circuit_breakers: Record<string, 'closed' | 'open' | 'half-open'>;
  };
}

async function checkOllama(baseUrl: string): Promise<{ status: 'ok' | 'down'; latency_ms?: number; error?: string }> {
  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(15000),
    });
    const latency_ms = Date.now() - start;
    if (!response.ok) {
      return { status: 'down', error: `HTTP ${response.status}`, latency_ms };
    }
    return { status: 'ok', latency_ms };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

async function checkDatabase(): Promise<{ status: 'ok' | 'down'; error?: string }> {
  try {
    await query('SELECT 1');
    return { status: 'ok' };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

async function checkQueue(): Promise<{ status: 'ok' | 'down' | 'unknown'; depth?: number; error?: string }> {
  const boss = getPgBoss();
  if (!boss) return { status: 'unknown' };

  try {
    const [queued, active] = await Promise.all([
      boss.getQueueSize('llm-batch', { before: 'completed' }),
      boss.getQueueSize('llm-batch', { before: 'active' }),
    ]);
    return { status: 'ok', depth: (queued ?? 0) + (active ?? 0) };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

async function getReviewQueueCount(): Promise<number> {
  try {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM review_queue WHERE decision IS NULL',
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  } catch {
    return 0;
  }
}

export async function healthRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/health',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Check if this is a dashboard UI request with ?ui=1 or ?dashboard=1
      const query = request.query as any;
      const isDashboardRequest = query.ui || query.dashboard;
      const acceptsHtml = String(request.headers.accept ?? '').includes('text/html');

      if (isDashboardRequest || acceptsHtml) {
        try {
          const __filename = fileURLToPath(import.meta.url);
          const __dirname = dirname(__filename);
          const publicDir = join(__dirname, '..', '..', 'public');
          const dashboardPath = join(publicDir, 'dashboard.html');

          if (existsSync(dashboardPath)) {
            const content = readFileSync(dashboardPath, 'utf-8');
            logger.info({ size: content.length }, 'Serving dashboard from /health?ui=1');
            return reply.type('text/html').send(content);
          }
        } catch (err) {
          logger.error({ err }, 'Failed to serve dashboard from /health');
          // Fall through to return health status instead
        }
      }

      const ollamaBaseUrl = getOllamaBaseUrl();

      const [ollamaCheck, dbCheck, queueCheck, reviewCount] = await Promise.all([
        checkOllama(ollamaBaseUrl),
        checkDatabase(),
        checkQueue(),
        getReviewQueueCount(),
      ]);

      const breakerStates = getAllBreakerStates();

      const isDown = ollamaCheck.status === 'down' || dbCheck.status === 'down';
      const isDegraded = queueCheck.status === 'down' || Object.values(breakerStates).some((s) => s === 'open');

      const status: HealthStatus['status'] = isDown ? 'down' : isDegraded ? 'degraded' : 'ok';

      const health: HealthStatus = {
        status,
        timestamp: new Date().toISOString(),
        checks: {
          ollama: ollamaCheck,
          database: dbCheck,
          queue: queueCheck,
          review_queue: { unreviewed_count: reviewCount },
          circuit_breakers: breakerStates,
        },
      };

      const statusCode = isDown ? 503 : 200;
      if (status !== 'ok') {
        logger.warn({ status, checks: health.checks }, 'Health check degraded');
      }

      return reply.status(statusCode).send(health);
    },
  );

  // Kubernetes-style liveness probe (minimal check)
  fastify.get(
    '/health/live',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ status: 'alive', ts: Date.now() });
    },
  );

  // Kubernetes-style readiness probe
  fastify.get(
    '/health/ready',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const dbCheck = await checkDatabase();
      if (dbCheck.status === 'down') {
        return reply.status(503).send({ status: 'not ready', reason: 'database unavailable' });
      }
      return reply.send({ status: 'ready' });
    },
  );

  // Test endpoint in health route
  fastify.get(
    '/health/test',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ test: 'ok', message: 'Test from health route', route: 'health.ts' });
    },
  );
}
