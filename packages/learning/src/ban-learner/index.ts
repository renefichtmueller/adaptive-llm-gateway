/**
 * Ban Learner — auto-detects new banned terms from approved outputs.
 *
 * Algorithm:
 * 1. Pull last 24h of approved outputs
 * 2. Extract suspicious phrases via regex pattern analysis
 * 3. Compare edited review_queue items (what was removed = candidate)
 * 4. Ask gateway LLM to identify AI-filler in low-confidence samples
 * 5. Upsert candidates into ban_candidates with occurrence counts
 * 6. Auto-promote candidates with count >= 5 to ban_candidates (promoted=true)
 */

import { query, withTransaction } from '../db/client.js';
import { callGateway } from '../gateway-client.js';
import { logger } from '../observability/logger.js';

// ─── Pattern sets ───────────────────────────────────────────────────────────

const EN_OPENER_PATTERNS = [
  /\bin today'?s\b/gi,
  /\bas we\b/gi,
  /\bit(?:'s| is) worth noting\b/gi,
  /\bit(?:'s| is) important to\b/gi,
  /\bin (?:this|the) (?:fast-paced|ever-changing|dynamic)\b/gi,
  /\bwithout further ado\b/gi,
  /\blet(?:'s| us) dive (?:in|into)\b/gi,
  /\bin conclusion\b/gi,
  /\bto summarize\b/gi,
  /\bhaving said that\b/gi,
  /\bthat being said\b/gi,
  /\ball things considered\b/gi,
  /\bat the end of the day\b/gi,
  /\bwhen all is said and done\b/gi,
];

const EN_BUZZWORD_PATTERNS = [
  /\bleverage[sd]?\b/gi,
  /\bsynerg(?:y|ies|ize[sd]?)\b/gi,
  /\bholistic(?:ally)?\b/gi,
  /\bcutting-edge\b/gi,
  /\bstate-of-the-art\b/gi,
  /\bparadigm shift\b/gi,
  /\bgame[\s-]changer\b/gi,
  /\bthought leader(?:ship)?\b/gi,
  /\bpivot[ed]?\b/gi,
  /\bdisrupt(?:ive|ion|ing)?\b/gi,
  /\bbest-in-class\b/gi,
  /\bworld-class\b/gi,
  /\bempower(?:ing|ment)?\b/gi,
  /\btransform(?:ative|ation)?\b/gi,
  /\bseamless(?:ly)?\b/gi,
  /\brobust solution\b/gi,
];

const EN_FILLER_PATTERNS = [
  /\btruly\b/gi,
  /\breally\b/gi,
  /\babsolutely\b/gi,
  /\bvery unique\b/gi,
  /\bquite frankly\b/gi,
  /\bneedless to say\b/gi,
  /\bfirst and foremost\b/gi,
  /\blast but not least\b/gi,
  /\brest assured\b/gi,
];

const DE_FILLER_PATTERNS = [
  /\bletztendlich\b/gi,
  /\bzusammenfassend\b/gi,
  /\babschlie[ßs]end\b/gi,
  /\bganzheitlich\b/gi,
  /\bnachhaltig\b/gi,
  /\binnovativ\b/gi,
  /\bsynergi(?:e|en|stisch)\b/gi,
  /\bim endeffekt\b/gi,
  /\bzu guter letzt\b/gi,
  /\bgrunds[äa]tzlich\b/gi,
  /\bselbstverst[äa]ndlich\b/gi,
  /\bdiesbez[üu]glich\b/gi,
];

interface PatternGroup {
  patterns: RegExp[];
  category: 'opener' | 'closer' | 'buzzword' | 'filler' | 'transition';
  language: 'en' | 'de' | 'auto';
}

const ALL_PATTERN_GROUPS: PatternGroup[] = [
  { patterns: EN_OPENER_PATTERNS, category: 'opener', language: 'en' },
  { patterns: EN_BUZZWORD_PATTERNS, category: 'buzzword', language: 'en' },
  { patterns: EN_FILLER_PATTERNS, category: 'filler', language: 'en' },
  { patterns: DE_FILLER_PATTERNS, category: 'filler', language: 'de' },
];

// ─── Types ──────────────────────────────────────────────────────────────────

interface CandidateTerm {
  term: string;
  language: 'en' | 'de' | 'auto';
  category: 'opener' | 'closer' | 'buzzword' | 'filler' | 'transition';
  context: string;
  taskType: string;
}

interface ApprovedOutput {
  id: string;
  task_type: string;
  output_text: string;
  confidence: number;
}

interface EditedOutput {
  task_type: string;
  output_text: string;
  edited_output: string;
}

// ─── Core functions ─────────────────────────────────────────────────────────

function extractCandidatesFromText(
  text: string,
  taskType: string,
): CandidateTerm[] {
  const candidates: CandidateTerm[] = [];

  for (const group of ALL_PATTERN_GROUPS) {
    for (const pattern of group.patterns) {
      const matches = [...text.matchAll(pattern)];
      for (const match of matches) {
        const term = match[0]?.toLowerCase();
        if (!term) continue;

        // Extract surrounding context (up to 80 chars)
        const start = Math.max(0, (match.index ?? 0) - 40);
        const end = Math.min(text.length, (match.index ?? 0) + term.length + 40);
        const context = text.slice(start, end).replace(/\n/g, ' ').trim();

        candidates.push({
          term,
          language: group.language,
          category: group.category,
          context,
          taskType,
        });
      }
    }
  }

  return candidates;
}

function extractDiffCandidates(
  original: string,
  edited: string,
  taskType: string,
): CandidateTerm[] {
  const candidates: CandidateTerm[] = [];

  // Simple word-level diff: find words in original not in edited
  const origWords = new Set(original.toLowerCase().split(/\s+/));
  const editWords = new Set(edited.toLowerCase().split(/\s+/));

  // Removed phrases: check if any known pattern terms were removed
  for (const group of ALL_PATTERN_GROUPS) {
    for (const pattern of group.patterns) {
      const matches = [...original.matchAll(pattern)];
      for (const match of matches) {
        const term = match[0]?.toLowerCase();
        if (!term) continue;
        const termWords = term.split(/\s+/);
        const removedAll = termWords.every((w) => !editWords.has(w) && origWords.has(w));
        if (removedAll) {
          const idx = match.index ?? 0;
          const context = original.slice(Math.max(0, idx - 40), idx + term.length + 40).trim();
          candidates.push({ term, language: group.language, category: group.category, context, taskType });
        }
      }
    }
  }

  return candidates;
}

async function parseLlmBanCandidates(llmOutput: string): Promise<CandidateTerm[]> {
  try {
    const json = JSON.parse(llmOutput) as {
      candidates: Array<{
        term: string;
        language: string;
        category: string;
        example_context: string;
      }>;
    };

    return (json.candidates ?? []).map((c) => ({
      term: c.term.toLowerCase().trim(),
      language: (['en', 'de', 'auto'].includes(c.language) ? c.language : 'auto') as 'en' | 'de' | 'auto',
      category: (['buzzword', 'filler', 'opener', 'closer', 'transition'].includes(c.category)
        ? c.category
        : 'filler') as CandidateTerm['category'],
      context: c.example_context ?? '',
      taskType: 'llm-detected',
    }));
  } catch {
    logger.warn({ llmOutput: llmOutput.slice(0, 200) }, 'Failed to parse LLM ban candidate response');
    return [];
  }
}

async function upsertCandidate(
  candidatesByTerm: Map<string, { term: CandidateTerm; taskTypes: Set<string>; contexts: string[] }>,
): Promise<{ upserted: number; promoted: number }> {
  let upserted = 0;
  let promoted = 0;

  for (const [key, data] of candidatesByTerm.entries()) {
    const { term } = data;
    const taskTypes = [...data.taskTypes];
    const contexts = data.contexts.slice(0, 3);

    try {
      await withTransaction(async (client) => {
        // Upsert: if term+language already exists, increment count
        const result = await client.query<{ id: string; occurrence_count: number; promoted: boolean }>(
          `INSERT INTO ban_candidates (term, language, category, occurrence_count, source_task_types, example_contexts)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (term, language) DO UPDATE
             SET occurrence_count = ban_candidates.occurrence_count + $4,
                 source_task_types = (
                   SELECT array_agg(DISTINCT t) FROM unnest(
                     ban_candidates.source_task_types || $5::text[]
                   ) AS t
                 ),
                 example_contexts = CASE
                   WHEN array_length(ban_candidates.example_contexts, 1) < 3
                   THEN ban_candidates.example_contexts || $6::text[]
                   ELSE ban_candidates.example_contexts
                 END
           WHERE ban_candidates.rejected = false
           RETURNING id, occurrence_count, promoted`,
          [
            term.term,
            term.language,
            term.category,
            data.taskTypes.size,
            taskTypes,
            contexts,
          ],
        );

        upserted++;
        const row = result.rows[0];

        // Auto-promote if threshold reached
        if (row && !row.promoted && row.occurrence_count >= 5) {
          await client.query(
            `UPDATE ban_candidates SET promoted = true, promoted_at = now() WHERE id = $1`,
            [row.id],
          );
          promoted++;
          logger.info(
            { term: term.term, language: term.language, count: row.occurrence_count },
            'Auto-promoted ban candidate to banlist',
          );
        }
      });
    } catch (err) {
      logger.error({ err, term: key }, 'Failed to upsert ban candidate');
    }
  }

  return { upserted, promoted };
}

// ─── Main job ───────────────────────────────────────────────────────────────

export async function runBanLearner(): Promise<void> {
  const startedAt = Date.now();
  logger.info('Ban learner job started');

  // 1. Pull last 24h approved outputs
  const approvedResult = await query<ApprovedOutput>(
    `SELECT id, task_type, output_text, confidence::float as confidence
     FROM llm_calls
     WHERE status = 'approved'
       AND created_at > now() - interval '24 hours'
       AND output_text IS NOT NULL
       AND output_text != ''
     ORDER BY created_at DESC
     LIMIT 500`,
  );

  const approved = approvedResult.rows;
  logger.info({ count: approved.length }, 'Pulled approved outputs');

  // 2. Pull edited outputs from review_queue
  const editedResult = await query<EditedOutput>(
    `SELECT rq.task_type, rq.output_text, rq.edited_output
     FROM review_queue rq
     WHERE rq.decision = 'edited'
       AND rq.edited_output IS NOT NULL
       AND rq.reviewed_at > now() - interval '24 hours'`,
  );

  const edited = editedResult.rows;
  logger.info({ count: edited.length }, 'Pulled edited outputs from review_queue');

  // 3. Pull low-confidence outputs for LLM analysis
  const lowConfResult = await query<ApprovedOutput>(
    `SELECT id, task_type, output_text, confidence::float as confidence
     FROM llm_calls
     WHERE confidence < 6.0
       AND created_at > now() - interval '24 hours'
       AND output_text IS NOT NULL
       AND status IN ('approved', 'warning')
     ORDER BY confidence ASC
     LIMIT 20`,
  );

  const lowConf = lowConfResult.rows;

  // Accumulate all candidates
  const candidateMap = new Map<
    string,
    { term: CandidateTerm; taskTypes: Set<string>; contexts: string[] }
  >();

  const addCandidate = (c: CandidateTerm) => {
    const key = `${c.term}::${c.language}`;
    const existing = candidateMap.get(key);
    if (existing) {
      existing.taskTypes.add(c.taskType);
      if (existing.contexts.length < 3) existing.contexts.push(c.context);
    } else {
      candidateMap.set(key, {
        term: c,
        taskTypes: new Set([c.taskType]),
        contexts: [c.context],
      });
    }
  };

  // Extract from approved outputs via regex
  for (const output of approved) {
    const candidates = extractCandidatesFromText(output.output_text, output.task_type);
    candidates.forEach(addCandidate);
  }

  // Extract from edited diffs
  for (const edit of edited) {
    if (!edit.edited_output) continue;
    const candidates = extractDiffCandidates(edit.output_text, edit.edited_output, edit.task_type);
    candidates.forEach(addCandidate);
  }

  // 4. LLM-based analysis of low-confidence samples
  if (lowConf.length >= 5) {
    const samples = lowConf
      .slice(0, 20)
      .map((o, i) => `--- Sample ${i + 1} (confidence: ${o.confidence}) ---\n${o.output_text.slice(0, 300)}`)
      .join('\n\n');

    try {
      const result = await callGateway({
        taskType: 'internal-ban-detect',
        input: samples,
        caller: 'internal',
      });

      const llmCandidates = await parseLlmBanCandidates(result.output);
      logger.info({ count: llmCandidates.length }, 'LLM detected ban candidates');
      llmCandidates.forEach(addCandidate);
    } catch (err) {
      logger.warn({ err }, 'LLM ban detection failed, continuing without it');
    }
  }

  // 5. Filter: only candidates appearing in >= 3 different outputs
  const filteredCandidates = new Map(
    [...candidateMap.entries()].filter(([, v]) => v.taskTypes.size >= 3),
  );

  logger.info(
    { total: candidateMap.size, filtered: filteredCandidates.size },
    'Filtered ban candidates by occurrence threshold',
  );

  // 6. Upsert to DB
  const { upserted, promoted } = await upsertCandidate(filteredCandidates);

  const durationMs = Date.now() - startedAt;
  logger.info(
    { upserted, promoted, durationMs },
    'Ban learner job completed',
  );
}
