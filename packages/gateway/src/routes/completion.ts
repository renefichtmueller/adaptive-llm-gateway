import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import yaml from 'js-yaml';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { classifyInput } from '../pipeline/pre-classifier.js';
import { route } from '../pipeline/router.js';
import { detectCaller } from '../modules/caller-detection.js';
import {
  computeCacheKey,
  getCachedResponse,
  getSemanticCachedResponse,
  setCachedResponse,
  recordCacheHit,
} from '../modules/response-cache.js';
import {
  applyPoolRouting,
  modelToSubscriptionId,
  recordSubscriptionUsage,
} from '../modules/subscription-wallet.js';
import { runRace, auditRaceResults, type RaceStrategy, type RaceCandidateResult } from '../modules/race-mode.js';
import { resolvePrompt } from '../pipeline/prompt-resolver.js';
import { getAllProviders } from '../pipeline/external-providers.js';
import {
  callOllamaWithFallbackChainInstrumented,
  callExternalProviderPrimaryInstrumented,
} from '../pipeline/instrumented-llm-client.js';
import { callOllama } from '../pipeline/llm-client.js';
import { runPostValidation } from '../pipeline/post-validator.js';
import { evaluateConfidence } from '../pipeline/confidence-gate.js';
import { writeAuditLog, writeBanAnalytics, hashText } from '../observability/audit-log.js';
import { addToReviewQueue } from '../observability/review-queue.js';
import { getPool } from '../db/client.js';
import {
  requestsTotal,
  latencySeconds,
  tokensTotal,
  confidenceScore,
  banlistHitsTotal,
  validationFailuresTotal,
} from '../observability/metrics.js';
import { logger } from '../observability/logger.js';
import { calculateCost, calculateSavings, calculateCompressionRatio } from '../observability/cost-calculator.js';
import { logCompressionMetric, logCostImpact } from '../utils/tokenvault-hooks.js';
import { costStream } from '../observability/cost-stream.js';
import { recordRoutingDecision, trackFallbackChain } from '../observability/routing-instrumentation.js';
import { createRequestLogger } from '../modules/request-logger.js';
import { compressContext, type CompressionResult } from '../modules/context-compressor.js';
import {
  scanForInjection,
  decideAction,
  llmJudge,
  getInjectionMode,
  isCallerExempt,
  type InjectionScanResult,
} from '../modules/injection-defense.js';
import {
  redactPii,
  restorePii,
  getRedactMode,
  shouldRedactFor,
} from '../modules/pii-redaction.js';
import { splitReasoningTrace, storeReasoningTrace } from '../modules/reasoning-trace.js';
import { getRoutingOverride } from '../modules/workspace-presets.js';
import { runPreComplete, runPostComplete } from '../modules/plugin-system.js';
import { getAdaptiveRecommendation } from '../modules/adaptive-routing.js';
import { guardOutputStream, getOutputDefenseMode } from '../modules/output-defense.js';

// // Disable Ollama-dependent scanners (sentinel, constitutional, embedding, attention)
// // to keep gateway scans fast and dependency-free
//   scanners: {
//     rules: true,           // 547+ rules, 50+ languages
//     sentinel: false,       // Requires Ollama
//     constitutional: false, // Requires Ollama
//     embedding: false,      // Requires Ollama
//     embeddingAnomaly: false,
//     entropy: true,         // Zero-cost entropy analysis
//     yara: false,           // Requires YARA binary
//     attention: false,      // Requires Ollama
//     canary: false,         // Not needed in gateway context
//     indirect: true,        // RAG/tool injection detection
//     selfConsciousness: false,
//     crossModel: false,
//     behavioral: true,      // Session profiling
//     unicode: true,         // Homoglyph/script detection
//     tokenizer: true,       // I.g.n.o.r.e-style attacks
//     compressedPayload: true,
//   },
//   logging: { level: 'warn', structured: true, incidentLog: false },
// } as any);  // DeepPartial config — merges with defaults

const CompletionRequestSchema = z.object({
  caller: z.string().min(1).max(100),
  task_type: z.string().optional(),
  input: z.string().min(1).max(50_000),
  language: z.enum(['de', 'en']).optional(),
  context: z.record(z.unknown()).optional(),
  options: z
    .object({
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().positive().max(16_384).optional(),
      return_validation_details: z.boolean().optional(),
      skip_cache: z.boolean().optional(),
      fuzzy_cache: z.boolean().optional(),
      fuzzy_threshold: z.number().min(0.5).max(1).optional(),
      cache_ttl: z.number().int().positive().optional(),
      compression: z
        .object({
          enabled: z.boolean().optional(),
          mode: z.enum(['auto', 'off', 'aggressive']).optional(),
          target_tokens: z.number().int().positive().max(64_000).optional(),
        })
        .optional(),
    })
    .optional(),
});

type CompletionRequest = z.infer<typeof CompletionRequestSchema>;

function shouldBypassResponseCache(caller: string): boolean {
  const normalized = caller.toLowerCase();
  return normalized.includes('claude-code')
    || normalized.includes('codex')
    || normalized.includes('copilot');
}

const ChatMessageSchema = z.object({
  role: z.string().min(1),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
});

// Tool / function-calling shape (OpenAI Chat Completions tools API).
// We accept and forward tool definitions transparently to the upstream.
const ToolFunctionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});
const ToolSchema = z.object({
  type: z.literal('function'),
  function: ToolFunctionSchema,
});

const OpenAIChatCompletionRequestSchema = z.object({
  model: z.string().min(1).default('llm-gateway-auto'),
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(16_384).optional(),
  stream: z.boolean().optional(),
  user: z.string().optional(),
  // Tool / function-calling pass-through
  tools: z.array(ToolSchema).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.literal('required'),
    z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
  ]).optional(),
  // Legacy function-calling (still supported by many clients)
  functions: z.array(ToolFunctionSchema).optional(),
  function_call: z.union([z.string(), z.object({ name: z.string() })]).optional(),
  // Response format (json_object, json_schema)
  response_format: z.object({
    type: z.enum(['text', 'json_object', 'json_schema']),
    json_schema: z.record(z.unknown()).optional(),
  }).optional(),
  // Vision: messages already accept array content via ChatMessageSchema's z.array(z.unknown())
});

type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequestSchema>;

// ─── Anthropic Messages API compat ───────────────────────────────────────────
const AnthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(z.unknown())]),
});

const AnthropicMessagesRequestSchema = z.object({
  model: z.string().min(1).default('llm-gateway-auto'),
  messages: z.array(AnthropicMessageSchema).min(1),
  system: z.union([z.string(), z.array(z.unknown())]).optional(),
  max_tokens: z.number().int().positive().max(16_384).default(1024),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

const OpenAIResponsesRequestSchema = z.object({
  model: z.string().min(1).default('llm-gateway-auto'),
  input: z.union([z.string(), z.array(z.unknown())]),
  instructions: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().positive().max(16_384).optional(),
  stream: z.boolean().optional(),
  user: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

type OpenAIResponsesRequest = z.infer<typeof OpenAIResponsesRequestSchema>;

interface GatewayCompletionResult {
  statusCode: number;
  body: Record<string, unknown>;
}


//   input: string,
//   caller: string,
// ): Promise<{ passed: boolean; reason?: string; threatLevel?: string; phase?: string; latencyMs?: number }> {
//   try {
//
//     if (result.detected) {
//       logger.warn({
//         caller,
//         threatLevel: result.threatLevel,
//         phase: result.killChainPhase,
//         action: result.action,
//         latencyMs: result.latencyMs,
//         ensemble: result.ensemble,
//         atlasMapping: result.atlasMapping?.techniqueIds?.slice(0, 5),
//         scannerCount: result.scanResults.length,
//
//       return {
//         passed: false,
//         reason: `Prompt injection detected: ${result.killChainPhase} (${result.threatLevel})`,
//         threatLevel: result.threatLevel,
//         phase: result.killChainPhase,
//         latencyMs: result.latencyMs,
//       };
//     }
//
//     return { passed: true, latencyMs: result.latencyMs };
//   } catch (err) {
//     return { passed: true };
//   }
// }

async function classifyAndRoute(taskType: string | undefined, caller: string, input: string, options: CompletionRequest['options']): Promise<{ taskType: string; decision: ReturnType<typeof route>; classificationResult?: unknown }> {
  let resolved = taskType;
  let classificationResult;
  if (!resolved) {
    try {
      classificationResult = await classifyInput(input);
      resolved = classificationResult.task_type;
    } catch (err) {
      logger.warn({ err }, 'Pre-classifier failed');
      resolved = 'generic_qa';
    }
  }

  let decision;
  try {
    decision = route(resolved, caller, { model: options?.model, temperature: options?.temperature, max_tokens: options?.max_tokens });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Failed to route request');
  }

  // Adaptive routing: when the caller did not pin a model explicitly, prefer
  // what the learner has found to work best (and cheapest) for this task
  // type. The learned fallback chain goes first; the static chain remains as
  // the tail so we never lose coverage.
  if (!options?.model) {
    const reco = getAdaptiveRecommendation(resolved);
    if (reco && reco.preferredModel !== decision.model) {
      const staticTail = decision.fallback_chain.filter(
        (m) => m !== reco.preferredModel && !reco.fallbackChain.includes(m),
      );
      logger.info(
        {
          taskType: resolved,
          staticModel: decision.model,
          adaptiveModel: reco.preferredModel,
          samples: reco.rationale.samples,
          successRate: reco.rationale.successRate,
        },
        'Adaptive routing recommendation applied',
      );
      decision = {
        ...decision,
        model: reco.preferredModel,
        fallback_chain: [reco.preferredModel, ...reco.fallbackChain, ...staticTail],
      };
    }
  }

  return { taskType: resolved, decision, classificationResult };
}

function buildPromptVariables(input: string, context: Record<string, unknown> | undefined): Record<string, unknown> & { input: string } {
  const contextVars = context ? Object.fromEntries(Object.entries(context).map(([k, v]) => [k, v as string])) : {};
  const inputAliases: Record<string, string> = {
    source_data: input, ocr_text: input, transcription: input, ticket_content: input, alert_data: input,
    incident_data: input, lldp_data: input, cve_data: input, inventory: input, anomaly_data: input,
    flagged_input: input, attack_description: input, bgp_data: input, health_checks: input, market_data: input,
    manuscript_text: input, raw_content: input, content: input, peeringdb_data: input, bgp_routes: input,
    network_context: input, alert_context: input, affected_inventory: input,
  };
  return { ...inputAliases, ...contextVars, input, user_context: context };
}

async function callLLMWithFallback(baseReq: any, decision: ReturnType<typeof route>, callId: string, taskType: string): Promise<any> {
  if (decision.provider) {
    return await callExternalProviderPrimaryInstrumented(baseReq, decision.provider, decision.tier, decision.fallback_chain, callId, taskType);
  }
  return await callOllamaWithFallbackChainInstrumented(baseReq, decision.fallback_chain, decision.tier, callId, taskType);
}

function recordAllMetrics(caller: string, taskType: string, confidenceResult: any, ollamaResponse: any, decision: ReturnType<typeof route>, validationOutput: any): void {
  requestsTotal.labels({ caller, task_type: taskType, status: confidenceResult.status }).inc();
  latencySeconds.labels({ caller, task_type: taskType, model: ollamaResponse.model ?? decision.model }).observe(0);
  tokensTotal.labels({ direction: 'in', model: decision.model }).inc(ollamaResponse.prompt_eval_count ?? 0);
  tokensTotal.labels({ direction: 'out', model: decision.model }).inc(ollamaResponse.eval_count ?? 0);
  confidenceScore.labels({ task_type: taskType, model: decision.model }).observe(confidenceResult.score);
  for (const violation of validationOutput.ban_violations) {
    banlistHitsTotal.labels({ term: violation.term, language: violation.language, category: violation.category }).inc();
  }
  for (const result of validationOutput.results) {
    if (!result.passed) {
      validationFailuresTotal.labels({ validator: result.validator, task_type: taskType }).inc();
    }
  }
}

async function auditAndTrackCosts(caller: string, taskType: string, input: string, outputText: string, latencyMs: number, ollamaResponse: any, resolved: any, decision: ReturnType<typeof route>, confidenceResult: any, validationOutput: any, classificationResult: any, callId: string, compression?: CompressionResult): Promise<{ costUsd: number; costSavedUsd: number }> {
  const inputHash = hashText(input);
  const outputHash = hashText(outputText);

  await writeAuditLog({
    caller, task_type: taskType, model_used: decision.model, prompt_id: resolved.prompt_id, prompt_version: resolved.prompt_version,
    input_hash: inputHash, output_text: confidenceResult.status !== 'pending_review' ? outputText : undefined, output_hash: outputHash,
    token_count_in: ollamaResponse.prompt_eval_count ?? 0, token_count_out: ollamaResponse.eval_count ?? 0, latency_ms: latencyMs,
    confidence: confidenceResult.score, status: confidenceResult.status, validation_log: validationOutput.results, ban_hits: validationOutput.ban_violations,
    metadata: {
      classification: classificationResult,
      model_tier: decision.tier,
      fallback_used: ollamaResponse.model !== decision.model,
      compression: compression ? buildCompressionResponse(compression) : undefined,
    },
  });

  if (validationOutput.ban_violations.length > 0) {
    void writeBanAnalytics(callId, validationOutput.ban_violations, caller, taskType);
  }

  if (confidenceResult.status === 'pending_review') {
    void addToReviewQueue({ callId, caller, taskType, inputText: input, outputText, confidence: confidenceResult.score, validationLog: validationOutput.results });
  }

  const db = getPool();
  const tokensIn = ollamaResponse.prompt_eval_count ?? 0;
  const tokensOut = ollamaResponse.eval_count ?? 0;
  const tokensCompressed = (compression?.tokensAfter ?? tokensIn) + tokensOut;
  const costUsd = calculateCost(decision.model, tokensIn, tokensOut);
  const costSavedUsd = compression?.applied
    ? calculateSavings(decision.model, compression.tokensBefore, compression.tokensAfter)
    : 0;

  void logCompressionMetric(db, {
    filePath: callId,
    mode: compression ? `${compression.method}:${compression.strategy}` : 'none:none',
    tokensBefore: compression?.tokensBefore ?? tokensIn,
    tokensAfter: compression?.tokensAfter ?? tokensIn,
    savingsPct: compression ? Math.round(compression.ratio * 10000) / 100 : 0,
    toolUsed: 'gateway',
  });

  void logCostImpact(db, callId, { callId, agent: 'gateway', model: decision.model, project: 'llm-gateway', taskType: taskType ?? 'generic' }, tokensIn, tokensOut, tokensCompressed, costUsd, costSavedUsd, confidenceResult.score);

  void recordRoutingDecision({ callId, taskType: taskType ?? 'generic', caller, routingModel: decision.model, routingTier: decision.tier, actualModelUsed: ollamaResponse.model ?? decision.model, wasFallback: ollamaResponse.model !== decision.model, success: confidenceResult.status === 'approved', confidenceFinal: confidenceResult.score, tokensIn, tokensOut, latencyMs, costUsd });

  costStream.broadcast({ callId, project: 'llm-gateway', taskType: taskType ?? 'generic', model: decision.model, costUsd, costSavedUsd, tokensIn, tokensOut, confidence: confidenceResult.score, timestamp: new Date().toISOString() });

  const requestLogger = createRequestLogger(db);
  void requestLogger.logRequest(callId, caller, taskType, decision.model, confidenceResult.status as 'approved' | 'warning' | 'pending_review' | 'rejected' | 'error', tokensIn, tokensOut, costUsd, latencyMs, confidenceResult.score, ollamaResponse.model !== decision.model, undefined);

  return { costUsd, costSavedUsd };
}

function buildResponseBody(callId: string, decision: ReturnType<typeof route>, taskType: string, confidenceResult: any, outputText: string, latencyMs: number, ollamaResponse: any, costUsd: number, costSavedUsd: number, returnValidationDetails: boolean, validationOutput: any): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: callId, status: confidenceResult.status, confidence: Math.round(confidenceResult.score * 100) / 100,
    model: decision.model, task_type: taskType, latency_ms: latencyMs,
    tokens: { in: ollamaResponse.prompt_eval_count ?? 0, out: ollamaResponse.eval_count ?? 0 },
    cost: { usd: costUsd, saved_usd: costSavedUsd },
  };
  if (confidenceResult.status !== 'pending_review') {
    body['output'] = outputText;
  } else {
    body['output'] = null;
    body['message'] = 'Output is pending human review due to low confidence';
  }
  if (returnValidationDetails) {
    body['validation'] = validationOutput.results;
    body['confidence_detail'] = { base_score: confidenceResult.base_score, total_impact: confidenceResult.total_impact, final_score: confidenceResult.score };
  }
  return body;
}

async function executeCompletion(body: CompletionRequest, startMs: number, callId: string): Promise<GatewayCompletionResult> {
  const { caller, language, context, options } = body;

  // ─── Plugin pre-hooks (PLUGINS_DIR) ────────────────────────────────────
  try {
    const preResult = await runPreComplete({ caller, callId, request: body as unknown as Record<string, unknown> });
    if (preResult === null) {
      return { statusCode: 422, body: { error: 'plugin_aborted', message: 'Request aborted by plugin pre-hook' } };
    }
    if (preResult && typeof preResult === 'object') {
      Object.assign(body as unknown as Record<string, unknown>, preResult);
    }
  } catch (err) {
    logger.warn({ err }, 'Plugin preComplete failed; continuing');
  }

  // ─── PII Redaction (REDACT_PII_MODE: off|cloud_only|always) ─────────────
  const redactMode = getRedactMode();
  let piiRestoreMap: Map<string, string> | null = null;
  if (redactMode !== 'off' && shouldRedactFor(redactMode, 'unknown', caller)) {
    const r = redactPii(body.input);
    if (r.restoreMap.size > 0) {
      body = { ...body, input: r.redacted };
      piiRestoreMap = r.restoreMap;
      logger.info(
        { callId, caller, redactedCounts: r.counts, redactedTokens: r.restoreMap.size },
        'PII redaction applied',
      );
    }
  }

  // ─── Prompt-injection defense (configurable via INJECTION_DEFENSE_MODE) ──
  const injectionMode = getInjectionMode();
  let injectionScan: InjectionScanResult | null = null;
  if (injectionMode !== 'off' && !isCallerExempt(caller)) {
    injectionScan = scanForInjection(body.input);
    const action = decideAction(injectionMode, injectionScan);
    if (action === 'block') {
      logger.warn(
        { caller, callId, score: injectionScan.score, matches: injectionScan.matches.map((m) => m.id) },
        'Injection defense blocked request',
      );
      return {
        statusCode: 422,
        body: {
          error: 'injection_detected',
          message: 'Request blocked by prompt-injection defense layer',
          score: injectionScan.score,
          matches: injectionScan.matches,
        },
      };
    }
    if (action === 'llm_judge') {
      try {
        const verdict = await llmJudge(body.input, {
          model: 'qwen2.5:3b',
          callLLM: async (req) => {
            const resp = await callOllama(
              { model: req.model, prompt: req.prompt, system: req.system, stream: false, options: { temperature: 0, num_predict: 8, ...(req.options ?? {}) } },
              'fast',
            );
            return { response: resp.response };
          },
        });
        if (verdict.verdict === 'injection') {
          return {
            statusCode: 422,
            body: {
              error: 'injection_detected',
              message: 'Request blocked by LLM-judge verdict',
              score: injectionScan.score,
              llm_judge: verdict,
              matches: injectionScan.matches,
            },
          };
        }
      } catch (err) {
        logger.warn({ err }, 'Injection LLM-judge failed; allowing through with warning');
      }
    }
    // action === 'warn' or 'allow' falls through; metadata is recorded later
  }

  // ─── Cache check (Tier 1: exact-match hash lookup) ─────────────────────
  const agenticNoCache = shouldBypassResponseCache(caller);
  const skipCache = agenticNoCache || (options as any)?.skip_cache === true;
  const cacheableReq = {
    caller,
    task_type: body.task_type,
    model: options?.model,
    system: typeof context === 'object' && context && 'system' in context ? String((context as any).system ?? '') : '',
    input: body.input,
  };
  const cacheKey = computeCacheKey(cacheableReq);
  const fuzzyEnabled = !agenticNoCache && (options as any)?.fuzzy_cache !== false; // default ON
  const fuzzyThreshold = typeof (options as any)?.fuzzy_threshold === 'number'
    ? Math.max(0.5, Math.min(1.0, (options as any).fuzzy_threshold))
    : 0.85; // empirically good default for nomic-embed-text — paraphrases hit, unrelated misses
  if (!skipCache) {
    const dbForCache = getPool();
    let hit = await getCachedResponse(dbForCache, cacheKey);
    let matchType: 'exact' | 'semantic' = 'exact';
    let similarity: number | undefined;

    // Fall through to semantic match when exact misses
    if (!hit && fuzzyEnabled) {
      const semHit = await getSemanticCachedResponse(
        dbForCache,
        caller,
        body.task_type,
        body.input,
        fuzzyThreshold
      );
      if (semHit) {
        hit = semHit;
        matchType = 'semantic';
        similarity = semHit.similarity;
      }
    }
    if (hit) {
      const latencyMs = Date.now() - startMs;
      void recordCacheHit(dbForCache, hit.id);
      // Log cache hit as a successful request (status=approved, fallback=false)
      const requestLogger = createRequestLogger(dbForCache);
      void requestLogger.logRequest(
        callId,
        caller,
        body.task_type,
        (hit.responseJson['model'] as string) ?? 'cache',
        'approved',
        hit.tokensIn,
        hit.tokensOut,
        0, // zero cost for cache hit
        latencyMs,
        (hit.responseJson['confidence'] as number) ?? 10,
        false,
        undefined
      );
      logger.info(
        { callId, caller, matchType, similarity, ageSeconds: hit.ageSeconds, hitCount: hit.hitCount + 1, costSaved: hit.costWhenCached },
        `Cache HIT (${matchType}) — skipping pipeline`
      );
      return {
        statusCode: 200,
        body: {
          ...hit.responseJson,
          id: callId, // refresh id so callers can deduplicate logs
          cache: {
            hit: true,
            match_type: matchType,
            similarity: similarity ?? null,
            age_seconds: hit.ageSeconds,
            hit_count: hit.hitCount + 1,
            cost_saved_usd: hit.costWhenCached,
            tokens_saved: hit.tokensIn + hit.tokensOut,
          },
          latency_ms: latencyMs,
        } as Record<string, unknown>,
      };
    }
  }

  const compression = compressContext(body.input, {
    enabled: options?.compression?.enabled,
    mode: options?.compression?.mode,
    targetTokens: options?.compression?.target_tokens,
  });
  const input = compression.input;

  let classifAndRoute;
  try {
    classifAndRoute = await classifyAndRoute(body.task_type, caller, input, options);
  } catch (err) {
    return {
      statusCode: 400,
      body: {
        statusCode: 400, error: 'Routing Error',
        message: err instanceof Error ? err.message : 'Failed to route request',
      },
    };
  }

  const { taskType, decision, classificationResult } = classifAndRoute;

  // ─── Pool Routing: re-route to the subscription with most headroom ─────
  let poolRouteApplied: string | null = null;
  try {
    const adjusted = await applyPoolRouting(getPool(), {
      model: decision.model,
      fallback_chain: decision.fallback_chain,
      tier: decision.tier,
    });
    if (adjusted) {
      logger.info({ callId, original: decision.model, switched: adjusted.model, reason: adjusted.reason }, 'Pool routing engaged');
      decision.model = adjusted.model;
      decision.fallback_chain = adjusted.fallback_chain;
      poolRouteApplied = adjusted.reason;
    }
  } catch (poolErr) {
    logger.debug({ poolErr }, 'pool routing skipped');
  }

  const promptVars = buildPromptVariables(input, context);
  const resolved = resolvePrompt(taskType ?? decision.prompt_template, promptVars, language ?? 'en');

  const format: '' | 'json' | undefined = decision.output_format === 'json' ? 'json' : '';
  const baseReq = { model: decision.model, prompt: resolved.prompt, system: resolved.system, options: { temperature: decision.temperature, num_predict: decision.max_tokens }, format, stream: false, callId, taskType };

  let ollamaResponse;
  try {
    ollamaResponse = await callLLMWithFallback(baseReq, decision, callId, taskType);
  } catch (err) {
    const latency = Date.now() - startMs;
    logger.error({ err, caller, taskType }, 'LLM call failed');
    requestsTotal.labels({ caller, task_type: taskType, status: 'rejected' }).inc();
    latencySeconds.labels({ caller, task_type: taskType, model: decision.model }).observe(latency / 1000);
    const db = getPool();
    const requestLogger = createRequestLogger(db);
    void requestLogger.logRequest(callId, caller, taskType, decision.model, 'error', 0, 0, 0, latency, 0, false, err instanceof Error ? err.message : 'LLM service unavailable');
    return { statusCode: 503, body: { statusCode: 503, error: 'Service Unavailable', message: 'LLM service unavailable, please retry' } };
  }

  const latencyMs = Date.now() - startMs;
  const outputText = ollamaResponse.response;
  const validationOutput = await runPostValidation(outputText, { validators: decision.validators, language, output_format: decision.output_format, requires_fact_check: decision.requires_fact_check, schema: resolved.schema });
  const confidenceResult = evaluateConfidence(validationOutput);

  recordAllMetrics(caller, taskType, confidenceResult, ollamaResponse, decision, validationOutput);
  const { costUsd, costSavedUsd } = await auditAndTrackCosts(caller, taskType, compression.originalInput, outputText, latencyMs, ollamaResponse, resolved, decision, confidenceResult, validationOutput, classificationResult, callId, compression);

  latencySeconds.labels({ caller, task_type: taskType, model: ollamaResponse.model ?? decision.model }).observe(latencyMs / 1000);

  // ─── Record subscription usage for the wallet ────────────────────────
  const usedModel = ollamaResponse.model ?? decision.model;
  const subscriptionId = modelToSubscriptionId(usedModel);
  if (subscriptionId) {
    void recordSubscriptionUsage(getPool(), subscriptionId, (ollamaResponse.eval_count ?? 0) + (ollamaResponse.prompt_eval_count ?? 0));
  }

  const responseBody = {
    ...buildResponseBody(callId, decision, taskType, confidenceResult, outputText, latencyMs, ollamaResponse, costUsd, costSavedUsd, options?.return_validation_details ?? false, validationOutput),
    compression: buildCompressionResponse(compression),
    ...(poolRouteApplied ? { pool_route: { applied: true, reason: poolRouteApplied } } : {}),
  };

  // ─── Cache write — only successful, validated responses are cached ──────
  // Skip caching when:
  //   • caller explicitly opted out via options.skip_cache
  //   • response was rejected/pending review (don't cache bad answers)
  //   • non-deterministic temperature (>0.5) was set (would poison the cache)
  const tempUsed = decision.temperature ?? 0.3;
  const shouldCache = !skipCache && confidenceResult.status === 'approved' && tempUsed <= 0.5;
  if (shouldCache) {
    const tokensIn = ollamaResponse.prompt_eval_count ?? 0;
    const tokensOut = ollamaResponse.eval_count ?? 0;
    void setCachedResponse(getPool(), cacheableReq, responseBody, {
      cost: costUsd,
      tokensIn,
      tokensOut,
      ttlSeconds: typeof (options as any)?.cache_ttl === 'number' ? (options as any).cache_ttl : 86_400,
    });
  }

  return { statusCode: 200, body: responseBody };
}

function buildCompressionResponse(compression: CompressionResult): Record<string, unknown> {
  return {
    applied: compression.applied,
    method: compression.method,
    tokens_before: compression.tokensBefore,
    tokens_after: compression.tokensAfter,
    tokens_saved: compression.tokensSaved,
    ratio: Math.round(compression.ratio * 1000) / 1000,
    strategy: compression.strategy,
    tags: compression.tags,
    notes: compression.notes,
  };
}

function contentToText(content: OpenAIChatCompletionRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof (part as any).text === 'string') {
      return (part as any).text;
    }
    return '';
  }).filter(Boolean).join('\n');
}

function responsesInputToText(input: OpenAIResponsesRequest['input']): string {
  if (typeof input === 'string') return input;
  return input.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    const value = item as any;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) {
      return value.content.map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.input_text || part.output_text || '';
        return '';
      }).filter(Boolean).join('\n');
    }
    if (typeof value.text === 'string') return value.text;
    return '';
  }).filter(Boolean).join('\n\n');
}

function openAIRequestToGatewayRequest(body: OpenAIChatCompletionRequest, request: FastifyRequest): CompletionRequest {
  // Use layered caller-detection (header → companion → body → user-agent → fallback)
  const { caller } = detectCaller(request, 'openai-compatible', body.user);

  const input = body.messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role}: ${contentToText(message.content)}`)
    .join('\n\n')
    .trim();

  const system = body.messages
    .filter((message) => message.role === 'system')
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join('\n\n');

  const model = ['auto', 'llm-gateway-auto', 'gateway-auto'].includes(body.model) ? undefined : body.model;
  const agenticNoCache = shouldBypassResponseCache(caller);

  return {
    caller,
    task_type: 'generic_qa',
    input: input || contentToText(body.messages[body.messages.length - 1]?.content),
    context: system ? { system } : undefined,
    options: {
      model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      skip_cache: agenticNoCache,
      fuzzy_cache: !agenticNoCache,
      compression: { enabled: true, mode: 'auto' },
    },
  };
}

function responsesRequestToGatewayRequest(body: OpenAIResponsesRequest, request: FastifyRequest): CompletionRequest {
  const metadataCaller = typeof body.metadata?.['caller'] === 'string' ? String(body.metadata['caller']) : undefined;
  const { caller } = detectCaller(request, 'responses-compatible', body.user || metadataCaller);
  const model = ['auto', 'llm-gateway-auto', 'gateway-auto'].includes(body.model) ? undefined : body.model;
  const agenticNoCache = shouldBypassResponseCache(caller);

  return {
    caller,
    task_type: 'generic_qa',
    input: responsesInputToText(body.input),
    context: body.instructions ? { system: body.instructions } : undefined,
    options: {
      model,
      temperature: body.temperature,
      max_tokens: body.max_output_tokens,
      skip_cache: agenticNoCache,
      fuzzy_cache: !agenticNoCache,
      compression: { enabled: true, mode: 'auto' },
    },
  };
}

// ─── Anthropic Messages API mappers ─────────────────────────────────────────
function anthropicContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (typeof b['text'] === 'string') return b['text'];
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function anthropicRequestToGatewayRequest(body: AnthropicMessagesRequest, request: FastifyRequest): CompletionRequest {
  const metadataUser = typeof body.metadata?.['user_id'] === 'string' ? String(body.metadata['user_id']) : undefined;
  const { caller } = detectCaller(request, 'anthropic-compatible', metadataUser);

  const input = body.messages
    .map((m) => `${m.role}: ${anthropicContentToText(m.content)}`)
    .join('\n\n')
    .trim();

  const system = body.system ? anthropicContentToText(body.system) : '';
  const model = ['auto', 'llm-gateway-auto', 'gateway-auto'].includes(body.model) ? undefined : body.model;
  const agenticNoCache = shouldBypassResponseCache(caller);

  return {
    caller,
    task_type: 'generic_qa',
    input: input || anthropicContentToText(body.messages[body.messages.length - 1]?.content),
    context: system ? { system } : undefined,
    options: {
      model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      skip_cache: agenticNoCache,
      fuzzy_cache: !agenticNoCache,
      compression: { enabled: true, mode: 'auto' },
    },
  };
}

function toAnthropicMessagesResponse(result: Record<string, unknown>, requestedModel: string): Record<string, unknown> {
  const output = typeof result['output'] === 'string' ? result['output'] : '';
  const tokens = result['tokens'] as { in?: number; out?: number } | undefined;
  const model = typeof result['model'] === 'string' ? result['model'] : requestedModel;
  const stopReason = result['status'] === 'pending_review' ? 'content_filtered' : 'end_turn';
  return {
    id: result['id'] ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: output }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: tokens?.in ?? 0,
      output_tokens: tokens?.out ?? 0,
    },
    gateway: {
      status: result['status'],
      confidence: result['confidence'],
      cost: result['cost'],
      latency_ms: result['latency_ms'],
      compression: result['compression'],
    },
  };
}

function toAnthropicError(result: GatewayCompletionResult): Record<string, unknown> {
  const message =
    (typeof result.body['message'] === 'string' && result.body['message']) ||
    (typeof result.body['error'] === 'string' && result.body['error']) ||
    'Internal error';
  return {
    type: 'error',
    error: {
      type: result.statusCode === 400 ? 'invalid_request_error' : 'api_error',
      message,
    },
  };
}

function toOpenAIChatResponse(result: Record<string, unknown>, requestedModel: string): Record<string, unknown> {
  const output = typeof result['output'] === 'string' ? result['output'] : '';
  const tokens = result['tokens'] as { in?: number; out?: number } | undefined;
  const model = typeof result['model'] === 'string' ? result['model'] : requestedModel;
  return {
    id: result['id'] ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: output },
        finish_reason: result['status'] === 'pending_review' ? 'content_filter' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: tokens?.in ?? 0,
      completion_tokens: tokens?.out ?? 0,
      total_tokens: (tokens?.in ?? 0) + (tokens?.out ?? 0),
    },
    gateway: {
      status: result['status'],
      confidence: result['confidence'],
      cost: result['cost'],
      latency_ms: result['latency_ms'],
      compression: result['compression'],
    },
  };
}

function toOpenAIResponsesResponse(result: Record<string, unknown>, requestedModel: string): Record<string, unknown> {
  const output = typeof result['output'] === 'string' ? result['output'] : '';
  const tokens = result['tokens'] as { in?: number; out?: number } | undefined;
  const model = typeof result['model'] === 'string' ? result['model'] : requestedModel;
  const id = String(result['id'] ?? `resp-${Date.now()}`);
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [
      {
        id: `${id}-msg`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: output, annotations: [] }],
      },
    ],
    output_text: output,
    usage: {
      input_tokens: tokens?.in ?? 0,
      output_tokens: tokens?.out ?? 0,
      total_tokens: (tokens?.in ?? 0) + (tokens?.out ?? 0),
    },
    gateway: {
      status: result['status'],
      confidence: result['confidence'],
      cost: result['cost'],
      latency_ms: result['latency_ms'],
      compression: result['compression'],
    },
  };
}

/**
 * Stream a non-streaming gateway response back to the client as
 * OpenAI-compatible Server-Sent Events. Chunks the assistant content
 * by ~32-char windows so SDKs that drive UIs see progressive output.
 *
 * Real upstream streaming (token-by-token from Ollama) is wired through
 * separately for providers that natively support stream=true; this helper
 * is the fallback path for the unified completion pipeline.
 */
const STREAM_CONTENT_STEP = 32;

async function* iterateContentChunks(content: string, step: number): AsyncGenerator<string, void, unknown> {
  for (let i = 0; i < content.length; i += step) {
    yield content.slice(i, i + step);
  }
}

async function streamOpenAIChatResponse(reply: FastifyReply, response: Record<string, unknown>): Promise<FastifyReply> {
  const choices = (response['choices'] as Array<Record<string, unknown>>) ?? [];
  const message = (choices[0]?.['message'] as Record<string, unknown>) ?? {};
  const content = typeof message['content'] === 'string' ? (message['content'] as string) : '';
  const toolCalls = message['tool_calls'];
  const id = String(response['id'] ?? `chatcmpl-${Date.now()}`);
  const created = Number(response['created'] ?? Math.floor(Date.now() / 1000));
  const model = String(response['model'] ?? 'llm-gateway-auto');

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  // 1) initial role chunk
  writeChunk({ role: 'assistant' });

  // 2) content chunks — piped through output-defense guard so secret leaks
  //    or sysprompt echoes can be cut/tagged mid-stream (see modules/output-defense.ts).
  //    When OUTPUT_DEFENSE_MODE=off (default), guardOutputStream is a transparent passthrough.
  if (content) {
    const defenseMode = getOutputDefenseMode();
    const upstream = iterateContentChunks(content, STREAM_CONTENT_STEP);
    const guarded = guardOutputStream(upstream, {
      mode: defenseMode,
      onDetect: (result) => {
        logger.warn(
          { matches: result.matches, score: result.score, id, model, mode: defenseMode },
          'Output-defense triggered on streaming response',
        );
      },
    });
    for await (const chunk of guarded) {
      writeChunk({ content: chunk });
    }
  }

  // 3) tool_calls (if present) — flush as a single delta with the full structure
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    writeChunk({ tool_calls: toolCalls });
  }

  // 4) finish marker + DONE sentinel
  writeChunk({}, 'stop');
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
  return reply;
}

function toOpenAIError(result: GatewayCompletionResult): Record<string, unknown> {
  return {
    error: {
      message: String(result.body['message'] ?? result.body['error'] ?? 'Gateway request failed'),
      type: String(result.body['error'] ?? 'gateway_error').toLowerCase().replace(/\s+/g, '_'),
      code: result.statusCode,
    },
  };
}

function listGatewayModels(): Record<string, unknown> {
  const ids = new Set<string>(['llm-gateway-auto']);

  for (const provider of getAllProviders()) {
    for (const model of provider.models) ids.add(model.id);
  }

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const yamlPath = join(__dirname, '..', 'config', 'models.yaml');
    if (existsSync(yamlPath)) {
      const cfg: any = yaml.load(readFileSync(yamlPath, 'utf-8'));
      for (const id of Object.keys(cfg.models ?? {})) ids.add(id);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load local model list for /v1/models');
  }

  return {
    object: 'list',
    data: [...ids].sort().map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: id === 'llm-gateway-auto' ? 'llm-gateway' : 'gateway-provider',
    })),
  };
}

export async function completionRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/models', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(listGatewayModels());
  });

  fastify.post('/chat/completions', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = Date.now();
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          message: parsed.error.errors[0]?.message ?? 'Invalid chat completion request',
          type: 'invalid_request_error',
          code: 400,
        },
      });
    }

    const callId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const gatewayRequest = openAIRequestToGatewayRequest(parsed.data, request);
    const result = await executeCompletion(gatewayRequest, startMs, callId);

    if (result.statusCode !== 200) {
      return reply.status(result.statusCode).send(toOpenAIError(result));
    }

    const response = toOpenAIChatResponse(result.body, parsed.data.model);
    if (parsed.data.stream) {
      return await streamOpenAIChatResponse(reply, response);
    }

    return reply.status(200).send(response);
  });

  // Anthropic Messages API compatibility — accept @anthropic-ai/sdk traffic.
  fastify.post('/messages', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = Date.now();
    const parsed = AnthropicMessagesRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: parsed.error.errors[0]?.message ?? 'Invalid messages request',
        },
      });
    }

    const callId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const gatewayRequest = anthropicRequestToGatewayRequest(parsed.data, request);
    const result = await executeCompletion(gatewayRequest, startMs, callId);

    if (result.statusCode !== 200) {
      return reply.status(result.statusCode).send(toAnthropicError(result));
    }

    const response = toAnthropicMessagesResponse(result.body, parsed.data.model);
    if (parsed.data.stream) {
      // Minimal SSE — emit the whole response as a single content_block_delta then message_stop.
      const text = (response.content as Array<{ text: string }>)[0]?.text ?? '';
      const lines = [
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...response, content: [], usage: { input_tokens: (response.usage as any).input_tokens, output_tokens: 0 } } })}`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: response.stop_reason, stop_sequence: null }, usage: { output_tokens: (response.usage as any).output_tokens } })}`,
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
      ];
      return reply
        .header('Content-Type', 'text/event-stream; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .send(lines.join('\n\n') + '\n\n');
    }
    return reply.status(200).send(response);
  });

  fastify.post('/responses', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = Date.now();
    const parsed = OpenAIResponsesRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          message: parsed.error.errors[0]?.message ?? 'Invalid responses request',
          type: 'invalid_request_error',
          code: 400,
        },
      });
    }

    const callId = `resp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // ─── Subscription-bridge passthrough for gpt-* models ────────────────
    // OpenAI's Responses API is consumed primarily by Codex.app + Codex CLI,
    // both of which authenticate against a ChatGPT-Plus/Pro subscription via
    // OAuth — not against the pay-per-token API. The codex-bridge process
    // The codex-bridge wraps `codex exec` and exposes an
    // OpenAI-compatible /v1/chat/completions endpoint that speaks the
    // subscription. When the user sends a gpt-5*/gpt-4*/codex-* model here,
    // we forward through the bridge so the subscription quota is honoured
    // rather than the request being mis-routed to a local fallback model.
    //
    // To enable: set CODEX_BRIDGE_URL to your bridge endpoint
    // and run the codex-bridge service. If the env var is unset, the
    // call falls through to the standard pipeline.
    if (/^gpt-/i.test(parsed.data.model ?? '')) {
      try {
        const bridgeUrl = process.env['CODEX_BRIDGE_URL'];
        if (!bridgeUrl) {
          // CODEX_BRIDGE_URL not configured — skip passthrough, fall through.
          throw new Error('CODEX_BRIDGE_URL not set');
        }
        const inputText = typeof parsed.data.input === 'string'
          ? parsed.data.input
          : (Array.isArray(parsed.data.input)
              ? parsed.data.input
                  .map((p: any) => typeof p?.content === 'string'
                    ? p.content
                    : (Array.isArray(p?.content) ? p.content.map((c: any) => c?.text ?? '').join(' ') : ''))
                  .join(' ')
              : '');
        const upstream = await fetch(`${bridgeUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: parsed.data.model,
            messages: [{ role: 'user', content: inputText }],
          }),
        });
        const upstreamJson: any = await upstream.json();
        if (upstream.ok && upstreamJson?.success !== false) {
          const text = upstreamJson?.content
            ?? upstreamJson?.response
            ?? upstreamJson?.choices?.[0]?.message?.content
            ?? '';
          const respBody = toOpenAIResponsesResponse(
            { output: text, model: parsed.data.model, status: 'approved' },
            parsed.data.model,
          );
          logger.info({ callId, model: parsed.data.model, len: text.length }, 'codex-bridge passthrough OK');
          // Quota tracking against the unified OpenAI subscription pool.
          try {
            const subId = modelToSubscriptionId(parsed.data.model ?? '') ?? 'codex';
            void recordSubscriptionUsage(getPool(), subId, 0);
          } catch (e) {
            logger.warn({ e, callId }, 'failed to record subscription usage for passthrough');
          }
          if (parsed.data.stream) {
            return reply
              .header('Content-Type', 'text/event-stream; charset=utf-8')
              .header('Cache-Control', 'no-cache')
              .send(`data: ${JSON.stringify({ type: 'response.completed', response: respBody })}\n\ndata: [DONE]\n\n`);
          }
          return reply.send(respBody);
        }
        logger.warn({ callId, model: parsed.data.model, upstreamJson }, 'codex-bridge upstream non-OK; falling back to standard pipeline');
      } catch (err) {
        logger.error({ err, callId, model: parsed.data.model }, 'codex-bridge passthrough threw; falling back');
      }
    }

    const gatewayRequest = responsesRequestToGatewayRequest(parsed.data, request);
    const result = await executeCompletion(gatewayRequest, startMs, callId);

    if (result.statusCode !== 200) {
      return reply.status(result.statusCode).send(toOpenAIError(result));
    }

    const response = toOpenAIResponsesResponse(result.body, parsed.data.model);
    if (parsed.data.stream) {
      return reply
        .header('Content-Type', 'text/event-stream; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .send(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`);
    }
    return reply.send(response);
  });

  // ─── Multi-Model Race Mode endpoint ────────────────────────────────────
  // Runs the same prompt against multiple models in parallel; returns
  // according to `strategy` (first | best | consensus). Audits each
  // candidate run for later analysis.
  fastify.post('/race', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = Date.now();
    const body = request.body as {
      caller?: string;
      task_type?: string;
      input?: string;
      models?: string[];
      strategy?: RaceStrategy;
      timeout_ms?: number;
      options?: any;
    };
    if (!body?.input || !Array.isArray(body.models) || body.models.length < 2) {
      return reply.status(400).send({
        error: 'race endpoint requires { input: string, models: string[] (>=2) }',
      });
    }
    const callerId = body.caller ?? 'race-client';
    const strategy: RaceStrategy = (body.strategy as RaceStrategy) ?? 'first';
    const callId = `race-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const runner = async (model: string, _signal: AbortSignal) => {
      const candStart = Date.now();
      const result = await executeCompletion({
        caller: callerId,
        task_type: body.task_type ?? 'generic_qa',
        input: body.input!,
        options: { ...(body.options ?? {}), model, skip_cache: true },
      } as CompletionRequest, candStart, `${callId}-${model}`);
      const ok = result.statusCode === 200;
      const r = result.body as Record<string, unknown>;
      return {
        model,
        status: ok ? 'ok' : 'error',
        output: typeof r['output'] === 'string' ? r['output'] : undefined,
        confidence: typeof r['confidence'] === 'number' ? r['confidence'] : undefined,
        cost: typeof r['cost'] === 'number' ? r['cost'] : undefined,
        latencyMs: Date.now() - candStart,
        errorMessage: !ok ? String(r['message'] ?? r['error'] ?? 'unknown') : undefined,
      } as RaceCandidateResult;
    };

    try {
      const { outcome } = await runRace(body.models, runner, strategy, { timeoutMs: body.timeout_ms ?? 60_000 });
      void auditRaceResults(getPool(), callId, callerId, body.task_type ?? 'generic_qa', outcome);
      return reply.send({
        success: true,
        call_id: callId,
        strategy: outcome.strategy,
        selected: {
          model: outcome.selected.model,
          output: outcome.selected.output,
          confidence: outcome.selected.confidence,
          cost: outcome.selected.cost,
          latency_ms: outcome.selected.latencyMs,
        },
        agreement_score: outcome.agreementScore ?? null,
        candidates: outcome.candidates.map((c) => ({
          model: c.model,
          status: c.status,
          confidence: c.confidence,
          latency_ms: c.latencyMs,
          error: c.errorMessage,
        })),
        total_latency_ms: Date.now() - startMs,
      });
    } catch (err) {
      logger.error({ err, callId }, 'race endpoint failed');
      return reply.status(500).send({ error: 'race failed', message: err instanceof Error ? err.message : 'unknown' });
    }
  });

  fastify.post('/completion', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = Date.now();

    let body: CompletionRequest;
    try {
      body = CompletionRequestSchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({
        statusCode: 400, error: 'Bad Request',
        message: err instanceof z.ZodError ? err.errors[0]?.message ?? 'Invalid request' : 'Invalid request body',
      });
    }

    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const result = await executeCompletion(body, startMs, callId);
    return reply.status(result.statusCode).send(result.body);
  });
}
