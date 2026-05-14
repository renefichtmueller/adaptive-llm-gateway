import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../observability/logger.js';

export async function staticRoute(fastify: FastifyInstance): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const publicDir = join(__dirname, '..', '..', 'public');

  logger.info({ publicDir }, 'Static file serving initialized');

  function sendHtml(filename: string, reply: any) {
    const filePath = join(publicDir, filename);
    if (!existsSync(filePath)) {
      logger.warn({ path: filePath }, `${filename} not found`);
      return reply.status(404).send({ error: `${filename} not found` });
    }

    const content = readFileSync(filePath, 'utf-8');
    return reply
      .header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .type('text/html')
      .send(content);
  }

  // Serve root path
  fastify.get('/', async (request, reply) => {
    logger.info({ method: request.method, url: request.url, host: request.hostname }, 'Root path requested');
    const dashboardPath = join(publicDir, 'dashboard.html');
    if (!existsSync(dashboardPath)) {
      logger.warn({ path: dashboardPath }, 'dashboard.html not found');
      return reply.status(404).send({ error: 'dashboard.html not found' });
    }
    const content = readFileSync(dashboardPath, 'utf-8');
    logger.info({ size: content.length }, 'Serving dashboard from root path');
    return reply.type('text/html').send(content);
  });

  // Serve /dashboard.html
  fastify.get('/dashboard.html', async (_request, reply) => {
    return sendHtml('dashboard.html', reply);
  });

  fastify.get('/dashboard-v2.html', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/v2/dashboard', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/v2/dashboard/', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/v2', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/v2/', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/dashboard/v2', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/dashboard/v2/', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/api/dashboard-v2', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/api/v2/dashboard', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  fastify.get('/api/dashboard/v2', async (_request, reply) => {
    return sendHtml('dashboard-v2.html', reply);
  });

  // Serve /api/dashboard as HTML for compatibility
  fastify.get('/api/dashboard', async (request, reply) => {
    // Check if this is a request for the dashboard UI (with ?ui=1 or no trailing segment)
    const url = request.url;
    const isDashboardUI = url === '/api/dashboard' || url === '/api/dashboard?ui=1' || url.startsWith('/api/dashboard?');

    if (isDashboardUI) {
      const dashboardPath = join(publicDir, 'dashboard.html');
      if (existsSync(dashboardPath)) {
        const content = readFileSync(dashboardPath, 'utf-8');
        logger.info({ size: content.length }, 'Serving dashboard from /api/dashboard');
        return reply.type('text/html').send(content);
      }
    }

    // Default response
    logger.warn({ path: 'dashboard.html' }, 'dashboard.html not found');
    return reply.status(404).send({ error: 'dashboard.html not found' });
  });
}
