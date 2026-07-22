/**
 * Tests for the scorer fast-path (skips the LLM pre-classifier for
 * clearly-simple requests). The scorer itself is mocked for the logic tests so
 * tier/confidence are deterministic; one test exercises the real scorer to
 * confirm complex requests are left to the LLM classifier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mutable holder the mock reads from, so each test controls the scorer output.
const scoreMock = vi.fn();

vi.mock('../request-scorer.js', () => ({
  scoreRequest: (...args: unknown[]) => scoreMock(...args),
}));

import { tryScorerFastPath } from '../scorer-fastpath.js';

const FASTPATH_ENV = [
  'SCORER_FASTPATH_ENABLED',
  'SCORER_FASTPATH_MIN_CONFIDENCE',
  'SCORER_FASTPATH_TIERS',
  'SCORER_FASTPATH_TASK_TYPE',
] as const;

function clearEnv(): void {
  for (const key of FASTPATH_ENV) delete process.env[key];
}

beforeEach(() => {
  clearEnv();
  scoreMock.mockReset();
  scoreMock.mockReturnValue({ tier: 'fast', score: -0.5, confidence: 0.9, reason: 'test', dimensions: [] });
});

afterEach(() => {
  clearEnv();
});

describe('tryScorerFastPath', () => {
  it('returns null when disabled (default), and does not even call the scorer', () => {
    const result = tryScorerFastPath('hello there, anything new today?');
    expect(result).toBeNull();
    expect(scoreMock).not.toHaveBeenCalled();
  });

  it('short-circuits a confident fast-tier request when enabled', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    const result = tryScorerFastPath('please forward this message and just acknowledge it back to me');
    expect(result).not.toBeNull();
    expect(result?.taskType).toBe('generic_qa');
    expect(result?.tier).toBe('fast');
    expect(result?.confidence).toBeCloseTo(0.9);
  });

  it('does NOT short-circuit tiers outside the allowed set (e.g. large)', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    scoreMock.mockReturnValue({ tier: 'large', score: 0.2, confidence: 0.9, reason: 'test', dimensions: [] });
    expect(tryScorerFastPath('some involved request')).toBeNull();
  });

  it('does NOT short-circuit below the confidence threshold', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    scoreMock.mockReturnValue({ tier: 'fast', score: -0.11, confidence: 0.55, reason: 'test', dimensions: [] });
    expect(tryScorerFastPath('borderline request')).toBeNull();
  });

  it('honours a custom confidence threshold', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    process.env['SCORER_FASTPATH_MIN_CONFIDENCE'] = '0.95';
    // confidence 0.9 < 0.95 → no fast-path
    expect(tryScorerFastPath('a request')).toBeNull();
  });

  it('honours a widened allowed-tier set', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    process.env['SCORER_FASTPATH_TIERS'] = 'fast,medium';
    scoreMock.mockReturnValue({ tier: 'medium', score: 0.02, confidence: 0.85, reason: 'test', dimensions: [] });
    const result = tryScorerFastPath('a short simple request over the length threshold');
    expect(result?.tier).toBe('medium');
  });

  it('honours a custom fast-path task_type', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    process.env['SCORER_FASTPATH_TASK_TYPE'] = 'generic_classify';
    expect(tryScorerFastPath('a request')?.taskType).toBe('generic_classify');
  });

  it('returns null for empty / whitespace input without calling the scorer', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    expect(tryScorerFastPath('   ')).toBeNull();
    expect(tryScorerFastPath('')).toBeNull();
    expect(scoreMock).not.toHaveBeenCalled();
  });

  it('never throws when the scorer errors — defers to the LLM classifier', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    scoreMock.mockImplementation(() => {
      throw new Error('scorer boom');
    });
    expect(tryScorerFastPath('a request')).toBeNull();
  });
});
