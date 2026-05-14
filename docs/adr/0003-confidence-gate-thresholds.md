# ADR-0003: Confidence Gate Thresholds & Learning Cycle Intervals

**Date**: 2026-04-19  
**Status**: accepted  
**Deciders**: René Fichtmüller

## Context

The confidence gate (Stage 8 in completion pipeline) determines whether output is approved for direct delivery or queued for human review. The gate is critical for:
- Ensuring quality (prevent hallucinations, factual errors)
- Cost control (human review is expensive, so threshold must be precise)
- User trust (false positives destroy credibility)

**Current scoring factors** (23 dimensions per Stage 8):
- Validator pass/fail (facts, schema, grammar, tone, length, security, etc.)
- Input clarity (5–10 dimensions)
- Output coherence (5 dimensions)
- Task complexity (model match, context relevance)
- Historical accuracy (task_type-model pair performance)

**Learning cycles** must tune these weights:
- Short cycles (6h) → reactive, catch fresh degradation
- Medium cycles (12h) → strategic, smooth seasonal trends
- Long cycles (24h) → historical, guide model selection

## Decision

Implement **three-tier confidence gating with autonomous learning cycles**:

1. **Gate thresholds** (0–10 scale):
   - **0–4**: pending_review (queue for human approval + learning)
   - **4–7**: warning (deliver with confidence metadata, flag in dashboard)
   - **7–10**: approved (deliver directly, log for metrics)

2. **Confidence scoring formula**:
   ```
   base_score = (validators_passed / total_validators) × 8 + input_clarity × 0.5 + coherence × 1.5
   final_score = base_score × (1 + task_accuracy_bonus - hallucination_penalty)
   ```
   Where:
   - `task_accuracy_bonus`: +0.5 if historical accuracy >90%, +0.2 if >75%
   - `hallucination_penalty`: -0.5 if task requires_fact_check and validator failed

3. **Learning cycles**:
   - **6h**: Adjust validator weights (which validators are most predictive?)
   - **12h**: Recalibrate thresholds (is 5.0 still the right boundary for review?)
   - **24h**: Assess model-tier assignments (should task_X move from fast → medium?)

4. **Feedback loop**:
   - Human reviewers mark outputs as: approved, modified, rejected
   - Learning engine correlates human decisions with confidence scores
   - Thresholds drift automatically (e.g., if 80% of 5.0–5.5 are approved, raise threshold)

5. **Cold-start handling**:
   - New task types → default to pending_review until 20+ human reviews collected
   - New model combinations → higher threshold until historical data accumulates

## Alternatives Considered

### Alternative 1: Static Thresholds (no learning)
- **Pros**: Predictable, easy to reason about
- **Cons**: Doesn't adapt to model improvements, domain shifts, or drifting validator accuracy
- **Why not**: Gateway exists to learn; static thresholds waste the learning engine

### Alternative 2: Single-Threshold (0–5 review, 5–10 approve)
- **Pros**: Simpler rules, fewer parameters
- **Cons**: Loses nuance; "warning" bucket is valuable for monitoring edge cases
- **Why not**: Warning zone catches systematic issues (e.g., "all medium-tier outputs on fact-check are slightly off")

### Alternative 3: Per-Caller Thresholds (e.g. caller A uses 6.0, caller B uses 4.0)
- **Pros**: Each caller can tune tolerance
- **Cons**: Inconsistent quality, hard to debug when results vary
- **Why not**: Gateway quality is uniform; thresholds should reflect task complexity, not caller whim

## Consequences

### Positive
- **Automatic adaptation**: Confidence thresholds self-tune to model quality over time
- **Learning visibility**: Dashboard shows why outputs were gated (which validator failed, etc.)
- **Cost optimized**: As models improve, fewer outputs queue for human review
- **Quality feedback loop**: Human reviews train the confidence scorer iteratively

### Negative
- **Delayed convergence**: Takes 1-2 weeks for learning cycles to stabilize thresholds
  - Mitigate: Seed with domain expert estimates; learning adjusts from there
- **Threshold oscillation**: If human review feedback is noisy, thresholds drift erratically
  - Mitigate: Smoothing filter (move thresholds by max ±0.1 per cycle)
- **Review queue backlog**: If 30% of requests pending_review, human team is bottleneck
  - Mitigate: Escalate high-confidence 4.0–5.0 to 6.0 after 1 week of queue backup

### Risks
- **Feedback bias**: If certain human reviewers are harsher/more lenient, learning is skewed
  - Mitigate: Track reviewer agreement (Cohen's kappa) and weight accordingly
- **Confidence score gaming**: If models learn to game the scoring formula, thresholds creep up
  - Mitigate: Periodic validator audit; ensure validators measure actual quality
- **Cascading threshold drift**: If thresholds move in response to poor model tier assignment, learning mixes causes
  - Mitigate: Separate tier learning (12h) from threshold learning (12h) with distinct signals

## Implementation Notes

1. **Scoring implementation** (existing in confidence-gate.ts):
   - Track all 23 dimensions during completion
   - Compute base_score from validators
   - Apply bonuses/penalties based on historical task accuracy
   - Return confidence + base_score + impacts (for UI debugging)

2. **Learning cycles** (learning-engine.ts):
   ```typescript
   // 6h: Reweight validators
   const validator_accuracy = await queryValidatorAccuracy(taskType);
   weights.grammar = validator_accuracy['grammar'].precision;
   
   // 12h: Adjust thresholds
   const human_reviews = await queryHumanReviews(taskType, hours=48);
   const current_threshold = thresholds[taskType].review;
   const true_positive_rate = human_reviews.filter(r => r.human_approved && r.confidence > current_threshold).length / human_reviews.length;
   if (true_positive_rate > 0.9) thresholds[taskType].review += 0.1;
   
   // 24h: Assess model assignments
   const perf = await queryModelPerformance(taskType);
   if (perf.fast_confidence < 4.5) changeDefaultTier(taskType, 'fast', 'medium');
   ```

3. **Dashboard metrics**:
   - Confidence score distribution (histogram)
   - Review queue size and age
   - Validator contribution to score (Shapley values or feature importance)
   - Threshold history over time (chart showing drift)
   - Human reviewer agreement rate

4. **Monitoring thresholds**:
   - Alert if review queue >24h backlog
   - Alert if any threshold drifts >0.5 in 24h (possible feedback bias)
   - Alert if validator accuracy drops >10% (model degradation signal)

## Related Decisions
- ADR-0001: Multi-Agent Coworking Architecture
- ADR-0002: Tier assignment strategy
- ADR-0004: External provider fallback chain ordering
