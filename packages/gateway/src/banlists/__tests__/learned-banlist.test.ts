/**
 * Learned banlist — verifies that promoted ban_candidates from the learning
 * engine become active ban terms in the validation pipeline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  refreshLearnedBanlist,
  getLearnedBanlistEntries,
  __setLearnedEntries,
} from '../learned-banlist.js';
import { checkBanlist } from '../../validation/banlist-checker.js';

function fakeDb(rows: Array<Record<string, unknown>>) {
  return {
    query: vi.fn(async (_text: string, _params?: unknown[]) => ({ rows })),
  };
}

describe('refreshLearnedBanlist', () => {
  beforeEach(() => {
    __setLearnedEntries([]);
  });

  it('loads promoted candidates from the database', async () => {
    const db = fakeDb([
      { term: 'paradigm-shifting synergy', category: 'buzzword', language: 'en' },
      { term: 'im endeffekt', category: 'filler', language: 'de' },
    ]);

    const result = await refreshLearnedBanlist(db);
    expect(result.loaded).toBe(2);

    const entries = getLearnedBanlistEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ term: 'paradigm-shifting synergy', language: 'en', wholeWord: true });
    expect(db.query.mock.calls[0]![0]).toContain('promoted = true');
    expect(db.query.mock.calls[0]![0]).toContain('rejected = false');
  });

  it('keeps current entries when the query fails', async () => {
    __setLearnedEntries([{ term: 'keepme', category: 'filler', language: 'auto', wholeWord: true }]);
    const failing = { query: vi.fn(async () => { throw new Error('db down'); }) };

    const result = await refreshLearnedBanlist(failing);
    expect(result.loaded).toBe(0);
    expect(getLearnedBanlistEntries()).toHaveLength(1);
  });

  it('normalizes unknown languages to auto', async () => {
    const db = fakeDb([{ term: 'quelque chose', category: 'filler', language: 'fr' }]);
    await refreshLearnedBanlist(db);
    expect(getLearnedBanlistEntries()[0]!.language).toBe('auto');
  });
});

describe('checkBanlist with learned entries', () => {
  beforeEach(() => {
    __setLearnedEntries([]);
  });

  it('flags learned terms in output text', () => {
    __setLearnedEntries([
      { term: 'paradigm-shifting synergy', category: 'buzzword', language: 'en', wholeWord: true },
    ]);

    const result = checkBanlist('Our paradigm-shifting synergy delivers value.', 'en');
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.term === 'paradigm-shifting synergy')).toBe(true);
  });

  it('respects the language filter', () => {
    __setLearnedEntries([
      { term: 'im endeffekt', category: 'filler', language: 'de', wholeWord: true },
    ]);

    const en = checkBanlist('This text says im endeffekt somewhere.', 'en');
    expect(en.violations.some((v) => v.term === 'im endeffekt')).toBe(false);

    const de = checkBanlist('Das ist im endeffekt egal.', 'de');
    expect(de.violations.some((v) => v.term === 'im endeffekt')).toBe(true);
  });

  it('does not flag clean text', () => {
    __setLearnedEntries([
      { term: 'paradigm-shifting synergy', category: 'buzzword', language: 'en', wholeWord: true },
    ]);
    const result = checkBanlist('A perfectly normal sentence.', 'en');
    expect(result.violations).toHaveLength(0);
  });
});
