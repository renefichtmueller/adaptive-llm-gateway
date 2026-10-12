import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeBridge } from './index.js'

/**
 * Hermetic unit tests — global fetch is mocked with gateway-shaped
 * responses, so no gateway or Ollama needs to be running.
 */

function gatewayResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    status: 'approved',
    confidence: 8,
    model: 'qwen2.5:14b',
    task_type: 'agent_completion',
    latency_ms: 12,
    tokens: { in: 15, out: 25 },
    output: 'mocked completion output',
    ...overrides
  }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

describe('ClaudeCodeBridge', () => {
  let bridge: ClaudeCodeBridge
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/health')) {
        return jsonResponse({ status: 'ok', ollama: {}, queue: {} })
      }
      return jsonResponse(gatewayResponse())
    })
    vi.stubGlobal('fetch', fetchMock)

    bridge = new ClaudeCodeBridge({
      gatewayUrl: 'http://localhost:8787',
      agentId: 'claude-code-test',
      ideVersion: '1.0.0',
      extensionVersion: '1.0.0'
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('health check', () => {
    it('should report health status', async () => {
      const health = await bridge.health()
      expect(health).toHaveProperty('healthy')
      expect(health).toHaveProperty('gateway')
      expect(health).toHaveProperty('ollama')
      expect(health).toHaveProperty('mode')
    })

    it('should report gateway mode when the gateway responds', async () => {
      const health = await bridge.health()
      expect(health.mode).toBe('gateway')
      expect(health.healthy).toBe(true)
    })

    it('should report offline when nothing responds', async () => {
      fetchMock.mockRejectedValue(new Error('everything down'))
      const health = await bridge.health()
      expect(health.healthy).toBe(false)
      expect(health.mode).toBe('offline')
    })
  })

  describe('completion methods', () => {
    it('should support explain command', async () => {
      const context = 'function add(a, b) { return a + b; }'
      const selection = 'return a + b'

      const response = await bridge.explain(context, selection)
      expect(response).toHaveProperty('text')
      expect(response).toHaveProperty('tokens')
      expect(response).toHaveProperty('model')
      expect(response).toHaveProperty('fallback')
      expect(response).toHaveProperty('confidence')
    })

    it('should support refactor command', async () => {
      const response = await bridge.refactor('for(;;){}', 'for(;;)')
      expect(response.text).toBeTruthy()
      expect(typeof response.tokens.input).toBe('number')
      expect(typeof response.tokens.output).toBe('number')
    })

    it('should support test command', async () => {
      const response = await bridge.test('export function multiply(a, b) { return a * b }', 'multiply')
      expect(response.text).toBeTruthy()
      expect(response.model).toBeTruthy()
    })

    it('should support document command', async () => {
      const response = await bridge.document('const config = { timeout: 5000 }', '{ timeout: 5000 }')
      expect(response.text).toBeTruthy()
    })

    it('should support fix command', async () => {
      const response = await bridge.fixError('ReferenceError: x is not defined', 'console.log(x)')
      expect(response.text).toBeTruthy()
    })

    it('should send agent metadata with each request', async () => {
      await bridge.explain('ctx', 'sel')

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
      expect(body.caller).toBe('claude-code-test')
      expect(body.context.command).toBe('explain')
      expect(body.context.ideVersion).toBe('1.0.0')
    })
  })

  describe('generic completion', () => {
    it('should handle custom prompts', async () => {
      const response = await bridge.completion('custom', 'Write a hello world function')
      expect(response).toHaveProperty('text')
      expect(response).toHaveProperty('tokens')
      expect(response).toHaveProperty('model')
    })

    it('should forward the maxTokens limit to the gateway', async () => {
      await bridge.completion('test', 'Short prompt', 100)

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
      expect(body.options.max_tokens).toBe(100)
    })
  })

  describe('fallback behavior', () => {
    it('should report when using fallback', async () => {
      const response = await bridge.completion('test', 'Test prompt')
      expect(typeof response.fallback).toBe('boolean')
      expect(response.fallback).toBe(false)
    })

    it('should fall back to Ollama when the gateway is down', async () => {
      fetchMock.mockReset()
      fetchMock
        .mockRejectedValueOnce(new Error('gateway down'))
        .mockResolvedValueOnce(
          jsonResponse({ response: 'ollama output', prompt_eval_count: 3, eval_count: 4 })
        )
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const response = await bridge.completion('test', 'Generate a simple greeting')
      expect(response.fallback).toBe(true)
      expect(response.text).toBe('ollama output')
    })
  })

  describe('metadata tracking', () => {
    it('should expose routing status', () => {
      const status = bridge.status()
      expect(status).toHaveProperty('gateway')
      expect(status).toHaveProperty('ollama')
      expect(status).toHaveProperty('mode')
    })

    it('should normalize confidence to 0-1', async () => {
      const response = await bridge.completion('test', 'Simple test')
      expect(response.confidence).toBeCloseTo(0.8)
    })
  })
})
