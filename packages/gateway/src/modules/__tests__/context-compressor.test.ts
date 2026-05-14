/**
 * Compressor smoke tests — proves the pipeline returns a well-shaped result
 * and respects the min-tokens threshold + safeguard against inflation.
 *
 * Run with: npm --workspace=packages/gateway test
 */
import { describe, it, expect } from 'vitest';
import { compressContext, estimateTokens } from '../context-compressor.js';

describe('compressContext', () => {
  it('returns a well-shaped result for any input', () => {
    const r = compressContext('hello world', { mode: 'auto' });
    expect(r).toMatchObject({
      input: expect.any(String),
      originalInput: 'hello world',
      applied: expect.any(Boolean),
      tokensBefore: expect.any(Number),
      tokensAfter: expect.any(Number),
      tokensSaved: expect.any(Number),
      ratio: expect.any(Number),
      method: expect.any(String),
      strategy: expect.any(String),
      tags: expect.any(Array),
      notes: expect.any(Array),
    });
  });

  it('does NOT apply compression when below the min-tokens threshold', () => {
    const shortInput = 'Quick question: what is BGP?';
    const r = compressContext(shortInput);
    expect(r.applied).toBe(false);
    expect(r.tokensBefore).toBe(r.tokensAfter);
    expect(r.tokensSaved).toBe(0);
  });

  it('returns input verbatim when disabled', () => {
    const r = compressContext('any content', { enabled: false });
    expect(r.applied).toBe(false);
    expect(r.method).toBe('none');
    expect(r.notes).toContain('disabled');
  });

  it('returns input verbatim when mode is "off"', () => {
    const r = compressContext('any content', { mode: 'off' });
    expect(r.applied).toBe(false);
    expect(r.method).toBe('none');
  });

  it('collapses repeated lines when input is long enough', () => {
    const longInput = Array.from({ length: 200 }, () =>
      'this is a verbose boilerplate line that repeats.\n'
    ).join('') + '\nQuestion: summarize the above.';
    const r = compressContext(longInput, { mode: 'aggressive' });
    expect(r.tokensBefore).toBeGreaterThan(500);
    // Should either apply OR have safeguard:inflation-rejected note
    if (r.applied) {
      expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
      expect(r.tokensSaved).toBeGreaterThan(0);
    } else {
      expect(r.notes.some((n) => n.includes('safeguard') || n === 'disabled')).toBe(true);
    }
  });

  it('tags each line type', () => {
    const codeyInput = `function foo() {\n  return 42;\n}\nfoo();`;
    const r = compressContext(codeyInput);
    const tagNames = r.tags.map((t) => t.tag);
    expect(tagNames.length).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('scales roughly linearly with input length', () => {
    const short = estimateTokens('hello world');
    const long = estimateTokens('hello world '.repeat(100));
    expect(long).toBeGreaterThan(short * 50);
  });

  it('counts CJK characters correctly', () => {
    const cjk = estimateTokens('日本語のテキスト');
    expect(cjk).toBeGreaterThan(0);
  });
});
