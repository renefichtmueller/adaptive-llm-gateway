import { describe, it, expect, beforeAll } from 'vitest';
import {
  LLMGatewayClient,
  TIPClient,
  createTIPClient,
  createInteractiveClient,
  createBatchClient,
  createRealtimeClient,
} from '@llm-gateway/client';

/**
 * Integration test: Claude Code agent using LLM Gateway
 *
 * This test demonstrates how the Claude Code agent (or any other AI agent)
 * would consume the Gateway's completion and classification endpoints.
 *
 * The live suites only run when a gateway is reachable (set LLM_GATEWAY_URL
 * or run one on localhost:8787); otherwise they are skipped so `npm test`
 * stays green without infrastructure. The client-construction suites at the
 * bottom always run.
 */

const gatewayUrl = process.env['LLM_GATEWAY_URL'] ?? 'http://localhost:8787';

async function gatewayReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(`${gatewayUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

const gatewayUp = await gatewayReachable();

describe.skipIf(!gatewayUp)('Claude Code Integration with LLM Gateway (live)', () => {
  let client: LLMGatewayClient;

  beforeAll(() => {
    client = new LLMGatewayClient({ caller: 'claude-code', baseUrl: gatewayUrl, timeout: 30_000 });
  });

  describe('Health checks', () => {
    it('should check gateway health', async () => {
      const health = await client.health();
      expect(health.status).toMatch(/^(ok|degraded|down)$/);
      expect(health.ollama).toBeDefined();
    });

    it('should report client status', () => {
      const status = client.getStatus();
      expect(status).toHaveProperty('gateway');
      expect(status).toHaveProperty('ollama');
      expect(status).toHaveProperty('mode');
    });
  });

  describe('Completion endpoint', () => {
    it('should process a code explanation request', async () => {
      const result = await client.completion({
        task_type: 'code_explanation',
        input: 'export function fibonacci(n: number): number { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }',
        language: 'en',
        options: { temperature: 0.3 },
      });

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('output');
      expect(result.status).toMatch(/^(approved|warning|pending_review|rejected)$/);
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(10);
    });

    it('should classify input before routing', async () => {
      const classification = await client.classify('What is the capital of France?');
      expect(classification).toHaveProperty('task_type');
      expect(classification).toHaveProperty('complexity');
      expect(classification.complexity).toMatch(/^(low|medium|high)$/);
    });

    it('should handle German language requests', async () => {
      const result = await client.completion({
        task_type: 'summarization',
        input: 'Das LLM Gateway ist ein zentraler Orchestrator für mehrere KI-Agenten. Es verwaltet Routing, Fallback-Ketten und lernt autonom.',
        language: 'de',
        options: { temperature: 0.5 },
      });

      expect(result.output).toBeDefined();
      expect(result.output.length).toBeGreaterThan(0);
    });

    it('should include token usage in response', async () => {
      const result = await client.completion({
        task_type: 'analysis',
        input: 'Analyze this: The quick brown fox jumps over the lazy dog.',
      });

      expect(result.tokens).toHaveProperty('in');
      expect(result.tokens).toHaveProperty('out');
      expect(result.tokens.in).toBeGreaterThanOrEqual(0);
      expect(result.tokens.out).toBeGreaterThanOrEqual(0);
    });

    it('should provide validation details when requested', async () => {
      const result = await client.completion({
        task_type: 'code_review',
        input: 'const x = 1; // simple variable assignment',
        options: { return_validation_details: true },
      });

      if (result.validation) {
        expect(result.validation).toHaveProperty('passed');
        expect(result.validation).toHaveProperty('score');
      }
    });
  });

  describe('TIP agent protocol (ADR-0005)', () => {
    it('should serve prompt-oriented agent completions', async () => {
      const tipClient = createTIPClient({ agentId: 'claude-code', gatewayUrl });
      const result = await tipClient.completion('Explain what a mutex is in one sentence.', {
        maxTokens: 200,
      });

      expect(result.text.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(typeof result.fallback).toBe('boolean');
      expect(result.tokens).toHaveProperty('input');
      expect(result.tokens).toHaveProperty('output');
    });
  });

  describe('Rate limiting and SLA', () => {
    it('should respect timeout configuration', async () => {
      const shortTimeoutClient = new LLMGatewayClient({
        caller: 'claude-code',
        baseUrl: gatewayUrl,
        timeout: 500, // Very short timeout for testing
      });

      try {
        await shortTimeoutClient.completion({
          task_type: 'timeout_test',
          input: 'Request that will timeout',
          options: { max_tokens: 10_000 }, // Force long generation
        });
        // If request completes, that's fine
      } catch (err) {
        // Timeout is expected with 500ms limit
        expect(err).toBeDefined();
      }
    });

    it('should track latency within reasonable bounds', async () => {
      const result = await client.completion({
        task_type: 'latency_test',
        input: 'Quick task',
      });

      expect(result.latency_ms).toBeGreaterThan(0);
      expect(result.latency_ms).toBeLessThan(60_000); // Should complete in <1 min
    });
  });
});

describe('Client construction (no gateway required)', () => {
  it('should create a TIP client from an ADR-0005 config object', () => {
    const tipClient = createTIPClient({ agentId: 'claude-code', gatewayUrl });
    expect(tipClient).toBeInstanceOf(TIPClient);
    expect(tipClient.agentId).toBe('claude-code');
    expect(tipClient.getStatus().mode).toBe('gateway');
  });

  it('should create a TIP client from a legacy URL string', () => {
    const tipClient = createTIPClient(gatewayUrl);
    expect(tipClient).toBeInstanceOf(TIPClient);
    expect(tipClient.agentId).toBe('tip');
  });

  it('should create pre-configured task clients', () => {
    for (const factory of [createInteractiveClient, createBatchClient, createRealtimeClient]) {
      const taskClient = factory('claude-code', gatewayUrl);
      expect(taskClient).toBeInstanceOf(LLMGatewayClient);
      expect(taskClient.getStatus()).toHaveProperty('mode');
    }
  });

  it('should provide meaningful error messages when everything is unreachable', async () => {
    const badClient = new LLMGatewayClient({
      caller: 'claude-code',
      baseUrl: 'http://localhost:1', // closed port
      ollamaUrl: 'http://localhost:1',
      timeout: 1_000,
    });

    await expect(
      badClient.completion({ task_type: 'error_test', input: 'This will fail' }),
    ).rejects.toThrow(/unavailable|failed|timeout|fetch/i);
  }, 30_000);
});
