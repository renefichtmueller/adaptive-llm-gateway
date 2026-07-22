/**
 * Integration tests for the scorer fast-path against the REAL request-scorer
 * (no mocks). Confirms the fast-path only fires for genuinely-simple requests
 * and leaves complex / specialised ones to the LLM classifier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

beforeEach(clearEnv);
afterEach(clearEnv);

describe('scorer fast-path (real scorer)', () => {
  it('is disabled by default even for a simple request', () => {
    expect(tryScorerFastPath('forward this along and just acknowledge')).toBeNull();
  });

  it('leaves a code-generation request to the LLM classifier', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    // Scores into the code_generation tier, which is not fast-path eligible.
    expect(
      tryScorerFastPath(
        'Write a TypeScript function that validates email addresses and returns a boolean',
      ),
    ).toBeNull();
  });

  it('leaves a formal-reasoning request to the LLM classifier', () => {
    process.env['SCORER_FASTPATH_ENABLED'] = '1';
    expect(
      tryScorerFastPath('Prove by induction that the Fibonacci sequence satisfies F(n) <= 2^n'),
    ).toBeNull();
  });
});
