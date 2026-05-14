/**
 * Reasoning-Trace Capture
 *
 * Modern reasoning models (OpenAI o1, DeepSeek-R1, Claude with extended
 * thinking, Qwen-with-thinking) emit a chain-of-thought (CoT) block in
 * addition to the final answer. This module captures the trace, stores
 * it separately, and makes it searchable / auditable without bloating
 * the audit-log `output_text` field.
 *
 * Supported trace markers:
 *   - <thinking>...</thinking>           (Anthropic extended thinking)
 *   - <think>...</think>                  (DeepSeek-R1, Qwen-with-thinking)
 *   - {"reasoning": "..."}                (OpenAI o1, when returned)
 *   - **Reasoning:**\n... \n**Answer:**   (some fine-tuned local models)
 */
import { logger } from '../observability/logger.js';

export interface ReasoningTrace {
  raw: string;
  /** Reasoning content without the wrapper markers */
  content: string;
  /** Which marker style we detected */
  marker: 'thinking_tag' | 'think_tag' | 'json_field' | 'markdown_header' | 'none';
  /** Estimated token count of the reasoning portion */
  estimatedTokens: number;
}

export interface SplitResult {
  /** The final answer (what the user wants to see) */
  finalAnswer: string;
  /** The reasoning trace, if any */
  trace: ReasoningTrace | null;
}

const THINKING_TAG = /<thinking>([\s\S]*?)<\/thinking>/i;
const THINK_TAG = /<think>([\s\S]*?)<\/think>/i;
const MARKDOWN_REASONING = /\*\*Reasoning:\*\*\s*([\s\S]*?)\n\s*\*\*(?:Answer|Response|Final answer):\*\*\s*([\s\S]*)/i;

function estimateTokens(s: string): number {
  // ~4 chars per token rough estimate
  return Math.ceil(s.length / 4);
}

/**
 * Split a model output into reasoning trace + final answer.
 */
export function splitReasoningTrace(output: string): SplitResult {
  if (!output) return { finalAnswer: '', trace: null };

  // 1) Anthropic-style <thinking>...</thinking>
  const thinking = THINKING_TAG.exec(output);
  if (thinking) {
    const trace: ReasoningTrace = {
      raw: thinking[0],
      content: (thinking[1] ?? '').trim(),
      marker: 'thinking_tag',
      estimatedTokens: estimateTokens(thinking[1] ?? ''),
    };
    return {
      finalAnswer: output.replace(THINKING_TAG, '').trim(),
      trace,
    };
  }

  // 2) DeepSeek-R1 / Qwen-with-thinking <think>...</think>
  const think = THINK_TAG.exec(output);
  if (think) {
    const trace: ReasoningTrace = {
      raw: think[0],
      content: (think[1] ?? '').trim(),
      marker: 'think_tag',
      estimatedTokens: estimateTokens(think[1] ?? ''),
    };
    return {
      finalAnswer: output.replace(THINK_TAG, '').trim(),
      trace,
    };
  }

  // 3) Markdown-style "**Reasoning:** ... **Answer:** ..."
  const md = MARKDOWN_REASONING.exec(output);
  if (md) {
    const trace: ReasoningTrace = {
      raw: md[0],
      content: (md[1] ?? '').trim(),
      marker: 'markdown_header',
      estimatedTokens: estimateTokens(md[1] ?? ''),
    };
    return {
      finalAnswer: (md[2] ?? '').trim(),
      trace,
    };
  }

  // 4) JSON field {"reasoning": "...", "answer": "..."}
  if (output.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(output) as Record<string, unknown>;
      if (typeof obj['reasoning'] === 'string' && typeof obj['answer'] === 'string') {
        const trace: ReasoningTrace = {
          raw: String(obj['reasoning']),
          content: String(obj['reasoning']).trim(),
          marker: 'json_field',
          estimatedTokens: estimateTokens(String(obj['reasoning'])),
        };
        return { finalAnswer: String(obj['answer']).trim(), trace };
      }
    } catch {
      /* not JSON, fall through */
    }
  }

  return { finalAnswer: output, trace: null };
}

/**
 * Persist a reasoning trace to the database. Wrapper around the pg pool
 * — the schema migration creates `reasoning_traces` table with
 *   (id PK uuid, call_id uuid FK, marker text, content text,
 *    estimated_tokens int, created_at timestamptz).
 */
type PgClient = { query: (text: string, params?: unknown[]) => Promise<unknown> };

export async function storeReasoningTrace(
  db: PgClient,
  callId: string,
  trace: ReasoningTrace,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO reasoning_traces (call_id, marker, content, estimated_tokens)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (call_id) DO NOTHING`,
      [callId, trace.marker, trace.content, trace.estimatedTokens],
    );
  } catch (err) {
    logger.warn({ err, callId }, 'Failed to persist reasoning trace');
  }
}
