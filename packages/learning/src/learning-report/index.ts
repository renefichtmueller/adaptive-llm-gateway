/**
 * Learning Report — generates a structured weekly report of all learning activity.
 * Saves to learning_reports table and POSTs to gateway /internal/learning-report.
 */

import { query } from '../db/client.js';
import { postInternal } from '../gateway-client.js';
import { logger } from '../observability/logger.js';

// ─── Report interface ────────────────────────────────────────────────────────

export interface LearningReport {
  period: { from: string; to: string };
  ban_list: {
    new_terms_detected: number;
    new_terms_auto_promoted: number;
    top_violating_models: Array<{ model: string; hits: number }>;
    most_common_violations: Array<{ term: string; count: number }>;
  };
  few_shot: {
    examples_promoted: number;
    negative_examples_added: number;
    templates_updated: string[];
  };
  routing: {
    changes_made: number;
    avg_confidence_delta: number;
    ab_tests_completed: number;
    ab_tests_won: string[];
  };
  prompts: {
    versions_bumped: number;
    auto_applied: number;
    pending_human_review: number;
    avg_confidence_improvement: number;
  };
  fine_tuning: {
    training_examples_collected: number;
    runs_triggered: number;
    models_deployed: string[];
  };
  overall_quality: {
    avg_confidence_this_week: number;
    avg_confidence_last_week: number;
    ban_violation_rate: number;
    review_queue_growth_rate: number;
  };
}

// ─── Individual metric gatherers ─────────────────────────────────────────────

async function getBanListStats(from: Date, to: Date) {
  const detectedResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM ban_candidates WHERE created_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const promotedResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM ban_candidates
     WHERE promoted_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const topViolatingResult = await query<{ model: string; hits: string }>(
    `SELECT lc.model_used as model, COUNT(*)::int as hits
     FROM ban_analytics ba
     JOIN llm_calls lc ON lc.id = ba.call_id
     WHERE ba.created_at BETWEEN $1 AND $2
     GROUP BY lc.model_used
     ORDER BY hits DESC
     LIMIT 5`,
    [from, to],
  );

  const commonViolationsResult = await query<{ term: string; count: string }>(
    `SELECT term, COUNT(*)::int as count
     FROM ban_analytics
     WHERE created_at BETWEEN $1 AND $2
     GROUP BY term
     ORDER BY count DESC
     LIMIT 10`,
    [from, to],
  );

  return {
    new_terms_detected: parseInt(detectedResult.rows[0]?.count ?? '0'),
    new_terms_auto_promoted: parseInt(promotedResult.rows[0]?.count ?? '0'),
    top_violating_models: topViolatingResult.rows.map((r) => ({
      model: r.model,
      hits: parseInt(r.hits),
    })),
    most_common_violations: commonViolationsResult.rows.map((r) => ({
      term: r.term,
      count: parseInt(r.count),
    })),
  };
}

async function getFewShotStats(from: Date, to: Date) {
  const promotedResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM few_shot_candidates
     WHERE promoted_at BETWEEN $1 AND $2 AND is_negative = false`,
    [from, to],
  );

  const negativeResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM few_shot_candidates
     WHERE promoted_at BETWEEN $1 AND $2 AND is_negative = true`,
    [from, to],
  );

  const templatesResult = await query<{ task_type: string }>(
    `SELECT DISTINCT task_type FROM few_shot_candidates
     WHERE promoted_at BETWEEN $1 AND $2`,
    [from, to],
  );

  return {
    examples_promoted: parseInt(promotedResult.rows[0]?.count ?? '0'),
    negative_examples_added: parseInt(negativeResult.rows[0]?.count ?? '0'),
    templates_updated: templatesResult.rows.map((r) => r.task_type),
  };
}

async function getRoutingStats(from: Date, to: Date) {
  const changesResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM routing_candidates
     WHERE applied_at BETWEEN $1 AND $2 AND auto_applied = true`,
    [from, to],
  );

  const avgDeltaResult = await query<{ avg_delta: string }>(
    `SELECT AVG(candidate_avg_confidence - current_avg_confidence)::float as avg_delta
     FROM routing_candidates
     WHERE applied_at BETWEEN $1 AND $2 AND auto_applied = true`,
    [from, to],
  );

  const abCompletedResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM ab_tests
     WHERE completed_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const abWinnersResult = await query<{ task_type: string; winner: string }>(
    `SELECT task_type, winner FROM ab_tests
     WHERE completed_at BETWEEN $1 AND $2
       AND auto_promoted = true
       AND winner = challenger_model`,
    [from, to],
  );

  return {
    changes_made: parseInt(changesResult.rows[0]?.count ?? '0'),
    avg_confidence_delta: parseFloat(avgDeltaResult.rows[0]?.avg_delta ?? '0'),
    ab_tests_completed: parseInt(abCompletedResult.rows[0]?.count ?? '0'),
    ab_tests_won: abWinnersResult.rows.map((r) => `${r.task_type}→${r.winner}`),
  };
}

async function getPromptStats(from: Date, to: Date) {
  const bumpedResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM prompt_candidates WHERE created_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const autoAppliedResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM prompt_candidates
     WHERE applied_at BETWEEN $1 AND $2 AND auto_applied = true`,
    [from, to],
  );

  const pendingResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM prompt_candidates
     WHERE created_at BETWEEN $1 AND $2
       AND auto_applied = false AND human_approved IS NULL`,
    [from, to],
  );

  const avgImprovementResult = await query<{ avg: string }>(
    `SELECT AVG(test_confidence_delta)::float as avg FROM prompt_candidates
     WHERE created_at BETWEEN $1 AND $2 AND test_confidence_delta IS NOT NULL`,
    [from, to],
  );

  return {
    versions_bumped: parseInt(bumpedResult.rows[0]?.count ?? '0'),
    auto_applied: parseInt(autoAppliedResult.rows[0]?.count ?? '0'),
    pending_human_review: parseInt(pendingResult.rows[0]?.count ?? '0'),
    avg_confidence_improvement: parseFloat(avgImprovementResult.rows[0]?.avg ?? '0'),
  };
}

async function getFineTuningStats(from: Date, to: Date) {
  const corpusResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM learning_corpus WHERE created_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const runsResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count FROM fine_tuning_runs WHERE created_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const deployedResult = await query<{ output_model: string }>(
    `SELECT output_model FROM fine_tuning_runs
     WHERE completed_at BETWEEN $1 AND $2
       AND status = 'completed'
       AND output_model IS NOT NULL`,
    [from, to],
  );

  return {
    training_examples_collected: parseInt(corpusResult.rows[0]?.count ?? '0'),
    runs_triggered: parseInt(runsResult.rows[0]?.count ?? '0'),
    models_deployed: deployedResult.rows
      .map((r) => r.output_model)
      .filter((m): m is string => m !== null),
  };
}

async function getOverallQuality(from: Date, to: Date) {
  const thisWeekResult = await query<{ avg_conf: string }>(
    `SELECT AVG(confidence)::float as avg_conf FROM llm_calls WHERE created_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const lastWeekFrom = new Date(from.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastWeekTo = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

  const lastWeekResult = await query<{ avg_conf: string }>(
    `SELECT AVG(confidence)::float as avg_conf FROM llm_calls WHERE created_at BETWEEN $1 AND $2`,
    [lastWeekFrom, lastWeekTo],
  );

  const banRateResult = await query<{ total_calls: string; calls_with_hits: string }>(
    `SELECT
       COUNT(*)::int as total_calls,
       SUM(CASE WHEN jsonb_array_length(ban_hits) > 0 THEN 1 ELSE 0 END)::int as calls_with_hits
     FROM llm_calls
     WHERE created_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const reviewGrowthResult = await query<{ this_week: string; last_week: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE created_at BETWEEN $1 AND $2) as this_week,
       COUNT(*) FILTER (WHERE created_at BETWEEN $3 AND $4) as last_week
     FROM review_queue`,
    [from, to, lastWeekFrom, lastWeekTo],
  );

  const totalCalls = parseInt(banRateResult.rows[0]?.total_calls ?? '1');
  const callsWithHits = parseInt(banRateResult.rows[0]?.calls_with_hits ?? '0');
  const thisWeekReview = parseInt(reviewGrowthResult.rows[0]?.this_week ?? '0');
  const lastWeekReview = parseInt(reviewGrowthResult.rows[0]?.last_week ?? '1');

  return {
    avg_confidence_this_week: parseFloat(thisWeekResult.rows[0]?.avg_conf ?? '0'),
    avg_confidence_last_week: parseFloat(lastWeekResult.rows[0]?.avg_conf ?? '0'),
    ban_violation_rate: totalCalls > 0 ? callsWithHits / totalCalls : 0,
    review_queue_growth_rate: lastWeekReview > 0 ? (thisWeekReview - lastWeekReview) / lastWeekReview : 0,
  };
}

// ─── Main job ────────────────────────────────────────────────────────────────

export async function runLearningReport(): Promise<LearningReport> {
  const startedAt = Date.now();
  logger.info('Learning report generation started');

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [banList, fewShot, routing, prompts, fineTuning, overallQuality] = await Promise.all([
    getBanListStats(from, to),
    getFewShotStats(from, to),
    getRoutingStats(from, to),
    getPromptStats(from, to),
    getFineTuningStats(from, to),
    getOverallQuality(from, to),
  ]);

  const report: LearningReport = {
    period: { from: from.toISOString(), to: to.toISOString() },
    ban_list: banList,
    few_shot: fewShot,
    routing,
    prompts,
    fine_tuning: fineTuning,
    overall_quality: overallQuality,
  };

  // Save to DB
  await query(
    `INSERT INTO learning_reports (period_from, period_to, report_data) VALUES ($1, $2, $3)`,
    [from, to, JSON.stringify(report)],
  );

  // POST to gateway
  await postInternal('/internal/learning-report', report);

  const durationMs = Date.now() - startedAt;
  logger.info(
    {
      durationMs,
      avgConfDelta: (overallQuality.avg_confidence_this_week - overallQuality.avg_confidence_last_week).toFixed(3),
      banTermsDetected: banList.new_terms_detected,
      promptVersions: prompts.versions_bumped,
    },
    'Learning report generated',
  );

  return report;
}
