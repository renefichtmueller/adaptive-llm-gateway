import { describe, it, expect } from 'vitest';
import { splitReasoningTrace } from '../reasoning-trace.js';

describe('splitReasoningTrace', () => {
  it('returns no trace for plain output', () => {
    const r = splitReasoningTrace('The capital of France is Paris.');
    expect(r.trace).toBeNull();
    expect(r.finalAnswer).toBe('The capital of France is Paris.');
  });

  it('extracts <thinking>...</thinking> blocks', () => {
    const out = '<thinking>The user asks about France. Capital = Paris.</thinking>\n\nParis.';
    const r = splitReasoningTrace(out);
    expect(r.trace).not.toBeNull();
    expect(r.trace?.marker).toBe('thinking_tag');
    expect(r.trace?.content).toContain('Paris');
    expect(r.finalAnswer).toBe('Paris.');
  });

  it('extracts <think>...</think> blocks (DeepSeek-R1 style)', () => {
    const out = '<think>Let me think... the answer is 42.</think>The answer is 42.';
    const r = splitReasoningTrace(out);
    expect(r.trace?.marker).toBe('think_tag');
    expect(r.finalAnswer).toBe('The answer is 42.');
  });

  it('extracts markdown **Reasoning:** ... **Answer:** style', () => {
    const out = '**Reasoning:**\nFirst we evaluate options...\n\n**Answer:**\nOption B is best.';
    const r = splitReasoningTrace(out);
    expect(r.trace?.marker).toBe('markdown_header');
    expect(r.finalAnswer).toBe('Option B is best.');
  });

  it('extracts JSON {"reasoning":..., "answer":...} shape', () => {
    const out = JSON.stringify({ reasoning: 'analysis here', answer: 'final answer' });
    const r = splitReasoningTrace(out);
    expect(r.trace?.marker).toBe('json_field');
    expect(r.finalAnswer).toBe('final answer');
  });

  it('estimates tokens from trace length', () => {
    const out = '<thinking>' + 'word '.repeat(100) + '</thinking>The end.';
    const r = splitReasoningTrace(out);
    expect(r.trace?.estimatedTokens).toBeGreaterThan(50);
  });
});
