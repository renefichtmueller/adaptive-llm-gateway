// Cost Calculator - Token pricing and cost computation
// Updated: 2026-04-19
// Supports: Ollama (free), Fallback chain (minimal), compression savings calculation

import { logger } from './logger.js';

export interface TokenPricing {
  inputCost: number;    // $ per 1k tokens
  outputCost: number;   // $ per 1k tokens
  tier: 'free' | 'minimal' | 'standard' | 'premium';
}

// Pricing configuration
const PRICING_CONFIG: Record<string, TokenPricing> = {
  // Ollama models (local, free)
  'ollama:qwen2.5:3b': {
    inputCost: 0,
    outputCost: 0,
    tier: 'free'
  },
  'ollama:qwen2.5:14b': {
    inputCost: 0,
    outputCost: 0,
    tier: 'free'
  },
  'ollama:qwen2.5:32b': {
    inputCost: 0,
    outputCost: 0,
    tier: 'free'
  },
  'ollama:llama3.3:70b': {
    inputCost: 0,
    outputCost: 0,
    tier: 'free'
  },

  // Fallback chain (minimal cost)
  'cerebras': {
    inputCost: 0,        // Free tier
    outputCost: 0,
    tier: 'minimal'
  },
  'groq': {
    inputCost: 0.00005,
    outputCost: 0.00015,
    tier: 'minimal'
  },
  'mistral': {
    inputCost: 0.00014,
    outputCost: 0.00042,
    tier: 'minimal'
  },
  'nvidia-nim': {
    inputCost: 0.0001,
    outputCost: 0.0003,
    tier: 'minimal'
  },
  'cloudflare-workers-ai': {
    inputCost: 0,
    outputCost: 0,
    tier: 'minimal'   // Free tier with limits
  },

  // Claude via Bridge (fallback only)
  'claude-code': {
    inputCost: 0,       // Covered by subscription, tracked separately
    outputCost: 0,
    tier: 'free'        // Flat-rate subscription
  }
};

/**
 * Get pricing for a model, fallback to groq if not found
 */
function getPricing(model: string): TokenPricing {
  return PRICING_CONFIG[model] || PRICING_CONFIG['groq'] || {
    inputCost: 0.0001,
    outputCost: 0.0003,
    tier: 'minimal'
  };
}

/**
 * Calculate cost for a single request
 * @param model Model identifier
 * @param tokensIn Input tokens
 * @param tokensOut Output tokens
 * @returns Cost in USD
 */
export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing = getPricing(model);
  const inputCost = (tokensIn * pricing.inputCost) / 1000;
  const outputCost = (tokensOut * pricing.outputCost) / 1000;
  return parseFloat((inputCost + outputCost).toFixed(6));
}

/**
 * Calculate cost savings from compression
 * @param model Model identifier
 * @param tokensBeforeCompression Tokens before LeanCTX + RTK
 * @param tokensAfterCompression Tokens after compression
 * @returns Savings in USD
 */
export function calculateSavings(
  model: string,
  tokensBeforeCompression: number,
  tokensAfterCompression: number
): number {
  const costBefore = calculateCost(model, tokensBeforeCompression, 0);
  const costAfter = calculateCost(model, tokensAfterCompression, 0);
  return parseFloat((costBefore - costAfter).toFixed(6));
}

/**
 * Calculate compression ratio (%)
 */
export function calculateCompressionRatio(
  tokensBefore: number,
  tokensAfter: number
): number {
  if (tokensBefore === 0) return 0;
  return parseFloat(
    (((tokensBefore - tokensAfter) / tokensBefore) * 100).toFixed(2)
  );
}

/**
 * Determine if model is free (Ollama or covered by subscription)
 */
export function isFreeTier(model: string): boolean {
  const pricing = getPricing(model);
  return pricing.tier === 'free';
}

/**
 * Get model category
 */
export function getModelCategory(
  model: string
): 'local' | 'fallback' | 'fallback_paid' {
  if (model.startsWith('ollama:') || model === 'claude-code') {
    return 'local';
  }
  const pricing = getPricing(model);
  if (pricing.inputCost === 0 && pricing.outputCost === 0) {
    return 'fallback';
  }
  return 'fallback_paid';
}

/**
 * Format cost for display
 */
export function formatCost(costUsd: number): string {
  if (costUsd === 0) return '€0';
  if (costUsd < 0.001) return '<€0.001';
  return `€${costUsd.toFixed(4)}`;
}

/**
 * Log cost breakdown for monitoring
 */
export function logCostBreakdown(
  callId: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  tokensCompressed: number,
  confidenceScore: number
): void {
  const cost = calculateCost(model, tokensIn, tokensOut);
  const savings = calculateSavings(model, tokensIn + tokensOut, tokensCompressed);
  const compressionRatio = calculateCompressionRatio(
    tokensIn + tokensOut,
    tokensCompressed
  );

  logger.info({
    model,
    tokensIn,
    tokensOut,
    tokensCompressed,
    cost: formatCost(cost),
    savings: formatCost(savings),
    compressionRatio: `${compressionRatio}%`,
    confidenceScore: `${(confidenceScore * 100).toFixed(1)}%`,
    category: getModelCategory(model)
  }, `Cost breakdown [${callId}]`);
}

/**
 * Estimate budget impact for a batch of tasks
 */
export function estimateBatchCost(
  tasks: Array<{
    model: string;
    tokensIn: number;
    tokensOut: number;
  }>
): {
  totalCost: number;
  costByModel: Record<string, number>;
  breakdown: string;
} {
  const costByModel: Record<string, number> = {};
  let totalCost = 0;

  for (const task of tasks) {
    const cost = calculateCost(task.model, task.tokensIn, task.tokensOut);
    costByModel[task.model] = (costByModel[task.model] || 0) + cost;
    totalCost += cost;
  }

  const breakdown = Object.entries(costByModel)
    .map(([model, cost]) => `${model}: ${formatCost(cost)}`)
    .join(', ');

  return {
    totalCost: parseFloat(totalCost.toFixed(6)),
    costByModel,
    breakdown
  };
}
