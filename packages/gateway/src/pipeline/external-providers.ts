import { logger } from '../observability/logger.js';

// ─── External Provider Configuration ────────────────────────────────
// Free LLM APIs for fallback when Ollama is unavailable.
// All use OpenAI-compatible /v1/chat/completions format.
// Source: github.com/mnfst/awesome-free-llm-apis (2026-04)

export interface ExternalProvider {
  readonly name: string;
  readonly baseUrl: string;
  readonly envKey: string;
  readonly models: readonly ExternalModel[];
  readonly rateLimitRpm: number;
  readonly enabled: boolean;
}

export interface ExternalModel {
  readonly id: string;
  readonly tier: 'fast' | 'medium' | 'large' | 'reasoning';
  readonly contextLength: number;
}

export interface ExternalCompletionRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly temperature?: number;
  readonly max_tokens?: number;
}

export interface ExternalCompletionResponse {
  readonly response: string;
  readonly model: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

// ─── Provider Registry ──────────────────────────────────────────────

const PROVIDERS: readonly ExternalProvider[] = [
  {
    name: 'claude-bridge',
    baseUrl: '', // constructed from CLAUDE_BRIDGE_URL env var
    envKey: 'CLAUDE_BRIDGE_URL',
    rateLimitRpm: 100,
    enabled: true,
    models: [
      { id: 'claude-opus-4-1', tier: 'reasoning', contextLength: 200000 },
      { id: 'claude-sonnet-4-1', tier: 'large', contextLength: 200000 },
      { id: 'claude-haiku-3', tier: 'fast', contextLength: 200000 },
    ],
  },
  {
    name: 'openai-bridge',
    baseUrl: '', // constructed from OPENAI_BRIDGE_URL env var
    envKey: 'OPENAI_BRIDGE_URL',
    rateLimitRpm: 90,
    enabled: true,
    models: [
      { id: 'gpt-4-turbo', tier: 'reasoning', contextLength: 128000 },
      { id: 'gpt-4', tier: 'reasoning', contextLength: 8192 },
      { id: 'gpt-3.5-turbo', tier: 'fast', contextLength: 16384 },
    ],
  },
  {
    name: 'chatgpt-bridge',
    baseUrl: '', // constructed from CHATGPT_BRIDGE_URL env var (same as openai-bridge)
    envKey: 'CHATGPT_BRIDGE_URL',
    rateLimitRpm: 90,
    enabled: true,
    models: [
      { id: 'gpt-4-turbo', tier: 'reasoning', contextLength: 128000 },
      { id: 'gpt-4', tier: 'large', contextLength: 8192 },
      { id: 'gpt-3.5-turbo', tier: 'medium', contextLength: 16384 },
    ],
  },
  {
    name: 'copilot-bridge',
    baseUrl: '', // constructed from COPILOT_BRIDGE_URL env var
    envKey: 'COPILOT_BRIDGE_URL',
    rateLimitRpm: 60,
    enabled: true,
    models: [
      { id: 'gpt-4', tier: 'reasoning', contextLength: 8192 },
      { id: 'gpt-3.5-turbo', tier: 'medium', contextLength: 4096 },
    ],
  },
  {
    name: 'm365-copilot-bridge',
    baseUrl: '', // constructed from M365_COPILOT_BRIDGE_URL env var
    envKey: 'M365_COPILOT_BRIDGE_URL',
    rateLimitRpm: 60,
    enabled: true,
    models: [
      { id: 'microsoft-365-copilot', tier: 'reasoning', contextLength: 128000 },
      { id: 'm365-copilot-chat', tier: 'large', contextLength: 128000 },
    ],
  },
  {
    name: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'CEREBRAS_API_KEY',
    rateLimitRpm: 30,
    enabled: true,
    models: [
      { id: 'llama-3.3-70b', tier: 'large', contextLength: 8192 },
      { id: 'qwen3-235b', tier: 'reasoning', contextLength: 8192 },
    ],
  },
  {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    rateLimitRpm: 30,
    enabled: true,
    models: [
      { id: 'llama-3.3-70b-versatile', tier: 'large', contextLength: 131072 },
      { id: 'llama-3.1-8b-instant', tier: 'fast', contextLength: 131072 },
      { id: 'gemma2-9b-it', tier: 'medium', contextLength: 8192 },
    ],
  },
  {
    name: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    rateLimitRpm: 60,
    enabled: true,
    models: [
      { id: 'mistral-large-latest', tier: 'reasoning', contextLength: 131072 },
      { id: 'mistral-small-latest', tier: 'medium', contextLength: 131072 },
      { id: 'ministral-8b-latest', tier: 'fast', contextLength: 131072 },
    ],
  },
  {
    name: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    rateLimitRpm: 40,
    enabled: true,
    models: [
      { id: 'meta/llama-3.3-70b-instruct', tier: 'large', contextLength: 131072 },
      { id: 'mistralai/mistral-large-2-instruct', tier: 'reasoning', contextLength: 131072 },
    ],
  },
  {
    name: 'cloudflare',
    baseUrl: '', // constructed dynamically from CLOUDFLARE_ACCOUNT_ID
    envKey: 'CLOUDFLARE_AI_TOKEN',
    rateLimitRpm: 100,
    enabled: true,
    models: [
      { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', tier: 'large', contextLength: 8192 },
      { id: '@cf/qwen/qwen1.5-14b-chat-awq', tier: 'medium', contextLength: 32768 },
    ],
  },
  {
    name: 'openai-codex',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_CODEX_URL',
    rateLimitRpm: 60,
    enabled: true,
    models: [
      { id: 'gpt-5.1-codex', tier: 'reasoning', contextLength: 256000 },
      { id: 'gpt-5.1-codex-mini', tier: 'large', contextLength: 256000 },
      { id: 'codex-mini-latest', tier: 'medium', contextLength: 200000 },
    ],
  },
  {
    name: 'claude-code',
    baseUrl: '', // constructed from CLAUDE_CODE_URL env var
    envKey: 'CLAUDE_CODE_URL',
    rateLimitRpm: 100,
    enabled: true,
    models: [
      { id: 'claude-opus-4-1', tier: 'reasoning', contextLength: 200000 },
      { id: 'claude-sonnet-4-1', tier: 'large', contextLength: 200000 },
      { id: 'claude-haiku-3', tier: 'fast', contextLength: 200000 },
    ],
  },
  {
    name: 'codex',
    baseUrl: 'https://api.github.com/copilot_inner/v2',
    envKey: 'CODEX_BRIDGE_URL',
    rateLimitRpm: 60,
    enabled: true,
    models: [
      { id: 'gpt-5.1-codex', tier: 'reasoning', contextLength: 256000 },
      { id: 'gpt-5.1-codex-mini', tier: 'large', contextLength: 256000 },
      { id: 'codex-mini-latest', tier: 'medium', contextLength: 200000 },
    ],
  },
];

const AUTHLESS_BRIDGE_PROVIDERS = new Set([
  'claude-bridge',
  'claude-code',
  'openai-bridge',
  'chatgpt-bridge',
  'copilot-bridge',
  'm365-copilot-bridge',
]);

const GENERATE_BRIDGE_PROVIDERS = new Set(['claude-bridge', 'claude-code']);

// ─── Rate Limiter (simple sliding window) ───────────────────────────

const requestTimestamps: Map<string, number[]> = new Map();

function isRateLimited(provider: ExternalProvider): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = requestTimestamps.get(provider.name) ?? [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  requestTimestamps.set(provider.name, recent);
  return recent.length >= provider.rateLimitRpm;
}

function recordRequest(providerName: string): void {
  const timestamps = requestTimestamps.get(providerName) ?? [];
  timestamps.push(Date.now());
  requestTimestamps.set(providerName, timestamps);
}

// ─── Provider Resolution ────────────────────────────────────────────

function getApiKey(provider: ExternalProvider): string | undefined {
  if (provider.name === 'claude-bridge') {
    // claude-bridge doesn't use an API key; check if enabled and URL is set
    const enabled = process.env['CLAUDE_BRIDGE_ENABLED'] === 'true';
    const url = process.env['CLAUDE_BRIDGE_URL'];
    return enabled && url ? 'claude-bridge-enabled' : undefined;
  }
  if (provider.name === 'claude-code') {
    // claude-code uses Claude Code subscription bridge
    const url = process.env['CLAUDE_CODE_URL'];
    return url ? 'claude-code-enabled' : undefined;
  }
  if (provider.name === 'openai-bridge') {
    // Subscription bridge auth is handled by the bridge process/CLI session.
    const url = process.env['OPENAI_BRIDGE_URL'];
    return url ? 'openai-bridge-enabled' : undefined;
  }
  if (provider.name === 'chatgpt-bridge') {
    // ChatGPT Plus bridge can reuse the OpenAI bridge when configured that way.
    const url = process.env['CHATGPT_BRIDGE_URL'] || process.env['OPENAI_BRIDGE_URL'];
    return url ? 'chatgpt-bridge-enabled' : undefined;
  }
  if (provider.name === 'copilot-bridge') {
    // copilot-bridge uses GitHub Copilot subscription (auth handled internally by copilot-api).
    const url = process.env['COPILOT_BRIDGE_URL'];
    return url ? 'copilot-authenticated' : undefined;
  }
  if (provider.name === 'm365-copilot-bridge') {
    // Microsoft 365 Copilot uses Microsoft Graph delegated auth inside the bridge.
    const url = process.env['M365_COPILOT_BRIDGE_URL'];
    return url ? 'm365-copilot-bridge-enabled' : undefined;
  }
  if (provider.name === 'openai-codex') {
    const bridgeUrl = process.env['OPENAI_CODEX_URL'] || process.env['CODEX_BRIDGE_URL'];
    if (bridgeUrl) return 'openai-codex-bridge-enabled';
    return process.env['OPENAI_API_KEY'] || undefined;
  }
  if (provider.name === 'codex') {
    // Codex can run through an authless local/subscription bridge. A token remains supported as fallback.
    const bridgeUrl = process.env['CODEX_BRIDGE_URL'] || process.env['OPENAI_CODEX_URL'];
    if (bridgeUrl) return 'codex-bridge-enabled';
    const token = process.env['GITHUB_CODEX_TOKEN'];
    return token ? token : undefined;
  }
  return process.env[provider.envKey] || undefined;
}

function getBaseUrl(provider: ExternalProvider): string {
  if (provider.name === 'claude-bridge') {
    const url = process.env['CLAUDE_BRIDGE_URL'];
    return url ?? '';
  }
  if (provider.name === 'claude-code') {
    const url = process.env['CLAUDE_CODE_URL'];
    return url ?? '';
  }
  if (provider.name === 'openai-bridge') {
    const url = process.env['OPENAI_BRIDGE_URL'];
    return url ? `${url}/v1` : '';
  }
  if (provider.name === 'chatgpt-bridge') {
    const url = process.env['CHATGPT_BRIDGE_URL'] || process.env['OPENAI_BRIDGE_URL'];
    return url ? `${url}/v1` : '';
  }
  if (provider.name === 'copilot-bridge') {
    const url = process.env['COPILOT_BRIDGE_URL'];
    return url ? `${url}/v1` : '';
  }
  if (provider.name === 'm365-copilot-bridge') {
    const url = process.env['M365_COPILOT_BRIDGE_URL'];
    return url ? `${url}/v1` : '';
  }
  if (provider.name === 'openai-codex') {
    const url = process.env['OPENAI_CODEX_URL'] || process.env['CODEX_BRIDGE_URL'];
    return url ? `${url}/v1` : provider.baseUrl;
  }
  if (provider.name === 'codex') {
    const url = process.env['CODEX_BRIDGE_URL'] || process.env['OPENAI_CODEX_URL'];
    return url ? `${url}/v1` : provider.baseUrl;
  }
  if (provider.name === 'cloudflare') {
    const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
    if (!accountId) return '';
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  }
  return provider.baseUrl;
}

export function getAvailableProviders(): readonly ExternalProvider[] {
  return PROVIDERS.filter((p) => p.enabled && getApiKey(p));
}

/** Returns ALL configured providers (enabled or not, with or without API key). For dashboard listing. */
export function getAllProviders(): readonly ExternalProvider[] {
  return PROVIDERS;
}

function findBestModel(
  provider: ExternalProvider,
  targetTier: 'fast' | 'medium' | 'large' | 'reasoning',
): ExternalModel | undefined {
  // Exact tier match first
  const exact = provider.models.find((m) => m.tier === targetTier);
  if (exact) return exact;

  // Fallback: try higher tiers
  const tierOrder: readonly string[] = ['fast', 'medium', 'large', 'reasoning'];
  const targetIdx = tierOrder.indexOf(targetTier);

  for (let i = targetIdx + 1; i < tierOrder.length; i++) {
    const model = provider.models.find((m) => m.tier === tierOrder[i]);
    if (model) return model;
  }

  // Last resort: any model
  return provider.models[0];
}

// ─── OpenAI-Compatible Client ───────────────────────────────────────

function buildRequestHeaders(provider: ExternalProvider, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const usesAuthlessBridge = AUTHLESS_BRIDGE_PROVIDERS.has(provider.name)
    || (provider.name === 'openai-codex' && !!(process.env['OPENAI_CODEX_URL'] || process.env['CODEX_BRIDGE_URL']))
    || (provider.name === 'codex' && !!(process.env['CODEX_BRIDGE_URL'] || process.env['OPENAI_CODEX_URL']));

  if (!usesAuthlessBridge) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildRequestPayload(model: ExternalModel, request: ExternalCompletionRequest): Record<string, unknown> {
  return {
    model: model.id,
    messages: request.messages,
    temperature: request.temperature ?? 0.3,
    max_tokens: request.max_tokens ?? 2048,
  };
}

function buildGenerateBridgePayload(model: ExternalModel, request: ExternalCompletionRequest): Record<string, unknown> {
  const system = request.messages.find((m) => m.role === 'system')?.content;
  const prompt = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n');

  return {
    model: model.id,
    prompt,
    system,
    temperature: request.temperature ?? 0.3,
    max_tokens: request.max_tokens ?? 2048,
  };
}

function parseExternalResponse(
  data: any,
  model: ExternalModel,
  provider: ExternalProvider,
  start: number,
): ExternalCompletionResponse {
  const content = data.choices?.[0]?.message?.content ?? data.content ?? data.response ?? data.message?.content ?? '';
  recordRequest(provider.name);
  return {
    response: content,
    model: data.model ?? model.id,
    provider: provider.name,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}

async function callProvider(
  provider: ExternalProvider,
  model: ExternalModel,
  request: ExternalCompletionRequest,
  timeoutMs: number,
): Promise<ExternalCompletionResponse> {
  const apiKey = getApiKey(provider);
  if (!apiKey) throw new Error(`No API key for ${provider.name}`);

  const baseUrl = getBaseUrl(provider);
  if (!baseUrl) throw new Error(`No base URL for ${provider.name}`);

  const generateBridge = GENERATE_BRIDGE_PROVIDERS.has(provider.name);
  const url = generateBridge ? `${baseUrl}/api/generate` : `${baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const headers = buildRequestHeaders(provider, apiKey);
    const payload = generateBridge ? buildGenerateBridgePayload(model, request) : buildRequestPayload(model, request);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${provider.name} HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return parseExternalResponse(data, model, provider, start);
  } finally {
    clearTimeout(timer);
  }
}

// ─── External Fallback Chain ────────────────────────────────────────

export async function callExternalFallback(
  request: ExternalCompletionRequest,
  targetTier: 'fast' | 'medium' | 'large' | 'reasoning',
  timeoutMs: number = 30_000,
): Promise<ExternalCompletionResponse> {
  const available = getAvailableProviders();

  if (available.length === 0) {
    throw new Error('No external providers configured (missing API keys)');
  }

  const errors: string[] = [];

  for (const provider of available) {
    if (isRateLimited(provider)) {
      logger.debug({ provider: provider.name }, 'External provider rate-limited, skipping');
      continue;
    }

    const model = findBestModel(provider, targetTier);
    if (!model) continue;

    try {
      logger.info(
        { provider: provider.name, model: model.id, tier: targetTier },
        'Calling external provider fallback',
      );

      const result = await callProvider(provider, model, request, timeoutMs);

      logger.info(
        {
          provider: result.provider,
          model: result.model,
          latencyMs: result.latencyMs,
          tokens: result.inputTokens + result.outputTokens,
        },
        'External provider fallback succeeded',
      );

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${provider.name}: ${msg}`);
      logger.warn({ provider: provider.name, err: msg }, 'External provider failed, trying next');
    }
  }

  throw new Error(`All external providers failed: ${errors.join('; ')}`);
}
