import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { logger } from '../observability/logger.js';
import { scoreRequest } from './request-scorer.js';
import type { ScoringResult, Tier } from './request-scorer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '../config');

export interface RoutingRule {
  model: string;
  tier: 'fast' | 'medium' | 'large';
  prompt_template: string;
  temperature: number;
  max_tokens: number;
  output_format: 'text' | 'json';
  requires_fact_check: boolean;
  validators: string[];
  callers: string[];
}

export interface ModelConfig {
  tier: 'fast' | 'medium' | 'large' | 'reasoning';
  context_length: number;
  strengths?: string[];
  max_tokens_default?: number;
  provider?: string;
  description?: string;
}

export interface TierConfig {
  timeout_ms: number;
  error_threshold_percent: number;
  circuit_breaker_reset_ms: number;
}

export interface ModelsYaml {
  ollama_base_url: string;
  tiers: Record<string, TierConfig>;
  models: Record<string, ModelConfig>;
  fallback_chains: Record<string, string[]>;
  tier_fallback: Record<string, string | null>;
}

export interface RoutingRulesYaml {
  routing_rules: Record<string, RoutingRule>;
  validators: Record<string, Record<string, unknown>>;
}

// ─── Config normalization ───────────────────────────────────────────────────
// The shipped YAML files use a compact, user-facing format (`rules:` entries
// with just model/tier/prompt_template). The router normalizes either that
// format or the fully explicit one into the internal schema, so hand-edited
// configs and learning-optimizer output both keep working.

const DEFAULT_TIERS: Record<string, TierConfig> = {
  fast: { timeout_ms: 30_000, error_threshold_percent: 50, circuit_breaker_reset_ms: 30_000 },
  medium: { timeout_ms: 60_000, error_threshold_percent: 50, circuit_breaker_reset_ms: 60_000 },
  large: { timeout_ms: 180_000, error_threshold_percent: 50, circuit_breaker_reset_ms: 60_000 },
};

const DEFAULT_MAX_TOKENS: Record<string, number> = {
  fast: 1024,
  medium: 2048,
  large: 4096,
};

function normalizeTier(tier: unknown): 'fast' | 'medium' | 'large' {
  // 'reasoning' models run with large-tier budgets.
  if (tier === 'fast' || tier === 'medium') return tier;
  return 'large';
}

function normalizeModels(raw: Record<string, unknown>): ModelsYaml {
  const legacyDefaults = (raw['defaults'] as { fallback_chain?: Record<string, string[]> } | undefined);
  return {
    ollama_base_url: (raw['ollama_base_url'] as string) ?? 'http://localhost:11434',
    tiers: { ...DEFAULT_TIERS, ...((raw['tiers'] as Record<string, TierConfig>) ?? {}) },
    models: (raw['models'] as Record<string, ModelConfig>) ?? {},
    fallback_chains:
      (raw['fallback_chains'] as Record<string, string[]>)
      ?? legacyDefaults?.fallback_chain
      ?? {},
    tier_fallback: (raw['tier_fallback'] as Record<string, string | null>) ?? {},
  };
}

function normalizeRoutingRules(raw: Record<string, unknown>): RoutingRulesYaml {
  const source = (raw['routing_rules'] ?? raw['rules'] ?? {}) as Record<string, Partial<RoutingRule>>;
  const rules: Record<string, RoutingRule> = {};

  for (const [taskType, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object' || !entry.model) continue;
    const tier = normalizeTier(entry.tier);
    rules[taskType] = {
      model: entry.model,
      tier,
      prompt_template: entry.prompt_template ?? 'default',
      temperature: entry.temperature ?? 0.7,
      max_tokens: entry.max_tokens ?? DEFAULT_MAX_TOKENS[tier]!,
      output_format: entry.output_format ?? 'text',
      requires_fact_check: entry.requires_fact_check ?? false,
      validators: entry.validators ?? [],
      callers: entry.callers ?? ['all'],
    };
  }

  return {
    routing_rules: rules,
    validators: (raw['validators'] as Record<string, Record<string, unknown>>) ?? {},
  };
}

export interface RouterDecision {
  model: string;
  provider?: string; // 'openai-codex', 'ollama' (default), etc
  fallback_chain: string[];
  tier: 'fast' | 'medium' | 'large';
  prompt_template: string;
  temperature: number;
  max_tokens: number;
  output_format: 'text' | 'json';
  requires_fact_check: boolean;
  validators: string[];
  ollama_base_url: string;
  timeout_ms: number;
  scoringResult?: ScoringResult;
}

let modelsConfig: ModelsYaml | null = null;
let routingConfig: RoutingRulesYaml | null = null;

function loadModels(): ModelsYaml {
  if (modelsConfig) return modelsConfig;
  try {
    const raw = readFileSync(join(CONFIG_DIR, 'models.yaml'), 'utf-8');
    modelsConfig = normalizeModels((yaml.load(raw) ?? {}) as Record<string, unknown>);
    return modelsConfig;
  } catch (err) {
    logger.error({ err }, 'Failed to load models.yaml');
    throw new Error('Could not load models configuration', { cause: err });
  }
}

function loadRoutingRules(): RoutingRulesYaml {
  if (routingConfig) return routingConfig;
  try {
    const raw = readFileSync(join(CONFIG_DIR, 'routing-rules.yaml'), 'utf-8');
    routingConfig = normalizeRoutingRules((yaml.load(raw) ?? {}) as Record<string, unknown>);
    return routingConfig;
  } catch (err) {
    logger.error({ err }, 'Failed to load routing-rules.yaml');
    throw new Error('Could not load routing rules configuration', { cause: err });
  }
}

export function reloadConfigs(): void {
  modelsConfig = null;
  routingConfig = null;
  loadModels();
  loadRoutingRules();
}

function isCallerAllowed(rule: RoutingRule, caller: string): boolean {
  return rule.callers.includes('all') || rule.callers.includes(caller);
}

function buildFallbackChain(
  primaryModel: string,
  tier: string,
  models: ModelsYaml,
): string[] {
  const chain = models.fallback_chains[tier] ?? [];
  // Put primary first, then other fallbacks excluding primary
  return [primaryModel, ...chain.filter((m) => m !== primaryModel)];
}

export function route(
  taskType: string,
  caller: string,
  overrides?: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
  },
): RouterDecision {
  const models = loadModels();
  const rules = loadRoutingRules();

  const rule = rules.routing_rules[taskType];
  if (!rule) {
    // Fall back to generic_qa
    const fallbackRule = rules.routing_rules['generic_qa'];
    if (!fallbackRule) {
      throw new Error(`No routing rule for task_type: ${taskType}`);
    }
    logger.warn({ taskType, caller }, 'Unknown task_type, falling back to generic_qa');
    return buildDecision('generic_qa', fallbackRule, caller, models, overrides);
  }

  if (!isCallerAllowed(rule, caller)) {
    throw new Error(`Caller "${caller}" is not allowed to use task_type "${taskType}"`);
  }

  return buildDecision(taskType, rule, caller, models, overrides);
}

function buildDecision(
  _taskType: string,
  rule: RoutingRule,
  _caller: string,
  models: ModelsYaml,
  overrides?: { model?: string; temperature?: number; max_tokens?: number },
): RouterDecision {
  const selectedModel = overrides?.model ?? rule.model;
  const tier = rule.tier;
  const tierConfig = models.tiers[tier];

  if (!tierConfig) {
    throw new Error(`Unknown model tier: ${tier}`);
  }

  return {
    model: selectedModel,
    fallback_chain: buildFallbackChain(selectedModel, tier, models),
    tier,
    prompt_template: rule.prompt_template,
    temperature: overrides?.temperature ?? rule.temperature,
    max_tokens: overrides?.max_tokens ?? rule.max_tokens,
    output_format: rule.output_format,
    requires_fact_check: rule.requires_fact_check,
    validators: rule.validators,
    ollama_base_url: models.ollama_base_url,
    timeout_ms: tierConfig.timeout_ms,
  };
}

export function getModelTier(model: string): 'fast' | 'medium' | 'large' {
  const models = loadModels();
  const config = models.models[model];
  if (!config) return 'medium';
  return normalizeTier(config.tier);
}

export function getOllamaBaseUrl(): string {
  // OLLAMA_URL env var takes precedence over config file
  const envUrl = process.env['OLLAMA_URL'];
  if (envUrl) return envUrl;
  const models = loadModels();
  return models.ollama_base_url;
}

// ── Tier-to-Model Mapping for Dynamic Scoring ──────────────────────────────

/**
 * Maps a scorer tier to the best primary model and its fallback chain.
 * The 'reasoning' tier uses llama3.3:70b (complex_reasoning strength) from the large tier.
 * The 'code_generation' tier uses OpenAI Codex (gpt-4-turbo) as primary via external provider.
 */
const TIER_MODEL_MAP: Record<Tier, { primary: string; configTier: 'fast' | 'medium' | 'large'; provider?: string }> = {
  fast: { primary: 'qwen2.5:3b', configTier: 'fast' },
  medium: { primary: 'qwen2.5:14b', configTier: 'medium' },
  large: { primary: 'qwen2.5:32b', configTier: 'large' },
  reasoning: { primary: 'llama3.3:70b', configTier: 'large' },
  code_generation: { primary: 'gpt-4-turbo', configTier: 'large', provider: 'openai-codex' },
};

function buildMediumTierFallback(
  models: ModelsYaml,
  options?: { max_tokens?: number },
  scoringResult?: ScoringResult,
): RouterDecision {
  const fallbackTierConfig = models.tiers['medium']!;
  return {
    model: 'qwen2.5:14b',
    fallback_chain: buildFallbackChain('qwen2.5:14b', 'medium', models),
    tier: 'medium',
    prompt_template: 'default',
    temperature: 0.7,
    max_tokens: options?.max_tokens ?? 2048,
    output_format: 'text',
    requires_fact_check: false,
    validators: [],
    ollama_base_url: models.ollama_base_url,
    timeout_ms: fallbackTierConfig.timeout_ms,
    scoringResult,
  };
}

function buildScoredFallbackChain(
  tier: Tier,
  selectedModel: string,
  configTier: 'fast' | 'medium' | 'large',
  models: ModelsYaml,
): string[] {
  if (tier === 'reasoning' || tier === 'code_generation') {
    // Prefer a dedicated chain for the scorer tier (e.g. strong local coder
    // models for code_generation); fall back to the config-tier chain.
    const scorerChain = models.fallback_chains[tier];
    const chain = scorerChain ?? models.fallback_chains[configTier] ?? [];
    return [selectedModel, ...chain.filter((m) => m !== selectedModel)];
  }
  return buildFallbackChain(selectedModel, configTier, models);
}

function buildScoredDecision(
  models: ModelsYaml,
  mapping: { primary: string; configTier: 'fast' | 'medium' | 'large'; provider?: string },
  selectedModel: string,
  configTier: 'fast' | 'medium' | 'large',
  fallbackChain: string[],
  tierConfig: ModelsYaml['tiers']['fast'],
  scoringResult: ScoringResult,
  options?: { max_tokens?: number },
): RouterDecision {
  const provider = mapping.provider;
  const modelConfig = models.models[selectedModel];

  logger.info(
    {
      tier: scoringResult.tier,
      model: selectedModel,
      provider: provider || 'ollama',
      score: scoringResult.score.toFixed(4),
      confidence: scoringResult.confidence.toFixed(3),
      reason: scoringResult.reason,
    },
    'Dynamic routing decision via request scorer',
  );

  return {
    model: selectedModel,
    provider,
    fallback_chain: fallbackChain,
    tier: configTier,
    prompt_template: 'default',
    temperature: 0.7,
    max_tokens: options?.max_tokens ?? modelConfig?.max_tokens_default ?? 2048,
    output_format: 'text',
    requires_fact_check: false,
    validators: [],
    ollama_base_url: models.ollama_base_url,
    timeout_ms: tierConfig.timeout_ms,
    scoringResult,
  };
}

/**
 * Dynamic routing based on the 23-dimension request scorer.
 * Use this alongside the static `route()` function — both coexist.
 *
 * @param messages - The conversation messages array
 * @param options  - Optional tools, tool_choice, max_tokens
 * @returns RouterDecision with scoring metadata attached
 */
export function routeByScore(
  messages: Array<{ role: string; content: string }>,
  options?: {
    tools?: unknown[];
    tool_choice?: string;
    max_tokens?: number;
    sessionHistory?: string[];
  },
): RouterDecision {
  const models = loadModels();

  const scoringResult = scoreRequest(
    {
      messages,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      max_tokens: options?.max_tokens,
    },
    options?.sessionHistory,
  );

  const mapping = TIER_MODEL_MAP[scoringResult.tier];
  const selectedModel = mapping.primary;
  const configTier = mapping.configTier;
  const tierConfig = models.tiers[configTier];

  if (!tierConfig) {
    logger.error({ tier: configTier }, 'Tier config not found in models.yaml, falling back to medium');
    return buildMediumTierFallback(models, options, scoringResult);
  }

  const fallbackChain = buildScoredFallbackChain(scoringResult.tier, selectedModel, configTier, models);
  return buildScoredDecision(models, mapping, selectedModel, configTier, fallbackChain, tierConfig, scoringResult, options);
}
