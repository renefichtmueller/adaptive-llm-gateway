# ADR-0002: Tier Assignment Strategy for Model Selection

**Date**: 2026-04-19  
**Status**: accepted  
**Deciders**: René Fichtmüller

## Context

The Gateway must decide which Ollama model to use for each request. Current routing system defines three tiers:
- **fast**: qwen2.5:3b (1.5B parameters, 5-10 tokens/sec, <500ms latency)
- **medium**: qwen2.5:14b (14B parameters, 1-5 tokens/sec, 1-3s latency)
- **large**: llama3.3:70b (70B parameters, 0.2-1 token/sec, 5-10s latency)

**Decision factors:**
- Task complexity (learned from historical confidence scores)
- Input length (longer inputs → need more capable models)
- Request latency SLA (e.g., downstream service needs <8s response)
- Fallback availability (if medium fails, should we degrade or escalate?)
- Cost optimization (fast is 3x cheaper than medium, 10x cheaper than large)

## Decision

Implement **cost-first tier assignment with confidence-based escalation**:

1. **Default**: Start with **fast** tier (qwen2.5:3b)
2. **Escalate if needed**:
   - Task type unknown → classify first, then assign tier
   - Historical confidence <5 on fast → try medium
   - Input length >2000 tokens → start with medium
   - Task requires_fact_check=true → use large
3. **Fallback chain per tier**:
   - fast fails → try medium
   - medium fails → try large
   - large fails → external provider fallback (Cerebras → Groq → Mistral → NVIDIA → CF)
4. **Learning feedback loop**:
   - Track confidence per (task_type, model) pair
   - Every 6h: if fast confidence <4.5 on task X, escalate task X to medium default
   - Every 12h: if medium confidence <3 on task X, escalate to large default

## Alternatives Considered

### Alternative 1: Complexity-First (classify every request)
- **Pros**: More accurate initial tier selection
- **Cons**: 500-1000ms pre-classification overhead, many classifications are themselves uncertain
- **Why not**: Cost of classification offsets benefit; learning loop converges faster if we start cheap

### Alternative 2: Confidence-Only (no task-specific routing)
- **Pros**: Simpler rules, single model per confidence threshold
- **Cons**: One task X might work well on fast but another task Y needs large; no specialization
- **Why not**: Tasks have vastly different complexity profiles; generic threshold wastes cost

### Alternative 3: Per-Caller Profiles (each caller gets a static tier)
- **Pros**: Predictable cost per caller, easy billing
- **Cons**: Ignores actual task complexity; intake scraping is diverse, shouldn't pay for all-large
- **Why not**: Multi-tenant fairness requires per-task routing

## Consequences

### Positive
- **Cost optimized**: ~70% of requests handled by fast tier
- **Quality maintained**: Learning loop escalates low-confidence tasks automatically
- **Responsive**: Most requests complete in <1s
- **Fair**: Each task gets the cheapest tier that works

### Negative
- **Cold-start problem**: New task types default to fast even if they need large
  - Mitigate: Classify task type on first few requests, then learn
- **Noisy escalation**: If confidence threshold is wrong, thrash between tiers
  - Mitigate: Threshold tuning in ADR-0003
- **Fallback chain latency**: Escalating from fast → medium → large → external can add 10-30s
  - Mitigate: Parallel fallback execution (fire medium request while fast is running)

### Risks
- **Cascading failures**: If fast tier bottleneck is hit, escalation floods medium
  - Mitigate: Per-tier rate limiting + circuit breaker pattern
- **User experience cliff**: Fast tier latency jitter (100-1000ms variance) unpredictable
  - Mitigate: SLA target enforcement; if P95 latency >SLA, escalate whole task type

## Implementation Notes

1. **Tier mapping in router.ts**:
   ```typescript
   interface TierAssignment {
     task_type: string;
     tier: ModelTier;
     fallback_chain: string[];
     escalation_condition?: string; // e.g. "confidence < 4.5"
   }
   ```

2. **Learning engine (6h cycle)**:
   - Query audit_log for (task_type, model) confidence distribution
   - If P50 confidence on fast:task_X < 4.5 for >20 requests, mark task_X → medium
   - If P50 confidence on medium:task_X < 3 for >20 requests, mark task_X → large

3. **Metrics to track**:
   - Per-tier latency distribution (P50, P95, P99)
   - Per-task escalation rate (% fast→medium, medium→large)
   - Cost-per-task across tiers

4. **UI/Dashboard**:
   - Show tier assignment rules (current state + learning history)
   - Plot task_type confidence distributions (binned by model)
   - Show cost savings vs "all-large" baseline

## Related Decisions
- ADR-0001: Multi-Agent Coworking Architecture
- ADR-0003: Confidence gate thresholds & learning cycle intervals
- ADR-0004: External provider fallback chain ordering
