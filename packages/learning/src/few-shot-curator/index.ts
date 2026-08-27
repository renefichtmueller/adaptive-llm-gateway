/**
 * Few-Shot Curator — auto-promotes high-quality outputs to prompt templates.
 *
 * Algorithm:
 * 1. Pull outputs with confidence >= 9.0 AND status='approved'
 * 2. Check diversity vs existing few-shot examples (TF-IDF cosine similarity)
 * 3. When 3+ candidates for a task_type accumulate → update YAML template
 * 4. Handle negative examples from rejected review_queue items
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { query, withTransaction } from '../db/client.js';
import { logger } from '../observability/logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const _dir = fileURLToPath(new URL('.', import.meta.url));
const _defaultTemplatesDir = resolve(join(_dir, '..', '..', '..', 'gateway', 'prompts', 'templates'));

const TEMPLATES_DIR =
  process.env['TEMPLATES_DIR'] ?? _defaultTemplatesDir;

const MIN_CONFIDENCE = 9.0;
const SIMILARITY_THRESHOLD = 0.7;
const CANDIDATES_REQUIRED = 3;
const MAX_FEW_SHOT_LENGTH = 800; // chars — too long clutters the prompt

// ─── TF-IDF cosine similarity (no ML needed) ────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function buildTfVector(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  // TF = count / total
  const total = tokens.length;
  const tf = new Map<string, number>();
  for (const [term, count] of freq.entries()) {
    tf.set(term, count / total);
  }
  return tf;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, valA] of a.entries()) {
    const valB = b.get(term) ?? 0;
    dot += valA * valB;
    normA += valA * valA;
  }
  for (const valB of b.values()) {
    normB += valB * valB;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function maxSimilarityToSet(candidate: string, existingTexts: string[]): number {
  if (existingTexts.length === 0) return 0;
  const candVec = buildTfVector(tokenize(candidate));
  let maxSim = 0;
  for (const text of existingTexts) {
    const sim = cosineSimilarity(candVec, buildTfVector(tokenize(text)));
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim;
}

// ─── Template YAML handling ─────────────────────────────────────────────────

interface FewShotExample {
  user: string;
  assistant: string;
}

interface NegativeExample {
  input: string;
  bad_output: string;
  why_bad: string;
}

interface PromptTemplate {
  id: string;
  version: string;
  task_type?: string;
  system_prompt?: string;
  system_prompt_de?: string;
  user_template?: string;
  user_template_de?: string;
  few_shot_examples?: FewShotExample[];
  negative_examples?: NegativeExample[];
  variables?: string[];
  [key: string]: unknown;
}

function loadTemplate(taskType: string): { template: PromptTemplate; filePath: string } | null {
  try {
    const files = readdirSync(TEMPLATES_DIR);
    const fileName = files.find((f) => f.replace('.yaml', '') === taskType);
    if (!fileName) return null;

    const filePath = join(TEMPLATES_DIR, fileName);
    const content = readFileSync(filePath, 'utf-8');
    const template = yaml.load(content) as PromptTemplate;
    return { template, filePath };
  } catch (err) {
    logger.error({ err, taskType }, 'Failed to load template');
    return null;
  }
}

function bumpPatchVersion(version: string): string {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3) return version;
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

function bumpMinorVersion(version: string): string {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3) return version;
  const [major, minor] = parts;
  return `${major}.${(minor ?? 0) + 1}.0`;
}

function writeTemplate(filePath: string, template: PromptTemplate): void {
  const content = yaml.dump(template, { lineWidth: 120, quotingType: '"' });
  writeFileSync(filePath, content, 'utf-8');
}

async function recordPromptVersion(
  template: PromptTemplate,
  filePath: string,
  notes: string,
): Promise<void> {
  const content = readFileSync(filePath, 'utf-8');
  await query(
    `INSERT INTO prompt_versions (prompt_id, version, task_type, template_yaml, active, deployed_by, notes)
     VALUES ($1, $2, $3, $4, true, 'few-shot-curator', $5)
     ON CONFLICT (prompt_id, version) DO NOTHING`,
    [template.id, template.version, template.id, content, notes],
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface HighConfOutput {
  id: string;
  task_type: string;
  input_text: string;
  output_text: string;
  confidence: number;
}

interface RejectedOutput {
  id: string;
  call_id: string | null;
  task_type: string;
  input_text: string;
  output_text: string;
  reviewer_notes: string | null;
}

// ─── Main job ───────────────────────────────────────────────────────────────

export async function runFewShotCurator(): Promise<void> {
  const startedAt = Date.now();
  logger.info('Few-shot curator job started');

  // 1. Pull high-confidence approved outputs not yet processed
  const highConfResult = await query<HighConfOutput>(
    `SELECT lc.id, lc.task_type, rq.input_text, lc.output_text, lc.confidence::float as confidence
     FROM llm_calls lc
     JOIN review_queue rq ON rq.call_id = lc.id
     WHERE lc.confidence >= $1
       AND lc.status = 'approved'
       AND lc.output_text IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM few_shot_candidates fsc
         WHERE fsc.llm_call_id = lc.id
       )
     ORDER BY lc.confidence DESC
     LIMIT 200`,
    [MIN_CONFIDENCE],
  );

  // Also try without review_queue join (direct calls that bypassed review)
  const directHighConfResult = await query<HighConfOutput>(
    `SELECT lc.id, lc.task_type, '' as input_text, lc.output_text, lc.confidence::float as confidence
     FROM llm_calls lc
     WHERE lc.confidence >= $1
       AND lc.status = 'approved'
       AND lc.output_text IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM few_shot_candidates fsc
         WHERE fsc.llm_call_id = lc.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM review_queue rq WHERE rq.call_id = lc.id
       )
     ORDER BY lc.confidence DESC
     LIMIT 100`,
    [MIN_CONFIDENCE],
  );

  const allHighConf = [...highConfResult.rows, ...directHighConfResult.rows];
  logger.info({ count: allHighConf.length }, 'Pulled high-confidence outputs');

  // 2. Pull rejected outputs for negative examples
  const rejectedResult = await query<RejectedOutput>(
    `SELECT rq.id, rq.call_id, rq.task_type, rq.input_text, rq.output_text, rq.reviewer_notes
     FROM review_queue rq
     WHERE rq.decision = 'rejected'
       AND rq.reviewed_at > now() - interval '7 days'
       AND NOT EXISTS (
         SELECT 1 FROM few_shot_candidates fsc
         WHERE fsc.llm_call_id = rq.call_id AND fsc.is_negative = true
       )`,
  );

  logger.info({ count: rejectedResult.rows.length }, 'Pulled rejected outputs for negative examples');

  // 3. Group by task_type and check diversity
  const byTaskType = new Map<string, HighConfOutput[]>();
  for (const output of allHighConf) {
    const list = byTaskType.get(output.task_type) ?? [];
    list.push(output);
    byTaskType.set(output.task_type, list);
  }

  let totalPromoted = 0;
  let totalNegative = 0;

  // 4. Process each task_type
  for (const [taskType, outputs] of byTaskType.entries()) {
    const loaded = loadTemplate(taskType);
    if (!loaded) {
      // No template file for this task_type — store as candidates anyway
      for (const output of outputs) {
        await storeFewShotCandidate(output, null);
      }
      continue;
    }

    const { template, filePath } = loaded;
    const existingExamples = (template.few_shot_examples ?? []).map((e) => e.assistant);

    const goodCandidates: Array<{ output: HighConfOutput; similarity: number }> = [];

    for (const output of outputs) {
      // Skip too-long outputs
      if (output.output_text.length > MAX_FEW_SHOT_LENGTH) continue;

      const similarity = maxSimilarityToSet(output.output_text, existingExamples);
      await storeFewShotCandidate(output, similarity);

      if (similarity < SIMILARITY_THRESHOLD) {
        goodCandidates.push({ output, similarity });
      }
    }

    // 5. Promote if enough diverse candidates
    if (goodCandidates.length >= CANDIDATES_REQUIRED) {
      // Pick the best (highest confidence, most diverse)
      goodCandidates.sort((a, b) => {
        // Score = confidence + (1 - similarity) → favor high confidence + low similarity
        const scoreA = a.output.confidence + (1 - a.similarity);
        const scoreB = b.output.confidence + (1 - b.similarity);
        return scoreB - scoreA;
      });

      const best = goodCandidates[0];
      if (!best) continue;

      const newExample: FewShotExample = {
        user: best.output.input_text || `[auto-curated from task: ${taskType}]`,
        assistant: best.output.output_text,
      };

      const updatedTemplate: PromptTemplate = {
        ...template,
        version: bumpPatchVersion(template.version),
        few_shot_examples: [...(template.few_shot_examples ?? []), newExample],
      };

      writeTemplate(filePath, updatedTemplate);
      await recordPromptVersion(
        updatedTemplate,
        filePath,
        `Added few-shot example (confidence: ${best.output.confidence.toFixed(1)}, similarity: ${best.similarity.toFixed(3)})`,
      );

      // Mark as promoted in DB
      await query(
        `UPDATE few_shot_candidates
         SET promoted = true, promoted_at = now(), template_version = $1
         WHERE llm_call_id = $2`,
        [updatedTemplate.version, best.output.id],
      );

      totalPromoted++;
      logger.info(
        {
          taskType,
          version: updatedTemplate.version,
          confidence: best.output.confidence,
          similarity: best.similarity,
        },
        'Added few-shot example to template',
      );
    }
  }

  // 6. Handle negative examples from rejections
  for (const rejected of rejectedResult.rows) {
    const loaded = loadTemplate(rejected.task_type);
    if (!loaded) continue;

    const { template, filePath } = loaded;
    const negExample: NegativeExample = {
      input: rejected.input_text,
      bad_output: rejected.output_text,
      why_bad: rejected.reviewer_notes ?? 'Rejected by human reviewer',
    };

    const updatedTemplate: PromptTemplate = {
      ...template,
      version: bumpPatchVersion(template.version),
      negative_examples: [...(template.negative_examples ?? []), negExample],
    };

    writeTemplate(filePath, updatedTemplate);
    await recordPromptVersion(
      updatedTemplate,
      filePath,
      `Added negative example from review_queue rejection`,
    );

    // Store in few_shot_candidates as negative. llm_call_id is carried so
    // the dedup check above recognizes already-processed rejections.
    await query(
      `INSERT INTO few_shot_candidates
         (task_type, llm_call_id, input_text, output_text, confidence, is_negative, negative_reason, promoted, promoted_at, template_version)
       VALUES ($1, $2, $3, $4, 0, true, $5, true, now(), $6)
       ON CONFLICT DO NOTHING`,
      [
        rejected.task_type,
        rejected.call_id,
        rejected.input_text,
        rejected.output_text,
        rejected.reviewer_notes ?? 'rejected',
        updatedTemplate.version,
      ],
    );

    totalNegative++;
    logger.info({ taskType: rejected.task_type, version: updatedTemplate.version }, 'Added negative example to template');
  }

  const durationMs = Date.now() - startedAt;
  logger.info({ totalPromoted, totalNegative, durationMs }, 'Few-shot curator job completed');
}

async function storeFewShotCandidate(
  output: HighConfOutput,
  similarity: number | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO few_shot_candidates
         (task_type, llm_call_id, input_text, output_text, confidence, similarity_to_existing)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        output.task_type,
        output.id,
        output.input_text,
        output.output_text,
        output.confidence,
        similarity,
      ],
    );
  } catch (err) {
    logger.error({ err, outputId: output.id }, 'Failed to store few-shot candidate');
  }
}

export { bumpMinorVersion };
