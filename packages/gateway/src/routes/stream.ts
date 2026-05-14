import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { costStream } from '../observability/cost-stream.js';
import { logger } from '../observability/logger.js';

export async function streamRoute(fastify: FastifyInstance): Promise<void> {
  /**
   * Server-Sent Events (SSE) endpoint for real-time cost updates
   * Clients connect via EventSource('GET /api/stream/costs')
   * Server broadcasts cost updates as they happen
   */
  fastify.get('/api/stream/costs', async (request: FastifyRequest, reply: FastifyReply) => {
    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    });

    const clientIp = request.ip;
    const clientId = `${clientIp}-${Date.now()}`;

    logger.debug({ clientId, clientIp }, 'SSE client connected');

    // Send initial connection message
    reply.raw.write('event: connected\n');
    reply.raw.write(`data: {"clientId":"${clientId}","timestamp":"${new Date().toISOString()}"}\n\n`);

    // Subscribe to cost updates
    const unsubscribe = costStream.subscribe((update) => {
      try {
        reply.raw.write('event: cost-update\n');
        reply.raw.write(`data: ${JSON.stringify(update)}\n\n`);
      } catch (err) {
        logger.debug({ clientId, err }, 'Error writing to SSE stream');
        unsubscribe();
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    });

    // Handle client disconnect
    reply.raw.on('close', () => {
      logger.debug({ clientId }, 'SSE client disconnected');
      unsubscribe();
    });

    // Keep connection alive with heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try {
        if (reply.raw.writable) {
          reply.raw.write(`: heartbeat\n\n`);
        } else {
          clearInterval(heartbeat);
          unsubscribe();
        }
      } catch (err) {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30000);

    // Cleanup on reply finish
    reply.raw.on('finish', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Prevent response from ending automatically
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /**
   * Health check endpoint for stream connection testing
   */
  fastify.get('/api/stream/health', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });
}
