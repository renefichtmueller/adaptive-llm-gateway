/**
 * Intent Extractor — 9-dimensional analysis
 * From prompt-master: task, input, output, constraints, context, audience, memory, success criteria, examples
 */

import { IntentDimensions } from '../types';

export class IntentExtractor {
  async extract(prompt: string): Promise<IntentDimensions> {
    // TODO: Implement Claude integration for semantic understanding
    // For now, return structured extraction

    return {
      task: this.extractTask(prompt),
      input: this.extractInput(prompt),
      output: this.extractOutput(prompt),
      constraints: this.extractConstraints(prompt),
      context: this.extractContext(prompt),
      audience: this.extractAudience(prompt),
      memory: this.extractMemory(prompt),
      successCriteria: this.extractSuccessCriteria(prompt),
      examples: this.extractExamples(prompt),
    };
  }

  private extractTask(prompt: string): string {
    // Task = main verb + object
    const match = prompt.match(/(?:build|write|create|fix|refactor|design|analyze|generate)\s+(?:a\s+)?([^.!?]+)/i);
    return match?.[1]?.trim() || prompt.substring(0, 100);
  }

  private extractInput(prompt: string): string {
    // What they're starting with
    return prompt.includes('given') || prompt.includes('starting with')
      ? prompt.substring(prompt.indexOf('given'))
      : 'unspecified';
  }

  private extractOutput(prompt: string): string {
    // Format/shape expected back
    const match = prompt.match(/(?:return|output|format|as)?\s+(?:a\s+)?([^.!?]*(?:json|xml|markdown|html|code|document|report|list|table|array))/i);
    return match?.[1]?.trim() || 'text response';
  }

  private extractConstraints(prompt: string): string[] {
    const constraints: string[] = [];
    const constraintPatterns = [
      /(?:do not|don't|never|avoid|no)\s+([^.!?]+)/gi,
      /(?:must|must not|should)\s+([^.!?]+)/gi,
      /(?:only|limited to)\s+([^.!?]+)/gi,
    ];

    for (const pattern of constraintPatterns) {
      let match;
      while ((match = pattern.exec(prompt)) !== null) {
        constraints.push(match[1].trim());
      }
    }

    return constraints;
  }

  private extractContext(prompt: string): string {
    // Project/background state
    const match = prompt.match(/(?:context|background|project|working on):\s*([^.!?]+)/i);
    return match?.[1]?.trim() || 'not provided';
  }

  private extractAudience(prompt: string): string {
    // Who needs to understand this
    const match = prompt.match(/(?:for|audience|target)\s+([^.!?]+)/i);
    return match?.[1]?.trim() || 'general';
  }

  private extractMemory(prompt: string): string[] {
    // Prior decisions to carry forward
    const memory: string[] = [];
    if (prompt.includes('remember') || prompt.includes('previously')) {
      // TODO: Extract memory blocks
    }
    return memory;
  }

  private extractSuccessCriteria(prompt: string): string[] {
    const criteria: string[] = [];
    const match = prompt.match(/(?:done when|success criteria|verify):\s*([^.!?]+)/gi);
    if (match) {
      criteria.push(...match.map((m) => m.replace(/(?:done when|success criteria|verify):\s*/i, '')));
    }
    return criteria;
  }

  private extractExamples(prompt: string): string[] {
    const examples: string[] = [];
    const match = prompt.match(/(?:example|like):\s*([^.!?]+)/gi);
    if (match) {
      examples.push(...match.map((m) => m.replace(/(?:example|like):\s*/i, '')));
    }
    return examples;
  }
}
