import { getBreaker, type ModelTier } from '../circuit-breaker/ollama-breaker.js';
import { getOllamaBaseUrl } from './router.js';
import { logger } from '../observability/logger.js';
import { callExternalFallback, getAvailableProviders } from './external-providers.js';

export interface OllamaRequest {
  model: string;
  prompt: string;
  system?: string;
  options?: {
    temperature: number;
    num_predict: number;
  };
  format?: 'json' | '';
  stream: boolean;
}

export interface OllamaResponse {
  response: string;
  done: boolean;
  total_duration: number;
  eval_count: number;
  prompt_eval_count: number;
  model: string;
}

const TIMEOUT_BY_TIER: Record<ModelTier, number> = {
  fast: 10_000,
  medium: 30_000,
  large: 120_000,
};

async function fetchOllama(req: OllamaRequest, timeoutMs: number): Promise<OllamaResponse> {
  const baseUrl = getOllamaBaseUrl();
  const url = `${baseUrl}/api/generate`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${body}`);
    }

    const data = await response.json() as OllamaResponse;
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === 'AbortError' ||
      err.message.includes('timeout') ||
      err.message.includes('abort') ||
      err.message.includes('ETIMEDOUT')
    );
  }
  return false;
}

async function tryModelWithRetries(
  modelReq: OllamaRequest,
  tier: ModelTier,
  timeoutMs: number,
): Promise<OllamaResponse | null> {
  const breaker = getBreaker(
    modelReq.model,
    tier,
    (r: OllamaRequest) => fetchOllama(r, timeoutMs),
  );
  const MAX_RETRIES = 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        logger.info({ model: modelReq.model, attempt }, 'Retrying Ollama call after timeout');
      }
      const result = await breaker.fire(modelReq);
      if (attempt > 0) {
        logger.info({ model: modelReq.model, attempt }, 'Ollama retry succeeded');
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTimeoutError(err)) {
        logger.error({ err, model: modelReq.model }, 'Ollama non-timeout error, skipping retry');
        break;
      }
      if (attempt < MAX_RETRIES - 1) {
        logger.warn({ model: modelReq.model, attempt }, 'Ollama timeout, retrying');
      }
    }
  }
  void lastErr;
  return null;
}

async function tryExternalFallback(
  req: OllamaRequest,
  tier: ModelTier,
): Promise<OllamaResponse> {
  const tierMap: Record<ModelTier, 'fast' | 'medium' | 'large' | 'reasoning'> = {
    fast: 'fast',
    medium: 'medium',
    large: 'large',
  };
  const externalResult = await callExternalFallback(
    {
      model: req.model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt },
      ],
      temperature: req.options?.temperature,
      max_tokens: req.options?.num_predict,
    },
    tierMap[tier] ?? 'medium',
  );
  return {
    response: externalResult.response,
    done: true,
    total_duration: externalResult.latencyMs * 1_000_000,
    eval_count: externalResult.outputTokens,
    prompt_eval_count: externalResult.inputTokens,
    model: `${externalResult.provider}/${externalResult.model}`,
  };
}

export async function callOllama(
  req: OllamaRequest,
  tier: ModelTier = 'medium',
  fallbackModels: string[] = [],
): Promise<OllamaResponse> {
  const timeoutMs = TIMEOUT_BY_TIER[tier];
  const allModels = [req.model, ...fallbackModels.filter((m) => m !== req.model)];

  for (const model of allModels) {
    const modelReq = { ...req, model };
    const result = await tryModelWithRetries(modelReq, tier, timeoutMs);
    if (result) return result;
    const nextModel = allModels[allModels.indexOf(model) + 1];
    logger.warn({ model, fallback: nextModel }, 'Ollama model failed, trying fallback');
  }

  if (getAvailableProviders().length > 0) {
    logger.warn({ models: allModels }, 'All Ollama models failed, trying external providers');
    try {
      return await tryExternalFallback(req, tier);
    } catch (extErr) {
      logger.error({ err: extErr }, 'External provider fallback also failed');
    }
  }

  throw new Error(`All models failed (Ollama + external): ${allModels.join(', ')}`);
}

export async function callOllamaWithFallbackChain(
  req: OllamaRequest,
  fallbackChain: string[],
  tier: ModelTier,
): Promise<OllamaResponse> {
  const fallbacks = fallbackChain.filter((m) => m !== req.model);
  return callOllama(req, tier, fallbacks);
}

/**
 * Route to external provider (e.g. OpenAI Codex) as primary.
 * Falls back to Ollama if external provider fails.
 */
export async function callExternalProviderPrimary(
  req: OllamaRequest,
  provider: string,
  tier: ModelTier,
  fallbackChain: string[] = [],
): Promise<OllamaResponse> {
  const tierMap: Record<ModelTier, 'fast' | 'medium' | 'large'> = {
    fast: 'fast',
    medium: 'medium',
    large: 'large',
  };

  const mappedTier = tierMap[tier];
  if (!mappedTier) {
    logger.warn({ tier, provider }, 'Unknown tier for external provider, falling back to Ollama');
    return callOllama(req, tier, fallbackChain);
  }

  try {
    logger.info({ provider, model: req.model }, 'Calling external provider as primary');
    const externalResult = await callExternalFallback(
      {
        model: req.model,
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          { role: 'user', content: req.prompt },
        ],
        temperature: req.options?.temperature,
        max_tokens: req.options?.num_predict,
      },
      mappedTier,
    );

    return {
      response: externalResult.response,
      done: true,
      total_duration: externalResult.latencyMs * 1_000_000,
      eval_count: externalResult.outputTokens,
      prompt_eval_count: externalResult.inputTokens,
      model: `${externalResult.provider}/${externalResult.model}`,
    };
  } catch (err) {
    logger.warn({ err, provider }, 'External provider failed, falling back to Ollama');
    // Fall back to Ollama if external provider fails
    return callOllama(req, tier, fallbackChain);
  }
}
