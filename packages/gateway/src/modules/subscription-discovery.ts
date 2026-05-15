/**
 * Subscription Discovery
 *
 * Auto-detects locally installed CLI subscriptions (Claude Code, GitHub Copilot,
 * ChatGPT, Gemini, etc.) and reports their authentication status. The discovery
 * results drive automatic bridge spawning and dynamic provider registration.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { logger } from '../observability/logger.js';

const execFileAsync = promisify(execFile);

export type SubscriptionId =
  | 'claude-code'
  | 'github-copilot'
  | 'microsoft-365-copilot'
  | 'gemini'
  | 'codex'
  | 'aider';

export interface SubscriptionDescriptor {
  id: SubscriptionId;
  /** Friendly display name */
  label: string;
  /** CLI binary required to use the subscription */
  command: string;
  /** Args used for the version probe */
  versionArgs: readonly string[];
  /** Args used for the auth probe (optional) */
  authProbeArgs?: readonly string[];
  /** Default port the bridge listens on */
  bridgePort: number;
  /** ENV var the gateway uses to find the bridge URL */
  bridgeEnvKey: string;
  /** Logical provider name in `external-providers.ts` */
  providerName: string;
  /** Models exposed via this subscription */
  models: ReadonlyArray<{ id: string; tier: 'fast' | 'medium' | 'large' | 'reasoning' }>;
  /** Bridge implementation path (relative to repo root or absolute) */
  bridgeImplementation: 'inline-claude' | 'inline-openai' | 'inline-copilot' | 'external-codex';
}

export interface SubscriptionStatus {
  descriptor: SubscriptionDescriptor;
  installed: boolean;
  authenticated: boolean | 'unknown';
  version?: string;
  error?: string;
  bridgeUrl?: string;
  bridgeRunning: boolean;
}

/**
 * Catalog of subscriptions the gateway knows how to bootstrap.
 * Adding a new entry here is enough to make it discoverable.
 */
export const SUBSCRIPTION_CATALOG: readonly SubscriptionDescriptor[] = [
  {
    id: 'claude-code',
    label: 'Claude Code (Anthropic Subscription)',
    command: 'claude',
    versionArgs: ['--version'],
    bridgePort: 3250,
    bridgeEnvKey: 'CLAUDE_BRIDGE_URL',
    providerName: 'claude-bridge',
    bridgeImplementation: 'inline-claude',
    models: [
      { id: 'claude-opus-4-1', tier: 'reasoning' },
      { id: 'claude-sonnet-4-1', tier: 'large' },
      { id: 'claude-haiku-3', tier: 'fast' },
    ],
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot Subscription',
    command: 'gh',
    versionArgs: ['copilot', '--version'],
    bridgePort: 3252,
    bridgeEnvKey: 'COPILOT_BRIDGE_URL',
    providerName: 'copilot-bridge',
    bridgeImplementation: 'inline-copilot',
    models: [
      { id: 'gpt-4', tier: 'reasoning' },
      { id: 'gpt-3.5-turbo', tier: 'medium' },
    ],
  },
  {
    id: 'microsoft-365-copilot',
    label: 'Microsoft 365 Copilot Subscription',
    command: 'node',
    versionArgs: ['--version'],
    bridgePort: 3257,
    bridgeEnvKey: 'M365_COPILOT_BRIDGE_URL',
    providerName: 'm365-copilot-bridge',
    bridgeImplementation: 'inline-openai',
    models: [
      { id: 'microsoft-365-copilot', tier: 'reasoning' },
      { id: 'm365-copilot-chat', tier: 'large' },
    ],
  },
{
    id: 'gemini',
    label: 'Google Gemini Advanced Subscription',
    command: 'gemini',
    versionArgs: ['--version'],
    bridgePort: 3254,
    bridgeEnvKey: 'GEMINI_BRIDGE_URL',
    providerName: 'gemini-bridge',
    bridgeImplementation: 'inline-openai',
    models: [
      { id: 'gemini-1.5-pro', tier: 'reasoning' },
      { id: 'gemini-1.5-flash', tier: 'fast' },
    ],
  },
  {
    id: 'codex',
    label: 'OpenAI (ChatGPT + Codex)',
    command: 'codex',
    versionArgs: ['--version'],
    authProbeArgs: ['login', 'status'],
    bridgePort: 3253,
    bridgeEnvKey: 'CODEX_BRIDGE_URL',
    providerName: 'codex-bridge',
    bridgeImplementation: 'external-codex',
    models: [
      { id: 'gpt-5.5', tier: 'reasoning' },
      { id: 'gpt-5', tier: 'reasoning' },
      { id: 'gpt-5-codex', tier: 'reasoning' },
      { id: 'gpt-5.1-codex', tier: 'reasoning' },
      { id: 'gpt-5.1-codex-mini', tier: 'large' },
      { id: 'gpt-5-mini', tier: 'medium' },
      { id: 'gpt-4-turbo', tier: 'large' },
      { id: 'gpt-4o', tier: 'large' },
      { id: 'codex-mini-latest', tier: 'medium' },
    ],
  },
  {
    id: 'aider',
    label: 'Aider AI Pair Programmer',
    command: 'aider',
    versionArgs: ['--version'],
    bridgePort: 3256,
    bridgeEnvKey: 'AIDER_BRIDGE_URL',
    providerName: 'aider-bridge',
    bridgeImplementation: 'inline-openai',
    models: [
      { id: 'aider-default', tier: 'large' },
    ],
  },
];

/**
 * Probe a CLI's --version with a 3s timeout. Returns null when not installed.
 */
async function probeVersion(command: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args as string[], {
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    const out = (stdout || stderr || '').trim().split('\n')[0];
    return out || 'installed';
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // Non-zero exit code but command exists (e.g. auth required) — count as installed
    return 'installed';
  }
}

/**
 * Best-effort authentication check. Many CLI tools don't have a clean probe,
 * so we return 'unknown' rather than guessing wrong.
 */
async function probeAuthenticated(desc: SubscriptionDescriptor): Promise<boolean | 'unknown'> {
  // Claude Code stores credentials in ~/.claude/.credentials.json
  if (desc.id === 'claude-code') {
    const home = process.env.HOME || '/root';
    return existsSync(`${home}/.claude/.credentials.json`);
  }
  // GitHub Copilot uses gh auth status
  if (desc.id === 'github-copilot') {
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
  if (desc.id === 'microsoft-365-copilot') {
    return Boolean(
      process.env['MICROSOFT_GRAPH_ACCESS_TOKEN'] ||
      process.env['M365_COPILOT_ACCESS_TOKEN'] ||
      process.env['MICROSOFT_CLIENT_ID']
    );
  }
  if (desc.id === 'codex') {
    try {
      await execFileAsync('codex', ['login', 'status'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
  return 'unknown';
}

/**
 * Check whether a bridge URL is reachable.
 */
async function probeBridge(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(`${url.replace(/\/$/, '')}/health`, { signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}

/**
 * Resolve the bridge URL for a subscription:
 *   1. Explicit env var (CLAUDE_BRIDGE_URL etc.) — set by Settings or PM2 ecosystem
 *   2. Auto-detect: probe http://127.0.0.1:{bridgePort} for a /health endpoint
 *
 * This means a bridge running locally on its default port is picked up
 * automatically without any configuration.
 */
async function resolveBridgeUrl(desc: SubscriptionDescriptor): Promise<{ url?: string; running: boolean }> {
  const explicit = process.env[desc.bridgeEnvKey];
  if (explicit) {
    const running = await probeBridge(explicit);
    return { url: explicit, running };
  }
  // Auto-detect on the default port
  const localUrl = `http://127.0.0.1:${desc.bridgePort}`;
  const running = await probeBridge(localUrl);
  return running ? { url: localUrl, running: true } : { running: false };
}

/**
 * Discover all subscriptions the gateway knows about. Probes the CLI binary,
 * authentication state, and any pre-configured bridge URL in the environment.
 */
export async function discoverSubscriptions(): Promise<SubscriptionStatus[]> {
  const results = await Promise.all(
    SUBSCRIPTION_CATALOG.map(async (desc): Promise<SubscriptionStatus> => {
      // Always probe the bridge first — a running bridge is enough to count
      // as "available" even if the CLI isn't installed on this host (the
      // bridge could live on the user's machine).
      const bridge = await resolveBridgeUrl(desc);

      const version = await probeVersion(desc.command, desc.versionArgs);
      if (!version) {
        return {
          descriptor: desc,
          installed: bridge.running, // remote bridge counts as installed
          authenticated: bridge.running ? 'unknown' : false,
          bridgeUrl: bridge.url,
          bridgeRunning: bridge.running,
        };
      }

      const authenticated = await probeAuthenticated(desc);
      return {
        descriptor: desc,
        installed: true,
        authenticated,
        version,
        bridgeUrl: bridge.url,
        bridgeRunning: bridge.running,
      };
    })
  );
  logger.info(
    {
      detected: results.filter((r) => r.installed).length,
      bridgesLive: results.filter((r) => r.bridgeRunning).length,
      total: results.length,
    },
    'Subscription discovery completed'
  );
  return results;
}
