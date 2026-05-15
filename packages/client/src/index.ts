/**
 * @adaptive-llm-gateway/client
 *
 * TypeScript client library for the Adaptive LLM Gateway.
 *
 * Usage:
 *   import { LLMGatewayClient, createInteractiveClient } from '@adaptive-llm-gateway/client';
 *   const client = createInteractiveClient('my-app');
 *   const result = await client.completion({ task_type: 'summarize', input: '...' });
 */

// ============================================================
// Request / Response types
// ============================================================

export interface CompletionRequest {
  /** Identifies which project/service is calling (e.g. 'my-scraper', 'my-app') */
  caller: string;
  /** Task type that maps to a prompt template (e.g. 'summarize', 'classify', 'translate') */
  task_type: string;
  /** The raw input text to process */
  input: string;
  /** Preferred output language */
  language?: 'de' | 'en';
  /** Additional context passed to the prompt template */
  context?: Record<string, unknown>;
  /** Per-request model / behavior overrides */
  options?: {
    /** Override the model (e.g. 'qwen2.5:32b'). Gateway picks a sensible default. */
    model?: string;
    /** Sampling temperature 0–1 */
    temperature?: number;
    /** Max output tokens */
    max_tokens?: number;
    /** Include full validation details in the response */
    return_validation_details?: boolean;
  };
}

export interface CompletionResponse {
  /** Request ID for tracing */
  id: string;
  /** Overall status of the response */
  status: 'approved' | 'warning' | 'pending_review' | 'rejected';
  /** Model confidence score 0–10 */
  confidence: number;
  /** Ollama model that produced the output */
  model: string;
  /** Task type that was processed */
  task_type: string;
  /** End-to-end latency in milliseconds */
  latency_ms: number;
  /** Token usage */
  tokens: { in: number; out: number };
  /** The LLM output text */
  output: string;
  /** Validation details (present when return_validation_details=true) */
  validation?: {
    passed: boolean;
    score: number;
    validators: Record<string, unknown>;
  };
}

export interface ClassifyResponse {
  task_type: string;
  content_type: string;
  language: string;
  complexity: 'low' | 'medium' | 'high';
  requires_facts: boolean;
  suggested_task_types: string[];
}

export interface BatchResponse {
  batch_id: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  ollama: unknown;
  queue: unknown;
}

// ============================================================
// Gateway client
// ============================================================

export class LLMGatewayClient {
  private readonly baseUrl: string;
  private readonly ollamaUrl: string;
  private readonly caller: string;
  private readonly timeout: number;
  private gatewayHealthy = true;
  private healthCheckCooldown = 0;

  constructor(config: {
    baseUrl?: string;
    ollamaUrl?: string;
    caller: string;
    /** Request timeout in ms (default: 30 000) */
    timeout?: number;
  }) {
    this.baseUrl = config.baseUrl
      ?? process.env['LLM_GATEWAY_URL']
      ?? 'http://localhost:0000';
    this.ollamaUrl = config.ollamaUrl
      ?? process.env['OLLAMA_URL']
      ?? 'http://localhost:11434';
    this.caller = config.caller;
    this.timeout = config.timeout ?? 30_000;
  }

  // ----------------------------------------------------------
  // Core: completion with offline fallback
  // ----------------------------------------------------------

  async completion(
    params: Omit<CompletionRequest, 'caller'>,
  ): Promise<CompletionResponse> {
    const body: CompletionRequest = { ...params, caller: this.caller };

    // If Gateway was recently healthy, try it first
    if (this.gatewayHealthy && Date.now() > this.healthCheckCooldown) {
      try {
        return await this.post<CompletionResponse>('/v1/completion', body);
      } catch (err) {
        console.warn('[LLMGateway] Gateway completion failed, falling back to Ollama', err);
        this.gatewayHealthy = false;
        this.healthCheckCooldown = Date.now() + 30_000; // retry in 30s
        // Fall through to Ollama fallback
      }
    }

    // Gateway is down or recently failed — use local Ollama
    return this.ollamaCompletion(body);
  }

  private async ollamaCompletion(
    body: CompletionRequest,
  ): Promise<CompletionResponse> {
    const model = body.options?.model ?? 'qwen2.5:14b';
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const startMs = Date.now();
        const res = await this.fetchWithTimeout(`${this.ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: body.input,
            stream: false,
            temperature: body.options?.temperature ?? 0.7,
            num_predict: body.options?.max_tokens ?? 1024,
          }),
        });

        if (!res.ok) {
          throw new Error(`Ollama error ${res.status}`);
        }

        const data = await res.json() as Record<string, unknown>;
        const latencyMs = Date.now() - startMs;

        return {
          id: `ollama-${Date.now()}`,
          status: 'approved',
          confidence: 7,
          model,
          task_type: body.task_type,
          latency_ms: latencyMs,
          tokens: {
            in: (data.prompt_eval_count as number) ?? 0,
            out: (data.eval_count as number) ?? 0,
          },
          output: (data.response as string) ?? '',
        };
      } catch (err) {
        if (attempt < maxRetries - 1) {
          const backoffMs = Math.pow(2, attempt) * 500;
          console.warn(`[Ollama] Attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`, err);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        } else {
          console.error('[Ollama] All retry attempts exhausted', err);
          throw new Error('Both Gateway and Ollama unavailable');
        }
      }
    }

    throw new Error('Ollama completion failed after retries');
  }

  // ----------------------------------------------------------
  // Classify input before routing
  // ----------------------------------------------------------

  async classify(input: string): Promise<ClassifyResponse> {
    return this.post<ClassifyResponse>('/v1/classify', {
      caller: this.caller,
      input,
    });
  }

  // ----------------------------------------------------------
  // Batch: submit multiple tasks, results delivered via webhook
  // ----------------------------------------------------------

  async batch(
    tasks: Array<Omit<CompletionRequest, 'caller'>>,
    webhookUrl: string,
  ): Promise<BatchResponse> {
    return this.post<BatchResponse>('/v1/batch', {
      caller: this.caller,
      tasks,
      webhook_url: webhookUrl,
    });
  }

  // ----------------------------------------------------------
  // Health & status
  // ----------------------------------------------------------

  async health(): Promise<HealthResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }
    const data = await res.json() as HealthResponse;
    this.gatewayHealthy = data.status === 'ok';
    return data;
  }

  getStatus(): { gateway: boolean; ollama: string; mode: 'gateway' | 'fallback' } {
    return {
      gateway: this.gatewayHealthy,
      ollama: this.ollamaUrl,
      mode: this.gatewayHealthy ? 'gateway' : 'fallback',
    };
  }

  // ----------------------------------------------------------
  // Graceful degradation — returns null when gateway is unavailable
  // ----------------------------------------------------------

  async safeCompletion(
    params: Omit<CompletionRequest, 'caller'>,
  ): Promise<CompletionResponse | null> {
    try {
      return await this.completion(params);
    } catch {
      // Gateway is down or timed out — caller handles degraded mode
      return null;
    }
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gateway error ${res.status} on ${path}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  private fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    return fetch(url, { ...init, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
  }
}

// ============================================================
// Project-specific pre-configured factory functions
// ============================================================
// Convenience factories with sensible default timeouts.
// Pick the one that matches your latency budget, or instantiate
// LLMGatewayClient directly with your own caller name + timeout.
// ============================================================

/**
 * For interactive UIs / chat: short timeout, fast feedback loop.
 */
export function createInteractiveClient(caller: string, baseUrl?: string): LLMGatewayClient {
  return new LLMGatewayClient({ caller, baseUrl, timeout: 10_000 });
}

/**
 * For background jobs / batch processing: long timeout, completion priority.
 */
export function createBatchClient(caller: string, baseUrl?: string): LLMGatewayClient {
  return new LLMGatewayClient({ caller, baseUrl, timeout: 60_000 });
}

/**
 * For real-time monitoring / health checks: tight latency budget.
 */
export function createRealtimeClient(caller: string, baseUrl?: string): LLMGatewayClient {
  return new LLMGatewayClient({ caller, baseUrl, timeout: 5_000 });
}
