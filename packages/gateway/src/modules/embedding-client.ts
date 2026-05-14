/**
 * Embedding Client
 *
 * Generates vector embeddings via Ollama (`nomic-embed-text`, 768 dim).
 * Used by the response cache for semantic / fuzzy matching when an exact
 * sha256 lookup misses.
 *
 * Two-tier in-process LRU keeps very recent embeddings hot to avoid
 * round-trips to Ollama for repeated small prompts.
 */
import { logger } from '../observability/logger.js';

const OLLAMA_URL = (process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434').replace(/\/$/, '');
const EMBED_MODEL = process.env['EMBEDDING_MODEL'] || 'nomic-embed-text';
const EMBED_TIMEOUT_MS = 5_000;

export const EMBEDDING_DIMENSION = 768;

// Tiny LRU — string text → vector, capped at 200 entries
const cache = new Map<string, number[]>();
const MAX_CACHE = 200;

function lruGet(key: string): number[] | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function lruSet(key: string, value: number[]): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
    else break;
  }
}

/**
 * Compute an embedding for a piece of text. Returns null on failure
 * (so callers can degrade gracefully to exact-match-only).
 */
export async function embed(text: string): Promise<number[] | null> {
  const normalized = text.trim().slice(0, 8_192);
  if (normalized.length === 0) return null;

  const cached = lruGet(normalized);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: normalized }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ status: res.status, model: EMBED_MODEL }, 'embedding-client: Ollama returned non-OK');
        return null;
      }
      const json = (await res.json()) as { embedding?: number[] };
      const vec = json.embedding;
      if (!vec || vec.length !== EMBEDDING_DIMENSION) {
        logger.warn({ got: vec?.length, expected: EMBEDDING_DIMENSION }, 'embedding-client: bad dimension');
        return null;
      }
      lruSet(normalized, vec);
      return vec;
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    logger.debug({ err }, 'embedding-client: embed failed');
    return null;
  }
}

/** Format a JS number[] as a pgvector literal string: '[0.1,0.2,…]' */
export function vectorToPgLiteral(vec: number[]): string {
  return `[${vec.map((v) => v.toFixed(6)).join(',')}]`;
}
