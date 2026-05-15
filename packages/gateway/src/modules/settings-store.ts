/**
 * Settings Store
 *
 * Persists user configuration (which subscriptions they have, which API
 * providers they use, etc.) to a JSON file on disk. Sensitive fields like
 * API keys are stored verbatim but never returned in plaintext from
 * `getPublicSettings()` — only a `hasKey: true/false` flag is exposed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { z } from 'zod';
import { logger } from '../observability/logger.js';

const SettingsSchema = z.object({
  /** How the gateway should pick providers: 'auto' uses all, others restrict the pool. */
  routingMode: z.enum(['auto', 'subscription-only', 'api-only', 'local-only']).default('auto'),
  /** Per-subscription configuration keyed by SubscriptionId. */
  subscriptions: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        autoSpawn: z.boolean().default(true),
        /**
         * Optional remote bridge URL. When set, the gateway will route to this
         * URL instead of trying to spawn a local bridge. Use this when the CLI
         * subscription lives on a different machine than the gateway.
         */
        bridgeUrl: z.string().url().optional().or(z.literal('')),
        notes: z.string().optional(),
      })
    )
    .default({}),
  /** Per-API-provider configuration keyed by provider name (cerebras, groq, …). */
  apiProviders: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(false),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .default({}),
  /** Local Ollama configuration. */
  ollama: z
    .object({
      enabled: z.boolean().default(true),
      baseUrl: z.string().default('http://localhost:11434'),
    })
    .default({ enabled: true, baseUrl: 'http://localhost:11434' }),
  /**
   * Simple Mode — for users who only use 1-2 subscriptions.
   * Hides advanced tabs (providers, races, share, report, memory) and
   * filters wallet/subscriptions to only show enabled providers.
   */
  ui: z
    .object({
      simpleMode: z.boolean().default(true),
      hideEmptyProviders: z.boolean().default(true),
      showTooltips: z.boolean().default(true),
    })
    .default({ simpleMode: true, hideEmptyProviders: true, showTooltips: true }),
  /** ISO timestamp of last update. */
  updatedAt: z.string().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export interface PublicSettings extends Omit<Settings, 'apiProviders'> {
  apiProviders: Record<string, { enabled: boolean; hasKey: boolean; baseUrl?: string; notes?: string }>;
}

const SETTINGS_PATH =
  process.env['SETTINGS_PATH'] ?? join(process.env['HOME'] ?? '/root', '.llm-gateway', 'settings.json');

const DEFAULT_SUBSCRIPTIONS: Settings['subscriptions'] = {
  'claude-code': { enabled: true, autoSpawn: true },
  'github-copilot': { enabled: true, autoSpawn: true },
  'gemini': { enabled: true, autoSpawn: true },
  'codex': { enabled: true, autoSpawn: true },
  'aider': { enabled: true, autoSpawn: true },
};

function getDefaults(): Settings {
  return SettingsSchema.parse({
    routingMode: 'auto',
    subscriptions: DEFAULT_SUBSCRIPTIONS,
    ollama: { enabled: true, baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434' },
  });
}

/**
 * Load settings from disk. Returns defaults when the file does not yet exist
 * or fails to parse.
 */
export function loadSettings(): Settings {
  try {
    if (!existsSync(SETTINGS_PATH)) {
      return getDefaults();
    }
    const raw = readFileSync(SETTINGS_PATH, 'utf-8');
    const parsed = SettingsSchema.parse(JSON.parse(raw));
    return parsed;
  } catch (err) {
    logger.warn({ err, path: SETTINGS_PATH }, 'Failed to load settings — using defaults');
    return getDefaults();
  }
}

/**
 * Persist settings to disk, merging with any existing values to avoid wiping
 * fields the caller didn't include in the patch.
 */
export function saveSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings();
  const merged: Settings = SettingsSchema.parse({
    ...current,
    ...patch,
    subscriptions: { ...current.subscriptions, ...(patch.subscriptions ?? {}) },
    apiProviders: { ...current.apiProviders, ...(patch.apiProviders ?? {}) },
    ollama: { ...current.ollama, ...(patch.ollama ?? {}) },
    ui: { ...current.ui, ...(patch.ui ?? {}) },
    updatedAt: new Date().toISOString(),
  });

  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
    logger.info({ path: SETTINGS_PATH }, 'Settings saved');
  } catch (err) {
    logger.error({ err, path: SETTINGS_PATH }, 'Failed to persist settings');
    throw err;
  }

  // Mirror to env vars so existing provider lookups pick up changes immediately.
  applySettingsToEnv(merged);
  return merged;
}

/**
 * Strip sensitive data (API keys) before sending to the dashboard.
 */
export function getPublicSettings(): PublicSettings {
  const settings = loadSettings();
  const apiProviders: PublicSettings['apiProviders'] = {};
  for (const [name, cfg] of Object.entries(settings.apiProviders)) {
    apiProviders[name] = {
      enabled: cfg.enabled,
      hasKey: !!cfg.apiKey,
      baseUrl: cfg.baseUrl,
      notes: cfg.notes,
    };
  }
  return {
    routingMode: settings.routingMode,
    subscriptions: settings.subscriptions,
    apiProviders,
    ollama: settings.ollama,
    ui: settings.ui,
    updatedAt: settings.updatedAt,
  };
}

/**
 * Apply settings to process.env so that the existing external-providers.ts
 * code transparently picks up user-configured API keys without changes.
 */
export function applySettingsToEnv(settings: Settings = loadSettings()): void {
  const apiEnvMap: Record<string, string> = {
    cerebras: 'CEREBRAS_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    cloudflare: 'CLOUDFLARE_AI_TOKEN',
    'openai-codex': 'OPENAI_API_KEY',
  };
  for (const [name, cfg] of Object.entries(settings.apiProviders)) {
    const envKey = apiEnvMap[name];
    if (envKey && cfg.enabled && cfg.apiKey) {
      process.env[envKey] = cfg.apiKey;
    }
  }
  if (settings.ollama.enabled && settings.ollama.baseUrl) {
    process.env['OLLAMA_BASE_URL'] = settings.ollama.baseUrl;
  }

  // Map subscription IDs to the env var the existing provider lookup uses
  const subEnvMap: Record<string, string> = {
    'claude-code': 'CLAUDE_BRIDGE_URL',
    'github-copilot': 'COPILOT_BRIDGE_URL',
    'microsoft-365-copilot': 'M365_COPILOT_BRIDGE_URL',
    'gemini': 'GEMINI_BRIDGE_URL',
    'codex': 'CODEX_BRIDGE_URL',
    'aider': 'AIDER_BRIDGE_URL',
  };
  for (const [id, cfg] of Object.entries(settings.subscriptions)) {
    const envKey = subEnvMap[id];
    if (envKey && cfg.enabled && cfg.bridgeUrl) {
      process.env[envKey] = cfg.bridgeUrl;
    }
  }
}

export const SettingsPatchSchema = SettingsSchema.partial().extend({
  subscriptions: SettingsSchema.shape.subscriptions.optional(),
  apiProviders: SettingsSchema.shape.apiProviders.optional(),
  ollama: SettingsSchema.shape.ollama.optional(),
  ui: SettingsSchema.shape.ui.optional(),
});
