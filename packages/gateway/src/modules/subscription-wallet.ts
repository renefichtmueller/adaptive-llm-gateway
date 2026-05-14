/**
 * Subscription Pool Wallet
 *
 * Tracks usage of each CLI subscription against its known quota window
 * (Claude Plus = 80 msg / 3h, ChatGPT Plus = 80 msg / 3h, Copilot = …).
 * Used by the dashboard to show which subscription has the most headroom
 * and (future) by the router to load-balance across subscriptions.
 *
 * This is the feature competitors don't have: combining MULTIPLE personal
 * AI subscriptions into a single managed pool.
 */

import type { Pool } from 'pg';
import { logger } from '../observability/logger.js';

export interface QuotaProfile {
  subscriptionId: string;
  label: string;
  /** Hard request quota inside the window. Null = unknown / unlimited. */
  requestQuota: number | null;
  /** Window length in seconds (Anthropic uses 3h = 10800s, OpenAI varies). */
  windowSeconds: number;
  /** Reset behaviour: 'rolling' = sliding window, 'fixed' = clock-aligned reset. */
  reset: 'rolling' | 'fixed';
}

/**
 * Known subscription quota profiles. Numbers are conservative defaults —
 * users can override via Settings if their plan differs.
 */
export const QUOTA_PROFILES: Record<string, QuotaProfile> = {
  'claude-code':           { subscriptionId: 'claude-code',           label: 'Claude Code (Pro)',         requestQuota: 45,   windowSeconds: 5 * 3600,  reset: 'rolling' },
  'github-copilot':        { subscriptionId: 'github-copilot',        label: 'GitHub Copilot',            requestQuota: null, windowSeconds: 30 * 86400, reset: 'fixed' },
  'microsoft-365-copilot': { subscriptionId: 'microsoft-365-copilot', label: 'M365 Copilot',              requestQuota: null, windowSeconds: 30 * 86400, reset: 'fixed' },
  'chatgpt':               { subscriptionId: 'chatgpt',               label: 'ChatGPT Plus',              requestQuota: 80,   windowSeconds: 3 * 3600,  reset: 'rolling' },
  'gemini':                { subscriptionId: 'gemini',                label: 'Gemini Advanced',           requestQuota: null, windowSeconds: 30 * 86400, reset: 'fixed' },
  'codex':                 { subscriptionId: 'codex',                 label: 'OpenAI Codex',              requestQuota: 150,  windowSeconds: 5 * 3600,  reset: 'rolling' },
  'aider':                 { subscriptionId: 'aider',                 label: 'Aider',                     requestQuota: null, windowSeconds: 86400,     reset: 'fixed' },
};

/** Record a request against a subscription quota window. */
export async function recordSubscriptionUsage(
  db: Pool,
  subscriptionId: string,
  tokensConsumed: number = 0
): Promise<void> {
  const profile = QUOTA_PROFILES[subscriptionId];
  if (!profile) return;

  // Compute the window-start timestamp this request belongs to.
  const now = new Date();
  let windowStart: Date;
  if (profile.reset === 'rolling') {
    // Floor to the most recent quarter-hour for grouping; rolling logic
    // applied at read-time by summing the last `windowSeconds`.
    const rounded = Math.floor(now.getTime() / 900_000) * 900_000;
    windowStart = new Date(rounded);
  } else {
    // Fixed reset — bucket into day windows
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    windowStart = day;
  }

  try {
    await db.query(
      `
      INSERT INTO subscription_quota_window
        (subscription_id, window_start, window_seconds, request_count, tokens_consumed, quota_limit, reset_at)
      VALUES ($1, $2, $3, 1, $4, $5, $6)
      ON CONFLICT (subscription_id, window_start)
      DO UPDATE SET
        request_count   = subscription_quota_window.request_count + 1,
        tokens_consumed = subscription_quota_window.tokens_consumed + EXCLUDED.tokens_consumed
      `,
      [
        subscriptionId,
        windowStart,
        profile.windowSeconds,
        tokensConsumed,
        profile.requestQuota,
        new Date(windowStart.getTime() + profile.windowSeconds * 1000),
      ]
    );
  } catch (err) {
    logger.warn({ err, subscriptionId }, 'subscription-wallet: usage record failed');
  }
}

export interface WalletEntry {
  subscriptionId: string;
  label: string;
  requestQuota: number | null;
  used: number;
  remaining: number | null;
  utilizationPercent: number | null;
  windowSeconds: number;
  resetAt: string | null;
  /** Predicted exhaustion timestamp based on current rate; null if no quota or no usage. */
  predictedExhaustionAt: string | null;
  recommendation: 'use-this' | 'available' | 'near-limit' | 'exhausted' | 'unknown';
}

/** Build the wallet snapshot for the dashboard. */
export async function getSubscriptionWallet(db: Pool): Promise<WalletEntry[]> {
  const entries: WalletEntry[] = [];

  for (const profile of Object.values(QUOTA_PROFILES)) {
    let used = 0;
    let resetAt: string | null = null;
    let predictedExhaustionAt: string | null = null;

    try {
      const result = await db.query(
        `
        SELECT
          COALESCE(SUM(request_count), 0)::INT AS used,
          MAX(reset_at) AS reset_at
        FROM subscription_quota_window
        WHERE subscription_id = $1
          AND window_start > NOW() - MAKE_INTERVAL(secs => $2)
        `,
        [profile.subscriptionId, profile.windowSeconds]
      );
      used = parseInt(result.rows[0]?.used ?? '0', 10);
      resetAt = result.rows[0]?.reset_at ? new Date(result.rows[0].reset_at).toISOString() : null;
    } catch (err) {
      logger.warn({ err, sub: profile.subscriptionId }, 'wallet: read failed');
    }

    const remaining = profile.requestQuota !== null ? Math.max(profile.requestQuota - used, 0) : null;
    const utilizationPercent = profile.requestQuota
      ? Math.min(100, (used / profile.requestQuota) * 100)
      : null;

    // Linear extrapolation for predicted exhaustion.
    if (remaining !== null && used > 0 && profile.requestQuota) {
      const ratePerSecond = used / profile.windowSeconds;
      if (ratePerSecond > 0) {
        const secondsRemaining = remaining / ratePerSecond;
        predictedExhaustionAt = new Date(Date.now() + secondsRemaining * 1000).toISOString();
      }
    }

    let recommendation: WalletEntry['recommendation'] = 'unknown';
    if (utilizationPercent !== null) {
      if (utilizationPercent >= 100) recommendation = 'exhausted';
      else if (utilizationPercent >= 80) recommendation = 'near-limit';
      else if (utilizationPercent <= 30) recommendation = 'use-this';
      else recommendation = 'available';
    }

    entries.push({
      subscriptionId: profile.subscriptionId,
      label: profile.label,
      requestQuota: profile.requestQuota,
      used,
      remaining,
      utilizationPercent: utilizationPercent !== null ? Math.round(utilizationPercent * 10) / 10 : null,
      windowSeconds: profile.windowSeconds,
      resetAt,
      predictedExhaustionAt,
      recommendation,
    });
  }

  return entries;
}

/**
 * Map an Ollama / external model id to the subscription it belongs to,
 * if any. Returns null for non-subscription models (free APIs, local Ollama).
 */
export function modelToSubscriptionId(model: string): string | null {
  const m = model.toLowerCase();
  if (m.startsWith('claude-') || m.includes('claude')) return 'claude-code';
  if (m.startsWith('gpt-5.1-codex') || m === 'codex-mini-latest') return 'codex';
  if (m.startsWith('gpt-')) return 'chatgpt';
  if (m.startsWith('gemini-')) return 'gemini';
  if (m.startsWith('github-copilot') || m === 'copilot-chat') return 'github-copilot';
  if (m === 'microsoft-365-copilot' || m === 'm365-copilot-chat') return 'microsoft-365-copilot';
  return null;
}

/**
 * Post-process a routing decision against the subscription wallet.
 *
 * If the picked model belongs to a subscription that is `exhausted` or
 * `near-limit` (>=80% utilization), we look at the same-tier siblings in
 * the fallback chain and re-pick the one with the most headroom.
 *
 * This is the Pool-Routing feature: distribute load across YOUR subscriptions
 * to maximize their value rather than always routing to the primary.
 */
export async function applyPoolRouting(
  db: Pool,
  decision: { model: string; fallback_chain: string[]; tier: string },
  options: { forced?: boolean } = {}
): Promise<{ model: string; fallback_chain: string[]; reason: string } | null> {
  const wallet = await getSubscriptionWallet(db);
  const utilByModel = (model: string): number | null => {
    const sub = modelToSubscriptionId(model);
    if (!sub) return null;
    const w = wallet.find((entry) => entry.subscriptionId === sub);
    return w?.utilizationPercent ?? null;
  };
  const isExhausted = (model: string): boolean => {
    const sub = modelToSubscriptionId(model);
    if (!sub) return false;
    const w = wallet.find((entry) => entry.subscriptionId === sub);
    return w?.recommendation === 'exhausted';
  };

  const primaryUtil = utilByModel(decision.model);
  const primarySub = modelToSubscriptionId(decision.model);

  // No re-routing for non-subscription models or when primary has plenty of headroom
  if (!primarySub) return null;
  if (!options.forced && primaryUtil !== null && primaryUtil < 80 && !isExhausted(decision.model)) return null;

  // Find a sibling in the fallback chain with lower utilization
  const candidates = decision.fallback_chain.filter((m) => m !== decision.model);
  let bestModel = decision.model;
  let bestUtil = primaryUtil ?? 100;

  for (const candidate of candidates) {
    if (isExhausted(candidate)) continue;
    const util = utilByModel(candidate);
    if (util === null) continue; // unknown utilization — don't pick blindly over a known one
    if (util < bestUtil) {
      bestUtil = util;
      bestModel = candidate;
    }
  }

  if (bestModel === decision.model) return null;

  // Move chosen model to front of chain
  const newChain = [bestModel, ...decision.fallback_chain.filter((m) => m !== bestModel)];
  return {
    model: bestModel,
    fallback_chain: newChain,
    reason: `pool-route: primary ${decision.model} at ${primaryUtil?.toFixed(0) ?? '?'}% util, switched to ${bestModel} at ${bestUtil.toFixed(0)}%`,
  };
}

/** Pick the subscription with the most headroom for a given tier. */
export async function pickBestSubscription(
  db: Pool,
  candidates: readonly string[]
): Promise<{ subscriptionId: string; reason: string } | null> {
  const wallet = await getSubscriptionWallet(db);
  const eligible = wallet.filter(
    (w) => candidates.includes(w.subscriptionId) && w.recommendation !== 'exhausted'
  );
  if (eligible.length === 0) return null;
  // Sort: lowest utilization first (most headroom). Unknown utilisation
  // sorts to the middle so paid quotas with usage data win over unknowns.
  eligible.sort((a, b) => {
    const ua = a.utilizationPercent ?? 50;
    const ub = b.utilizationPercent ?? 50;
    return ua - ub;
  });
  const winner = eligible[0];
  return {
    subscriptionId: winner.subscriptionId,
    reason: winner.utilizationPercent !== null
      ? `${winner.utilizationPercent.toFixed(0)}% used in window`
      : 'no quota tracking',
  };
}
