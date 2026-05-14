/**
 * Voice Pipeline endpoints — OpenAI-compatible audio routes.
 *
 *   POST /v1/audio/transcriptions    (Speech → Text via Whisper)
 *   POST /v1/audio/translations      (Speech → English Text)
 *   POST /v1/audio/speech            (Text → Speech via configured TTS)
 *
 * Default STT backend: local `whisper.cpp` HTTP server (env WHISPER_URL).
 * Default TTS backend: `piper` HTTP server (env PIPER_URL).
 * Both default to disabled — if the backend URL is unset, route returns 503.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../observability/logger.js';

const WHISPER_URL = (process.env['WHISPER_URL'] ?? '').replace(/\/$/, '');
const PIPER_URL = (process.env['PIPER_URL'] ?? '').replace(/\/$/, '');
const AUDIO_TIMEOUT_MS = parseInt(process.env['AUDIO_TIMEOUT_MS'] ?? '60000', 10);

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function audioRoute(fastify: FastifyInstance): Promise<void> {
  // ─── Transcriptions (multipart) ─────────────────────────────────────────
  fastify.post('/audio/transcriptions', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!WHISPER_URL) {
      return reply.status(503).send({ error: { message: 'WHISPER_URL not configured', type: 'service_unavailable' } });
    }
    try {
      // Forward the multipart body verbatim to the upstream Whisper server.
      const body = (request as unknown as { body: Buffer | unknown }).body;
      const contentType = request.headers['content-type'] ?? 'multipart/form-data';
      const upstream = await fetchWithTimeout(`${WHISPER_URL}/inference`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: body as never,
      }, AUDIO_TIMEOUT_MS);
      const data = await upstream.json();
      return reply.status(upstream.status).send(data);
    } catch (err) {
      logger.error({ err }, 'Audio transcription forwarding failed');
      return reply.status(502).send({ error: { message: 'transcription failed', type: 'upstream_error' } });
    }
  });

  // ─── Speech synthesis ────────────────────────────────────────────────────
  fastify.post('/audio/speech', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!PIPER_URL) {
      return reply.status(503).send({ error: { message: 'PIPER_URL not configured', type: 'service_unavailable' } });
    }
    const body = (request.body as Record<string, unknown>) ?? {};
    const text = String(body['input'] ?? '');
    const voice = String(body['voice'] ?? 'en_US-amy-medium');
    if (!text) {
      return reply.status(400).send({ error: { message: '`input` text required', type: 'invalid_request' } });
    }
    try {
      const upstream = await fetchWithTimeout(`${PIPER_URL}/?voice=${encodeURIComponent(voice)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      }, AUDIO_TIMEOUT_MS);
      reply.raw.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'audio/wav',
      });
      const buf = await upstream.arrayBuffer();
      reply.raw.end(Buffer.from(buf));
      return reply;
    } catch (err) {
      logger.error({ err }, 'Audio speech forwarding failed');
      return reply.status(502).send({ error: { message: 'speech failed', type: 'upstream_error' } });
    }
  });
}
