import { createHash } from 'crypto';
import { query } from '../db/client.js';
import { logger } from './logger.js';
import type { ValidationResult } from '../pipeline/post-validator.js';
import type { BanViolation } from '../validation/banlist-checker.js';

export interface AuditEntry {
  caller: string;
  task_type: string;
  model_used: string;
  prompt_id: string;
  prompt_version: string;
  input_hash: string;
  output_text?: string;
  output_hash: string;
  token_count_in: number;
  token_count_out: number;
  latency_ms: number;
  confidence: number;
  status: 'approved' | 'warning' | 'pending_review' | 'rejected';
  validation_log: ValidationResult[];
  ban_hits: BanViolation[];
  metadata?: Record<string, unknown>;
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export async function writeAuditLog(entry: AuditEntry): Promise<string> {
  const sql = `
    INSERT INTO llm_calls (
      caller, task_type, model_used, prompt_id, prompt_version,
      input_hash, output_text, output_hash,
      token_count_in, token_count_out, latency_ms,
      confidence, status, validation_log, ban_hits, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14, $15, $16
    )
    RETURNING id
  `;

  const params = [
    entry.caller,
    entry.task_type,
    entry.model_used,
    entry.prompt_id,
    entry.prompt_version,
    entry.input_hash,
    entry.output_text ?? null,
    entry.output_hash,
    entry.token_count_in,
    entry.token_count_out,
    entry.latency_ms,
    entry.confidence,
    entry.status,
    JSON.stringify(entry.validation_log),
    JSON.stringify(entry.ban_hits),
    entry.metadata ? JSON.stringify(entry.metadata) : null,
  ];

  try {
    const result = await query<{ id: string }>(sql, params);
    return (result.rows[0]?.id) ?? '';
  } catch (err) {
    logger.error({ err, caller: entry.caller, task_type: entry.task_type }, 'Failed to write audit log');
    return '';
  }
}

export async function writeBanAnalytics(
  callId: string,
  violations: BanViolation[],
  caller: string,
  taskType: string,
): Promise<void> {
  if (violations.length === 0) return;

  const values = violations
    .map(
      (_, i) =>
        `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`,
    )
    .join(', ');

  const params: unknown[] = [];
  for (const v of violations) {
    params.push(callId, v.term, v.category, v.language, caller, taskType, v.context);
  }

  const sql = `
    INSERT INTO ban_analytics (call_id, term, category, language, caller, task_type, context_snippet)
    VALUES ${values}
  `;

  try {
    await query(sql, params);
  } catch (err) {
    logger.warn({ err }, 'Failed to write ban analytics');
  }
}
