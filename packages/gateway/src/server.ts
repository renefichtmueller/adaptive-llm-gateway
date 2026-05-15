import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import { completionRoute } from './routes/completion.js';
import { batchRoute } from './routes/batch.js';
import { classifyRoute } from './routes/classify.js';
import { healthRoute } from './routes/health.js';
import { metricsRoute } from './routes/metrics.js';
import { reviewRoute } from './routes/review.js';
import { dashboardRoute } from './routes/dashboard.js';
import { streamRoute } from './routes/stream.js';
import { learningInsightsRoute } from './routes/learning-insights.js';
import { embeddingsRoute } from './routes/embeddings.js';
import { replayRoute } from './routes/replay.js';
import { audioRoute } from './routes/audio.js';
import { mcpRoute } from './modules/mcp-server.js';
import { loadWorkspacePreset, applyWorkspaceDefaults } from './modules/workspace-presets.js';
import { loadPlugins } from './modules/plugin-system.js';
import { startBridgeWatchdog } from './modules/bridge-watchdog.js';
import { ingestPeerStats, scheduleFederationPublisher, buildStats } from './modules/federated-stats.js';
import { scheduleAdaptiveLearner, getAllRecommendations } from './modules/adaptive-routing.js';
import { staticRoute } from './routes/static.js';
import { getPool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { initPgBoss } from './queue/pg-boss-client.js';
import { logger } from './observability/logger.js';
import { scheduleLearningCycles } from './learning/learning-engine.js';
import { autoSpawnOnBoot } from './modules/auto-discovery.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import {
  getTLSConfig,
  loadTLSCertificates,
  validateTLSConfig,
  validateDatabaseSSL,
  registerHSTSMiddleware,
  registerHTTPSRedirectMiddleware,
  registerSecurityHeadersMiddleware,
} from './security/tls-config.js';

// Per-caller rate limits (requests/min). Override or extend via env or your
// own deployment config. The "default" entry is used for any caller not
// listed here. "internal" + "dashboard" are reserved gateway-internal callers.
const RATE_LIMITS: Record<string, number> = {
  'dashboard': 300,
  'internal': 1000,
  'default': 100,
};

export function getCallerRateLimit(caller: string): number {
  return RATE_LIMITS[caller] ?? RATE_LIMITS['default'] ?? 20;
}

async function buildServer() {
  const server = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
    },
    trustProxy: true,
  });

  // CIS 3.2: Data in Transit Encryption
  const tlsConfig = getTLSConfig();
  const tlsErrors = validateTLSConfig(tlsConfig);
  if (tlsErrors.length > 0) {
    logger.warn({ tlsErrors }, 'TLS configuration warnings');
  }

  const dbSSLCheck = validateDatabaseSSL();
  if (!dbSSLCheck.valid) {
    logger.warn({ error: dbSSLCheck.error }, 'Database SSL validation failed');
  }

  // Register security headers middleware (before Helmet to allow proper ordering)
  await registerSecurityHeadersMiddleware(server);
  await registerHSTSMiddleware(server, tlsConfig);
  await registerHTTPSRedirectMiddleware(server);

  await server.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
      },
    },
  });

  // CORS origins are configurable via GATEWAY_CORS_ORIGINS env var
  // (comma-separated). Localhost is allowed by default; everything else is
  // off until explicitly listed.
  const corsAllowList = (process.env['GATEWAY_CORS_ORIGINS'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await server.register(fastifyCors, {
    origin: [
      'http://localhost:0000',
      'http://localhost:0000',
      'http://localhost:0000',
      'http://localhost:0000',
      ...corsAllowList,
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Caller-ID'],
    credentials: true,
  });

  await server.register(fastifyRateLimit, {
    global: true,
    max: 1000,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const caller = (request.headers['x-caller-id'] as string) ?? 'default';
      return `${caller}:${request.ip}`;
    },
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${context.after}`,
    }),
  });

  await server.register(completionRoute, { prefix: '/v1' });
  await server.register(embeddingsRoute, { prefix: '/v1' });
  await server.register(replayRoute, { prefix: '/v1' });
  await server.register(audioRoute, { prefix: '/v1' });
  await server.register(mcpRoute);
  // Federation ingest endpoint (opt-in)
  server.post('/v1/federation/ingest', async (request, reply) => {
    const result = ingestPeerStats(request.body as never);
    return reply.send({ success: true, ...result });
  });
  await server.register(batchRoute, { prefix: '/v1' });
  await server.register(classifyRoute, { prefix: '/v1' });
  await server.register(reviewRoute, { prefix: '/v1' });
  await server.register(learningInsightsRoute, { prefix: '/v1' });
  await server.register(healthRoute);
  await server.register(metricsRoute);
  await server.register(staticRoute);
  await server.register(dashboardRoute);
  await server.register(streamRoute);

  server.setErrorHandler((error, request, reply) => {
    logger.error({ error, url: request.url, method: request.method }, 'Unhandled error');
    const statusCode = (error instanceof Error && 'statusCode' in error && typeof (error as any).statusCode === 'number') ? (error as any).statusCode : 500;
    const errorName = error instanceof Error ? error.name : 'InternalServerError';
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    reply.status(statusCode).send({
      statusCode,
      error: errorName,
      message: statusCode >= 500 ? 'Internal server error' : errorMessage,
    });
  });

  server.setNotFoundHandler((request, reply) => {
    // Serve dashboard for root path as fallback (handles Cloudflare tunnel routing issues)
    if (request.url === '/' || request.url === '/dashboard.html') {
      try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const publicDir = join(__dirname, '..', 'public');
        const dashboardPath = join(publicDir, 'dashboard.html');
        if (existsSync(dashboardPath)) {
          const content = readFileSync(dashboardPath, 'utf-8');
          return reply.type('text/html').send(content);
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to serve dashboard fallback');
      }
    }
    reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found' });
  });

  return server;
}

async function main() {
  const server = await buildServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      await server.close();
      const pool = getPool();
      await pool.end();
      logger.info('Server and DB connections closed');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = parseInt(process.env['PORT'] ?? '0000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  try {
    try {
      await runMigrations();
    } catch (migErr) {
      logger.warn({ migErr }, 'Migration failed - starting server without DB');
    }
    try {
      await initPgBoss();
    } catch (pgErr) {
      logger.warn({ pgErr }, 'PgBoss init failed - continuing without queue');
    }
    // Workspace preset (apply env defaults from workspace.yaml if present)
    try {
      const preset = await loadWorkspacePreset();
      if (preset) applyWorkspaceDefaults(preset);
    } catch (err) {
      logger.warn({ err }, 'Workspace preset load failed (non-fatal)');
    }

    // Plugin system (load pre/post hooks from PLUGINS_DIR)
    try {
      await loadPlugins();
    } catch (err) {
      logger.warn({ err }, 'Plugin loading failed (non-fatal)');
    }

    scheduleLearningCycles();
    await server.listen({ port, host });
    logger.info({ port, host }, 'LLM Gateway started');

    // Auto-spawn detected subscription bridges if AUTO_SPAWN_BRIDGES=1
    void autoSpawnOnBoot();

    // Bridge watchdog (opt-in via WATCHDOG_ENABLED=1)
    try {
      startBridgeWatchdog();
    } catch (err) {
      logger.warn({ err }, 'Bridge watchdog start failed');
    }

    // Adaptive routing learner (cost-aware recommendations from llm_calls)
    try {
      const pool = getPool();
      scheduleAdaptiveLearner(pool);
    } catch (err) {
      logger.warn({ err }, 'Adaptive learner scheduling failed');
    }

    // Federation publisher (opt-in via FEDERATION_ENABLED=1)
    scheduleFederationPublisher(async () => {
      const recos = getAllRecommendations();
      return buildStats(recos.map((r) => ({
        task_type: r.taskType,
        model_used: r.preferredModel,
        samples: r.rationale.samples,
        success_rate: r.rationale.successRate,
        avg_latency_ms: r.rationale.avgLatencyMs,
      })));
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main();
