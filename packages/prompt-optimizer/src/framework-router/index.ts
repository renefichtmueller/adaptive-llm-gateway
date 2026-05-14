/**
 * Framework Router — Selects optimal prompt template
 * Based on prompt-master's 12 templates + tool/intent matching
 */

import { IntentDimensions, PromptFramework, ToolTarget } from '../types';

export class FrameworkRouter {
  private frameworks: Record<PromptFramework, string> = {
    RTF: 'Role, Task, Format — Fast one-shot tasks',
    'CO-STAR': 'Context, Objective, Style, Tone, Audience, Response — Professional documents',
    RISEN: 'Role, Instructions, Steps, End Goal, Narrowing — Complex multi-step',
    CRISPE: 'Capacity, Role, Insight, Statement, Personality — Creative work',
    CHAIN_OF_THOUGHT: 'Step-by-step reasoning for logic tasks',
    FEW_SHOT: 'Examples for consistent structured output',
    FILE_SCOPE: 'File path + scope for IDE AI (Cursor, Windsurf, Copilot)',
    REACT_STOP: 'ReAct + stop conditions for agents (Claude Code, Devin)',
    VISUAL_DESCRIPTOR: 'Descriptors for image AI (Midjourney, DALL-E, SD)',
    REFERENCE_IMAGE: 'For editing existing images vs generating',
    COMFYUI: 'Node-based image workflows',
    DECOMPILE: 'Breaking down / simplifying existing prompts',
  };

  async select(intent: IntentDimensions, toolTarget?: string): Promise<PromptFramework> {
    const target = (toolTarget as ToolTarget) || this.detectToolTarget(intent);

    // Tool-specific routing
    if (target.includes('cursor') || target.includes('windsurf') || target.includes('copilot')) {
      return 'FILE_SCOPE';
    }
    if (target.includes('devin') || target.includes('claude-code')) {
      return 'REACT_STOP';
    }
    if (target.includes('midjourney') || target.includes('dall-e') || target.includes('stable-diffusion')) {
      return 'VISUAL_DESCRIPTOR';
    }
    if (target.includes('o3') || target.includes('o1')) {
      return 'CHAIN_OF_THOUGHT'; // But CoT will be stripped by auditor
    }

    // Intent-based routing (Claude/GPT)
    if (intent.task && intent.successCriteria.length > 0 && intent.constraints.length > 0) {
      return 'RISEN'; // Complex, structured
    }
    if (intent.audience === 'general' || !intent.audience) {
      return 'RTF'; // Fast, simple
    }
    if (intent.audience.includes('professional') || intent.audience.includes('business')) {
      return 'CO-STAR'; // Professional context
    }
    if (intent.task && intent.examples && intent.examples.length > 0) {
      return 'FEW_SHOT'; // Has examples
    }
    if (intent.successCriteria.length > 2) {
      return 'CO-STAR'; // Multiple criteria = structured needed
    }

    return 'RTF'; // Default
  }

  private detectToolTarget(intent: IntentDimensions): ToolTarget {
    // Heuristics for tool detection from intent
    if (intent.task.includes('file') || intent.task.includes('code edit')) {
      return 'cursor';
    }
    if (intent.task.includes('image') || intent.task.includes('generate')) {
      return 'midjourney';
    }
    if (intent.task.includes('agent') || intent.task.includes('autonomous')) {
      return 'claude-code';
    }
    return 'claude';
  }
}
