import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { classifyInput } from '../pipeline/pre-classifier.js';
import { route } from '../pipeline/router.js';
import { resolvePrompt } from '../pipeline/prompt-resolver.js';
import {
  callOllamaWithFallbackChainInstrumented,
  callExternalProviderPrimaryInstrumented,
} from '../pipeline/instrumented-llm-client.js';
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
import { logCostImpact } from '../utils/tokenvault-hooks.js';
import { costStream } from '../observability/cost-stream.js';
import { recordRoutingDecision, trackFallbackChain } from '../observability/routing-instrumentation.js';
import { createRequestLogger } from '../modules/request-logger.js';

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
    })
    .optional(),
});

type CompletionRequest = z.infer<typeof CompletionRequestSchema>;


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

async function auditAndTrackCosts(caller: string, taskType: string, input: string, outputText: string, latencyMs: number, ollamaResponse: any, resolved: any, decision: ReturnType<typeof route>, confidenceResult: any, validationOutput: any, classificationResult: any, callId: string): Promise<{ costUsd: number; costSavedUsd: number }> {
  const inputHash = hashText(input);
  const outputHash = hashText(outputText);

  await writeAuditLog({
    caller, task_type: taskType, model_used: decision.model, prompt_id: resolved.prompt_id, prompt_version: resolved.prompt_version,
    input_hash: inputHash, output_text: confidenceResult.status !== 'pending_review' ? outputText : undefined, output_hash: outputHash,
    token_count_in: ollamaResponse.prompt_eval_count ?? 0, token_count_out: ollamaResponse.eval_count ?? 0, latency_ms: latencyMs,
    confidence: confidenceResult.score, status: confidenceResult.status, validation_log: validationOutput.results, ban_hits: validationOutput.ban_violations,
    metadata: { classification: classificationResult, model_tier: decision.tier, fallback_used: ollamaResponse.model !== decision.model },
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
  const tokensCompressed = tokensIn + tokensOut;
  const costUsd = calculateCost(decision.model, tokensIn, tokensOut);
  const costSavedUsd = calculateSavings(decision.model, tokensCompressed, tokensCompressed);

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

export async function completionRoute(fastify: FastifyInstance): Promise<void> {
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

    const { caller, input, language, context, options } = body;
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    let classifAndRoute;
    try {
      classifAndRoute = await classifyAndRoute(body.task_type, caller, input, options);
    } catch (err) {
      return reply.status(400).send({
        statusCode: 400, error: 'Routing Error',
        message: err instanceof Error ? err.message : 'Failed to route request',
      });
    }

    const { taskType, decision, classificationResult } = classifAndRoute;
    const promptVars = buildPromptVariables(input, context);
    const resolved = resolvePrompt(taskType ?? decision.prompt_template, promptVars, language ?? 'en');

    const format: '' | 'json' | undefined = decision.output_format === 'json' ? 'json' : '';
    const baseReq = { model: decision.model, prompt: resolved.prompt, system: resolved.system, options: { temperature: decision.temperature, num_predict: decision.max_tokens }, format, stream: false, callId, taskType };

    let ollamaResponse;
    try {
      ollamaResponse = await callLLMWithFallback(baseReq, decision, callId, taskType);
    } catch (err) {
      const latency = Date.now() - startMs;
      logger.error({ err, caller, taskType }, 'Ollama call failed');
      requestsTotal.labels({ caller, task_type: taskType, status: 'rejected' }).inc();
      latencySeconds.labels({ caller, task_type: taskType, model: decision.model }).observe(latency / 1000);
      const db = getPool();
      const requestLogger = createRequestLogger(db);
      void requestLogger.logRequest(callId, caller, taskType, decision.model, 'error', 0, 0, 0, latency, 0, false, err instanceof Error ? err.message : 'LLM service unavailable');
      return reply.status(503).send({ statusCode: 503, error: 'Service Unavailable', message: 'LLM service unavailable, please retry' });
    }

    const latencyMs = Date.now() - startMs;
    const outputText = ollamaResponse.response;
    const validationOutput = await runPostValidation(outputText, { validators: decision.validators, language, output_format: decision.output_format, requires_fact_check: decision.requires_fact_check, schema: resolved.schema });
    const confidenceResult = evaluateConfidence(validationOutput);

    recordAllMetrics(caller, taskType, confidenceResult, ollamaResponse, decision, validationOutput);
    const { costUsd, costSavedUsd } = await auditAndTrackCosts(caller, taskType, input, outputText, latencyMs, ollamaResponse, resolved, decision, confidenceResult, validationOutput, classificationResult, callId);

    // Fix latency observation after computation
    latencySeconds.labels({ caller, task_type: taskType, model: ollamaResponse.model ?? decision.model }).observe(latencyMs / 1000);

    const responseBody = buildResponseBody(callId, decision, taskType, confidenceResult, outputText, latencyMs, ollamaResponse, costUsd, costSavedUsd, options?.return_validation_details ?? false, validationOutput);
    return reply.status(200).send(responseBody);
  });
}
