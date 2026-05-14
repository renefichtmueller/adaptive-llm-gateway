import { query } from '../db/client.js';
import { logger } from './logger.js';
import { reviewQueueSize } from './metrics.js';
import type { ValidationResult } from '../pipeline/post-validator.js';

export interface ReviewQueueItem {
  id: string;
  created_at: string;
  caller: string;
  task_type: string;
  input_text: string;
  output_text: string | null;
  confidence: number;
  validation_log: ValidationResult[];
  decision: 'approved' | 'rejected' | 'edited' | null;
  edited_output: string | null;
  reviewer_notes: string | null;
}

export interface ReviewDecision {
  decision: 'approved' | 'rejected' | 'edited';
  edited_output?: string;
  reviewer_notes?: string;
}

const WEBHOOK_URL = process.env['REVIEW_QUEUE_WEBHOOK_URL'] ?? '';

async function notifyWebhook(item: ReviewQueueItem): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'review_queue_new',
        id: item.id,
        caller: item.caller,
        task_type: item.task_type,
        confidence: item.confidence,
        created_at: item.created_at,
      }),
    });
  } catch (err) {
    logger.warn({ err }, 'Review queue webhook notification failed');
  }
}

export async function addToReviewQueue(params: {
  callId: string;
  caller: string;
  taskType: string;
  inputText: string;
  outputText?: string;
  confidence: number;
  validationLog: ValidationResult[];
}): Promise<string> {
  const sql = `
    INSERT INTO review_queue (call_id, caller, task_type, input_text, output_text, confidence, validation_log)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, created_at, caller, task_type, input_text, output_text, confidence, validation_log
  `;

  try {
    const result = await query<ReviewQueueItem>(sql, [
      params.callId,
      params.caller,
      params.taskType,
      params.inputText,
      params.outputText ?? null,
      params.confidence,
      JSON.stringify(params.validationLog),
    ]);

    const item = result.rows[0];
    if (!item) throw new Error('Insert returned no rows');

    // Update gauge
    await updateReviewQueueGauge();

    // Notify webhook (non-blocking)
    void notifyWebhook(item);

    return item.id;
  } catch (err) {
    logger.error({ err, caller: params.caller }, 'Failed to add item to review queue');
    return '';
  }
}

export async function listPendingReviews(
  limit = 50,
  offset = 0,
): Promise<ReviewQueueItem[]> {
  const sql = `
    SELECT id, created_at, caller, task_type, input_text, output_text,
           confidence, validation_log, decision, edited_output, reviewer_notes
    FROM review_queue
    WHERE decision IS NULL
    ORDER BY confidence ASC, created_at ASC
    LIMIT $1 OFFSET $2
  `;
  const result = await query<ReviewQueueItem>(sql, [limit, offset]);
  return result.rows;
}

export async function processDecision(
  id: string,
  decision: ReviewDecision,
): Promise<ReviewQueueItem | null> {
  const sql = `
    UPDATE review_queue
    SET decision = $1,
        edited_output = $2,
        reviewer_notes = $3,
        reviewed_at = NOW()
    WHERE id = $4
    RETURNING *
  `;

  const result = await query<ReviewQueueItem>(sql, [
    decision.decision,
    decision.edited_output ?? null,
    decision.reviewer_notes ?? null,
    id,
  ]);

  const updated = result.rows[0] ?? null;
  if (updated) {
    await updateReviewQueueGauge();
  }
  return updated;
}

export async function updateReviewQueueGauge(): Promise<void> {
  try {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM review_queue WHERE decision IS NULL',
    );
    const count = parseInt(result.rows[0]?.count ?? '0', 10);
    reviewQueueSize.set(count);
  } catch (err) {
    logger.warn({ err }, 'Failed to update review queue gauge');
  }
}
