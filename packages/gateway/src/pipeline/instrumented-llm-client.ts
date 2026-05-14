import {
  callOllama,
  callOllamaWithFallbackChain,
  callExternalProviderPrimary,
  type OllamaRequest,
  type OllamaResponse,
} from './llm-client.js';
import { trackFallbackChain } from '../observability/routing-instrumentation.js';
import { logger } from '../observability/logger.js';
import type { ModelTier } from '../circuit-breaker/ollama-breaker.js';

export interface InstrumentedOllamaRequest extends OllamaRequest {
  callId?: string;
  taskType?: string;
}

/**
 * Wraps callOllama to track fallback chain execution
 */
export async function callOllamaInstrumented(
  req: InstrumentedOllamaRequest,
  tier: ModelTier = 'medium',
  fallbackModels: string[] = [],
  callId?: string,
  taskType?: string,
): Promise<OllamaResponse> {
  const startMs = Date.now();
  const actualCallId = callId ?? req.callId;
  const actualTaskType = taskType ?? req.taskType ?? 'unknown';

  try {
    // Call the standard ollama function
    const response = await callOllama(req, tier, fallbackModels);

    // Only track if we have call metadata
    if (actualCallId) {
      void trackFallbackChain(actualCallId, actualTaskType, req.model, fallbackModels, [
        {
          model: response.model,
          response,
          latencyMs: Date.now() - startMs,
        },
      ]);
    }

    return response;
  } catch (err) {
    logger.error({ err, callId: actualCallId, model: req.model }, 'Instrumented Ollama call failed');
    throw err;
  }
}

/**
 * Wraps callOllamaWithFallbackChain to track fallback chain execution
 */
export async function callOllamaWithFallbackChainInstrumented(
  req: InstrumentedOllamaRequest,
  fallbackChain: string[],
  tier: ModelTier,
  callId?: string,
  taskType?: string,
): Promise<OllamaResponse> {
  const startMs = Date.now();
  const actualCallId = callId ?? req.callId;
  const actualTaskType = taskType ?? req.taskType ?? 'unknown';

  try {
    const response = await callOllamaWithFallbackChain(req, fallbackChain, tier);

    // Track the successful fallback execution
    if (actualCallId) {
      void trackFallbackChain(actualCallId, actualTaskType, req.model, fallbackChain, [
        {
          model: response.model,
          response,
          latencyMs: Date.now() - startMs,
        },
      ]);
    }

    return response;
  } catch (err) {
    logger.error(
      { err, callId: actualCallId, model: req.model, fallbackChain },
      'Instrumented fallback chain failed',
    );
    throw err;
  }
}

/**
 * Wraps callExternalProviderPrimary to track external provider usage
 */
export async function callExternalProviderPrimaryInstrumented(
  req: InstrumentedOllamaRequest,
  provider: string,
  tier: ModelTier,
  fallbackChain: string[] = [],
  callId?: string,
  taskType?: string,
): Promise<OllamaResponse> {
  const startMs = Date.now();
  const actualCallId = callId ?? req.callId;
  const actualTaskType = taskType ?? req.taskType ?? 'unknown';

  try {
    const response = await callExternalProviderPrimary(req, provider, tier, fallbackChain);

    // Track external provider usage
    if (actualCallId) {
      void trackFallbackChain(actualCallId, actualTaskType, provider, fallbackChain, [
        {
          model: response.model,
          response,
          latencyMs: Date.now() - startMs,
        },
      ]);
    }

    return response;
  } catch (err) {
    logger.error({ err, callId: actualCallId, provider }, 'Instrumented external provider failed');
    throw err;
  }
}
