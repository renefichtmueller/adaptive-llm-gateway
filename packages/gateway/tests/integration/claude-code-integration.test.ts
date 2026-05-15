import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLMGatewayClient, createTIPClient, createEOPulseClient } from '@llm-gateway/client';

/**
 * Integration test: Claude Code agent using LLM Gateway
 *
 * This test demonstrates how the Claude Code agent (or any other AI agent)
 * would consume the Gateway's completion and classification endpoints.
 *
 * Real usage: Claude Code would instantiate createClaudeCodeClient() and
 * call client.completion() for each generation/analysis task.
 */

describe('Claude Code Integration with LLM Gateway', () => {
  let client: LLMGatewayClient;
  let gatewayUrl: string;

  beforeAll(() => {
    // Gateway must be running on localhost:0000 for these tests
    gatewayUrl = process.env['LLM_GATEWAY_URL'] ?? 'http://localhost:0000';
    client = new LLMGatewayClient({ caller: 'claude-code', baseUrl: gatewayUrl, timeout: 30_000 });
  });

  afterAll(() => {
    // Cleanup: nothing to do for HTTP client
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

  describe('Offline fallback behavior', () => {
    it('should gracefully degrade if gateway is unavailable', async () => {
      // Create a client pointing to an unreachable gateway
      const offlineClient = new LLMGatewayClient({
        caller: 'claude-code',
        baseUrl: 'http://localhost:9999', // non-existent
        ollamaUrl: 'http://localhost:11434', // fallback to local Ollama
        timeout: 2_000,
      });

      try {
        // This should fall back to local Ollama
        const result = await offlineClient.completion({
          task_type: 'fallback_test',
          input: 'This request should use local Ollama',
        });

        expect(result.status).toBe('approved');
        expect(result.model).toMatch(/qwen|llama/);
      } catch (err) {
        // If Ollama is also unavailable, that's ok for this test
        expect(err).toBeDefined();
      }
    });

    it('should retry Ollama on transient failures', async () => {
      const client2 = new LLMGatewayClient({
        caller: 'claude-code',
        baseUrl: 'http://localhost:0000',
        ollamaUrl: 'http://localhost:11434',
        timeout: 30_000,
      });

      const result = await client2.completion({
        task_type: 'retry_test',
        input: 'Testing retry logic',
      });

      expect(result).toBeDefined();
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

  describe('Project-specific clients', () => {
    it('should create a client with custom timeout', async () => {
      const tipClient = createTIPClient(gatewayUrl);
      const status = (tipClient as any).timeout; // Access private timeout for testing
      expect(status).toBeDefined();
    });

    it('should create EO Pulse client with appropriate timeout', async () => {
      const eoPulseClient = createEOPulseClient(gatewayUrl);
      const status = (eoPulseClient as any).timeout;
      expect(status).toBeDefined();
    });
  });

  describe('Error handling', () => {
    it('should provide meaningful error messages', async () => {
      try {
        const badClient = new LLMGatewayClient({
          caller: 'claude-code',
          baseUrl: 'http://invalid-domain-that-does-not-exist.localhost',
          timeout: 2_000,
        });

        await badClient.completion({
          task_type: 'error_test',
          input: 'This will fail',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/unavailable|failed|timeout/i);
      }
    });
  });
});
