/**
 * GEO Ranking Test — prompt monitoring for generative engines
 * -----------------------------------------------------------
 * Implements the GEO measurement loop from the Evergreen Media guide: define
 * the prompts your customers actually ask an AI assistant, run them regularly
 * against the models the gateway can reach, and measure whether — and how
 * prominently — your brand shows up in the generated answers.
 *
 * KPIs per run (see GEO_KPIS in geo-knowledge.ts): mention rate, share of
 * voice vs. competitors, citation rate of your own domains, first-mention
 * position, sentiment, and a composite 0–100 visibility score. Runs are
 * persisted to Postgres (geo_ranking_runs / geo_ranking_results) so trends
 * are comparable over time.
 *
 * The module is transport-agnostic: callers inject a `GeoAnswerRunner`
 * (model, prompt) => answer. geo-monitor.ts provides the default runner that
 * goes through the gateway's own LLM pipeline; tests inject a fake.
 *
 * Config: src/config/geo-targets.yaml (override path via GEO_TARGETS_PATH).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { load as loadYaml } from 'js-yaml';
import { logger } from '../observability/logger.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

// ─── Config ────────────────────────────────────────────────────────────────

export interface GeoBrandTarget {
  name: string;
  aliases?: string[];
  domains?: string[];
}

export interface GeoPrompt {
  id: string;
  text: string;
  category?: string;
}

export interface GeoTargetsConfig {
  brand: GeoBrandTarget;
  competitors: GeoBrandTarget[];
  models: string[];
  prompts: GeoPrompt[];
}

/**
 * Load the ranking-test targets. Search order:
 *   1. GEO_TARGETS_PATH (absolute or cwd-relative)
 *   2. <package>/src|dist/config/geo-targets.yaml (shipped default)
 */
export function loadGeoTargets(): GeoTargetsConfig | null {
  const candidates = [
    process.env['GEO_TARGETS_PATH'],
    resolve(__dirname, '../config/geo-targets.yaml'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const raw = loadYaml(readFileSync(path, 'utf-8')) as Partial<GeoTargetsConfig> | null;
      if (!raw || typeof raw !== 'object') continue;
      const brand = raw.brand;
      if (!brand || typeof brand.name !== 'string' || brand.name.trim().length === 0) {
        logger.warn({ path }, 'geo-ranking: targets file has no brand.name — skipping');
        continue;
      }
      const prompts = (Array.isArray(raw.prompts) ? raw.prompts : [])
        .filter((p): p is GeoPrompt => !!p && typeof p.text === 'string' && p.text.trim().length > 0)
        .map((p, i) => ({ id: p.id ?? `prompt-${i + 1}`, text: p.text.trim(), category: p.category }));
      if (prompts.length === 0) {
        logger.warn({ path }, 'geo-ranking: targets file has no prompts — skipping');
        continue;
      }
      return {
        brand,
        competitors: Array.isArray(raw.competitors) ? raw.competitors.filter((c) => !!c && typeof c.name === 'string') : [],
        models: Array.isArray(raw.models) ? raw.models.filter((m): m is string => typeof m === 'string') : [],
        prompts,
      };
    } catch (err) {
      logger.warn({ err, path }, 'geo-ranking: failed to load targets file');
    }
  }
  return null;
}

// ─── Answer evaluation ─────────────────────────────────────────────────────

export interface AnswerEvaluation {
  brandMentioned: boolean;
  mentionCount: number;
  /** Relative position of the first brand mention (0 = very start, 1 = end). */
  firstMentionPos: number | null;
  /** One of the brand's own domains referenced as a source. */
  domainCited: boolean;
  /** 1-based order of first appearance among all tracked brands; null if absent. */
  brandRank: number | null;
  competitorMentions: Record<string, number>;
  sentiment: 'positive' | 'neutral' | 'negative';
  /** Composite 0–100: mentioned + early + cited + before competitors. */
  visibilityScore: number;
}

const POSITIVE_WORDS = /\b(empfehlenswert|empfohlen|empfehle|beste[nrs]?|am besten|führend|ausgezeichnet|hervorragend|zuverlässig|beliebt|stark|erste wahl|top|recommended|recommend|best|leading|excellent|outstanding|reliable|popular|powerful|great|solid|mature|robust|first choice)\b/gi;
const NEGATIVE_WORDS = /\b(schlecht|schwach|unzuverlässig|veraltet|unsicher|kompliziert|überteuert|vermeiden|abraten|nachteil\w*|poor|weak|unreliable|outdated|insecure|complicated|overpriced|avoid|buggy|deprecated|drawback\w*|lacking)\b/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function brandPattern(target: GeoBrandTarget): RegExp {
  const names = [target.name, ...(target.aliases ?? [])].filter((n) => n.trim().length > 0);
  return new RegExp(`(?<![\\w])(?:${names.map(escapeRegExp).join('|')})(?![\\w])`, 'gi');
}

function findMentions(answer: string, target: GeoBrandTarget): { count: number; firstIndex: number | null } {
  const pattern = brandPattern(target);
  let count = 0;
  let firstIndex: number | null = null;
  for (const m of answer.matchAll(pattern)) {
    count++;
    if (firstIndex === null) firstIndex = m.index ?? 0;
  }
  return { count, firstIndex };
}

export function evaluateAnswer(answer: string, brand: GeoBrandTarget, competitors: GeoBrandTarget[] = []): AnswerEvaluation {
  const text = answer.trim();
  const own = findMentions(text, brand);
  const brandMentioned = own.count > 0;
  const firstMentionPos = own.firstIndex !== null && text.length > 0 ? own.firstIndex / text.length : null;

  const domains = (brand.domains ?? []).filter((d) => d.trim().length > 0);
  const domainCited = domains.some((d) => text.toLowerCase().includes(d.toLowerCase()));

  const competitorMentions: Record<string, number> = {};
  const firstAppearances: { name: string; index: number }[] = [];
  if (own.firstIndex !== null) firstAppearances.push({ name: brand.name, index: own.firstIndex });
  for (const competitor of competitors) {
    const found = findMentions(text, competitor);
    competitorMentions[competitor.name] = found.count;
    if (found.firstIndex !== null) firstAppearances.push({ name: competitor.name, index: found.firstIndex });
  }
  firstAppearances.sort((a, b) => a.index - b.index);
  const rankIndex = firstAppearances.findIndex((a) => a.name === brand.name);
  const brandRank = rankIndex >= 0 ? rankIndex + 1 : null;

  // Sentiment: tone of the ±140-char window around each brand mention.
  let sentiment: AnswerEvaluation['sentiment'] = 'neutral';
  if (brandMentioned) {
    let positive = 0;
    let negative = 0;
    const pattern = brandPattern(brand);
    for (const m of text.matchAll(pattern)) {
      const idx = m.index ?? 0;
      const window = text.slice(Math.max(0, idx - 140), idx + m[0].length + 140);
      positive += (window.match(POSITIVE_WORDS) ?? []).length;
      negative += (window.match(NEGATIVE_WORDS) ?? []).length;
    }
    if (positive > negative) sentiment = 'positive';
    else if (negative > positive) sentiment = 'negative';
  }

  let visibilityScore = 0;
  if (brandMentioned) {
    visibilityScore = 40;
    if (firstMentionPos !== null) visibilityScore += (1 - firstMentionPos) * 20;
    if (domainCited) visibilityScore += 25;
    if (brandRank === 1) visibilityScore += 15;
    else if (brandRank === 2) visibilityScore += 8;
    else if (brandRank === 3) visibilityScore += 4;
  }

  return {
    brandMentioned,
    mentionCount: own.count,
    firstMentionPos: firstMentionPos !== null ? Math.round(firstMentionPos * 10_000) / 10_000 : null,
    domainCited,
    brandRank,
    competitorMentions,
    sentiment,
    visibilityScore: Math.max(0, Math.min(100, Math.round(visibilityScore))),
  };
}

// ─── Running a test ────────────────────────────────────────────────────────

export type GeoAnswerRunner = (model: string, promptText: string) => Promise<string>;

export interface GeoRankingResultRow {
  model: string;
  promptId: string;
  promptText: string;
  answered: boolean;
  error?: string;
  answerExcerpt: string;
  evaluation: AnswerEvaluation | null;
}

export interface GeoRankingModelSummary {
  answers: number;
  mentionRate: number;
  citationRate: number;
  shareOfVoice: number;
  avgVisibility: number;
}

export interface GeoRankingRunSummary {
  brand: string;
  models: string[];
  promptCount: number;
  answerCount: number;
  errorCount: number;
  mentionRate: number;
  citationRate: number;
  shareOfVoice: number;
  avgVisibility: number;
  avgFirstMentionPos: number | null;
  sentimentBreakdown: { positive: number; neutral: number; negative: number };
  perModel: Record<string, GeoRankingModelSummary>;
  results: GeoRankingResultRow[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface RunRankingTestOptions {
  models?: string[];
  prompts?: GeoPrompt[];
  maxPrompts?: number;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function summarize(rows: GeoRankingResultRow[]): {
  mentionRate: number; citationRate: number; shareOfVoice: number;
  avgVisibility: number; avgFirstMentionPos: number | null;
} {
  const answered = rows.filter((r) => r.answered && r.evaluation);
  if (answered.length === 0) {
    return { mentionRate: 0, citationRate: 0, shareOfVoice: 0, avgVisibility: 0, avgFirstMentionPos: null };
  }
  const mentioned = answered.filter((r) => r.evaluation!.brandMentioned);
  const cited = answered.filter((r) => r.evaluation!.domainCited);
  const ownMentions = answered.reduce((sum, r) => sum + r.evaluation!.mentionCount, 0);
  const allMentions = answered.reduce(
    (sum, r) => sum + r.evaluation!.mentionCount + Object.values(r.evaluation!.competitorMentions).reduce((a, b) => a + b, 0),
    0,
  );
  const positions = mentioned.map((r) => r.evaluation!.firstMentionPos).filter((p): p is number => p !== null);
  return {
    mentionRate: round4(mentioned.length / answered.length),
    citationRate: round4(cited.length / answered.length),
    shareOfVoice: allMentions > 0 ? round4(ownMentions / allMentions) : 0,
    avgVisibility: Math.round((answered.reduce((sum, r) => sum + r.evaluation!.visibilityScore, 0) / answered.length) * 100) / 100,
    avgFirstMentionPos: positions.length > 0 ? round4(positions.reduce((a, b) => a + b, 0) / positions.length) : null,
  };
}

/**
 * Run the ranking test: every prompt against every model. Prompts run
 * sequentially (keeps local Ollama from thrashing), models per prompt run in
 * parallel. A failing model/prompt pair is recorded, never fatal.
 */
export async function runRankingTest(
  config: GeoTargetsConfig,
  runner: GeoAnswerRunner,
  options: RunRankingTestOptions = {},
): Promise<GeoRankingRunSummary> {
  const startedAt = new Date();
  const models = (options.models && options.models.length > 0 ? options.models : config.models);
  const prompts = (options.prompts && options.prompts.length > 0 ? options.prompts : config.prompts)
    .slice(0, Math.max(1, options.maxPrompts ?? Number.MAX_SAFE_INTEGER));
  if (models.length === 0) throw new Error('geo-ranking: no models configured (set models in geo-targets.yaml or pass models)');

  const rows: GeoRankingResultRow[] = [];
  for (const prompt of prompts) {
    const settled = await Promise.allSettled(models.map((model) => runner(model, prompt.text)));
    settled.forEach((outcome, i) => {
      const model = models[i] ?? 'unknown';
      if (outcome.status === 'fulfilled' && outcome.value.trim().length > 0) {
        const answer = outcome.value;
        rows.push({
          model,
          promptId: prompt.id,
          promptText: prompt.text,
          answered: true,
          answerExcerpt: answer.slice(0, 1_000),
          evaluation: evaluateAnswer(answer, config.brand, config.competitors),
        });
      } else {
        const error = outcome.status === 'rejected' ? String(outcome.reason instanceof Error ? outcome.reason.message : outcome.reason) : 'empty answer';
        logger.warn({ model, promptId: prompt.id, error }, 'geo-ranking: prompt failed for model');
        rows.push({ model, promptId: prompt.id, promptText: prompt.text, answered: false, error, answerExcerpt: '', evaluation: null });
      }
    });
  }

  const answered = rows.filter((r) => r.answered && r.evaluation);
  const overall = summarize(rows);
  const sentimentBreakdown = { positive: 0, neutral: 0, negative: 0 };
  for (const row of answered) sentimentBreakdown[row.evaluation!.sentiment]++;

  const perModel: Record<string, GeoRankingModelSummary> = {};
  for (const model of models) {
    const modelRows = rows.filter((r) => r.model === model);
    const modelSummary = summarize(modelRows);
    perModel[model] = {
      answers: modelRows.filter((r) => r.answered).length,
      mentionRate: modelSummary.mentionRate,
      citationRate: modelSummary.citationRate,
      shareOfVoice: modelSummary.shareOfVoice,
      avgVisibility: modelSummary.avgVisibility,
    };
  }

  const finishedAt = new Date();
  return {
    brand: config.brand.name,
    models,
    promptCount: prompts.length,
    answerCount: answered.length,
    errorCount: rows.length - answered.length,
    ...overall,
    sentimentBreakdown,
    perModel,
    results: rows,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

// ─── Persistence ───────────────────────────────────────────────────────────

type PgClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

/** Store a finished run. Best-effort: logs + returns null on DB trouble. */
export async function persistRankingRun(
  db: PgClient,
  summary: GeoRankingRunSummary,
  triggeredBy: 'manual' | 'scheduled' = 'manual',
): Promise<string | null> {
  try {
    const runResult = await db.query(
      `INSERT INTO geo_ranking_runs
         (brand, triggered_by, models, prompt_count, answer_count, mention_rate,
          citation_rate, share_of_voice, avg_visibility, summary, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        summary.brand,
        triggeredBy,
        summary.models,
        summary.promptCount,
        summary.answerCount,
        summary.mentionRate,
        summary.citationRate,
        summary.shareOfVoice,
        summary.avgVisibility,
        JSON.stringify({ perModel: summary.perModel, sentimentBreakdown: summary.sentimentBreakdown, avgFirstMentionPos: summary.avgFirstMentionPos, errorCount: summary.errorCount, durationMs: summary.durationMs }),
        summary.startedAt,
        summary.finishedAt,
      ],
    );
    const runId = String(runResult.rows[0]?.['id'] ?? '');
    if (!runId) return null;

    for (const row of summary.results) {
      await db.query(
        `INSERT INTO geo_ranking_results
           (run_id, model, prompt_id, prompt_text, answered, brand_mentioned, mention_count,
            first_mention_pos, domain_cited, brand_rank, competitor_mentions, sentiment,
            visibility_score, answer_excerpt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          runId,
          row.model,
          row.promptId,
          row.promptText,
          row.answered,
          row.evaluation?.brandMentioned ?? false,
          row.evaluation?.mentionCount ?? 0,
          row.evaluation?.firstMentionPos ?? null,
          row.evaluation?.domainCited ?? false,
          row.evaluation?.brandRank ?? null,
          JSON.stringify(row.evaluation?.competitorMentions ?? {}),
          row.evaluation?.sentiment ?? 'neutral',
          row.evaluation?.visibilityScore ?? 0,
          row.answerExcerpt,
        ],
      );
    }
    logger.info({ runId, brand: summary.brand, avgVisibility: summary.avgVisibility, mentionRate: summary.mentionRate }, 'geo-ranking: run persisted');
    return runId;
  } catch (err) {
    logger.warn({ err }, 'geo-ranking: persistRankingRun failed');
    return null;
  }
}

export interface GeoRankingHistoryEntry {
  id: string;
  brand: string;
  triggeredBy: string;
  models: string[];
  promptCount: number;
  answerCount: number;
  mentionRate: number;
  citationRate: number;
  shareOfVoice: number;
  avgVisibility: number;
  startedAt: string;
  summary: Record<string, unknown>;
  /** Delta vs. the previous run (same brand), when one exists. */
  trend?: { mentionRate: number; citationRate: number; shareOfVoice: number; avgVisibility: number };
}

export async function loadRankingHistory(db: PgClient, limit = 20): Promise<GeoRankingHistoryEntry[]> {
  try {
    const result = await db.query(
      `SELECT id, brand, triggered_by, models, prompt_count, answer_count, mention_rate,
              citation_rate, share_of_voice, avg_visibility, summary, started_at
         FROM geo_ranking_runs
        ORDER BY started_at DESC
        LIMIT $1`,
      [Math.min(200, Math.max(1, limit))],
    );
    const entries: GeoRankingHistoryEntry[] = result.rows.map((row) => ({
      id: String(row['id']),
      brand: String(row['brand']),
      triggeredBy: String(row['triggered_by']),
      models: (row['models'] as string[] | null) ?? [],
      promptCount: Number(row['prompt_count'] ?? 0),
      answerCount: Number(row['answer_count'] ?? 0),
      mentionRate: Number(row['mention_rate'] ?? 0),
      citationRate: Number(row['citation_rate'] ?? 0),
      shareOfVoice: Number(row['share_of_voice'] ?? 0),
      avgVisibility: Number(row['avg_visibility'] ?? 0),
      summary: (row['summary'] as Record<string, unknown> | null) ?? {},
      startedAt: row['started_at'] instanceof Date ? (row['started_at'] as Date).toISOString() : String(row['started_at']),
    }));
    // Trend: compare each run with the next-older run for the same brand.
    for (let i = 0; i < entries.length; i++) {
      const current = entries[i]!;
      const previous = entries.slice(i + 1).find((e) => e.brand === current.brand);
      if (previous) {
        current.trend = {
          mentionRate: round4(current.mentionRate - previous.mentionRate),
          citationRate: round4(current.citationRate - previous.citationRate),
          shareOfVoice: round4(current.shareOfVoice - previous.shareOfVoice),
          avgVisibility: Math.round((current.avgVisibility - previous.avgVisibility) * 100) / 100,
        };
      }
    }
    return entries;
  } catch (err) {
    logger.warn({ err }, 'geo-ranking: loadRankingHistory failed');
    return [];
  }
}

/** Exposed for unit tests. */
export const __INTERNALS = { brandPattern, findMentions, summarize };
