/**
 * Prompt Optimizer — uses the LLM to improve its own prompts.
 *
 * Algorithm:
 * 1. For each active task_type with > 20 calls in the last 7 days:
 *    - Pull 5 highest + 5 lowest confidence outputs
 *    - Pull all human-edited gold examples
 *    - Pull top ban_list violations for this task_type
 * 2. Send to LLM (internal-prompt-improve) for analysis
 * 3. Store candidate improved prompt
 * 4. Auto-apply for non-sensitive task_types if confidence delta >= 0.3
 * 5. Queue for human review for sensitive task_types
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { query, withTransaction } from '../db/client.js';
import { callGateway } from '../gateway-client.js';
import { logger } from '../observability/logger.js';
import { bumpMinorVersion } from '../few-shot-curator/index.js';
import { PromptOptimizer } from '@llm-gateway/prompt-optimizer';

// ─── Constants ──────────────────────────────────────────────────────────────

const _dir = fileURLToPath(new URL('.', import.meta.url));
const _defaultTemplatesDir = resolve(join(_dir, '..', '..', '..', 'gateway', 'prompts', 'templates'));

const TEMPLATES_DIR =
  process.env['TEMPLATES_DIR'] ?? _defaultTemplatesDir;

// Task types that MUST have human review before prompt updates go live
const SENSITIVE_TASK_TYPES = new Set([
  'linkedin-post-de',
  'newsletter-dispatch-de',
  'infra-x-edit-review',
]);

const MIN_CALLS_FOR_OPTIMIZATION = 20;
const MIN_CONFIDENCE_DELTA_FOR_AUTO_APPLY = 0.3;
const LOOKBACK_DAYS = 7;

// ─── Types ──────────────────────────────────────────────────────────────────

interface SampleOutput {
  id: string;
  task_type: string;
  input_text: string;
  output_text: string;
  confidence: number;
}

interface GoldEdit {
  input_text: string;
  original_output: string;
  edited_output: string;
  reviewer_notes: string | null;
}

interface BanViolation {
  term: string;
  count: number;
}

interface LlmImprovementResponse {
  analysis: {
    main_problems: string[];
    main_strengths: string[];
  };
  improved_system_prompt: string;
  changes_made: string[];
  expected_improvements: string[];
}

interface PromptQualityAnalysis {
  currentScore: number;
  improvedScore: number;
  scoreDelta: number;
  currentDimensions: { clarity: number; specificity: number; completeness: number; efficiency: number };
  improvedDimensions: { clarity: number; specificity: number; completeness: number; efficiency: number };
  currentPatternCount: number;
  improvedPatternCount: number;
  suggestedFramework: string;
  tokenSavings: number;
}

interface PromptTemplate {
  id: string;
  version: string;
  system_prompt?: string;
  system_prompt_de?: string;
  negative_examples?: Array<{ input: string; bad_output: string; why_bad: string }>;
  [key: string]: unknown;
}

// ─── Template I/O ────────────────────────────────────────────────────────────

function loadTemplateForTask(taskType: string): { template: PromptTemplate; filePath: string } | null {
  try {
    const normalized = taskType.replace(/-/g, '_');
    const filePath = join(TEMPLATES_DIR, `${normalized}.yaml`);
    const content = readFileSync(filePath, 'utf-8');
    const template = yaml.load(content) as PromptTemplate;
    return { template, filePath };
  } catch {
    return null;
  }
}

function writeTemplate(filePath: string, template: PromptTemplate): void {
  const content = yaml.dump(template, { lineWidth: 120, quotingType: '"' });
  writeFileSync(filePath, content, 'utf-8');
}

// ─── Data gathering ──────────────────────────────────────────────────────────

async function gatherTaskData(taskType: string): Promise<{
  positive: SampleOutput[];
  negative: SampleOutput[];
  gold: GoldEdit[];
  banViolations: BanViolation[];
} | null> {
  // Check call volume
  const volumeResult = await query<{ cnt: string }>(
    `SELECT COUNT(*)::int AS cnt FROM llm_calls
     WHERE task_type = $1 AND created_at > now() - interval '${LOOKBACK_DAYS} days'`,
    [taskType],
  );
  const volume = parseInt(volumeResult.rows[0]?.cnt ?? '0');
  if (volume < MIN_CALLS_FOR_OPTIMIZATION) return null;

  // Positive examples (highest confidence)
  const posResult = await query<SampleOutput>(
    `SELECT lc.id, lc.task_type, rq.input_text, lc.output_text, lc.confidence::float as confidence
     FROM llm_calls lc
     LEFT JOIN review_queue rq ON rq.call_id = lc.id
     WHERE lc.task_type = $1
       AND lc.confidence >= 8.0
       AND lc.status = 'approved'
       AND lc.output_text IS NOT NULL
       AND lc.created_at > now() - interval '${LOOKBACK_DAYS} days'
     ORDER BY lc.confidence DESC
     LIMIT 5`,
    [taskType],
  );

  // Negative examples (lowest confidence)
  const negResult = await query<SampleOutput>(
    `SELECT lc.id, lc.task_type, rq.input_text, lc.output_text, lc.confidence::float as confidence
     FROM llm_calls lc
     LEFT JOIN review_queue rq ON rq.call_id = lc.id
     WHERE lc.task_type = $1
       AND lc.confidence <= 5.0
       AND lc.output_text IS NOT NULL
       AND lc.created_at > now() - interval '${LOOKBACK_DAYS} days'
     ORDER BY lc.confidence ASC
     LIMIT 5`,
    [taskType],
  );

  // Gold examples from human edits
  const goldResult = await query<GoldEdit>(
    `SELECT rq.input_text, rq.output_text as original_output, rq.edited_output, rq.reviewer_notes
     FROM review_queue rq
     WHERE rq.task_type = $1
       AND rq.decision = 'edited'
       AND rq.edited_output IS NOT NULL
       AND rq.reviewed_at > now() - interval '${LOOKBACK_DAYS} days'`,
    [taskType],
  );

  // Ban violations for this task type
  const banResult = await query<BanViolation>(
    `SELECT term, COUNT(*)::int as count
     FROM ban_analytics
     WHERE task_type = $1
       AND created_at > now() - interval '${LOOKBACK_DAYS} days'
     GROUP BY term
     ORDER BY count DESC
     LIMIT 5`,
    [taskType],
  );

  if (posResult.rows.length === 0 && negResult.rows.length === 0) return null;

  return {
    positive: posResult.rows,
    negative: negResult.rows,
    gold: goldResult.rows,
    banViolations: banResult.rows,
  };
}

// ─── LLM improvement call ───────────────────────────────────────────────────

async function buildImprovementPrompt(
  currentPrompt: string,
  positive: SampleOutput[],
  negative: SampleOutput[],
  gold: GoldEdit[],
  banViolations: BanViolation[],
): Promise<string> {
  const optimizer = new PromptOptimizer();
  const currentAnalysis = await optimizer.optimize(currentPrompt, 'analysis');

  const formatSample = (s: SampleOutput, idx: number) =>
    `[${idx + 1}] Confidence: ${s.confidence.toFixed(1)}\n${s.output_text.slice(0, 400)}`;

  const formatGold = (g: GoldEdit, idx: number) =>
    `[${idx + 1}] Human edit:\nOriginal: ${g.original_output.slice(0, 200)}\nCorrected: ${g.edited_output.slice(0, 200)}${g.reviewer_notes ? `\nNote: ${g.reviewer_notes}` : ''}`;

  return JSON.stringify({
    current_system_prompt: currentPrompt,
    current_quality_metrics: {
      overall_score: currentAnalysis.qualityScore.overall,
      dimensions: currentAnalysis.qualityScore.dimensions,
      detected_patterns: currentAnalysis.qualityScore.detectedPatterns.map((p: { category: string }) => p.category),
      suggested_framework: currentAnalysis.framework,
    },
    positive_examples: positive.map(formatSample).join('\n\n'),
    negative_examples: negative.map(formatSample).join('\n\n'),
    human_edits: gold.map(formatGold).join('\n\n'),
    ban_violations: banViolations.map((b) => `"${b.term}" (${b.count} times)`).join(', '),
  });
}

async function callPromptImprover(input: string): Promise<LlmImprovementResponse | null> {
  try {
    const result = await callGateway({
      taskType: 'internal-prompt-improve',
      input,
      caller: 'internal',
    });

    const parsed = JSON.parse(result.output) as LlmImprovementResponse;
    if (!parsed.improved_system_prompt || !parsed.analysis) {
      logger.warn({ output: result.output.slice(0, 200) }, 'Malformed LLM improvement response');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error({ err }, 'Prompt improvement LLM call failed');
    return null;
  }
}

// ─── Test improved prompt using PromptOptimizer ────────────────────────────────

async function testImprovedPrompt(
  taskType: string,
  currentPrompt: string,
  newPrompt: string,
  testInputs: SampleOutput[],
): Promise<PromptQualityAnalysis> {
  if (testInputs.length === 0) {
    return {
      currentScore: 0,
      improvedScore: 0,
      scoreDelta: 0,
      currentDimensions: { clarity: 0, specificity: 0, completeness: 0, efficiency: 0 },
      improvedDimensions: { clarity: 0, specificity: 0, completeness: 0, efficiency: 0 },
      currentPatternCount: 0,
      improvedPatternCount: 0,
      suggestedFramework: 'RTF',
      tokenSavings: 0,
    };
  }

  const optimizer = new PromptOptimizer();

  // Take sample inputs to analyze
  const samples = testInputs.slice(0, 3);
  const analysisResults: PromptQualityAnalysis[] = [];

  for (const sample of samples) {
    const currentResult = await optimizer.optimize(currentPrompt, taskType);
    const improvedResult = await optimizer.optimize(newPrompt, taskType);

    analysisResults.push({
      currentScore: currentResult.qualityScore.overall,
      improvedScore: improvedResult.qualityScore.overall,
      scoreDelta: improvedResult.qualityScore.overall - currentResult.qualityScore.overall,
      currentDimensions: currentResult.qualityScore.dimensions,
      improvedDimensions: improvedResult.qualityScore.dimensions,
      currentPatternCount: currentResult.qualityScore.detectedPatterns.length,
      improvedPatternCount: improvedResult.qualityScore.detectedPatterns.length,
      suggestedFramework: improvedResult.framework,
      tokenSavings: improvedResult.tokenDelta.savings,
    });
  }

  // Average results across samples
  const avg = (results: PromptQualityAnalysis[], key: keyof PromptQualityAnalysis): number => {
    const sum = results.reduce((acc, r) => acc + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);
    return sum / results.length;
  };

  return {
    currentScore: avg(analysisResults, 'currentScore'),
    improvedScore: avg(analysisResults, 'improvedScore'),
    scoreDelta: avg(analysisResults, 'scoreDelta'),
    currentDimensions: {
      clarity: avg(analysisResults, 'currentDimensions'),
      specificity: avg(analysisResults, 'currentDimensions'),
      completeness: avg(analysisResults, 'currentDimensions'),
      efficiency: avg(analysisResults, 'currentDimensions'),
    },
    improvedDimensions: {
      clarity: avg(analysisResults, 'improvedDimensions'),
      specificity: avg(analysisResults, 'improvedDimensions'),
      completeness: avg(analysisResults, 'improvedDimensions'),
      efficiency: avg(analysisResults, 'improvedDimensions'),
    },
    currentPatternCount: Math.round(avg(analysisResults, 'currentPatternCount')),
    improvedPatternCount: Math.round(avg(analysisResults, 'improvedPatternCount')),
    suggestedFramework: analysisResults[0]?.suggestedFramework ?? 'RTF',
    tokenSavings: Math.round(avg(analysisResults, 'tokenSavings')),
  };
}

// ─── Apply prompt change ─────────────────────────────────────────────────────

async function applyPromptCandidate(
  taskType: string,
  template: PromptTemplate,
  filePath: string,
  improvement: LlmImprovementResponse,
  currentPromptKey: 'system_prompt' | 'system_prompt_de',
  candidateId: string,
): Promise<void> {
  const newVersion = bumpMinorVersion(template.version);

  const updatedTemplate: PromptTemplate = {
    ...template,
    version: newVersion,
    [currentPromptKey]: improvement.improved_system_prompt,
  };

  writeTemplate(filePath, updatedTemplate);

  // Record in prompt_versions
  const templateYaml = readFileSync(filePath, 'utf-8');
  await query(
    `INSERT INTO prompt_versions (prompt_id, version, task_type, template_yaml, active, deployed_by, notes)
     VALUES ($1, $2, $3, $4, true, 'prompt-optimizer', $5)
     ON CONFLICT (prompt_id, version) DO NOTHING`,
    [
      template.id,
      newVersion,
      taskType,
      templateYaml,
      improvement.changes_made.join('; '),
    ],
  );

  // Mark candidate as applied
  await query(
    `UPDATE prompt_candidates SET auto_applied = true, applied_at = now(), candidate_version = $1 WHERE id = $2`,
    [newVersion, candidateId],
  );

  logger.info(
    { taskType, version: newVersion, changes: improvement.changes_made },
    'Prompt candidate auto-applied',
  );
}

// ─── Main job ────────────────────────────────────────────────────────────────

export async function runPromptOptimizer(): Promise<void> {
  const startedAt = Date.now();
  logger.info('Prompt optimizer job started');

  // Get all distinct active task_types from recent calls
  const taskTypesResult = await query<{ task_type: string }>(
    `SELECT DISTINCT task_type
     FROM llm_calls
     WHERE created_at > now() - interval '${LOOKBACK_DAYS} days'
       AND task_type NOT LIKE 'internal-%'
       AND task_type NOT LIKE 'pre_classify%'
     ORDER BY task_type`,
  );

  const taskTypes = taskTypesResult.rows.map((r) => r.task_type);
  logger.info({ count: taskTypes.length }, 'Found active task types');

  let versionsCreated = 0;
  let autoApplied = 0;
  let pendingReview = 0;

  for (const taskType of taskTypes) {
    try {
      const data = await gatherTaskData(taskType);
      if (!data) continue;

      const loaded = loadTemplateForTask(taskType);
      if (!loaded) continue;

      const { template, filePath } = loaded;
      const currentPrompt = template.system_prompt ?? '';
      if (!currentPrompt) continue;

      // Build and send improvement request
      const input = await buildImprovementPrompt(
        currentPrompt,
        data.positive,
        data.negative,
        data.gold,
        data.banViolations,
      );

      const improvement = await callPromptImprover(input);
      if (!improvement) continue;

      // Validate: new prompt must be at least as long
      if (improvement.improved_system_prompt.length < currentPrompt.length * 0.8) {
        logger.warn({ taskType }, 'Improved prompt is too short, skipping');
        continue;
      }

      // Estimate quality analysis with comprehensive metrics
      const qualityAnalysis = await testImprovedPrompt(taskType, currentPrompt, improvement.improved_system_prompt, data.negative);
      const newVersion = bumpMinorVersion(template.version);

      // Store candidate with comprehensive quality metrics
      const insertResult = await query<{ id: string }>(
        `INSERT INTO prompt_candidates
           (template_id, current_version, candidate_version, current_system_prompt,
            candidate_system_prompt, improvement_rationale, changes_made,
            expected_improvements, test_confidence_delta, current_quality_score,
            improved_quality_score, current_dimensions, improved_dimensions,
            pattern_reduction_count, suggested_framework, estimated_token_savings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          template.id,
          template.version,
          newVersion,
          currentPrompt,
          improvement.improved_system_prompt,
          improvement.analysis.main_problems.join('; '),
          improvement.changes_made,
          improvement.expected_improvements,
          qualityAnalysis.scoreDelta,
          qualityAnalysis.currentScore,
          qualityAnalysis.improvedScore,
          JSON.stringify(qualityAnalysis.currentDimensions),
          JSON.stringify(qualityAnalysis.improvedDimensions),
          qualityAnalysis.currentPatternCount - qualityAnalysis.improvedPatternCount,
          qualityAnalysis.suggestedFramework,
          qualityAnalysis.tokenSavings,
        ],
      );

      const candidateId = insertResult.rows[0]?.id;
      if (!candidateId) continue;

      versionsCreated++;

      const isSensitive = SENSITIVE_TASK_TYPES.has(taskType);
      const meetsAutoApplyThreshold = qualityAnalysis.scoreDelta >= MIN_CONFIDENCE_DELTA_FOR_AUTO_APPLY;

      if (!isSensitive && meetsAutoApplyThreshold) {
        await applyPromptCandidate(
          taskType,
          template,
          filePath,
          improvement,
          'system_prompt',
          candidateId,
        );
        autoApplied++;
      } else {
        // Queue for human review
        const humanReviewInput = [
          `Task type: ${taskType}`,
          `Current version: ${template.version} → Proposed: ${newVersion}`,
          `Problems identified: ${improvement.analysis.main_problems.join(', ')}`,
          `Changes: ${improvement.changes_made.join(', ')}`,
          '',
          'CURRENT PROMPT:',
          currentPrompt.slice(0, 500),
          '',
          'PROPOSED PROMPT:',
          improvement.improved_system_prompt.slice(0, 500),
        ].join('\n');

        await query(
          `INSERT INTO review_queue
             (call_id, caller, task_type, input_text, output_text, confidence, validation_log)
           VALUES (NULL, 'prompt-optimizer', $1, $2, $3, $4, $5)`,
          [
            taskType,
            humanReviewInput,
            improvement.improved_system_prompt,
            qualityAnalysis.scoreDelta,
            JSON.stringify({
              currentScore: qualityAnalysis.currentScore,
              improvedScore: qualityAnalysis.improvedScore,
              dimensions: qualityAnalysis.improvedDimensions,
              patternReduction: qualityAnalysis.currentPatternCount - qualityAnalysis.improvedPatternCount,
              framework: qualityAnalysis.suggestedFramework,
              tokenSavings: qualityAnalysis.tokenSavings,
            }),
          ],
        );

        pendingReview++;
        logger.info({ taskType, reason: isSensitive ? 'sensitive' : 'low-delta' }, 'Prompt candidate queued for human review');
      }
    } catch (err) {
      logger.error({ err, taskType }, 'Prompt optimizer failed for task type');
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info(
    { versionsCreated, autoApplied, pendingReview, durationMs },
    'Prompt optimizer job completed',
  );
}
