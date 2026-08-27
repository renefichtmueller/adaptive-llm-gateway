/**
 * GEO Optimizer — LLM-assisted content rewriting for generative engines
 * ---------------------------------------------------------------------
 * Takes content + its GEO analysis and asks a model (through the gateway's
 * own LLM pipeline) to apply the techniques that measurably raise visibility
 * in generative answers: answer-first structure, extractable chunks, fluent
 * sentences, and placeholders for statistics/quotes/sources that a human must
 * verify.
 *
 * Honesty guarantee: the optimizer NEVER lets the model invent statistics,
 * quotes or sources. Where real data is missing it inserts explicit
 * `[GEO-TODO: …]` markers, which are extracted and returned so the editorial
 * team knows exactly what to research. Optimizing means restructuring +
 * marking gaps — perfecting is the human's job, measured by the re-analysis.
 *
 * The LLM call is dependency-injected (same pattern as injection-defense's
 * llm_judge) so the module stays unit-testable without a model.
 */

import { logger } from '../observability/logger.js';
import { analyzeGeo, type GeoAnalysis, type GeoContentFormat } from './geo-analyzer.js';

export interface GeoLlmCaller {
  (req: { prompt: string; system?: string; options?: { temperature: number; num_predict: number } }): Promise<{ response?: string; model?: string }>;
}

export interface GeoOptimizeInput {
  content: string;
  format?: GeoContentFormat;
  brand?: string;
  brandAliases?: string[];
  targetQueries?: string[];
  /** Re-optimize the result while the score keeps improving (1–3). */
  iterations?: number;
}

export interface GeoOptimizeResult {
  optimizedContent: string;
  before: GeoAnalysis;
  after: GeoAnalysis;
  scoreDelta: number;
  /** Open research tasks the model marked instead of inventing facts. */
  todos: string[];
  iterationsRun: number;
  modelUsed: string;
}

const GEO_TODO_PATTERN = /\[GEO-TODO:\s*([^\]]+)\]/g;

const SYSTEM_PROMPT = `You are a Generative Engine Optimization (GEO) editor. You rewrite content so that
AI answer engines (ChatGPT, Perplexity, Google AI Overviews, Gemini, Copilot) can extract,
quote and cite it. You apply the techniques validated by the GEO study (Aggarwal et al.,
KDD 2024) and practitioner guides:

1. ANSWER FIRST: open the page and every section with the direct, concise answer; details after.
2. EXTRACTABLE STRUCTURE: clear markdown H2/H3 headings (phrased as user questions where natural),
   short paragraphs (2-4 sentences), bullet lists for enumerations, tables for comparisons.
3. FLUENCY: active voice, ~15-20 words per sentence, zero marketing fluff or superlatives.
4. STATISTICS, QUOTES, SOURCES: keep every existing number, quote and source EXACTLY as given.
   Where a claim would be stronger with data, a quote or a citation you DO NOT invent one —
   insert a marker instead: [GEO-TODO: <what to research, e.g. "add measured latency figure">].
5. ENTITY CLARITY: if a brand is given, use its canonical name consistently and keep/add one
   definitional sentence ("<brand> is …") early in the text.
6. NO KEYWORD STUFFING: never repeat the main keyword unnaturally; it reduces visibility.

Hard rules:
- Preserve every fact, number, name and claim of the original. Never fabricate facts,
  statistics, quotes, sources, dates or people. Uncertain? Use [GEO-TODO: …].
- Keep the original language of the text (German stays German, English stays English).
- Return ONLY the rewritten content as markdown. No preamble, no explanations, no code fences.`;

function buildUserPrompt(input: GeoOptimizeInput, analysis: GeoAnalysis): string {
  const weakest = analysis.factors
    .filter((f) => f.applicable && f.score < 70)
    .sort((a, b) => (100 - b.score) * b.weight - (100 - a.score) * a.weight)
    .slice(0, 5);

  const lines: string[] = [];
  lines.push(`Current GEO score: ${analysis.geoScore}/100 (grade ${analysis.grade}). Language: ${analysis.stats.language}.`);
  if (input.brand) lines.push(`Brand entity: ${input.brand}${input.brandAliases?.length ? ` (aliases: ${input.brandAliases.join(', ')})` : ''}`);
  if (input.targetQueries?.length) lines.push(`The content should be THE answer to these user questions:\n${input.targetQueries.map((q) => `- ${q}`).join('\n')}`);
  if (weakest.length > 0) {
    lines.push(`Weakest factors to fix (analyzer findings):`);
    for (const f of weakest) {
      lines.push(`- ${f.label} (${f.score}/100): ${f.recommendations.join(' ') || 'improve this factor'}`);
    }
  }
  lines.push('', 'Rewrite the following content applying the rules. Return only the rewritten markdown.', '', '--- CONTENT START ---', input.content, '--- CONTENT END ---');
  return lines.join('\n');
}

function extractTodos(content: string): string[] {
  const todos: string[] = [];
  for (const m of content.matchAll(GEO_TODO_PATTERN)) {
    const todo = (m[1] ?? '').trim();
    if (todo) todos.push(todo);
  }
  return [...new Set(todos)];
}

function stripCodeFence(response: string): string {
  const trimmed = response.trim();
  const fence = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return fence ? (fence[1] ?? trimmed) : trimmed;
}

/**
 * Optimize content for GEO. Runs up to `iterations` rewrite passes (default 1,
 * max 3) and keeps the best-scoring version. Analysis of the optimized content
 * treats it as markdown, because that is what the model is asked to produce.
 */
export async function optimizeContentForGeo(
  input: GeoOptimizeInput,
  callLLM: GeoLlmCaller,
): Promise<GeoOptimizeResult> {
  const before = analyzeGeo({
    content: input.content,
    format: input.format ?? 'auto',
    brand: input.brand,
    brandAliases: input.brandAliases,
    targetQueries: input.targetQueries,
  });

  const maxIterations = Math.max(1, Math.min(3, input.iterations ?? 1));
  let bestContent = input.content;
  let bestAnalysis = before;
  let modelUsed = 'unknown';
  let iterationsRun = 0;

  for (let i = 0; i < maxIterations; i++) {
    const prompt = buildUserPrompt(
      { ...input, content: bestContent, format: i === 0 ? (input.format ?? 'auto') : 'markdown' },
      bestAnalysis,
    );
    const estimatedTokens = Math.ceil(bestContent.length / 4);
    const numPredict = Math.min(8_000, Math.max(1_200, Math.round(estimatedTokens * 1.6) + 400));

    let response: { response?: string; model?: string };
    try {
      response = await callLLM({ prompt, system: SYSTEM_PROMPT, options: { temperature: 0.3, num_predict: numPredict } });
    } catch (err) {
      logger.warn({ err, iteration: i }, 'geo-optimizer: LLM call failed');
      break;
    }
    const candidate = stripCodeFence(response.response ?? '');
    if (candidate.length < Math.min(200, input.content.length * 0.3)) {
      logger.warn({ iteration: i, candidateLength: candidate.length }, 'geo-optimizer: suspiciously short rewrite, discarding');
      break;
    }
    iterationsRun++;
    if (response.model) modelUsed = response.model;

    const candidateAnalysis = analyzeGeo({
      content: candidate,
      format: 'markdown',
      brand: input.brand,
      brandAliases: input.brandAliases,
      targetQueries: input.targetQueries,
    });
    if (candidateAnalysis.geoScore > bestAnalysis.geoScore) {
      bestContent = candidate;
      bestAnalysis = candidateAnalysis;
    } else {
      break; // no further improvement — stop iterating
    }
  }

  return {
    optimizedContent: bestContent,
    before,
    after: bestAnalysis,
    scoreDelta: bestAnalysis.geoScore - before.geoScore,
    todos: extractTodos(bestContent),
    iterationsRun,
    modelUsed,
  };
}

/** Exposed for unit tests. */
export const __INTERNALS = { buildUserPrompt, extractTodos, stripCodeFence, SYSTEM_PROMPT };
