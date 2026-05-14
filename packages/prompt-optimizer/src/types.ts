/**
 * Prompt Optimizer Types
 * Based on prompt-master's 9-dimensional intent extraction + 35 pattern analysis
 */

export type ToolTarget =
  | 'claude' | 'gpt' | 'gemini' | 'o3' | 'ollama' | 'qwen' | 'local'
  | 'cursor' | 'windsurf' | 'copilot' | 'cline'
  | 'midjourney' | 'dall-e' | 'stable-diffusion'
  | 'claude-code' | 'devin' | 'v0' | 'bolt'
  | 'unknown';

export type PromptFramework =
  | 'RTF' | 'CO-STAR' | 'RISEN' | 'CRISPE' | 'CHAIN_OF_THOUGHT'
  | 'FEW_SHOT' | 'FILE_SCOPE' | 'REACT_STOP' | 'VISUAL_DESCRIPTOR'
  | 'REFERENCE_IMAGE' | 'COMFYUI' | 'DECOMPILE';

export interface IntentDimensions {
  task: string;           // What they want done
  input: string;          // What they're starting with
  output: string;         // What format/shape they need back
  constraints: string[];  // Limitations/rules
  context: string;        // Background/project state
  audience: string;       // Who needs to understand this
  memory: string[];       // Prior decisions to carry forward
  successCriteria: string[]; // How to know it worked
  examples?: string[];    // Reference patterns
}

export interface CreditKillingPattern {
  id: number;
  category: 'task' | 'context' | 'format' | 'scope' | 'reasoning' | 'agentic' | 'ai-writing';
  pattern: string;
  before: string;
  after: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  impact: string;         // e.g. "3 wasted API calls"
}

export interface PromptQualityScore {
  overall: number;        // 0-100
  dimensions: {
    clarity: number;
    specificity: number;
    completeness: number;
    efficiency: number;
  };
  detectedPatterns: CreditKillingPattern[];
  suggestedFramework: PromptFramework;
  estimatedTokenSavings: number;
}

export interface OptimizedPrompt {
  original: string;
  optimized: string;
  framework: PromptFramework;
  toolTarget: ToolTarget;
  qualityScore: PromptQualityScore;
  strategy: string;        // One-line explanation of what was optimized
  tokenDelta: {
    before: number;
    after: number;
    savings: number;
    percent: number;
  };
}
