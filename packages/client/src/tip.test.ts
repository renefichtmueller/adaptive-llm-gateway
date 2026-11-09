import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTIPClient, TIPClient } from './tip.js';

/**
 * Hermetic unit tests for the TIP client — global fetch is mocked, so no
 * gateway or Ollama needs to be running.
 */

const GATEWAY_URL = 'http://gateway.test:8787';

function gatewayCompletionResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-123',
    status: 'approved',
    confidence: 8,
    model: 'qwen2.5:14b',
    task_type: 'agent_completion',
    latency_ms: 42,
    tokens: { in: 10, out: 20 },
    output: 'gateway says hi',
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('TIPClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('maps a gateway response to the TIP result shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(gatewayCompletionResponse()));

    const client = createTIPClient({ agentId: 'claude-code', gatewayUrl: GATEWAY_URL });
    const result = await client.completion('explain this', { maxTokens: 100 });

    expect(result.text).toBe('gateway says hi');
    expect(result.model).toBe('qwen2.5:14b');
    expect(result.tokens).toEqual({ input: 10, output: 20 });
    expect(result.confidence).toBeCloseTo(0.8); // 8/10 normalized
    expect(result.fallback).toBe(false);
    expect(result.latencyMs).toBe(42);
    expect(result.requestId).toBe('req-123');
    expect(result.status).toBe('approved');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${GATEWAY_URL}/v1/completion`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.caller).toBe('claude-code');
    expect(body.task_type).toBe('agent_completion');
    expect(body.input).toBe('explain this');
    expect(body.options.max_tokens).toBe(100);
  });

  it('forwards metadata as prompt context', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(gatewayCompletionResponse()));

    const client = createTIPClient({ agentId: 'ide', gatewayUrl: GATEWAY_URL });
    await client.completion('prompt', { metadata: { command: 'explain' } });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.context).toEqual({ command: 'explain' });
  });

  it('falls back to Ollama when the gateway is unreachable', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(
        jsonResponse({ response: 'ollama says hi', prompt_eval_count: 5, eval_count: 7 }),
      );

    const client = createTIPClient({
      agentId: 'claude-code',
      gatewayUrl: GATEWAY_URL,
      ollamaUrl: 'localhost:11434', // scheme-less on purpose
    });
    const result = await client.completion('hello');

    expect(result.fallback).toBe(true);
    expect(result.text).toBe('ollama says hi');
    expect(result.tokens).toEqual({ input: 5, output: 7 });

    const ollamaUrl = fetchMock.mock.calls[1]![0] as string;
    expect(ollamaUrl).toBe('http://localhost:11434/api/generate');
  });

  it('supports the legacy string signature', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(gatewayCompletionResponse()));

    const client = createTIPClient(GATEWAY_URL, 'legacy-agent');
    expect(client).toBeInstanceOf(TIPClient);
    expect(client.agentId).toBe('legacy-agent');

    await client.completion('ping');
    expect(fetchMock.mock.calls[0]![0]).toBe(`${GATEWAY_URL}/v1/completion`);
  });

  it('defaults the agent id when created without config', () => {
    const client = createTIPClient();
    expect(client.agentId).toBe('tip');
    expect(client.getStatus().mode).toBe('gateway');
  });

  it('reports gateway health when the gateway responds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok', ollama: {}, queue: {} }));

    const client = createTIPClient({ gatewayUrl: GATEWAY_URL });
    const health = await client.health();

    expect(health).toEqual({
      healthy: true,
      gateway: true,
      ollama: 'http://localhost:11434',
      mode: 'gateway',
    });
  });

  it('reports fallback health when only Ollama responds', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValueOnce(jsonResponse({ models: [] }));

    const client = createTIPClient({ gatewayUrl: GATEWAY_URL });
    const health = await client.health();

    expect(health.healthy).toBe(true);
    expect(health.gateway).toBe(false);
    expect(health.mode).toBe('fallback');
  });

  it('reports offline when neither gateway nor Ollama respond', async () => {
    fetchMock.mockRejectedValue(new Error('everything down'));

    const client = createTIPClient({ gatewayUrl: GATEWAY_URL });
    const health = await client.health();

    expect(health).toEqual({ healthy: false, gateway: false, ollama: 'offline', mode: 'offline' });
  });
});
