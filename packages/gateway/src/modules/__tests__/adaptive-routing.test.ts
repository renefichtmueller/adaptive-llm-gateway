/**
 * Adaptive routing — unit tests for the cost-aware learner.
 *
 * The Pg client is faked, so no database is required. We verify the
 * Pareto selection (success rate ÷ cost), persistence into the
 * adaptive_routing table, warm-start loading, and the keep-previous
 * behavior when no fresh samples exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Adaptive routing is enabled by default; pin explicitly for clarity.
process.env['ADAPTIVE_ROUTING_ENABLED'] = '1';
process.env['ADAPTIVE_MIN_SAMPLES'] = '10';

const {
  runAdaptiveLearner,
  loadPersistedRecommendations,
  getAdaptiveRecommendation,
  getAllRecommendations,
} = await import('../adaptive-routing.js');

type Row = Record<string, unknown>;

function llmCallsRow(taskType: string, model: string, successRate: number, costUsd: number, samples = 50): Row {
  return {
    task_type: taskType,
    model_used: model,
    samples,
    success_rate: successRate,
    avg_latency_ms: 1000,
    avg_cost_usd: costUsd,
  };
}

function fakeDb(llmCallsRows: Row[], persistedRows: Row[] = []) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (text.includes('FROM llm_calls')) return { rows: llmCallsRows };
      if (text.includes('FROM adaptive_routing')) return { rows: persistedRows };
      return { rows: [] };
    }),
  };
}

describe('runAdaptiveLearner', () => {
  beforeEach(async () => {
    // Reset the in-memory map by "learning" an empty distinct task set is not
    // possible (empty keeps previous), so we overwrite with a throwaway task.
    const db = fakeDb([llmCallsRow('__reset__', 'm', 1, 0.1)]);
    await runAdaptiveLearner(db);
  });

  it('prefers the model with the best success-per-cost score', async () => {
    const db = fakeDb([
      llmCallsRow('summarize', 'qwen2.5:3b', 0.95, 0.0001),
      llmCallsRow('summarize', 'qwen2.5:32b', 0.98, 0.002),
    ]);

    const result = await runAdaptiveLearner(db);
    expect(result.updated).toBe(1);

    const reco = getAdaptiveRecommendation('summarize');
    expect(reco).not.toBeNull();
    // 0.95/0.0001 = 9500 beats 0.98/0.002 = 490
    expect(reco!.preferredModel).toBe('qwen2.5:3b');
    expect(reco!.fallbackChain).toEqual(['qwen2.5:32b']);
    expect(reco!.rationale.alternativesConsidered).toBe(2);
  });

  it('persists recommendations into the adaptive_routing table', async () => {
    const db = fakeDb([
      llmCallsRow('classify', 'qwen2.5:3b', 0.9, 0.0001),
    ]);

    await runAdaptiveLearner(db);

    const persistCalls = db.queries.filter((q) => q.text.includes('INSERT INTO adaptive_routing'));
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]!.params![0]).toBe('classify');
    expect(persistCalls[0]!.params![1]).toBe('qwen2.5:3b');

    const deleteCalls = db.queries.filter((q) => q.text.includes('DELETE FROM adaptive_routing'));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]!.params![0]).toEqual(['classify']);
  });

  it('keeps previous recommendations when no fresh samples exist', async () => {
    await runAdaptiveLearner(fakeDb([llmCallsRow('summarize', 'qwen2.5:3b', 0.9, 0.0001)]));
    expect(getAdaptiveRecommendation('summarize')).not.toBeNull();

    const result = await runAdaptiveLearner(fakeDb([]));
    expect(result.updated).toBe(0);
    expect(getAdaptiveRecommendation('summarize')).not.toBeNull();
  });

  it('survives db failures without wiping recommendations', async () => {
    await runAdaptiveLearner(fakeDb([llmCallsRow('summarize', 'qwen2.5:3b', 0.9, 0.0001)]));

    const failingDb = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const result = await runAdaptiveLearner(failingDb);
    expect(result.updated).toBe(0);
    expect(getAdaptiveRecommendation('summarize')).not.toBeNull();
  });
});

describe('loadPersistedRecommendations', () => {
  it('warm-starts the in-memory map from the adaptive_routing table', async () => {
    const db = fakeDb(
      [],
      [
        {
          task_type: 'translate',
          preferred_model: 'qwen2.5:14b',
          fallback_chain: ['qwen2.5:32b', 'llama3.3:70b'],
          samples: 240,
          success_rate: '0.9100',
          avg_cost_usd: '0.0003000',
          avg_latency_ms: 1500,
          alternatives: 3,
          updated_at: '2026-08-27T00:00:00Z',
        },
      ],
    );

    const result = await loadPersistedRecommendations(db);
    expect(result.loaded).toBe(1);

    const reco = getAdaptiveRecommendation('translate');
    expect(reco).not.toBeNull();
    expect(reco!.preferredModel).toBe('qwen2.5:14b');
    expect(reco!.fallbackChain).toEqual(['qwen2.5:32b', 'llama3.3:70b']);
    expect(reco!.rationale.successRate).toBeCloseTo(0.91);
    expect(getAllRecommendations().some((r) => r.taskType === 'translate')).toBe(true);
  });

  it('returns 0 and keeps the map when the table is unreadable', async () => {
    const failingDb = {
      query: vi.fn(async () => {
        throw new Error('relation does not exist');
      }),
    };
    const result = await loadPersistedRecommendations(failingDb);
    expect(result.loaded).toBe(0);
  });
});
