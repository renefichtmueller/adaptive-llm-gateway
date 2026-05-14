import type { PostValidationOutput } from './post-validator.js';

export type ConfidenceStatus = 'approved' | 'warning' | 'pending_review';

export interface ConfidenceResult {
  score: number;
  status: ConfidenceStatus;
  base_score: number;
  total_impact: number;
}

const BASE_SCORE = 8.0;
const APPROVED_THRESHOLD = 7.0;
const WARNING_THRESHOLD = 4.0;

export function evaluateConfidence(
  validationOutput: PostValidationOutput,
): ConfidenceResult {
  const totalImpact = validationOutput.total_score_impact;
  const raw = BASE_SCORE + totalImpact;
  const score = Math.max(0, Math.min(10, raw));

  let status: ConfidenceStatus;
  if (score >= APPROVED_THRESHOLD) {
    status = 'approved';
  } else if (score >= WARNING_THRESHOLD) {
    status = 'warning';
  } else {
    status = 'pending_review';
  }

  return {
    score,
    status,
    base_score: BASE_SCORE,
    total_impact: totalImpact,
  };
}
