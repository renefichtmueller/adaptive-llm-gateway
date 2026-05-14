/**
 * Semantic cache — unit tests for the in-memory cosine-similarity store.
 *
 * Embeddings are stubbed via fetch mock since the real backend requires
 * a running Ollama. We verify hit/miss logic, eviction, and stats.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Force enabled BEFORE importing the module
process.env['SEMANTIC_CACHE_ENABLED'] = '1';
process.env['SEMANTIC_CACHE_MAX_ENTRIES'] = '5';
process.env['SEMANTIC_CACHE_THRESHOLD'] = '0.9';

const {
  semanticCacheLookup,
  semanticCacheStore,
  getSemanticCacheStats,
  __resetSemanticCache,
} = await import('../semantic-cache.js');

/** Build a fake 4-dim vector based on a seed character so similar inputs get similar vectors */
function fakeVector(seed: string): number[] {
  const code = seed.charCodeAt(0) || 1;
  return [code / 100, code / 200, code / 300, code / 400];
}

const originalFetch = global.fetch;

beforeEach(() => {
  __resetSemanticCache();
  global.fetch = vi.fn(async (url: any, init: any) => {
    const body = JSON.parse(init?.body ?? '{}');
    const prompt = String(body.prompt ?? '');
    const vector = fakeVector(prompt);
    return new Response(JSON.stringify({ embedding: vector }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('semantic-cache', () => {
  it('returns miss when empty', async () => {
    const r = await semanticCacheLookup('hello', 'qa');
    expect(r.hit).toBe(false);
  });

  it('hits on identical prompt + same task', async () => {
    await semanticCacheStore('hello world', 'qa', 'cached response');
    const r = await semanticCacheLookup('hello world', 'qa');
    expect(r.hit).toBe(true);
    expect(r.response).toBe('cached response');
    expect(r.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it('does not cross task_type boundaries', async () => {
    await semanticCacheStore('hello', 'qa', 'qa answer');
    const r = await semanticCacheLookup('hello', 'code-review');
    expect(r.hit).toBe(false);
  });

  it('reports stats correctly', async () => {
    __resetSemanticCache();
    await semanticCacheStore('a', 'qa', 'response a');
    await semanticCacheLookup('a', 'qa');       // hit
    await semanticCacheLookup('zzz', 'qa');     // miss (different vector)
    const s = getSemanticCacheStats();
    expect(s.enabled).toBe(true);
    expect(s.entries).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBe(0.5);
  });

  it('evicts oldest beyond MAX_ENTRIES', async () => {
    for (let i = 0; i < 10; i++) {
      await semanticCacheStore('p' + String.fromCharCode(65 + i), 'qa', 'r' + i);
    }
    const s = getSemanticCacheStats();
    expect(s.entries).toBeLessThanOrEqual(5); // MAX_ENTRIES
  });
});
