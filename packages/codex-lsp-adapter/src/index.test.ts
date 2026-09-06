import { describe, expect, it } from 'vitest'
import type { TIPCompletionResult } from '@llm-gateway/client'
import { toCompletionItem, toHoverMarkdown } from './index.js'

function tipResult(overrides: Partial<TIPCompletionResult> = {}): TIPCompletionResult {
  return {
    text: 'const x = 1\nconst y = 2',
    model: 'qwen2.5:14b',
    tokens: { input: 10, output: 5 },
    confidence: 0.85,
    fallback: false,
    latencyMs: 20,
    requestId: 'req-1',
    status: 'approved',
    ...overrides
  }
}

describe('toCompletionItem', () => {
  it('uses the first line as label and the full text as insertText', () => {
    const item = toCompletionItem(tipResult())
    expect(item.label).toBe('const x = 1')
    expect(item.insertText).toBe('const x = 1\nconst y = 2')
  })

  it('renders confidence as a percentage', () => {
    const item = toCompletionItem(tipResult({ confidence: 0.85 }))
    expect(JSON.stringify(item.documentation)).toContain('85.0%')
  })

  it('marks fallback responses', () => {
    expect(toCompletionItem(tipResult({ fallback: true })).detail).toBe('(Ollama fallback)')
    expect(toCompletionItem(tipResult({ fallback: false })).detail).toBe('(Gateway)')
  })

  it('handles empty completions', () => {
    const item = toCompletionItem(tipResult({ text: '' }))
    expect(item.label).toBe('')
    expect(item.insertText).toBe('')
  })
})

describe('toHoverMarkdown', () => {
  it('appends model and confidence to the explanation', () => {
    const markdown = toHoverMarkdown(tipResult({ text: 'Adds two numbers.', confidence: 0.7 }))
    expect(markdown).toBe('Adds two numbers.\n\n*qwen2.5:14b (70%)*')
  })
})
