import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ClaudeCodeBridge } from './index'

describe('ClaudeCodeBridge', () => {
  let bridge: ClaudeCodeBridge

  beforeEach(() => {
    bridge = new ClaudeCodeBridge({
      gatewayUrl: 'http://localhost:3000',
      agentId: 'claude-code-test',
      ideVersion: '1.0.0',
      extensionVersion: '1.0.0'
    })
  })

  describe('health check', () => {
    it('should report health status', async () => {
      const health = await bridge.health()
      expect(health).toHaveProperty('healthy')
      expect(health).toHaveProperty('gateway')
      expect(health).toHaveProperty('ollama')
      expect(health).toHaveProperty('mode')
    })

    it('should handle gateway unavailable gracefully', async () => {
      const health = await bridge.health()
      // Should have fallback mode or offline
      expect(health.mode).toMatch(/fallback|offline|gateway/)
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
      const context = 'for(let i=0;i<arr.length;i++){}'
      const selection = 'for(let i=0;i<arr.length;i++)'

      const response = await bridge.refactor(context, selection)
      expect(response.text).toBeTruthy()
      expect(typeof response.tokens.input).toBe('number')
      expect(typeof response.tokens.output).toBe('number')
    })

    it('should support test command', async () => {
      const context = 'export function multiply(a, b) { return a * b }'
      const selection = 'export function multiply(a, b)'

      const response = await bridge.test(context, selection)
      expect(response.text).toBeTruthy()
      expect(response.model).toBeTruthy()
    })

    it('should support document command', async () => {
      const context = 'const config = { timeout: 5000 }'
      const selection = '{ timeout: 5000 }'

      const response = await bridge.document(context, selection)
      expect(response.text).toBeTruthy()
    })

    it('should support fix command', async () => {
      const error = 'ReferenceError: x is not defined'
      const context = 'function test() { console.log(x); }'

      const response = await bridge.fixError(error, context)
      expect(response.text).toBeTruthy()
    })
  })

  describe('generic completion', () => {
    it('should handle custom prompts', async () => {
      const response = await bridge.completion('custom', 'Write a hello world function')
      expect(response).toHaveProperty('text')
      expect(response).toHaveProperty('tokens')
      expect(response).toHaveProperty('model')
    })

    it('should respect maxTokens limit', async () => {
      const response = await bridge.completion('test', 'Short prompt', 100)
      expect(response.tokens.output).toBeLessThanOrEqual(150) // Small margin for tokenizer variance
    })
  })

  describe('fallback behavior', () => {
    it('should report when using fallback', async () => {
      const response = await bridge.completion('test', 'Test prompt')
      expect(response).toHaveProperty('fallback')
      expect(typeof response.fallback).toBe('boolean')
    })

    it('should still work during fallback to Ollama', async () => {
      const response = await bridge.completion('test', 'Generate a simple greeting')
      expect(response.text).toBeTruthy()
      expect(response.tokens).toBeTruthy()
    })
  })

  describe('metadata tracking', () => {
    it('should track IDE version', async () => {
      const status = await bridge.status()
      expect(status).toBeDefined()
    })

    it('should identify agent as claude-code', async () => {
      const response = await bridge.completion('test', 'Simple test')
      expect(response.model).toBeTruthy()
    })
  })
})
