/**
 * /v1/embeddings — OpenAI-compatible embeddings endpoint.
 *
 * Routes embedding requests to the configured embedding model. Default
 * backend is local Ollama (`nomic-embed-text`), which is free and fast.
 * Set EMBEDDINGS_MODEL / EMBEDDINGS_BASE_URL to point elsewhere.
 *
 * Compatible with OpenAI's `openai.embeddings.create()` and any SDK that
 * speaks the standard shape.
 */
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../observability/logger.js';

const EMBEDDINGS_BASE_URL = (process.env['EMBEDDINGS_BASE_URL'] ?? process.env['OLLAMA_URL'] ?? 'http://localhost:11434').replace(/\/$/, '');
const DEFAULT_MODEL = process.env['EMBEDDINGS_MODEL'] ?? 'nomic-embed-text';
const REQUEST_TIMEOUT_MS = parseInt(process.env['EMBEDDINGS_TIMEOUT_MS'] ?? '20000', 10);

const EmbeddingRequestSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional().default(DEFAULT_MODEL),
  encoding_format: z.enum(['float', 'base64']).optional().default('float'),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});

interface OllamaEmbeddingResponse {
  embedding: number[];
}

async function fetchEmbedding(model: string, prompt: string, timeoutMs: number): Promise<number[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${EMBEDDINGS_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Embeddings backend HTTP ${res.status}`);
    }
    const data = (await res.json()) as OllamaEmbeddingResponse;
    if (!Array.isArray(data.embedding)) {
      throw new Error('Invalid embeddings response shape');
    }
    return data.embedding;
  } finally {
    clearTimeout(timer);
  }
}

function toBase64(vector: readonly number[]): string {
  const buf = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    buf.writeFloatLE(vector[i] ?? 0, i * 4);
  }
  return buf.toString('base64');
}

export async function embeddingsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/embeddings', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = EmbeddingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          message: parsed.error.errors[0]?.message ?? 'Invalid embeddings request',
          type: 'invalid_request_error',
          code: 400,
        },
      });
    }

    const startMs = Date.now();
    const { input, model, encoding_format } = parsed.data;
    const inputs = Array.isArray(input) ? input : [input];

    if (inputs.length === 0) {
      return reply.status(400).send({
        error: { message: '`input` must contain at least one item', type: 'invalid_request_error' },
      });
    }
    if (inputs.length > 100) {
      return reply.status(400).send({
        error: { message: '`input` may not exceed 100 items per call', type: 'invalid_request_error' },
      });
    }

    try {
      const vectors = await Promise.all(
        inputs.map((text) => fetchEmbedding(model, text, REQUEST_TIMEOUT_MS)),
      );
      const data = vectors.map((vec, index) => ({
        object: 'embedding',
        index,
        embedding: encoding_format === 'base64' ? toBase64(vec) : vec,
      }));
      const totalTokens = inputs.reduce((acc, s) => acc + Math.ceil(s.length / 4), 0);

      return reply.send({
        object: 'list',
        data,
        model,
        usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
        _gateway_latency_ms: Date.now() - startMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'embeddings call failed';
      logger.error({ err, model }, '/v1/embeddings backend error');
      return reply.status(502).send({
        error: { message: msg.slice(0, 200), type: 'upstream_error' },
      });
    }
  });
}
