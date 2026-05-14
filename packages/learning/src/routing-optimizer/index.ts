/**
 * Routing Optimizer — auto-adjusts model routing based on performance data.
 *
 * Algorithm:
 * 1. Aggregate routing_metrics by (task_type, model_used)
 * 2. Compare against current routing-rules.yaml assignments
 * 3. Generate routing improvement candidates
 * 4. Auto-apply safe changes (confidence delta > 1.0 OR latency improvement > 30%)
 * 5. Run A/B tests for task_types with > 100 calls/day
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { query, withTransaction } from '../db/client.js';
import { postInternal } from '../gateway-client.js';
import { logger } from '../observability/logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

// Resolve path relative to this file: packages/learning/src/routing-optimizer/ → packages/gateway/src/config/
const _dir = fileURLToPath(new URL('.', import.meta.url));
const _defaultRoutingRulesPath = resolve(join(_dir, '..', '..', '..', 'gateway', 'src', 'config', 'routing-rules.yaml'));

const ROUTING_RULES_PATH =
  process.env['ROUTING_RULES_PATH'] ?? _defaultRoutingRulesPath;

const MIN_CONFIDENCE_DELTA = 1.0;
const MIN_LATENCY_IMPROVEMENT_PCT = 30;
const FALLBACK_USAGE_THRESHOLD = 0.20; // 20%
const AB_TEST_TRAFFIC_PCT = 10;
const AB_TEST_MIN_CALLS = 50;
const MIN_CALLS_FOR_AB = 100; // calls/day before we start A/B testing

// ─── Types ──────────────────────────────────────────────────────────────────

interface ModelMetrics {
  taskType: string;
  modelUsed: string;
  avgConfidence: number;
  p95LatencyMs: number;
  avgLatencyMs: number;
  successRate: number;
  totalCalls: number;
}

interface RoutingRule {
  model: string;
  fallback_model?: string;
  tier?: string;
  [key: string]: unknown;
}

interface RoutingRulesFile {
  routing_rules: Record<string, RoutingRule>;
}

interface AbTest {
  id: string;
  task_type: string;
  control_model: string;
  challenger_model: string;
  traffic_percent: number;
  control_calls: number;
  challenger_calls: number;
  control_avg_conf: number | null;
  challenger_avg_conf: number | null;
  status: string;
}

// ─── Routing rules YAML ─────────────────────────────────────────────────────

function loadRoutingRules(): RoutingRulesFile {
  const content = readFileSync(ROUTING_RULES_PATH, 'utf-8');
  return yaml.load(content) as RoutingRulesFile;
}

function writeRoutingRules(rules: RoutingRulesFile): void {
  const content = yaml.dump(rules, { lineWidth: 120 });
  writeFileSync(ROUTING_RULES_PATH, content, 'utf-8');
}

// ─── Metrics aggregation ─────────────────────────────────────────────────────

async function aggregateMetrics(lookbackHours = 168): Promise<ModelMetrics[]> {
  const result = await query<{
    task_type: string;
    model_used: string;
    avg_confidence: string;
    p95_latency_ms: string;
    avg_latency_ms: string;
    success_rate: string;
    total_calls: string;
  }>(
    `SELECT
       task_type,
       model_used,
       AVG(confidence)::float AS avg_confidence,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95_latency_ms,
       AVG(latency_ms)::float AS avg_latency_ms,
       AVG(CASE WHEN status = 'approved' THEN 1.0 ELSE 0.0 END)::float AS success_rate,
       COUNT(*)::int AS total_calls
     FROM routing_metrics
     WHERE recorded_at > now() - interval '${lookbackHours} hours'
     GROUP BY task_type, model_used
     HAVING COUNT(*) >= 10
     ORDER BY task_type, avg_confidence DESC`,
  );

  return result.rows.map((r) => ({
    taskType: r.task_type,
    modelUsed: r.model_used,
    avgConfidence: parseFloat(r.avg_confidence),
    p95LatencyMs: parseInt(r.p95_latency_ms),
    avgLatencyMs: parseFloat(r.avg_latency_ms),
    successRate: parseFloat(r.success_rate),
    totalCalls: parseInt(r.total_calls),
  }));
}

// ─── Candidate generation ────────────────────────────────────────────────────

interface RoutingCandidate {
  taskType: string;
  currentModel: string;
  candidateModel: string;
  currentAvgConf: number;
  candidateAvgConf: number;
  currentP95: number;
  candidateP95: number;
  sampleSize: number;
  reason: string;
}

function generateCandidates(
  metrics: ModelMetrics[],
  rules: RoutingRulesFile,
): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = [];

  // Group by task_type
  const byTask = new Map<string, ModelMetrics[]>();
  for (const m of metrics) {
    const list = byTask.get(m.taskType) ?? [];
    list.push(m);
    byTask.set(m.taskType, list);
  }

  for (const [taskType, taskMetrics] of byTask.entries()) {
    const rule = rules.routing_rules[taskType];
    if (!rule) continue;

    const currentModel = rule.model;
    const currentMetrics = taskMetrics.find((m) => m.modelUsed === currentModel);
    if (!currentMetrics) continue;

    for (const candidate of taskMetrics) {
      if (candidate.modelUsed === currentModel) continue;

      const confDelta = candidate.avgConfidence - currentMetrics.avgConfidence;
      const latencyImprovement =
        currentMetrics.p95LatencyMs > 0
          ? ((currentMetrics.p95LatencyMs - candidate.p95LatencyMs) / currentMetrics.p95LatencyMs) * 100
          : 0;

      if (confDelta >= MIN_CONFIDENCE_DELTA) {
        candidates.push({
          taskType,
          currentModel,
          candidateModel: candidate.modelUsed,
          currentAvgConf: currentMetrics.avgConfidence,
          candidateAvgConf: candidate.avgConfidence,
          currentP95: currentMetrics.p95LatencyMs,
          candidateP95: candidate.p95LatencyMs,
          sampleSize: candidate.totalCalls,
          reason: `confidence improvement +${confDelta.toFixed(2)}`,
        });
      } else if (
        latencyImprovement >= MIN_LATENCY_IMPROVEMENT_PCT &&
        Math.abs(confDelta) < 0.5
      ) {
        candidates.push({
          taskType,
          currentModel,
          candidateModel: candidate.modelUsed,
          currentAvgConf: currentMetrics.avgConfidence,
          candidateAvgConf: candidate.avgConfidence,
          currentP95: currentMetrics.p95LatencyMs,
          candidateP95: candidate.p95LatencyMs,
          sampleSize: candidate.totalCalls,
          reason: `latency improvement ${latencyImprovement.toFixed(0)}% with similar quality`,
        });
      }
    }

    // Check fallback usage rate
    if (rule.fallback_model) {
      const fallbackMetrics = taskMetrics.find((m) => m.modelUsed === rule.fallback_model);
      if (fallbackMetrics && currentMetrics) {
        const fallbackRatio = fallbackMetrics.totalCalls / (currentMetrics.totalCalls + fallbackMetrics.totalCalls);
        if (fallbackRatio > FALLBACK_USAGE_THRESHOLD) {
          logger.warn(
            { taskType, fallbackRatio: fallbackRatio.toFixed(2), model: currentModel },
            'Primary model fallback usage exceeds threshold — primary model may be unreliable',
          );
        }
      }
    }
  }

  return candidates;
}

// ─── Auto-apply safe changes ─────────────────────────────────────────────────

async function applyRoutingChange(
  candidate: RoutingCandidate,
  rules: RoutingRulesFile,
): Promise<void> {
  const rule = rules.routing_rules[candidate.taskType];
  if (!rule) return;

  // Move current model to fallback
  const updatedRule: RoutingRule = {
    ...rule,
    model: candidate.candidateModel,
    fallback_model: candidate.currentModel,
  };

  const updatedRules: RoutingRulesFile = {
    ...rules,
    routing_rules: {
      ...rules.routing_rules,
      [candidate.taskType]: updatedRule,
    },
  };

  writeRoutingRules(updatedRules);

  // Record in routing_candidates
  await query(
    `INSERT INTO routing_candidates
       (task_type, current_model, candidate_model, current_avg_confidence,
        candidate_avg_confidence, current_p95_latency_ms, candidate_p95_latency_ms,
        sample_size, auto_applied, applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now())`,
    [
      candidate.taskType,
      candidate.currentModel,
      candidate.candidateModel,
      candidate.currentAvgConf,
      candidate.candidateAvgConf,
      candidate.currentP95,
      candidate.candidateP95,
      candidate.sampleSize,
    ],
  );

  // Signal gateway to reload config
  await postInternal('/internal/reload-config', { reason: 'routing-optimizer', taskType: candidate.taskType });

  logger.info(
    {
      taskType: candidate.taskType,
      from: candidate.currentModel,
      to: candidate.candidateModel,
      reason: candidate.reason,
    },
    'Applied routing change',
  );
}

// ─── A/B testing ────────────────────────────────────────────────────────────

async function manageAbTests(metrics: ModelMetrics[], rules: RoutingRulesFile): Promise<void> {
  // Find task_types with > MIN_CALLS_FOR_AB calls/day
  const eligibleTasks = metrics.filter(
    (m) => m.totalCalls >= MIN_CALLS_FOR_AB && m.modelUsed === rules.routing_rules[m.taskType]?.model,
  );

  // Check for running tests to conclude
  const runningTests = await query<AbTest>(
    `SELECT * FROM ab_tests WHERE status = 'running' AND created_at < now() - interval '1 day'`,
  );

  for (const test of runningTests.rows) {
    await concludeAbTest(test, rules);
  }

  // Start new tests for eligible tasks without one
  for (const eligible of eligibleTasks) {
    const existing = await query(
      `SELECT id FROM ab_tests WHERE task_type = $1 AND status = 'running'`,
      [eligible.taskType],
    );
    if (existing.rows.length > 0) continue;

    // Find a challenger — the second-best model for this task
    const taskMetrics = metrics.filter((m) => m.taskType === eligible.taskType);
    taskMetrics.sort((a, b) => b.avgConfidence - a.avgConfidence);

    const control = taskMetrics.find((m) => m.modelUsed === eligible.modelUsed);
    const challenger = taskMetrics.find((m) => m.modelUsed !== eligible.modelUsed && m.totalCalls >= 5);

    if (!control || !challenger) continue;

    await query(
      `INSERT INTO ab_tests
         (task_type, control_model, challenger_model, traffic_percent, status)
       VALUES ($1, $2, $3, $4, 'running')`,
      [eligible.taskType, control.modelUsed, challenger.modelUsed, AB_TEST_TRAFFIC_PCT],
    );

    logger.info(
      { taskType: eligible.taskType, control: control.modelUsed, challenger: challenger.modelUsed },
      'Started A/B test',
    );
  }
}

async function concludeAbTest(test: AbTest, rules: RoutingRulesFile): Promise<void> {
  // Re-fetch latest metrics for this test
  const metricsResult = await query<{ model_used: string; avg_conf: string; call_count: string }>(
    `SELECT model_used,
            AVG(confidence)::float AS avg_conf,
            COUNT(*)::int AS call_count
     FROM routing_metrics
     WHERE task_type = $1
       AND model_used IN ($2, $3)
       AND recorded_at > (SELECT created_at FROM ab_tests WHERE id = $4)
     GROUP BY model_used`,
    [test.task_type, test.control_model, test.challenger_model, test.id],
  );

  const controlM = metricsResult.rows.find((r) => r.model_used === test.control_model);
  const challengerM = metricsResult.rows.find((r) => r.model_used === test.challenger_model);

  if (!controlM || !challengerM) {
    logger.warn({ testId: test.id }, 'A/B test: insufficient data to conclude');
    return;
  }

  const controlConf = parseFloat(controlM.avg_conf);
  const challengerConf = parseFloat(challengerM.avg_conf);
  const controlCalls = parseInt(controlM.call_count);
  const challengerCalls = parseInt(challengerM.call_count);

  if (challengerCalls < AB_TEST_MIN_CALLS) {
    logger.info({ testId: test.id, challengerCalls }, 'A/B test: not enough challenger calls yet');
    return;
  }

  const winner = challengerConf > controlConf + 0.5 ? test.challenger_model : test.control_model;
  const autoPromote = winner === test.challenger_model;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE ab_tests
       SET completed_at = now(),
           control_calls = $1,
           challenger_calls = $2,
           control_avg_conf = $3,
           challenger_avg_conf = $4,
           winner = $5,
           auto_promoted = $6,
           status = 'completed'
       WHERE id = $7`,
      [controlCalls, challengerCalls, controlConf, challengerConf, winner, autoPromote, test.id],
    );
  });

  logger.info(
    {
      taskType: test.task_type,
      winner,
      controlConf: controlConf.toFixed(2),
      challengerConf: challengerConf.toFixed(2),
    },
    'A/B test concluded',
  );

  if (autoPromote) {
    const rule = rules.routing_rules[test.task_type];
    if (rule) {
      const updatedRules: RoutingRulesFile = {
        ...rules,
        routing_rules: {
          ...rules.routing_rules,
          [test.task_type]: {
            ...rule,
            model: winner,
            fallback_model: test.control_model,
          },
        },
      };
      writeRoutingRules(updatedRules);
      await postInternal('/internal/reload-config', { reason: 'ab-test-winner', taskType: test.task_type });
      logger.info({ taskType: test.task_type, winner }, 'Auto-promoted A/B test winner');
    }
  }
}

// ─── Main job ────────────────────────────────────────────────────────────────

export async function runRoutingOptimizer(): Promise<void> {
  const startedAt = Date.now();
  logger.info('Routing optimizer job started');

  let rules: RoutingRulesFile;
  try {
    rules = loadRoutingRules();
  } catch (err) {
    logger.error({ err }, 'Failed to load routing rules — aborting');
    return;
  }

  const metrics = await aggregateMetrics();
  logger.info({ count: metrics.length }, 'Aggregated routing metrics');

  // Generate candidates
  const candidates = generateCandidates(metrics, rules);
  logger.info({ count: candidates.length }, 'Generated routing candidates');

  // Store all candidates in DB first
  for (const candidate of candidates) {
    try {
      await query(
        `INSERT INTO routing_candidates
           (task_type, current_model, candidate_model, current_avg_confidence,
            candidate_avg_confidence, current_p95_latency_ms, candidate_p95_latency_ms, sample_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          candidate.taskType,
          candidate.currentModel,
          candidate.candidateModel,
          candidate.currentAvgConf,
          candidate.candidateAvgConf,
          candidate.currentP95,
          candidate.candidateP95,
          candidate.sampleSize,
        ],
      );
    } catch {
      // Non-fatal
    }
  }

  // Auto-apply safe changes
  let applied = 0;
  const currentRules = loadRoutingRules(); // reload fresh before applying

  for (const candidate of candidates) {
    const confDelta = candidate.candidateAvgConf - candidate.currentAvgConf;
    const latencyImprovement =
      candidate.currentP95 > 0
        ? ((candidate.currentP95 - candidate.candidateP95) / candidate.currentP95) * 100
        : 0;

    const isSafe =
      (confDelta >= MIN_CONFIDENCE_DELTA) ||
      (latencyImprovement >= MIN_LATENCY_IMPROVEMENT_PCT && confDelta >= -0.3);

    if (isSafe && candidate.sampleSize >= 30) {
      await applyRoutingChange(candidate, currentRules);
      // Update local copy of rules for subsequent candidates
      const reloaded = loadRoutingRules();
      Object.assign(currentRules, reloaded);
      applied++;
    }
  }

  // Manage A/B tests
  await manageAbTests(metrics, currentRules);

  const durationMs = Date.now() - startedAt;
  logger.info({ candidates: candidates.length, applied, durationMs }, 'Routing optimizer job completed');
}
