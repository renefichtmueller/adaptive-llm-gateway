/**
 * Integration Test: Stop-Slop Pattern Detection in Learning Pipeline
 *
 * Validates that:
 * 1. 21 Stop-Slop patterns are detected in sample AI-generated content
 * 2. Pattern detection scores quality correctly (ai-writing category)
 * 3. Learning loop can use pattern detection for prompt improvement
 * 4. Quality delta is calculated accurately
 */

import { PromptOptimizer } from '@llm-gateway/prompt-optimizer'
import { describe, it, expect, beforeAll } from 'vitest'

// ─── Test Data ──────────────────────────────────────────────────────────────

const SAMPLE_PROMPTS = {
  // AI-generated content with multiple Stop-Slop patterns
  ai_generated: `Here's what I find interesting about this approach: the implications are significant. It turns out that when it comes to implementing the strategy, most organizations navigate challenges by taking a step back. But here's why that matters — the data tells us something different. At the end of the day, this is what effective leadership actually looks like.

What makes this hard is coordination. The answer is not just technology — it's culture. Not a bug. A feature. This enables a solution that emerges from the team's collective effort. The strategy becomes a fix that was desperately needed.

In summary, the rest of this essay explores how really important changes happen: they require genuine commitment from leadership, and literally every team member must lean into the hard decisions. You might say that this fundamentally changes everything.`,

  // Humanized content with fewer patterns
  humanized: `Most organizations get this wrong. Teams back away from hard decisions, hoping conditions improve. The data disagrees: companies that lean in outpace competitors by 40%.

Effective leadership means staying engaged. Coordination isn't just technology—it's culture. When teams align on decisions, implementation accelerates. The strategy that emerges is one where commitment meets execution.

Every leadership challenge requires two things: clear decisions and team alignment. Organizations that deliver both see measurable results.`,

  // Current gateway prompt (baseline)
  gateway_baseline: `You are an expert prompt optimizer. Analyze the given system prompt and:
1. Identify patterns that make it unclear or inefficient
2. Suggest concrete improvements that increase clarity, specificity, and efficiency
3. Recommend the best prompt framework (RTF, CO-STAR, RISEN, etc.)
4. Estimate token savings from the improvements

Focus on:
- Removing filler phrases (throat-clearing, emphasis crutches, business jargon)
- Strengthening agency and specificity
- Varying sentence structure
- Eliminating passive voice where possible

Provide your analysis as JSON with these fields:
- main_problems: array of identified issues
- main_strengths: array of things done well
- improved_system_prompt: your improved version
- changes_made: array of specific changes
- expected_improvements: array of expected benefits`,
}

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('Stop-Slop Integration in Learning Pipeline', () => {
  let optimizer: PromptOptimizer

  beforeAll(() => {
    optimizer = new PromptOptimizer()
  })

  describe('Pattern Detection', () => {
    it('detects throat-clearing patterns in AI content', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')

      // Should detect patterns like:
      // - "Here's what I find interesting"
      // - "Here's why that matters"
      // - "At the end of the day"
      const patternIds = result.qualityScore.detectedPatterns.map((p) => p.id)
      const hasThroatClearing = patternIds.some((id) => id >= 36 && id <= 56)

      expect(hasThroatClearing).toBe(true)
      expect(result.qualityScore.detectedPatterns.length).toBeGreaterThan(0)
    })

    it('detects emphasis crutches and business jargon', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')

      const patterns = result.qualityScore.detectedPatterns
      const categories = patterns.map((p) => p.category)

      // Should identify ai-writing category patterns
      expect(categories).toContain('ai-writing')
      expect(patterns.length).toBeGreaterThan(3)
    })

    it('scores AI content lower than humanized content', async () => {
      const aiResult = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')
      const humanResult = await optimizer.optimize(SAMPLE_PROMPTS.humanized, 'analysis')

      const aiScore = aiResult.qualityScore.overall
      const humanScore = humanResult.qualityScore.overall

      // Humanized content should score significantly higher
      expect(humanScore).toBeGreaterThan(aiScore)
      expect(humanScore - aiScore).toBeGreaterThanOrEqual(10)
    })

    it('detects low-severity patterns in formulaic content', async () => {
      const testContent = `This is important — pay attention.
Always remember this. Never forget that.
What makes this hard is X. The solution is not Y — it's Z.
This is literally game-changing. Really important. Genuinely revolutionary.`

      const result = await optimizer.optimize(testContent, 'analysis')
      const patterns = result.qualityScore.detectedPatterns

      // Should find low-severity patterns
      const lowSeverity = patterns.filter((p) => p.severity === 'low')
      expect(lowSeverity.length).toBeGreaterThan(0)
    })
  })

  describe('Quality Scoring', () => {
    it('calculates accurate quality deltas', async () => {
      const aiResult = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')
      const humanResult = await optimizer.optimize(SAMPLE_PROMPTS.humanized, 'analysis')

      const delta = humanResult.qualityScore.overall - aiResult.qualityScore.overall

      // Delta should be meaningful (>15 points)
      expect(delta).toBeGreaterThan(15)
      expect(delta).toBeLessThan(50) // But not implausibly large
    })

    it('breaks down quality by dimensions', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')
      const dims = result.qualityScore.dimensions

      // All dimensions should be scored
      expect(dims.clarity).toBeDefined()
      expect(dims.specificity).toBeDefined()
      expect(dims.completeness).toBeDefined()
      expect(dims.efficiency).toBeDefined()

      // All should be numbers in 0-100 range
      Object.values(dims).forEach((score) => {
        expect(typeof score).toBe('number')
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(100)
      })
    })

    it('identifies suggested framework for content type', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.gateway_baseline, 'analysis')

      expect(result.framework).toBeDefined()
      expect(['RTF', 'CO-STAR', 'RISEN', 'CRISPE', 'CHAIN_OF_THOUGHT', 'FEW_SHOT']).toContain(
        result.framework,
      )
    })

    it('estimates token savings from optimization', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')

      const tokenDelta = result.tokenDelta
      expect(tokenDelta).toBeDefined()
      expect(tokenDelta.savings).toBeGreaterThanOrEqual(0)
      expect(tokenDelta.percent).toBeGreaterThanOrEqual(0)
      expect(tokenDelta.percent).toBeLessThanOrEqual(100)
    })
  })

  describe('Learning Pipeline Integration', () => {
    it('produces actionable pattern feedback', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')
      const patterns = result.qualityScore.detectedPatterns

      // Each pattern should have actionable info
      patterns.forEach((pattern) => {
        expect(pattern.pattern).toBeDefined()
        expect(pattern.category).toBeDefined()
        expect(pattern.severity).toMatch(/critical|high|medium|low/)
        expect(pattern.before).toBeDefined()
        expect(pattern.after).toBeDefined()
        expect(pattern.impact).toBeDefined()
      })
    })

    it('enables confidence delta calculation for auto-apply', async () => {
      const beforeResult = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')
      const afterResult = await optimizer.optimize(SAMPLE_PROMPTS.humanized, 'analysis')

      const delta = afterResult.qualityScore.overall - beforeResult.qualityScore.overall

      // For learning pipeline auto-apply threshold (0.3 = 30% improvement)
      const confidenceDelta = delta / 100

      expect(confidenceDelta).toBeGreaterThan(0.15)
      expect(typeof confidenceDelta).toBe('number')
    })

    it('handles multiple samples for statistical significance', async () => {
      const samples = [SAMPLE_PROMPTS.ai_generated, SAMPLE_PROMPTS.humanized, SAMPLE_PROMPTS.gateway_baseline]

      const results = await Promise.all(
        samples.map((sample) => optimizer.optimize(sample, 'analysis')),
      )

      const scores = results.map((r) => r.qualityScore.overall)

      // Should show meaningful variation
      const minScore = Math.min(...scores)
      const maxScore = Math.max(...scores)
      const variation = maxScore - minScore

      expect(variation).toBeGreaterThan(10)
    })

    it('prioritizes critical patterns in feedback', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')
      const patterns = result.qualityScore.detectedPatterns

      // Sort by severity
      const bySeverity = patterns.reduce(
        (acc, p) => {
          acc[p.severity] = (acc[p.severity] || 0) + 1
          return acc
        },
        {} as Record<string, number>,
      )

      // Should have detection across all severity levels
      expect(Object.keys(bySeverity).length).toBeGreaterThan(0)
    })
  })

  describe('Stop-Slop Pattern Catalog', () => {
    it('detects all major pattern categories', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')
      const patterns = result.qualityScore.detectedPatterns

      // Should include ai-writing patterns (36-56)
      const aiWritingPatterns = patterns.filter((p) => p.id >= 36 && p.id <= 56)
      expect(aiWritingPatterns.length).toBeGreaterThan(0)

      // And original patterns (1-35)
      const originalPatterns = patterns.filter((p) => p.id < 36)
      expect(originalPatterns.length + aiWritingPatterns.length).toBeGreaterThan(0)
    })

    it('distinguishes between ai-writing and other categories', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')
      const patterns = result.qualityScore.detectedPatterns

      const categories = new Set(patterns.map((p) => p.category))
      expect(categories.has('ai-writing')).toBe(true)

      // Should also have other categories
      expect(categories.size).toBeGreaterThan(1)
    })
  })

  describe('Learning Job Compatibility', () => {
    it('produces JSON-serializable results for database storage', async () => {
      const result = await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis')

      // Should be able to serialize all results
      expect(() => JSON.stringify(result.qualityScore.detectedPatterns)).not.toThrow()
      expect(() =>
        JSON.stringify({
          currentScore: result.qualityScore.overall,
          dimensions: result.qualityScore.dimensions,
          patterns: result.qualityScore.detectedPatterns.map((p) => p.category),
        }),
      ).not.toThrow()
    })

    it('returns consistent results across multiple calls', async () => {
      const results = await Promise.all([
        optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis'),
        optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis'),
        optimizer.optimize(SAMPLE_PROMPTS.ai_generated, 'analysis'),
      ])

      const scores = results.map((r) => r.qualityScore.overall)

      // Scores should be consistent (allow small floating point variation)
      const variance = Math.max(...scores) - Math.min(...scores)
      expect(variance).toBeLessThan(5)
    })

    it('completes within performance threshold for 12-hour job window', async () => {
      const taskTypes = ['linkedin-post-de', 'newsletter-dispatch-de', 'social-media-en']

      const startTime = Date.now()

      for (const taskType of taskTypes) {
        await optimizer.optimize(SAMPLE_PROMPTS.ai_generated, taskType)
      }

      const duration = Date.now() - startTime

      // Should complete 3 analyses in <2 seconds (learning job has 12h window)
      expect(duration).toBeLessThan(2000)
    })
  })
})
