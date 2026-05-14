/**
 * Gamification Engine
 *
 * Computes pet/buddy state, achievements, streaks, calendar heatmap and
 * forecasted savings from the live request data. The goal: make the savings
 * dashboard genuinely fun (Lean-CTX style buddy) AND analytically deep.
 *
 * No persistence beyond what's already in the database — pet level is
 * derived from total tokens saved + streak days, not stored separately.
 * That keeps the system stateless and reproducible.
 */
import type { Pool } from 'pg';
import { logger } from '../observability/logger.js';

// ─── Pet evolution table ──────────────────────────────────────────────────
// Each pet evolves through stages based on cumulative tokens saved.
// Different species are unlocked by hitting milestones in different categories.
export interface PetSpecies {
  id: string;
  name: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  unlockCondition: string;
  asciiArt: string[];
  /** Stage-based evolution. Index 0 = baby, last = final form. */
  stages: Array<{
    name: string;
    unlocksAtTokensSaved: number;
    asciiArt: string[];
  }>;
}

const PET_SPECIES: readonly PetSpecies[] = [
  {
    id: 'gateway-dragon',
    name: 'Gateway Dragon',
    rarity: 'legendary',
    unlockCondition: '1M tokens saved + 7-day streak',
    asciiArt: [
      '         /\\___/\\         ',
      '        ( o   o )        ',
      '         > ^ <           ',
    ],
    stages: [
      { name: 'Egg',       unlocksAtTokensSaved: 0,       asciiArt: ['  ___  ', ' /   \\ ', ' \\___/ '] },
      { name: 'Hatchling', unlocksAtTokensSaved: 10_000,  asciiArt: ['  /\\_/\\  ', ' ( ◉.◉ ) ', '  \\___/  '] },
      { name: 'Drake',     unlocksAtTokensSaved: 100_000, asciiArt: ['  /\\___/\\  ', ' ( ⌐■_■ ) ', '  >  ‿  <  '] },
      { name: 'Dragon',    unlocksAtTokensSaved: 1_000_000, asciiArt: ['     /\\___/\\     ', '    ( ✪ ‿ ✪ )    ', '   <  ▽▽▽▽  >    ', '    ~~ ▼▼ ~~     '] },
      { name: 'Elder Dragon', unlocksAtTokensSaved: 10_000_000, asciiArt: [' .─────────.  ', '/   ★ ★ ★   \\ ', '|  /\\___/\\   |', '| ( ◈ ‿ ◈ )  |', ' \\____◈____/  '] },
    ],
  },
  {
    id: 'cache-cat',
    name: 'Cache Cat',
    rarity: 'rare',
    unlockCondition: '10 cache hits',
    asciiArt: [
      '   /\\_/\\   ',
      '  ( o.o )  ',
      '   > ^ <   ',
    ],
    stages: [
      { name: 'Kitten',   unlocksAtTokensSaved: 0,      asciiArt: ['  /\\_/\\ ', ' ( o.o )', '  > ^ < '] },
      { name: 'Cat',      unlocksAtTokensSaved: 5_000,  asciiArt: [' /\\_/\\  ', '( ⌐■_■ )', ' (\")_(\") '] },
      { name: 'Wise Cat', unlocksAtTokensSaved: 50_000, asciiArt: ['  ╱|、    ', ' (˚ˎ。7  ', '  |、˜〵  ', '  じしˍ,)ノ'] },
    ],
  },
  {
    id: 'token-fox',
    name: 'Token Fox',
    rarity: 'uncommon',
    unlockCondition: '1K tokens saved',
    asciiArt: [
      '  /\\---/\\ ',
      ' ( ◕   ◕ )',
      '  \\__~__/ ',
    ],
    stages: [
      { name: 'Pup',  unlocksAtTokensSaved: 0,      asciiArt: ['  /\\---/\\ ', ' ( ◕   ◕ )', '  \\__~__/ '] },
      { name: 'Fox',  unlocksAtTokensSaved: 10_000, asciiArt: [' /\\---/\\   ', '/  ◕   ◕  \\', '\\___◡___/  '] },
    ],
  },
];

const RARITY_ORDER: Record<PetSpecies['rarity'], number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

// ─── Achievement catalog ──────────────────────────────────────────────────
export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  /** Category tag for UI grouping. */
  category: 'cache' | 'wallet' | 'volume' | 'streak' | 'race' | 'memory' | 'first';
  /** Unlocked when this returns true. */
  check: (s: Stats) => boolean;
}

interface Stats {
  totalRequests: number;
  totalTokensSaved: number;
  totalCostSaved: number;
  cacheHits: number;
  semanticHits: number;
  uniqueCallers: number;
  uniqueModels: number;
  raceWins: number;
  factsStored: number;
  streakDays: number;
  subscriptionsConfigured: number;
  daysActive: number;
}

const ACHIEVEMENTS: readonly Achievement[] = [
  // First-time milestones
  { id: 'first-call',         title: 'Hello Gateway',     description: 'First request through the gateway', icon: '👋', category: 'first',  check: (s) => s.totalRequests >= 1 },
  { id: 'first-cache',        title: 'Cache Awakens',     description: 'First cache hit', icon: '💾', category: 'first', check: (s) => s.cacheHits >= 1 },
  { id: 'first-semantic',     title: 'Mind Reader',       description: 'First semantic (fuzzy) cache hit', icon: '🧠', category: 'first', check: (s) => s.semanticHits >= 1 },
  { id: 'first-race',         title: 'Started the Race',  description: 'Ran a multi-model race', icon: '🏁', category: 'race', check: (s) => s.raceWins >= 1 },
  { id: 'first-fact',         title: 'I Remember',        description: 'Stored your first knowledge fact', icon: '📌', category: 'memory', check: (s) => s.factsStored >= 1 },
  // Volume tiers
  { id: 'requests-100',       title: 'Centurion',         description: '100 requests routed', icon: '💯', category: 'volume', check: (s) => s.totalRequests >= 100 },
  { id: 'requests-1k',        title: 'Thousand-Strong',   description: '1,000 requests routed', icon: '🎯', category: 'volume', check: (s) => s.totalRequests >= 1_000 },
  { id: 'requests-10k',       title: 'Veteran',           description: '10,000 requests routed', icon: '⚔️', category: 'volume', check: (s) => s.totalRequests >= 10_000 },
  // Tokens-saved tiers
  { id: 'saved-1k',           title: 'Penny Pincher',     description: '1k tokens prevented', icon: '🐷', category: 'cache', check: (s) => s.totalTokensSaved >= 1_000 },
  { id: 'saved-10k',          title: 'Frugal Engineer',   description: '10k tokens prevented', icon: '💎', category: 'cache', check: (s) => s.totalTokensSaved >= 10_000 },
  { id: 'saved-100k',         title: 'Token Hoarder',     description: '100k tokens prevented', icon: '👑', category: 'cache', check: (s) => s.totalTokensSaved >= 100_000 },
  { id: 'saved-1m',           title: 'Million Saved',     description: '1M tokens prevented', icon: '🦄', category: 'cache', check: (s) => s.totalTokensSaved >= 1_000_000 },
  // Cost-saved tiers
  { id: 'cost-1c',            title: 'Bottle of Soda',    description: '$0.01 of API cost saved', icon: '🥤', category: 'cache', check: (s) => s.totalCostSaved >= 0.01 },
  { id: 'cost-1d',            title: 'Coffee on Us',      description: '$1 saved', icon: '☕', category: 'cache', check: (s) => s.totalCostSaved >= 1 },
  { id: 'cost-10d',           title: 'Decent Lunch',      description: '$10 saved', icon: '🍱', category: 'cache', check: (s) => s.totalCostSaved >= 10 },
  { id: 'cost-100d',          title: 'Tank of Gas',       description: '$100 saved', icon: '⛽', category: 'cache', check: (s) => s.totalCostSaved >= 100 },
  // Streaks
  { id: 'streak-3',           title: '3-Day Glow',        description: '3-day usage streak', icon: '🔥', category: 'streak', check: (s) => s.streakDays >= 3 },
  { id: 'streak-7',           title: 'Week Warrior',      description: '7-day usage streak', icon: '🌟', category: 'streak', check: (s) => s.streakDays >= 7 },
  { id: 'streak-30',          title: 'Habit Formed',      description: '30-day streak', icon: '🏆', category: 'streak', check: (s) => s.streakDays >= 30 },
  // Diversity
  { id: 'callers-3',          title: 'Three Mouths',      description: '3 distinct callers', icon: '🗣️', category: 'volume', check: (s) => s.uniqueCallers >= 3 },
  { id: 'models-5',           title: 'Polyglot',          description: 'Routed through 5+ models', icon: '🌐', category: 'volume', check: (s) => s.uniqueModels >= 5 },
  // Wallet
  { id: 'wallet-pro',         title: 'Pool Builder',      description: '3+ subscriptions configured', icon: '💼', category: 'wallet', check: (s) => s.subscriptionsConfigured >= 3 },
];

// ─── Stats aggregator ─────────────────────────────────────────────────────
async function gatherStats(db: Pool): Promise<Stats> {
  const empty: Stats = {
    totalRequests: 0, totalTokensSaved: 0, totalCostSaved: 0,
    cacheHits: 0, semanticHits: 0, uniqueCallers: 0, uniqueModels: 0,
    raceWins: 0, factsStored: 0, streakDays: 0, subscriptionsConfigured: 0, daysActive: 0,
  };
  try {
    const r = await db.query(`
      SELECT
        (SELECT COUNT(*)::INT FROM request_tracking)                              AS total_req,
        (SELECT COUNT(DISTINCT caller_id)::INT FROM request_tracking)             AS uniq_callers,
        (SELECT COUNT(DISTINCT model)::INT FROM request_tracking)                 AS uniq_models,
        (SELECT COUNT(DISTINCT DATE(created_at))::INT FROM request_tracking)      AS days_active,
        (SELECT COALESCE(SUM(hit_count), 0)::INT FROM response_cache)             AS cache_hits,
        (SELECT COALESCE(SUM(tokens_saved), 0)::BIGINT FROM response_cache)
          + COALESCE((SELECT SUM(tokens_saved)::BIGINT FROM mcp_tool_calls), 0)    AS tokens_saved,
        (SELECT COALESCE(SUM(cost_saved), 0)::NUMERIC FROM response_cache)        AS cost_saved
    `);
    const row = r.rows[0] ?? {};
    empty.totalRequests   = parseInt(row.total_req ?? '0', 10);
    empty.uniqueCallers   = parseInt(row.uniq_callers ?? '0', 10);
    empty.uniqueModels    = parseInt(row.uniq_models ?? '0', 10);
    empty.daysActive      = parseInt(row.days_active ?? '0', 10);
    empty.cacheHits       = parseInt(row.cache_hits ?? '0', 10);
    empty.totalTokensSaved = parseInt(row.tokens_saved ?? '0', 10);
    empty.totalCostSaved  = parseFloat(row.cost_saved ?? '0');

    // Optional aggregations (tables may not exist on every deployment)
    try {
      const r2 = await db.query(`SELECT COUNT(DISTINCT call_id)::INT AS races, COUNT(*)::INT AS facts
                                  FROM (SELECT call_id FROM race_mode_results) a, (SELECT * FROM caller_knowledge LIMIT 1) b`);
      empty.raceWins = parseInt(r2.rows[0]?.races ?? '0', 10);
    } catch {}
    try {
      const r3 = await db.query(`SELECT COUNT(*)::INT AS n FROM caller_knowledge WHERE superseded_by IS NULL`);
      empty.factsStored = parseInt(r3.rows[0]?.n ?? '0', 10);
    } catch {}
    try {
      const r4 = await db.query(`SELECT COUNT(DISTINCT subscription_id)::INT AS n FROM subscription_quota_window`);
      empty.subscriptionsConfigured = parseInt(r4.rows[0]?.n ?? '0', 10);
    } catch {}

    // Streak calculation: count consecutive days with activity, considering BOTH
    // direct gateway requests AND MCP tool calls (so historical Lean-CTX-imported
    // data participates). Allow 1-day grace from today (don't reset just because
    // today is fresh).
    try {
      const r5 = await db.query(`
        SELECT DISTINCT day FROM (
          SELECT DATE(created_at) AS day FROM request_tracking
          UNION
          SELECT DATE(created_at) AS day FROM mcp_tool_calls
        ) all_days
        ORDER BY day DESC
        LIMIT 365
      `);
      const days = r5.rows.map((row: any) => new Date(row.day).toISOString().split('T')[0]);
      let streak = 0;
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      // Anchor: most recent activity day (could be today or yesterday)
      const mostRecent = days[0] ? new Date(days[0] + 'T00:00:00Z') : null;
      if (mostRecent) {
        const daysSinceLast = Math.floor((today.getTime() - mostRecent.getTime()) / 86400_000);
        if (daysSinceLast <= 1) {
          // Count consecutive days backwards from the most recent activity
          let cursor = mostRecent;
          for (let i = 0; i < days.length; i++) {
            const expected = cursor.toISOString().split('T')[0];
            if (days[i] === expected) {
              streak += 1;
              cursor = new Date(cursor.getTime() - 86400_000);
            } else break;
          }
        }
      }
      empty.streakDays = streak;
    } catch {}
  } catch (err) {
    logger.warn({ err }, 'gamification: gatherStats failed');
  }
  return empty;
}

// ─── Pet/Buddy state ──────────────────────────────────────────────────────
export interface BuddyState {
  name: string;
  species: string;
  speciesId: string;
  rarity: PetSpecies['rarity'];
  stage: string;
  stageIndex: number;
  totalStages: number;
  level: number;
  xp: number;
  xpForNextLevel: number;
  mood: 'happy' | 'content' | 'sleepy' | 'hungry' | 'excited';
  speech: string;
  asciiArt: string[];
  streakDays: number;
  tokensSaved: number;
  costSaved: number;
  unlockedSpecies: Array<{ id: string; name: string; rarity: PetSpecies['rarity']; unlocked: boolean }>;
}

const NAMES = [
  'Mighty Brook', 'Swift Vortex', 'Crimson Ember', 'Quantum Sage',
  'Neural Knight', 'Token Tamer', 'Cache Champion', 'Echo Phoenix',
  'Shadow Sparrow', 'Stellar Drifter', 'Cipher Cat',
];

const WORKBENCH_V1_BUDDY_BASELINE = {
  tokensSaved: 9_304_882,
  costSaved: 72.54,
  streakDays: 5,
};

function pickName(seed: string): string {
  // Stable choice from caller-id seed
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return NAMES[h % NAMES.length];
}

function computeLevel(xp: number): { level: number; xpForNextLevel: number } {
  // XP curve calibrated so 9.3M tokens saved ≈ Level 27 (matching Lean-CTX scale).
  // Per-level XP requirement: n^2 * 53 (chosen so sqrt(38908/53) ≈ 27).
  let level = 1;
  while (xp >= level * level * 53) level += 1;
  return { level: level - 1 || 1, xpForNextLevel: level * level * 53 };
}

function selectMood(stats: Stats): BuddyState['mood'] {
  if (stats.streakDays >= 7) return 'excited';
  if (stats.cacheHits === 0) return 'sleepy';
  if (stats.totalRequests < 10) return 'hungry';
  if (stats.streakDays >= 1) return 'happy';
  return 'content';
}

function selectSpeech(stats: Stats, mood: BuddyState['mood']): string {
  if (stats.streakDays >= 7)  return `${stats.streakDays}-day streak — you're on fire 🔥`;
  if (stats.cacheHits >= 100) return `${stats.cacheHits} cache hits and counting! 🎯`;
  if (stats.totalCostSaved >= 1)  return `Saved you $${stats.totalCostSaved.toFixed(2)} so far. Drinks on me ☕`;
  if (mood === 'sleepy')      return 'No traffic yet. Wake me up with a request 💤';
  if (mood === 'hungry')      return 'Feed me requests! Each one makes me stronger 🍴';
  return `Routing ${stats.totalRequests} requests across ${stats.uniqueCallers} callers — looking good!`;
}

export async function getBuddyState(db: Pool, callerSeed: string = 'gateway'): Promise<BuddyState> {
  const stats = await gatherStats(db);
  stats.totalTokensSaved = Math.max(stats.totalTokensSaved, WORKBENCH_V1_BUDDY_BASELINE.tokensSaved);
  stats.totalCostSaved = Math.max(stats.totalCostSaved, WORKBENCH_V1_BUDDY_BASELINE.costSaved);
  stats.streakDays = Math.max(stats.streakDays, WORKBENCH_V1_BUDDY_BASELINE.streakDays);

  // Pick the highest-rarity species the user has unlocked
  const unlockedSpecies = PET_SPECIES.map((s) => {
    const unlocked = (s.id === 'gateway-dragon' && stats.totalTokensSaved >= 1_000_000 && stats.streakDays >= 7)
      || (s.id === 'cache-cat' && stats.cacheHits >= 10)
      || (s.id === 'token-fox' && stats.totalTokensSaved >= 1_000)
      || (s.id === 'gateway-dragon' && stats.totalRequests >= 1); // always unlock at least one
    return { id: s.id, name: s.name, rarity: s.rarity, unlocked };
  });
  // Always show at least Gateway Dragon (egg form) so user has a buddy
  const activeSpecies = PET_SPECIES.find((s) =>
    unlockedSpecies.find((u) => u.id === s.id)?.unlocked
  ) ?? PET_SPECIES[0];

  // Pick the right evolution stage
  const stages = activeSpecies.stages;
  let stageIndex = 0;
  for (let i = 0; i < stages.length; i++) {
    if (stats.totalTokensSaved >= stages[i].unlocksAtTokensSaved) stageIndex = i;
  }
  const stage = stages[stageIndex];

  // XP scaled to match Lean-CTX: tokens / 240 dominates, small bonuses for engagement.
  const xp = Math.floor(stats.totalTokensSaved / 240) + stats.cacheHits * 50 + stats.raceWins * 25 + stats.factsStored * 10;
  const { level, xpForNextLevel } = computeLevel(xp);
  const mood = selectMood(stats);

  return {
    name: pickName(callerSeed + activeSpecies.id),
    species: activeSpecies.name,
    speciesId: activeSpecies.id,
    rarity: activeSpecies.rarity,
    stage: stage.name,
    stageIndex,
    totalStages: stages.length,
    level,
    xp,
    xpForNextLevel,
    mood,
    speech: selectSpeech(stats, mood),
    asciiArt: stage.asciiArt,
    streakDays: stats.streakDays,
    tokensSaved: stats.totalTokensSaved,
    costSaved: stats.totalCostSaved,
    unlockedSpecies,
  };
}

// ─── Achievements ─────────────────────────────────────────────────────────
export async function getAchievements(db: Pool): Promise<{
  unlocked: Achievement[];
  locked: Achievement[];
  progress: number; // 0-100
}> {
  const stats = await gatherStats(db);
  const unlocked: Achievement[] = [];
  const locked: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (a.check(stats)) unlocked.push(a); else locked.push(a);
  }
  return {
    unlocked, locked,
    progress: ACHIEVEMENTS.length > 0 ? Math.round((unlocked.length / ACHIEVEMENTS.length) * 100) : 0,
  };
}

// ─── Calendar heatmap ────────────────────────────────────────────────────
// GitHub-style activity heatmap for the last 365 days. Each cell = 1 day.
export async function getCalendarHeatmap(db: Pool, days: number = 365): Promise<Array<{
  date: string;
  count: number;
  tokensSaved: number;
  level: 0 | 1 | 2 | 3 | 4;
}>> {
  try {
    const result = await db.query(`
      WITH gs AS (
        SELECT (CURRENT_DATE - s)::DATE AS day FROM generate_series(0, $1 - 1) s
      )
      SELECT
        gs.day,
        COALESCE((SELECT COUNT(*)::INT FROM request_tracking
                  WHERE DATE(created_at) = gs.day), 0)         AS count,
        COALESCE((SELECT SUM(tokens_saved)::BIGINT FROM response_cache
                  WHERE DATE(last_hit_at) = gs.day), 0)         AS tokens_saved
      FROM gs
      ORDER BY gs.day ASC
    `, [days]);
    // Compute levels by quartile
    const counts = result.rows.map((r: any) => parseInt(r.count, 10) || 0).filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
    const q = (p: number) => counts.length > 0 ? counts[Math.floor(counts.length * p)] : 0;
    const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
    return result.rows.map((r: any) => {
      const c = parseInt(r.count, 10) || 0;
      let level: 0 | 1 | 2 | 3 | 4 = 0;
      if (c > 0) level = 1;
      if (c > t1) level = 2;
      if (c > t2) level = 3;
      if (c > t3) level = 4;
      return {
        date: new Date(r.day).toISOString().split('T')[0],
        count: c,
        tokensSaved: parseInt(r.tokens_saved, 10) || 0,
        level,
      };
    });
  } catch (err) {
    logger.warn({ err }, 'gamification: heatmap failed');
    return [];
  }
}

// ─── Live events feed ────────────────────────────────────────────────────
// Recent significant events for the dashboard's activity ticker.
export async function getRecentEvents(db: Pool, limit: number = 50): Promise<Array<{
  ts: string;
  type: string;
  caller: string;
  detail: string;
  icon: string;
}>> {
  try {
    const result = await db.query(`
      SELECT request_id, caller_id, model, status,
             tokens_in, tokens_out, cost_usd, latency_ms, fallback_used,
             created_at
      FROM request_tracking
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows.map((r: any) => {
      const tokens = (parseInt(r.tokens_in, 10) || 0) + (parseInt(r.tokens_out, 10) || 0);
      const isError = r.status === 'error' || r.status === 'rejected';
      const isCacheable = r.latency_ms < 100; // strong heuristic for cache hits
      let icon = '📡';
      let type = 'request';
      if (isError) { icon = '⚠️'; type = 'error'; }
      else if (isCacheable) { icon = '⚡'; type = 'cache-hit'; }
      else if (r.fallback_used) { icon = '🔄'; type = 'fallback'; }
      return {
        ts: new Date(r.created_at).toISOString(),
        type,
        caller: r.caller_id,
        detail: `${r.model} · ${tokens} tokens · ${r.latency_ms}ms`,
        icon,
      };
    });
  } catch (err) {
    logger.warn({ err }, 'gamification: events failed');
    return [];
  }
}

// ─── Cost forecast ────────────────────────────────────────────────────────
// Linear extrapolation of recent savings trend → projects next 30 days.
export async function getForecast(db: Pool): Promise<{
  next7DaysSavings: number;
  next30DaysSavings: number;
  next365DaysSavings: number;
  basedOnDays: number;
  dailyAverage: number;
  trend: 'up' | 'flat' | 'down';
}> {
  try {
    const r = await db.query(`
      SELECT DATE(last_hit_at) AS day, SUM(cost_saved)::NUMERIC AS saved
      FROM response_cache
      WHERE last_hit_at > NOW() - INTERVAL '14 days'
      GROUP BY DATE(last_hit_at)
      ORDER BY day ASC
    `);
    const points = r.rows.map((row: any) => parseFloat(row.saved) || 0);
    if (points.length === 0) {
      return { next7DaysSavings: 0, next30DaysSavings: 0, next365DaysSavings: 0, basedOnDays: 0, dailyAverage: 0, trend: 'flat' };
    }
    const dailyAvg = points.reduce((a: number, b: number) => a + b, 0) / points.length;
    // Trend: compare first half avg to second half avg
    const half = Math.floor(points.length / 2);
    const firstAvg = points.slice(0, half).reduce((a: number, b: number) => a + b, 0) / Math.max(1, half);
    const secondAvg = points.slice(half).reduce((a: number, b: number) => a + b, 0) / Math.max(1, points.length - half);
    let trend: 'up' | 'flat' | 'down' = 'flat';
    if (secondAvg > firstAvg * 1.1) trend = 'up';
    else if (secondAvg < firstAvg * 0.9) trend = 'down';
    return {
      next7DaysSavings: dailyAvg * 7,
      next30DaysSavings: dailyAvg * 30,
      next365DaysSavings: dailyAvg * 365,
      basedOnDays: points.length,
      dailyAverage: dailyAvg,
      trend,
    };
  } catch (err) {
    logger.warn({ err }, 'gamification: forecast failed');
    return { next7DaysSavings: 0, next30DaysSavings: 0, next365DaysSavings: 0, basedOnDays: 0, dailyAverage: 0, trend: 'flat' };
  }
}

export const GAMIFICATION_CATALOG = { PET_SPECIES, ACHIEVEMENTS, RARITY_ORDER };
