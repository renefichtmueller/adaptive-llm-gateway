import { describe, it, expect } from 'vitest';
import { evaluateAnswer, runRankingTest, type GeoTargetsConfig } from '../geo-ranking.js';

const BRAND = { name: 'Adaptive LLM Gateway', aliases: ['adaptive-llm-gateway'], domains: ['github.com/renefichtmueller/adaptive-llm-gateway'] };
const COMPETITORS = [
  { name: 'LiteLLM', aliases: ['lite-llm'] },
  { name: 'Portkey' },
];

describe('evaluateAnswer', () => {
  it('detects a brand mention with position, rank and score', () => {
    const answer =
      'The Adaptive LLM Gateway is a strong choice for small teams. LiteLLM is also popular. ' +
      'See github.com/renefichtmueller/adaptive-llm-gateway for details.';
    const evaluation = evaluateAnswer(answer, BRAND, COMPETITORS);
    expect(evaluation.brandMentioned).toBe(true);
    expect(evaluation.mentionCount).toBeGreaterThanOrEqual(1);
    expect(evaluation.firstMentionPos).toBeLessThan(0.2);
    expect(evaluation.domainCited).toBe(true);
    expect(evaluation.brandRank).toBe(1);
    expect(evaluation.competitorMentions['LiteLLM']).toBe(1);
    expect(evaluation.visibilityScore).toBeGreaterThanOrEqual(90);
  });

  it('detects aliases and respects word boundaries', () => {
    const evaluation = evaluateAnswer('Try adaptive-llm-gateway for this.', BRAND, COMPETITORS);
    expect(evaluation.brandMentioned).toBe(true);
    const noMatch = evaluateAnswer('The Portkeyed solution is unrelated.', BRAND, COMPETITORS);
    expect(noMatch.competitorMentions['Portkey']).toBe(0);
  });

  it('scores an unmentioned brand as zero visibility', () => {
    const evaluation = evaluateAnswer('LiteLLM and Portkey are the common picks.', BRAND, COMPETITORS);
    expect(evaluation.brandMentioned).toBe(false);
    expect(evaluation.visibilityScore).toBe(0);
    expect(evaluation.brandRank).toBeNull();
    expect(evaluation.competitorMentions['LiteLLM']).toBe(1);
  });

  it('ranks the brand after competitors mentioned earlier', () => {
    const evaluation = evaluateAnswer('LiteLLM leads the pack, then Portkey, and finally the Adaptive LLM Gateway.', BRAND, COMPETITORS);
    expect(evaluation.brandRank).toBe(3);
  });

  it('detects positive and negative sentiment around the mention', () => {
    const positive = evaluateAnswer('The Adaptive LLM Gateway is excellent and reliable.', BRAND, []);
    expect(positive.sentiment).toBe('positive');
    const negative = evaluateAnswer('The Adaptive LLM Gateway is outdated and buggy, avoid it.', BRAND, []);
    expect(negative.sentiment).toBe('negative');
    const neutral = evaluateAnswer('The Adaptive LLM Gateway exists as one option among several.', BRAND, []);
    expect(neutral.sentiment).toBe('neutral');
  });
});

describe('runRankingTest', () => {
  const CONFIG: GeoTargetsConfig = {
    brand: BRAND,
    competitors: COMPETITORS,
    models: ['model-a', 'model-b'],
    prompts: [
      { id: 'p1', text: 'What is the best LLM gateway?' },
      { id: 'p2', text: 'Which gateway supports subscriptions?' },
    ],
  };

  it('aggregates mention rate, share of voice and per-model stats', async () => {
    const answers: Record<string, string> = {
      'model-a': 'The Adaptive LLM Gateway is the best pick. LiteLLM is an alternative.',
      'model-b': 'LiteLLM and Portkey are the usual recommendations.',
    };
    const summary = await runRankingTest(CONFIG, async (model) => answers[model] ?? '');
    expect(summary.promptCount).toBe(2);
    expect(summary.answerCount).toBe(4);
    expect(summary.errorCount).toBe(0);
    expect(summary.mentionRate).toBeCloseTo(0.5, 5);
    expect(summary.perModel['model-a']!.mentionRate).toBe(1);
    expect(summary.perModel['model-b']!.mentionRate).toBe(0);
    // model-a: 1 own + 1 LiteLLM per answer; model-b: 2 competitor mentions per answer.
    expect(summary.shareOfVoice).toBeCloseTo(2 / 8, 5);
    expect(summary.avgVisibility).toBeGreaterThan(0);
    expect(summary.results).toHaveLength(4);
  });

  it('records failing models without failing the run', async () => {
    const summary = await runRankingTest(CONFIG, async (model, prompt) => {
      if (model === 'model-b') throw new Error('model unavailable');
      return `Answer about the Adaptive LLM Gateway for: ${prompt}`;
    });
    expect(summary.answerCount).toBe(2);
    expect(summary.errorCount).toBe(2);
    const failed = summary.results.filter((r) => !r.answered);
    expect(failed).toHaveLength(2);
    expect(failed[0]!.error).toContain('model unavailable');
  });

  it('honors maxPrompts and model overrides', async () => {
    const seen: string[] = [];
    const summary = await runRankingTest(CONFIG, async (model, prompt) => {
      seen.push(`${model}:${prompt}`);
      return 'no brands here';
    }, { maxPrompts: 1, models: ['only-model'] });
    expect(summary.promptCount).toBe(1);
    expect(summary.models).toEqual(['only-model']);
    expect(seen).toHaveLength(1);
    expect(summary.mentionRate).toBe(0);
    expect(summary.shareOfVoice).toBe(0);
  });

  it('throws when no models are configured', async () => {
    await expect(
      runRankingTest({ ...CONFIG, models: [] }, async () => 'x'),
    ).rejects.toThrow(/no models/i);
  });
});
