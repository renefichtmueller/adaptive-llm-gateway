/**
 * GEO routes — Generative Engine Optimization API
 * -----------------------------------------------
 *   GET  /v1/geo/knowledge        embedded playbook (disciplines, techniques, crawlers, KPIs)
 *   GET  /v1/geo/targets          resolved ranking-test configuration
 *   POST /v1/geo/analyze          score content (or a URL) — incl. AEO/GEO/LLMO lenses
 *   POST /v1/geo/crawler-check    robots.txt audit for AI crawlers
 *   POST /v1/geo/llms-txt-check   llms.txt presence + structure audit
 *   POST /v1/geo/optimize         LLM-assisted rewrite with before/after scores
 *   POST /v1/geo/ranking-test     run the brand-visibility test now
 *   GET  /v1/geo/ranking-history  persisted runs incl. trend vs. previous run
 *
 * "geo" is the route family's umbrella name: the toolkit covers the whole
 * AI-visibility discipline family (GEO, AEO, LLMO) — see docs/geo.md.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { logger } from '../observability/logger.js';
import { getPool } from '../db/client.js';
import { analyzeGeo, checkAiCrawlerAccess, evaluateLlmsTxt } from '../modules/geo-analyzer.js';
import { GEO_TECHNIQUES, GEO_SOURCES, GEO_ENGINE_TYPES, GEO_DISCIPLINES, GEO_KPIS, AI_CRAWLERS } from '../modules/geo-knowledge.js';
import { optimizeContentForGeo } from '../modules/geo-optimizer.js';
import {
  loadGeoTargets,
  runRankingTest,
  persistRankingRun,
  loadRankingHistory,
  type GeoTargetsConfig,
} from '../modules/geo-ranking.js';
import { buildGeoLlm, buildRankingRunner } from '../modules/geo-monitor.js';

const MAX_CONTENT_CHARS = 400_000;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_USER_AGENT = 'adaptive-llm-gateway-geo/1.0 (+https://github.com/renefichtmueller/adaptive-llm-gateway)';

const FormatSchema = z.enum(['auto', 'html', 'markdown', 'text']).optional().default('auto');

const AnalyzeRequestSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_CHARS).optional(),
  url: z.string().url().optional(),
  format: FormatSchema,
  brand: z.string().min(1).max(200).optional(),
  brand_aliases: z.array(z.string().min(1).max(200)).max(20).optional(),
  target_queries: z.array(z.string().min(1).max(500)).max(20).optional(),
  robots_txt: z.string().max(200_000).optional(),
});

const CrawlerCheckRequestSchema = z.object({
  robots_txt: z.string().max(200_000).optional(),
  url: z.string().url().optional(),
  path: z.string().max(2_000).optional().default('/'),
});

const LlmsTxtCheckRequestSchema = z.object({
  content: z.string().max(200_000).optional(),
  url: z.string().url().optional(),
});

const OptimizeRequestSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  format: FormatSchema,
  brand: z.string().min(1).max(200).optional(),
  brand_aliases: z.array(z.string().min(1).max(200)).max(20).optional(),
  target_queries: z.array(z.string().min(1).max(500)).max(20).optional(),
  model: z.string().min(1).max(200).optional(),
  iterations: z.number().int().min(1).max(3).optional(),
});

const BrandTargetSchema = z.object({
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(200)).max(20).optional(),
  domains: z.array(z.string().min(1).max(300)).max(20).optional(),
});

const RankingTestRequestSchema = z.object({
  models: z.array(z.string().min(1).max(200)).max(10).optional(),
  prompts: z
    .array(z.object({ id: z.string().max(100).optional(), text: z.string().min(1).max(2_000), category: z.string().max(100).optional() }))
    .max(50)
    .optional(),
  max_prompts: z.number().int().min(1).max(50).optional(),
  brand: BrandTargetSchema.optional(),
  competitors: z.array(BrandTargetSchema).max(20).optional(),
  persist: z.boolean().optional().default(true),
});

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message });
}

function zodMessage(err: unknown): string {
  return err instanceof z.ZodError ? (err.errors[0]?.message ?? 'Invalid request body') : 'Invalid request body';
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': FETCH_USER_AGENT, Accept: 'text/html,text/plain,*/*' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    const text = await response.text();
    return text.slice(0, 2_000_000);
  } finally {
    clearTimeout(timer);
  }
}

export async function geoRoute(fastify: FastifyInstance): Promise<void> {
  // ── Knowledge base ──────────────────────────────────────────────────────
  fastify.get('/geo/knowledge', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      disciplines: GEO_DISCIPLINES,
      sources: GEO_SOURCES,
      engine_types: GEO_ENGINE_TYPES,
      techniques: GEO_TECHNIQUES,
      ai_crawlers: AI_CRAWLERS,
      kpis: GEO_KPIS,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Resolved targets config ─────────────────────────────────────────────
  fastify.get('/geo/targets', async (_request: FastifyRequest, reply: FastifyReply) => {
    const config = loadGeoTargets();
    if (!config) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'No GEO targets configured. Ship src/config/geo-targets.yaml or set GEO_TARGETS_PATH.',
      });
    }
    return reply.send({ targets: config, source: process.env['GEO_TARGETS_PATH'] ?? 'built-in geo-targets.yaml', timestamp: new Date().toISOString() });
  });

  // ── Content analysis ────────────────────────────────────────────────────
  fastify.post('/geo/analyze', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof AnalyzeRequestSchema>;
    try {
      body = AnalyzeRequestSchema.parse(request.body);
    } catch (err) {
      return badRequest(reply, zodMessage(err));
    }
    if (!body.content && !body.url) return badRequest(reply, 'Provide either "content" or "url"');

    const startMs = Date.now();
    try {
      let content = body.content ?? '';
      let format = body.format;
      if (!content && body.url) {
        content = await fetchText(body.url);
        format = 'html';
      }
      const analysis = analyzeGeo({
        content,
        format,
        brand: body.brand,
        brandAliases: body.brand_aliases,
        targetQueries: body.target_queries,
      });
      const crawlerAccess = body.robots_txt ? checkAiCrawlerAccess(body.robots_txt) : undefined;
      return reply.send({
        analysis,
        crawler_access: crawlerAccess ?? null,
        source_url: body.url ?? null,
        latency_ms: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err, url: body.url }, 'geo: analyze failed');
      return reply.status(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: err instanceof Error ? err.message : 'Analysis failed',
      });
    }
  });

  // ── AI crawler robots.txt audit ─────────────────────────────────────────
  fastify.post('/geo/crawler-check', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof CrawlerCheckRequestSchema>;
    try {
      body = CrawlerCheckRequestSchema.parse(request.body);
    } catch (err) {
      return badRequest(reply, zodMessage(err));
    }
    if (!body.robots_txt && !body.url) return badRequest(reply, 'Provide either "robots_txt" or "url"');

    try {
      let robotsTxt = body.robots_txt ?? '';
      let robotsUrl: string | null = null;
      if (!robotsTxt && body.url) {
        const origin = new URL(body.url).origin;
        robotsUrl = `${origin}/robots.txt`;
        robotsTxt = await fetchText(robotsUrl);
      }
      const report = checkAiCrawlerAccess(robotsTxt, body.path);
      return reply.send({ report, robots_url: robotsUrl, timestamp: new Date().toISOString() });
    } catch (err) {
      logger.error({ err, url: body.url }, 'geo: crawler-check failed');
      return reply.status(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: err instanceof Error ? err.message : 'Crawler check failed',
      });
    }
  });

  // ── llms.txt audit ──────────────────────────────────────────────────────
  fastify.post('/geo/llms-txt-check', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof LlmsTxtCheckRequestSchema>;
    try {
      body = LlmsTxtCheckRequestSchema.parse(request.body);
    } catch (err) {
      return badRequest(reply, zodMessage(err));
    }
    if (!body.content && !body.url) return badRequest(reply, 'Provide either "content" or "url"');

    let llmsTxtUrl: string | null = null;
    let content: string | null = body.content ?? null;
    if (!content && body.url) {
      const origin = new URL(body.url).origin;
      llmsTxtUrl = `${origin}/llms.txt`;
      try {
        content = await fetchText(llmsTxtUrl);
      } catch (err) {
        // Missing llms.txt is a finding, not an error — report absence.
        logger.info({ err, llmsTxtUrl }, 'geo: llms.txt not reachable, reporting as absent');
        content = null;
      }
    }
    const report = evaluateLlmsTxt(content);
    return reply.send({ report, llms_txt_url: llmsTxtUrl, timestamp: new Date().toISOString() });
  });

  // ── LLM-assisted optimization ───────────────────────────────────────────
  fastify.post('/geo/optimize', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof OptimizeRequestSchema>;
    try {
      body = OptimizeRequestSchema.parse(request.body);
    } catch (err) {
      return badRequest(reply, zodMessage(err));
    }

    const startMs = Date.now();
    try {
      const result = await optimizeContentForGeo(
        {
          content: body.content,
          format: body.format,
          brand: body.brand,
          brandAliases: body.brand_aliases,
          targetQueries: body.target_queries,
          iterations: body.iterations,
        },
        buildGeoLlm(body.model),
      );
      return reply.send({
        optimized_content: result.optimizedContent,
        score_before: result.before.geoScore,
        score_after: result.after.geoScore,
        score_delta: result.scoreDelta,
        grade_before: result.before.grade,
        grade_after: result.after.grade,
        todos: result.todos,
        iterations_run: result.iterationsRun,
        model_used: result.modelUsed,
        analysis_before: result.before,
        analysis_after: result.after,
        latency_ms: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err }, 'geo: optimize failed');
      return reply.status(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: err instanceof Error ? err.message : 'Optimization failed',
      });
    }
  });

  // ── Ranking test (run now) ──────────────────────────────────────────────
  fastify.post('/geo/ranking-test', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof RankingTestRequestSchema>;
    try {
      body = RankingTestRequestSchema.parse(request.body ?? {});
    } catch (err) {
      return badRequest(reply, zodMessage(err));
    }

    const fileConfig = loadGeoTargets();
    if (!fileConfig && !body.brand) {
      return badRequest(reply, 'No GEO targets configured — ship geo-targets.yaml, set GEO_TARGETS_PATH, or pass "brand" (+ "prompts") in the request');
    }
    const config: GeoTargetsConfig = {
      brand: body.brand ?? fileConfig!.brand,
      competitors: body.competitors ?? fileConfig?.competitors ?? [],
      models: body.models ?? fileConfig?.models ?? [],
      prompts: (body.prompts?.map((p, i) => ({ id: p.id ?? `adhoc-${i + 1}`, text: p.text, category: p.category })) ?? fileConfig?.prompts) ?? [],
    };
    if (config.prompts.length === 0) return badRequest(reply, 'No prompts configured or provided');
    if (config.models.length === 0) return badRequest(reply, 'No models configured or provided');

    const startMs = Date.now();
    try {
      const summary = await runRankingTest(config, buildRankingRunner(), { maxPrompts: body.max_prompts });
      let runId: string | null = null;
      if (body.persist) {
        runId = await persistRankingRun(getPool(), summary, 'manual');
      }
      return reply.send({
        run_id: runId,
        persisted: runId !== null,
        run: summary,
        latency_ms: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err }, 'geo: ranking-test failed');
      return reply.status(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: err instanceof Error ? err.message : 'Ranking test failed',
      });
    }
  });

  // ── Ranking history + trend ─────────────────────────────────────────────
  fastify.get('/geo/ranking-history', async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
    const limit = Math.min(200, Math.max(1, parseInt(request.query.limit ?? '20', 10) || 20));
    try {
      const history = await loadRankingHistory(getPool(), limit);
      return reply.send({ runs: history, count: history.length, timestamp: new Date().toISOString() });
    } catch (err) {
      logger.error({ err }, 'geo: ranking-history failed');
      return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Failed to load ranking history' });
    }
  });
}
