/**
 * Auto-Discovery — full system scan for available LLM sources.
 *
 * Probes everything the gateway can route to:
 *   1. CLI subscriptions (Claude Code, ChatGPT, Codex, Copilot, M365, Gemini, Aider)
 *      → delegates to subscription-discovery.ts + bridge-spawner.ts
 *   2. Local LLM servers (Ollama, LM Studio, llamafile, vLLM)
 *      → HTTP probes against well-known ports
 *   3. API-key providers (Cerebras, Groq, Mistral, NVIDIA, Cloudflare AI, OpenAI, Anthropic)
 *      → env-var presence + cheap auth-ping where possible
 *
 * Returns a unified DiscoveryReport that the dashboard renders and the
 * gateway uses for auto-routing decisions.
 */
import { logger } from '../observability/logger.js';
import {
  discoverSubscriptions,
  type SubscriptionStatus,
} from './subscription-discovery.js';
import {
  getRunningBridges,
  spawnDetectedBridges,
} from './bridge-spawner.js';

// ─── Type definitions ────────────────────────────────────────────────────────

export interface LocalLLMServer {
  id: 'ollama' | 'lmstudio' | 'llamafile' | 'vllm';
  label: string;
  url: string;
  detected: boolean;
  models: ReadonlyArray<{ id: string; size?: number; family?: string }>;
  latencyMs: number | null;
  error?: string;
}

export interface ApiKeyProvider {
  id: string;
  label: string;
  envKey: string;
  configured: boolean;
  authPingOk: boolean | 'untested';
  modelsExpected: ReadonlyArray<string>;
}

export interface DiscoveryReport {
  generatedAt: string;
  host: string;
  subscriptions: {
    detected: number;
    authenticated: number;
    bridgesRunning: number;
    items: SubscriptionStatus[];
  };
  localLLMs: {
    detected: number;
    items: LocalLLMServer[];
  };
  apiKeys: {
    configured: number;
    items: ApiKeyProvider[];
  };
  summary: {
    totalProviders: number;
    totalRoutableModels: number;
  };
}

// ─── Local LLM servers ───────────────────────────────────────────────────────

const LOCAL_LLM_PROBES: ReadonlyArray<{
  id: LocalLLMServer['id'];
  label: string;
  defaultUrl: string;
  modelsPath: string;
  envKeys: ReadonlyArray<string>;
}> = [
  {
    id: 'ollama',
    label: 'Ollama (local models)',
    defaultUrl: 'http://localhost:11434',
    modelsPath: '/api/tags',
    envKeys: ['OLLAMA_URL', 'OLLAMA_BASE_URL'],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    defaultUrl: 'http://localhost:1234',
    modelsPath: '/v1/models',
    envKeys: ['LMSTUDIO_URL'],
  },
  {
    id: 'llamafile',
    label: 'llamafile',
    defaultUrl: 'http://localhost:8080',
    modelsPath: '/v1/models',
    envKeys: ['LLAMAFILE_URL'],
  },
  {
    id: 'vllm',
    label: 'vLLM',
    defaultUrl: 'http://localhost:8000',
    modelsPath: '/v1/models',
    envKeys: ['VLLM_URL'],
  },
];

function resolveLocalLLMUrl(probe: (typeof LOCAL_LLM_PROBES)[number]): string {
  for (const key of probe.envKeys) {
    const v = process.env[key];
    if (v && v.length > 0) return v.replace(/\/$/, '');
  }
  return probe.defaultUrl;
}

async function probeLocalLLM(
  probe: (typeof LOCAL_LLM_PROBES)[number],
): Promise<LocalLLMServer> {
  const url = resolveLocalLLMUrl(probe);
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${url}${probe.modelsPath}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return {
        id: probe.id,
        label: probe.label,
        url,
        detected: false,
        models: [],
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as Record<string, unknown>;
    // Ollama: { models: [{ name, size, details: { family } }] }
    // OpenAI-compat: { data: [{ id }] }
    const list = Array.isArray(data.models)
      ? (data.models as Array<Record<string, unknown>>).map((m) => ({
          id: String(m.name ?? m.id ?? '?'),
          size: typeof m.size === 'number' ? (m.size as number) : undefined,
          family: (m.details as Record<string, unknown> | undefined)?.family as
            | string
            | undefined,
        }))
      : Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data: Array<Record<string, unknown>> }).data).map((m) => ({
          id: String(m.id ?? '?'),
        }))
      : [];
    return {
      id: probe.id,
      label: probe.label,
      url,
      detected: true,
      models: list,
      latencyMs,
    };
  } catch (err) {
    return {
      id: probe.id,
      label: probe.label,
      url,
      detected: false,
      models: [],
      latencyMs: null,
      error: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function discoverLocalLLMs(): Promise<LocalLLMServer[]> {
  return Promise.all(LOCAL_LLM_PROBES.map(probeLocalLLM));
}

// ─── API-key providers ───────────────────────────────────────────────────────

const API_KEY_PROVIDERS: ReadonlyArray<Omit<ApiKeyProvider, 'configured' | 'authPingOk'>> = [
  // ─── Free-tier providers ─────────────────────────────────────────────────
  { id: 'cerebras', label: 'Cerebras (free tier)', envKey: 'CEREBRAS_API_KEY', modelsExpected: ['llama-3.3-70b', 'qwen-3-32b'] },
  { id: 'groq', label: 'Groq (free tier)', envKey: 'GROQ_API_KEY', modelsExpected: ['llama-3.3-70b-versatile', 'mixtral-8x7b'] },
  { id: 'mistral', label: 'Mistral AI', envKey: 'MISTRAL_API_KEY', modelsExpected: ['mistral-large-latest', 'mistral-small'] },
  { id: 'nvidia', label: 'NVIDIA NIM', envKey: 'NVIDIA_API_KEY', modelsExpected: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.3-nemotron-super-49b'] },
  { id: 'cloudflare', label: 'Cloudflare Workers AI', envKey: 'CLOUDFLARE_AI_TOKEN', modelsExpected: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'] },

  // ─── Hosted inference platforms ──────────────────────────────────────────
  { id: 'together', label: 'Together AI', envKey: 'TOGETHER_API_KEY', modelsExpected: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'] },
  { id: 'fireworks', label: 'Fireworks AI', envKey: 'FIREWORKS_API_KEY', modelsExpected: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen2p5-72b-instruct'] },
  { id: 'deepseek', label: 'DeepSeek API', envKey: 'DEEPSEEK_API_KEY', modelsExpected: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'anyscale', label: 'Anyscale Endpoints', envKey: 'ANYSCALE_API_KEY', modelsExpected: ['meta-llama/Meta-Llama-3-70B-Instruct'] },
  { id: 'replicate', label: 'Replicate', envKey: 'REPLICATE_API_TOKEN', modelsExpected: ['meta/llama-3-70b-instruct', 'mistralai/mixtral-8x22b-instruct-v0.1'] },
  { id: 'perplexity', label: 'Perplexity AI', envKey: 'PERPLEXITY_API_KEY', modelsExpected: ['sonar-pro', 'sonar', 'sonar-reasoning'] },
  { id: 'xai', label: 'xAI Grok', envKey: 'XAI_API_KEY', modelsExpected: ['grok-2-latest', 'grok-2-mini'] },

  // ─── Frontier API providers ──────────────────────────────────────────────
  { id: 'openai', label: 'OpenAI API', envKey: 'OPENAI_API_KEY', modelsExpected: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'anthropic', label: 'Anthropic API', envKey: 'ANTHROPIC_API_KEY', modelsExpected: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  { id: 'google', label: 'Google Gemini API', envKey: 'GOOGLE_API_KEY', modelsExpected: ['gemini-2.0-flash', 'gemini-2.0-pro'] },

  // ─── Search / auxiliary ─────────────────────────────────────────────────
  { id: 'brave', label: 'Brave Search API', envKey: 'BRAVE_API_KEY', modelsExpected: [] },
];

function discoverApiKeys(): ApiKeyProvider[] {
  return API_KEY_PROVIDERS.map((p) => ({
    ...p,
    configured: Boolean(process.env[p.envKey]),
    authPingOk: 'untested',
  }));
}

// ─── Full discovery report ────────────────────────────────────────────────────

/**
 * Run the complete discovery sweep. Pure read-only — does NOT spawn bridges.
 * Use `runDiscoveryAndSpawn()` to also start any detected CLI bridges.
 */
export async function runDiscovery(): Promise<DiscoveryReport> {
  logger.info('Starting full system auto-discovery');
  const [subs, locals] = await Promise.all([
    discoverSubscriptions(),
    discoverLocalLLMs(),
  ]);
  const running = getRunningBridges();
  const apiKeys = discoverApiKeys();

  const totalRoutableModels =
    subs.reduce((acc, s) => acc + (s.installed ? s.descriptor.models.length : 0), 0) +
    locals.reduce((acc, l) => acc + l.models.length, 0) +
    apiKeys.reduce((acc, k) => acc + (k.configured ? k.modelsExpected.length : 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    host: process.env.HOSTNAME ?? 'unknown',
    subscriptions: {
      detected: subs.filter((s) => s.installed).length,
      authenticated: subs.filter((s) => s.installed && s.authenticated === true).length,
      bridgesRunning: running.length,
      items: subs,
    },
    localLLMs: {
      detected: locals.filter((l) => l.detected).length,
      items: locals,
    },
    apiKeys: {
      configured: apiKeys.filter((k) => k.configured).length,
      items: apiKeys,
    },
    summary: {
      totalProviders:
        subs.filter((s) => s.installed).length +
        locals.filter((l) => l.detected).length +
        apiKeys.filter((k) => k.configured).length,
      totalRoutableModels,
    },
  };
}

/**
 * Run discovery AND spawn any CLI bridges that are detected but not yet running.
 * Returns the discovery report plus the spawned bridges.
 */
export async function runDiscoveryAndSpawn(): Promise<{
  report: DiscoveryReport;
  spawned: ReadonlyArray<{ id: string; url: string; port: number }>;
}> {
  const report = await runDiscovery();
  const spawned = await spawnDetectedBridges(report.subscriptions.items);
  return {
    report,
    spawned: spawned.map((b) => ({
      id: b.descriptor.id,
      url: b.url,
      port: b.port,
    })),
  };
}

/**
 * Optional boot-time hook. Wired from server.ts if env AUTO_SPAWN_BRIDGES=1.
 */
export async function autoSpawnOnBoot(): Promise<void> {
  if (process.env['AUTO_SPAWN_BRIDGES'] !== '1') {
    logger.info('AUTO_SPAWN_BRIDGES not set — skipping boot-time bridge spawn');
    return;
  }
  try {
    const result = await runDiscoveryAndSpawn();
    logger.info(
      {
        providers: result.report.summary.totalProviders,
        bridgesSpawned: result.spawned.length,
      },
      'Auto-spawn completed at boot',
    );
  } catch (err) {
    logger.error({ err }, 'Auto-spawn at boot failed (non-fatal)');
  }
}
