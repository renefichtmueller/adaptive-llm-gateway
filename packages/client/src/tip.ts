/**
 * TIP client — the agent-integration entry point of @llm-gateway/client.
 *
 * TIP is the agent/tool integration protocol described in ADR-0005
 * (docs/adr/0005-agent-integration-protocol.md). Every agent adapter
 * (Claude Code bridge, Codex LSP adapter, ChatGPT API adapter, …) talks to
 * the gateway through this client instead of wiring up HTTP calls itself.
 *
 * Compared to the task-oriented `LLMGatewayClient`, the TIP client is
 * prompt-oriented: agents send a ready-made prompt plus options and get a
 * normalized result back, including whether the local Ollama fallback served
 * the request and a confidence score normalized to 0–1.
 *
 * Usage (ADR-0005 style):
 *   import { createTIPClient } from '@llm-gateway/client';
 *   const client = createTIPClient({ agentId: 'claude-code' });
 *   const result = await client.completion('Explain this code: …');
 *
 * Legacy signature (pre-2G project clients) is still accepted:
 *   const client = createTIPClient('http://localhost:8787');
 */

import { LLMGatewayClient, type CompletionResponse } from './core.js';

// ============================================================
// Types
// ============================================================

export interface TIPClientConfig {
  /** Identifies the agent to the gateway (metrics, rate limits, learning). */
  agentId?: string;
  /** Gateway base URL. Falls back to LLM_GATEWAY_URL / GATEWAY_URL env vars. */
  gatewayUrl?: string;
  /** Local Ollama URL used when the gateway is unreachable. */
  ollamaUrl?: string;
  /** Request timeout in ms (default: 30 000). */
  timeout?: number;
  /** ADR-0005 fallback block; `ollamaUrl` wins over `fallback.ollamaUrl`. */
  fallback?: {
    ollamaUrl?: string;
  };
}

export interface TIPCompletionOptions {
  /** Gateway task type; defaults to 'agent_completion' (gateway may re-classify). */
  taskType?: string;
  /** Model override (e.g. 'qwen2.5:32b'). */
  model?: string;
  /** Sampling temperature 0–1. */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /** Arbitrary agent metadata, forwarded as prompt context. */
  metadata?: Record<string, unknown>;
}

export interface TIPCompletionResult {
  /** The generated text. */
  text: string;
  /** Model that produced the output. */
  model: string;
  /** Token usage. */
  tokens: { input: number; output: number };
  /** Confidence normalized to 0–1 (gateway reports 0–10). */
  confidence: number;
  /** True when the local Ollama fallback served this request. */
  fallback: boolean;
  /** End-to-end latency in ms. */
  latencyMs: number;
  /** Request ID for tracing. */
  requestId: string;
  /** Gateway confidence-gate status. */
  status: CompletionResponse['status'];
}

export interface TIPStatus {
  /** Whether the gateway responded to the most recent request/health check. */
  gateway: boolean;
  /** Configured Ollama fallback URL. */
  ollama: string;
  /** Which path requests currently take. */
  mode: 'gateway' | 'fallback';
}

export interface TIPHealth {
  healthy: boolean;
  gateway: boolean;
  ollama: string;
  mode: 'gateway' | 'fallback' | 'offline';
}

// ============================================================
// Implementation
// ============================================================

const DEFAULT_AGENT_ID = 'tip';
const DEFAULT_TASK_TYPE = 'agent_completion';

/** Prepend http:// when an URL is given without a scheme ('localhost:11434'). */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

export class TIPClient {
  readonly agentId: string;
  private readonly inner: LLMGatewayClient;
  private readonly ollamaUrl: string;
  private readonly timeout: number;

  constructor(config: TIPClientConfig = {}) {
    this.agentId = config.agentId ?? DEFAULT_AGENT_ID;
    const gatewayUrl = config.gatewayUrl
      ?? process.env['LLM_GATEWAY_URL']
      ?? process.env['GATEWAY_URL'];
    this.ollamaUrl = withScheme(
      config.ollamaUrl
        ?? config.fallback?.ollamaUrl
        ?? process.env['OLLAMA_URL']
        ?? 'http://localhost:11434',
    );
    this.timeout = config.timeout ?? 30_000;
    this.inner = new LLMGatewayClient({
      caller: this.agentId,
      ollamaUrl: this.ollamaUrl,
      timeout: this.timeout,
      ...(gatewayUrl ? { baseUrl: withScheme(gatewayUrl) } : {}),
    });
  }

  /**
   * Prompt-oriented completion. Tries the gateway first and transparently
   * falls back to local Ollama; `result.fallback` tells which path served.
   */
  async completion(
    prompt: string,
    options: TIPCompletionOptions = {},
  ): Promise<TIPCompletionResult> {
    const response = await this.inner.completion({
      task_type: options.taskType ?? DEFAULT_TASK_TYPE,
      input: prompt,
      ...(options.metadata ? { context: options.metadata } : {}),
      options: {
        ...(options.model ? { model: options.model } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      },
    });

    return {
      text: response.output,
      model: response.model,
      tokens: { input: response.tokens.in, output: response.tokens.out },
      confidence: Math.min(1, Math.max(0, response.confidence / 10)),
      // Fallback responses are synthesized client-side with an 'ollama-' ID.
      fallback: response.id.startsWith('ollama-'),
      latencyMs: response.latency_ms,
      requestId: response.id,
      status: response.status,
    };
  }

  /** Snapshot of the current routing state (no network call). */
  getStatus(): TIPStatus {
    const status = this.inner.getStatus();
    return {
      gateway: status.gateway,
      ollama: status.ollama,
      mode: status.mode,
    };
  }

  /**
   * Active health probe: asks the gateway first; when it is unreachable,
   * checks whether the Ollama fallback answers.
   */
  async health(): Promise<TIPHealth> {
    try {
      const health = await this.inner.health();
      if (health.status !== 'down') {
        return { healthy: true, gateway: true, ollama: this.ollamaUrl, mode: 'gateway' };
      }
      // Gateway reachable but reports itself down — probe the fallback.
    } catch {
      // Gateway unreachable — probe the fallback.
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      const res = await fetch(`${this.ollamaUrl}/api/tags`, { signal: controller.signal })
        .finally(() => clearTimeout(timer));
      if (res.ok) {
        return { healthy: true, gateway: false, ollama: this.ollamaUrl, mode: 'fallback' };
      }
    } catch {
      // Ollama unreachable as well.
    }

    return { healthy: false, gateway: false, ollama: 'offline', mode: 'offline' };
  }
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a TIP client for an agent integration (ADR-0005).
 *
 * Accepts either a full config object or — for backwards compatibility with
 * the pre-2G project clients — a plain gateway URL string.
 */
export function createTIPClient(config?: TIPClientConfig): TIPClient;
export function createTIPClient(gatewayUrl: string, agentId?: string): TIPClient;
export function createTIPClient(
  configOrUrl: TIPClientConfig | string = {},
  agentId?: string,
): TIPClient {
  if (typeof configOrUrl === 'string') {
    return new TIPClient({
      gatewayUrl: configOrUrl,
      ...(agentId ? { agentId } : {}),
    });
  }
  return new TIPClient(configOrUrl);
}
