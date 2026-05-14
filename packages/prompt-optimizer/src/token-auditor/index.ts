/**
 * Token Auditor — Strip non-load-bearing words
 * Core insight from prompt-master: "Best prompt is not longest, it's sharpest"
 */

import { PromptFramework } from '../types';

export class TokenAuditor {
  private fillerWords = [
    'very', 'really', 'actually', 'basically', 'just', 'simply',
    'kind of', 'sort of', 'like', 'literally', 'honestly',
    'please', 'thank you', 'thanks', 'kindly',
    'try to', 'attempt to', 'make sure to',
  ];

  private redundantPhrases = [
    'in order to',      // → to
    'at the end of the day', // → ultimately
    'in my opinion',    // → drop
    'it is important to note that', // → note:
    'the fact that',    // → that
    'due to the fact that', // → because
  ];

  async optimize(prompt: string, framework: PromptFramework): Promise<string> {
    let optimized = prompt;

    // 1. Remove fillers
    for (const filler of this.fillerWords) {
      const regex = new RegExp(`\\b${filler}\\s+`, 'gi');
      optimized = optimized.replace(regex, '');
    }

    // 2. Replace redundant phrases
    for (const [redundant, replacement] of Object.entries(this.redundantPhrases)) {
      const regex = new RegExp(redundant, 'gi');
      optimized = optimized.replace(regex, replacement);
    }

    // 3. Framework-specific optimization
    if (framework === 'FILE_SCOPE') {
      optimized = this.optimizeForFileScope(optimized);
    }
    if (framework === 'VISUAL_DESCRIPTOR') {
      optimized = this.optimizeForVisual(optimized);
    }

    // 4. Consolidate whitespace
    optimized = optimized.replace(/\s+/g, ' ').trim();

    return optimized;
  }

  calculateDelta(
    original: string,
    optimized: string
  ): {
    before: number;
    after: number;
    savings: number;
    percent: number;
  } {
    // Rough token count (~4 chars = 1 token)
    const beforeTokens = Math.ceil(original.length / 4);
    const afterTokens = Math.ceil(optimized.length / 4);
    const savings = beforeTokens - afterTokens;
    const percent = Math.round((savings / beforeTokens) * 100);

    return {
      before: beforeTokens,
      after: afterTokens,
      savings: Math.max(0, savings),
      percent: Math.max(0, percent),
    };
  }

  private optimizeForFileScope(prompt: string): string {
    // For IDE AI: Extract file path + function, drop context
    const pathMatch = prompt.match(/(?:in|at|file|path|`\/[^`]+`)/);
    const funcMatch = prompt.match(/(?:function|method|class)\s+`?([^`\s]+)`?/);

    if (pathMatch && funcMatch) {
      return `${pathMatch[0]}: ${funcMatch[1]}. ${prompt.split('\n')[0]}`;
    }
    return prompt;
  }

  private optimizeForVisual(prompt: string): string {
    // For image AI: Convert prose to comma-separated descriptors
    // Remove connecting words
    const descriptors = prompt
      .replace(/\b(and|or|with|in|at|the|a|an)\b/gi, ',')
      .replace(/,+/g, ', ')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    return descriptors.join(', ');
  }
}
