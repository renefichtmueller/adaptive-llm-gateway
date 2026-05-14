/**
 * Auto-discovery smoke tests. These mostly verify shape — actual network
 * probes are stubbed/timed-out and treated as "not detected" in CI.
 */
import { describe, it, expect } from 'vitest';
import { runDiscovery } from '../auto-discovery.js';

describe('runDiscovery', () => {
  it('returns a well-shaped DiscoveryReport', async () => {
    const r = await runDiscovery();
    expect(r).toMatchObject({
      generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      subscriptions: expect.objectContaining({
        detected: expect.any(Number),
        authenticated: expect.any(Number),
        bridgesRunning: expect.any(Number),
        items: expect.any(Array),
      }),
      localLLMs: expect.objectContaining({
        detected: expect.any(Number),
        items: expect.any(Array),
      }),
      apiKeys: expect.objectContaining({
        configured: expect.any(Number),
        items: expect.any(Array),
      }),
      summary: expect.objectContaining({
        totalProviders: expect.any(Number),
        totalRoutableModels: expect.any(Number),
      }),
    });
  }, 30_000);

  it('lists all four local LLM probes', async () => {
    const r = await runDiscovery();
    const ids = r.localLLMs.items.map((l) => l.id).sort();
    expect(ids).toEqual(['llamafile', 'lmstudio', 'ollama', 'vllm']);
  }, 30_000);

  it('lists the expected API-key providers', async () => {
    const r = await runDiscovery();
    const ids = r.apiKeys.items.map((k) => k.id);
    expect(ids).toContain('cerebras');
    expect(ids).toContain('groq');
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('together');
    expect(ids).toContain('deepseek');
  }, 30_000);

  it('summary.totalProviders is the sum of detected sources', async () => {
    const r = await runDiscovery();
    const expected =
      r.subscriptions.items.filter((s) => s.installed).length +
      r.localLLMs.items.filter((l) => l.detected).length +
      r.apiKeys.items.filter((k) => k.configured).length;
    expect(r.summary.totalProviders).toBe(expected);
  }, 30_000);
});
