/**
 * Workspace Presets
 *
 * One YAML file describes the full gateway configuration for a team or
 * project. Versioning in git, easy onboarding, transparent setup audit.
 *
 * Lives at: `workspace.yaml` in the project root (configurable via env
 * WORKSPACE_FILE).
 *
 * Schema:
 *   name: string
 *   description: string
 *   defaults:
 *     model_tier: fast | medium | large | reasoning
 *     compression_mode: off | auto | aggressive
 *     injection_defense: off | warn | block | llm_judge
 *     pii_redaction: off | cloud_only | always
 *     output_defense: off | tag | cut
 *   routing_overrides:
 *     <task_type>:
 *       model: <model_id>
 *       tier: ...
 *       prompt_template: ...
 *   callers:
 *     <caller_id>:
 *       rate_limit_per_minute: int
 *       allowed_task_types: [string]
 *       compression_mode: off | auto | aggressive
 *   providers_enabled: [string]   # whitelist of provider IDs (auto-discovery still finds others, but they're inactive)
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../observability/logger.js';

// Minimal embedded YAML parser usage — we use the `yaml` package which
// the gateway already depends on via routing-rules.yaml loading. If
// importing here proves circular, swap for a small inline parser.
// We do the lazy import to avoid a hard dep when WORKSPACE_FILE is unset.

export interface WorkspacePreset {
  name: string;
  description?: string;
  defaults?: {
    model_tier?: 'fast' | 'medium' | 'large' | 'reasoning';
    compression_mode?: 'off' | 'auto' | 'aggressive';
    injection_defense?: 'off' | 'warn' | 'block' | 'llm_judge';
    pii_redaction?: 'off' | 'cloud_only' | 'always';
    output_defense?: 'off' | 'tag' | 'cut';
    semantic_cache?: boolean;
  };
  routing_overrides?: Record<string, { model?: string; tier?: string; prompt_template?: string }>;
  callers?: Record<string, {
    rate_limit_per_minute?: number;
    allowed_task_types?: string[];
    compression_mode?: 'off' | 'auto' | 'aggressive';
  }>;
  providers_enabled?: string[];
}

let cached: WorkspacePreset | null = null;
let loadedAt = 0;

function getPath(): string {
  const f = process.env['WORKSPACE_FILE'] ?? 'workspace.yaml';
  return resolve(f);
}

/**
 * Load + parse `workspace.yaml`. Returns null when the file is absent
 * (legitimate — workspace presets are optional).
 */
export async function loadWorkspacePreset(force = false): Promise<WorkspacePreset | null> {
  const path = getPath();
  if (!existsSync(path)) return null;
  if (!force && cached && Date.now() - loadedAt < 60_000) return cached;

  try {
    const yaml = await import('yaml');
    const raw = readFileSync(path, 'utf-8');
    const parsed = yaml.parse(raw) as WorkspacePreset;
    cached = parsed;
    loadedAt = Date.now();
    logger.info({ path, name: parsed?.name }, 'Workspace preset loaded');
    return parsed;
  } catch (err) {
    logger.warn({ err, path }, 'Failed to load workspace preset');
    return null;
  }
}

/**
 * Apply a workspace preset's env defaults to process.env. Called once
 * at boot. Existing env vars take precedence — preset is a fallback only.
 */
export function applyWorkspaceDefaults(preset: WorkspacePreset): void {
  const d = preset.defaults ?? {};
  const setIfUnset = (key: string, value: string | undefined) => {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  };
  setIfUnset('LLM_GATEWAY_COMPRESSION_MODE', d.compression_mode);
  setIfUnset('INJECTION_DEFENSE_MODE', d.injection_defense);
  setIfUnset('REDACT_PII_MODE', d.pii_redaction);
  setIfUnset('OUTPUT_DEFENSE_MODE', d.output_defense);
  if (d.semantic_cache !== undefined) {
    setIfUnset('SEMANTIC_CACHE_ENABLED', d.semantic_cache ? '1' : '0');
  }
  logger.info({ defaults: d }, 'Workspace defaults applied');
}

/**
 * Get the routing override (if any) for a given task_type. The router
 * consults this before falling back to routing-rules.yaml.
 */
export function getRoutingOverride(taskType: string): { model?: string; tier?: string; prompt_template?: string } | null {
  if (!cached?.routing_overrides) return null;
  return cached.routing_overrides[taskType] ?? null;
}

/**
 * Get the per-caller config (rate limit, allowed task types, etc.)
 */
export function getCallerConfig(caller: string): WorkspacePreset['callers'] extends Record<string, infer V> ? V | null : null {
  if (!cached?.callers) return null;
  return (cached.callers[caller] ?? null) as never;
}

export function isProviderEnabled(providerName: string): boolean {
  if (!cached?.providers_enabled) return true; // no whitelist → all enabled
  return cached.providers_enabled.includes(providerName);
}
