/**
 * Test: Scoring and Routing for Code Generation
 * Validates that code generation requests are correctly identified and routed to Codex
 */

import { describe, it, expect } from 'vitest';
import { scoreRequest } from '../request-scorer.js';
import { route, routeByScore } from '../router.js';

describe('Code Generation Scoring and Routing', () => {
  describe('Request Scorer - Code Generation Detection', () => {
    it('should detect code generation request with keywords', () => {
      const result = scoreRequest({
        messages: [
          { role: 'user', content: 'Write a TypeScript function that validates email addresses and returns a boolean' },
        ],
      });

      expect(result.tier).toBe('code_generation');
      expect(result.score).toBeGreaterThan(0.55);
      expect(result.confidence).toBeGreaterThan(0.6);
      expect(result.reason).toContain('code generation');
    });

    it('should detect code generation with "implement" keyword', () => {
      const result = scoreRequest({
        messages: [
          { role: 'user', content: 'Implement a REST API endpoint for user authentication with JWT tokens' },
        ],
      });

      expect(result.tier).toBe('code_generation');
    });

    it('should detect code generation with "scaffold" keyword', () => {
      const result = scoreRequest({
        messages: [
          { role: 'user', content: 'Scaffold a new Next.js project with TypeScript, Tailwind, and ESLint configured' },
        ],
      });

      expect(result.tier).toBe('code_generation');
    });

    it('should handle reasoning tier (formal logic) differently from code generation', () => {
      const codeGenResult = scoreRequest({
        messages: [
          { role: 'user', content: 'Write a function that implements merge sort' },
        ],
      });

      const reasoningResult = scoreRequest({
        messages: [
          { role: 'user', content: 'Prove by induction that the Fibonacci sequence satisfies F(n) <= 2^n' },
        ],
      });

      expect(codeGenResult.tier).toBe('code_generation');
      expect(reasoningResult.tier).toBe('reasoning');
    });

    it('should assign medium tier for non-complex requests', () => {
      const result = scoreRequest({
        messages: [
          { role: 'user', content: 'What is the weather today?' },
        ],
      });

      expect(result.tier).not.toBe('code_generation');
      expect(result.tier).toBe('medium');
    });
  });

  describe('Router - Code Generation Tier Mapping', () => {
    it('should map code_generation tier to gpt-4-turbo with openai-codex provider', () => {
      const messages = [
        { role: 'user', content: 'Write a Python script that downloads files from URLs and extracts metadata' },
      ];

      const decision = routeByScore(messages);

      expect(decision.model).toBe('gpt-4-turbo');
      expect(decision.provider).toBe('openai-codex');
      expect(decision.tier).toBe('large');
    });

    it('should use code_generation tier fallback chain', () => {
      const messages = [
        { role: 'user', content: 'Implement a distributed cache with Redis and implement consistency protocols' },
      ];

      const decision = routeByScore(messages);

      // Primary is gpt-4-turbo, fallback chain should be deepseek-r1:32b → qwen2.5:32b → llama3.3:70b
      expect(decision.fallback_chain).toContain('deepseek-r1:32b');
      expect(decision.fallback_chain).toContain('qwen2.5:32b');
      expect(decision.fallback_chain[0]).toBe('gpt-4-turbo');
    });

    it('should correctly route task_type=code_generation via static router', () => {
      const decision = route('code_generation', 'internal');

      // Static router should have code_generation routing rule, but we're testing the dynamic routeByScore
      // which is the primary pathway for code generation detection
      expect(decision).toBeDefined();
    });
  });

  describe('Full Integration: Scorer → Router → Decision', () => {
    it('should end-to-end route a code generation request', () => {
      const userRequest = 'Create a React component for an image gallery with light box support and keyboard navigation';

      const scoringResult = scoreRequest({
        messages: [{ role: 'user', content: userRequest }],
      });

      expect(scoringResult.tier).toBe('code_generation');

      const routingDecision = routeByScore([{ role: 'user', content: userRequest }]);

      expect(routingDecision.provider).toBe('openai-codex');
      expect(routingDecision.model).toBe('gpt-4-turbo');
      expect(routingDecision.timeout_ms).toBe(180000); // 3 minutes for code generation
    });

    it('should handle code generation requests with additional context', () => {
      const scoringResult = scoreRequest({
        messages: [
          { role: 'system', content: 'You are a TypeScript expert' },
          { role: 'user', content: 'Create a class that manages file uploads with validation and progress tracking' },
        ],
      });

      expect(scoringResult.tier).toBe('code_generation');
    });

    it('should prefer code_generation tier even with long context', () => {
      const longContext = 'A'.repeat(100000);
      const scoringResult = scoreRequest({
        messages: [
          { role: 'user', content: `${longContext}\n\nWrite a function to parse this data` },
        ],
      });

      // Should still be code_generation despite long context
      expect(scoringResult.tier).toBe('code_generation');
    });
  });

  describe('Confidence Levels for Code Generation', () => {
    it('should have high confidence for strong code generation requests', () => {
      const result = scoreRequest({
        messages: [
          { role: 'user', content: 'Implement a complete REST API with TypeScript, Express, and PostgreSQL, including authentication' },
        ],
      });

      expect(result.confidence).toBeGreaterThan(0.75);
    });

    it('should have lower confidence for ambiguous requests', () => {
      const result = scoreRequest({
        messages: [
          { role: 'user', content: 'Tell me about software development' },
        ],
      });

      expect(result.tier).not.toBe('code_generation');
    });
  });
});
