/**
 * Semantic Cache
 *
 * Embedding-based response cache: if a new prompt is semantically close to
 * a recent successful call, return the cached response instead of paying
 * for inference again. Complements exact-match caching.
 *
 * Storage: in-memory ring buffer of recent (vector, response) pairs.
 * Configurable size + similarity threshold via env. For multi-instance
 * deployments, swap the in-memory store for Redis / pgvector.
 *
 * Off by default — enable via SEMANTIC_CACHE_ENABLED=1.
 */
import { logger } from '../observability/logger.js';

const ENABLED = process.env['SEMANTIC_CACHE_ENABLED'] === '1';
const MAX_ENTRIES = parseInt(process.env['SEMANTIC_CACHE_MAX_ENTRIES'] ?? '500', 10);
const SIMILARITY_THRESHOLD = parseFloat(process.env['SEMANTIC_CACHE_THRESHOLD'] ?? '0.93');
const TTL_MS = parseInt(process.env['SEMANTIC_CACHE_TTL_MS'] ?? '3600000', 10); // 1h
const EMBEDDINGS_URL = (process.env['EMBEDDINGS_BASE_URL'] ?? process.env['OLLAMA_URL'] ?? 'http://localhost:11434').replace(/\/$/, '');
const EMBEDDINGS_MODEL = process.env['SEMANTIC_CACHE_MODEL'] ?? process.env['EMBEDDINGS_MODEL'] ?? 'nomic-embed-text';

interface CacheEntry {
  vector: Float32Array;
  norm: number;
  prompt: string;
  taskType: string;
  response: string;
  storedAt: number;
}

interface CacheStats {
  enabled: boolean;
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
  bytesEstimate: number;
}

let stats = { hits: 0, misses: 0 };
const entries: CacheEntry[] = [];

function l2Norm(vec: number[] | Float32Array): number {
  let s = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s);
}

function cosineSimilarity(a: Float32Array, aNorm: number, b: Float32Array, bNorm: number): number {
  if (aNorm === 0 || bNorm === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot / (aNorm * bNorm);
}

async function embed(prompt: string): Promise<number[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${EMBEDDINGS_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDINGS_MODEL, prompt }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embedding?: number[] };
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function dropExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (let i = entries.length - 1; i >= 0; i--) {
    if ((entries[i]?.storedAt ?? 0) < cutoff) {
      entries.splice(i, 1);
    }
  }
}

/**
 * Look for a semantically-similar cached response. Returns the cached
 * response text if similarity exceeds the threshold, otherwise null.
 */
export async function semanticCacheLookup(prompt: string, taskType: string): Promise<{ hit: boolean; response?: string; similarity?: number; latencyMs: number }> {
  const t0 = Date.now();
  if (!ENABLED || entries.length === 0 || !prompt) {
    return { hit: false, latencyMs: Date.now() - t0 };
  }
  dropExpired();
  const vec = await embed(prompt);
  if (!vec) {
    stats.misses += 1;
    return { hit: false, latencyMs: Date.now() - t0 };
  }
  const probe = new Float32Array(vec);
  const probeNorm = l2Norm(probe);

  let bestIdx = -1;
  let bestSim = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.taskType !== taskType) continue; // only match within same task
    const sim = cosineSimilarity(probe, probeNorm, e.vector, e.norm);
    if (sim > bestSim) {
      bestSim = sim;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0 && bestSim >= SIMILARITY_THRESHOLD) {
    stats.hits += 1;
    return { hit: true, response: entries[bestIdx]!.response, similarity: bestSim, latencyMs: Date.now() - t0 };
  }
  stats.misses += 1;
  return { hit: false, similarity: bestSim, latencyMs: Date.now() - t0 };
}

/**
 * Store a successful (prompt, response) pair for future similarity lookups.
 */
export async function semanticCacheStore(prompt: string, taskType: string, response: string): Promise<void> {
  if (!ENABLED || !prompt || !response) return;
  const vec = await embed(prompt);
  if (!vec) return;

  const stored = new Float32Array(vec);
  const norm = l2Norm(stored);
  entries.push({
    vector: stored,
    norm,
    prompt: prompt.slice(0, 200),
    taskType,
    response,
    storedAt: Date.now(),
  });

  // Eviction: drop oldest when over capacity
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

export function getSemanticCacheStats(): CacheStats {
  const totalCalls = stats.hits + stats.misses;
  // Rough size estimate: each entry holds an N-float vector + small strings
  const bytesEstimate = entries.reduce((acc, e) => acc + e.vector.byteLength + e.prompt.length + e.response.length + 64, 0);
  return {
    enabled: ENABLED,
    entries: entries.length,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: totalCalls === 0 ? 0 : Math.round((stats.hits / totalCalls) * 100) / 100,
    bytesEstimate,
  };
}

/**
 * For tests: clear all entries + reset stats.
 */
export function __resetSemanticCache(): void {
  entries.length = 0;
  stats = { hits: 0, misses: 0 };
}

logger.info({ enabled: ENABLED, threshold: SIMILARITY_THRESHOLD, maxEntries: MAX_ENTRIES }, 'Semantic cache initialised');
