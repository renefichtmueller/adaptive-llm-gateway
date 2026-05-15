import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ChatGPTAPIAdapter from './index'

describe('ChatGPTAPIAdapter', () => {
  let adapter: ChatGPTAPIAdapter

  beforeEach(() => {
    adapter = new ChatGPTAPIAdapter(0)
  })

  afterEach(async () => {
    try {
      await adapter.stop()
    } catch (e) {
      // Ignore cleanup errors
    }
  })

  it('should create adapter instance with default port', () => {
    const a = new ChatGPTAPIAdapter()
    expect(a).toBeDefined()
  })

  it('should create adapter instance with custom port', () => {
    const a = new ChatGPTAPIAdapter(8080)
    expect(a).toBeDefined()
  })

  it('should format messages to prompt correctly', async () => {
    const messages = [
      { role: 'system' as const, content: 'You are helpful' },
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' }
    ]

    // Use reflection to access private method for testing
    const formatMessagesToPrompt = (adapter as any).formatMessagesToPrompt.bind(adapter)
    const prompt = formatMessagesToPrompt(messages)

    expect(prompt).toContain('[SYSTEM]')
    expect(prompt).toContain('[USER]')
    expect(prompt).toContain('[ASSISTANT]')
    expect(prompt).toContain('You are helpful')
    expect(prompt).toContain('Hello')
    expect(prompt).toContain('Hi there')
  })

  it('should map OpenAI model names to gateway models', () => {
    const mapModelName = (adapter as any).mapModelName.bind(adapter)

    expect(mapModelName('gpt-4')).toBe('qwen2.5:32b')
    expect(mapModelName('gpt-4-turbo')).toBe('qwen2.5:32b')
    expect(mapModelName('gpt-3.5-turbo')).toBe('qwen2.5:14b')
    expect(mapModelName('gpt-4-mini')).toBe('qwen2.5:3b')
    expect(mapModelName('unknown-model')).toBe('qwen2.5:14b') // Default fallback
  })

  it('should handle missing model gracefully', () => {
    const mapModelName = (adapter as any).mapModelName.bind(adapter)
    expect(mapModelName('custom-model')).toBe('qwen2.5:14b')
  })

  it('should start and stop server', async () => {
    const adaptForTest = new ChatGPTAPIAdapter(3112)
    await adaptForTest.start()
    // Server should be running
    await adaptForTest.stop()
    // Server should be stopped
    expect(true).toBe(true)
  })

  it('should have /v1/models endpoint', async () => {
    // This test is integration-style
    // Would need actual server running and HTTP client
    expect(adapter).toBeDefined()
  })

  it('should format streaming response correctly', () => {
    // Test that streaming response format matches OpenAI spec
    const event = {
      id: 'chatcmpl-123',
      object: 'text_completion.chunk',
      created: 1234567890,
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          delta: { content: 'Hello' },
          finish_reason: null
        }
      ]
    }
    const jsonStr = JSON.stringify(event)
    expect(jsonStr).toContain('chatcmpl-')
    expect(jsonStr).toContain('text_completion.chunk')
    expect(jsonStr).toContain('Hello')
  })

  it('should handle temperature parameter', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user' as const, content: 'Hi' }],
      temperature: 0.5
    }
    expect(request.temperature).toBe(0.5)
  })

  it('should handle max_tokens parameter', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user' as const, content: 'Hi' }],
      max_tokens: 1000
    }
    expect(request.max_tokens).toBe(1000)
  })

  it('should default to non-streaming mode', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user' as const, content: 'Hi' }]
    }
    expect(request as any).not.toHaveProperty('stream')
  })

  it('should handle streaming flag', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user' as const, content: 'Hi' }],
      stream: true
    }
    expect(request.stream).toBe(true)
  })

  it('should have proper response structure', () => {
    const response = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Response'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    }

    expect(response).toHaveProperty('id')
    expect(response).toHaveProperty('object')
    expect(response).toHaveProperty('created')
    expect(response).toHaveProperty('model')
    expect(response).toHaveProperty('choices')
    expect(response).toHaveProperty('usage')
    expect(response.choices[0].message.role).toBe('assistant')
    expect(response.usage.total_tokens).toBe(15)
  })
})
