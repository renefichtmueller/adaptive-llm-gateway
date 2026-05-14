# ADR-0006: Learning System Integration & Per-Agent Metrics

**Date**: 2026-04-19
**Status**: accepted
**Deciders**: Rene Fichtmueller

## Context

The multi-agent architecture (ADR-0005) connects heterogeneous clients (Claude Code, Codex, ChatGPT, Ollama) to a shared LLM Gateway with independent adapter layers. Each agent has different:
- Request patterns (IDE completions vs full conversations)
- Model preferences (Claude Code needs fast inference, ChatGPT clients expect GPT models)
- Success criteria (IDE: response latency + relevance, ChatGPT: token count + completion quality)
- Failure tolerance (IDE: silent fallback acceptable, ChatGPT: explicit error required)

The learning engine (Phase 2D) currently optimizes globally across all traffic. This creates a mismatch: optimizations for ChatGPT streaming may degrade IDE completions, and per-agent feedback is lost in aggregation.

**Forces:**
- Learning efficiency requires per-agent signal isolation (what helps Claude Code may hurt ChatGPT)
- Agents have distinct success metrics — cannot optimize for all simultaneously
- Fallback chains should be tuned per agent (IDE tolerates Ollama, ChatGPT may reject it)
- Cost attribution: multi-tenant billing requires knowing which agent consumed tokens

## Decision

Extend the learning system to track per-agent metrics in parallel with global optimization:

**1. Per-Agent Metric Collection**
- Agent-scoped request log: `gateway_request_log` → `agent_id` + `model` + `latency_ms` + `tokens_{in,out}` + `confidence` + `fallback_used`
- Agent request registry: track request volume by agent and model tier (fast/medium/large)
- Agent-specific latency targets: Claude Code ≤100ms, ChatGPT ≤500ms (streaming chunk), Ollama-based adapters ≤2s

**2. Agent-Scoped Learning Metrics**
- **Confidence evolution**: Per-agent score tracks "how well does model X work for agent Y"
  - Initialized from global baseline (ADR-0003)
  - Updated on every agent request based on observed outcome (success/fallback)
  - Separate from global confidence — agent-specific signal only
- **Accuracy tracking**: Agent-specific success rate (model X + agent Y combination)
  - IDE: detected via code compilation success or test pass/fail
  - ChatGPT: explicit feedback via client signal (thumbs up/down in UI)
  - Ollama adapter: tracked via request completion time
- **Cost per agent**: Monthly token consumption × model cost + compute time
  - Agent cost reports generated on UTC 00:00 daily
  - Used for cost attribution and budgeting decisions

**3. Adaptive Per-Agent Routing**
- Agent-specific confidence gate (ADR-0003, threshold T) overrides global gate
  - Claude Code: T=0.65 (low latency trumps perfect accuracy)
  - ChatGPT: T=0.75 (accuracy critical, users expect quality)
  - Codex: T=0.70 (balanced)
- Per-agent fallback chain priority
  - Claude Code: Ollama → external (Mistral, Groq) if latency acceptable
  - ChatGPT: External → Ollama only if gateway unavailable
  - Codex LSP: Gateway only (no fallback)
- Agent-specific model tier selection
  - Request scoring (ADR-0002 enhanced): add agent context to dimension set
  - Dimensions now include: `agent_id`, `context_tokens`, `user_language`, etc.
  - Score computation per-agent lookup table (learned over time)

**4. Integration with Learning Engine**
- Feedback loop: agent adapter → gateway metrics → learning engine
  - Agent ID propagated in every request (header `X-Agent-ID` + request body)
  - Response includes agent-specific confidence and model choice rationale
- Learning job phases (30min/1h/6h/12h, ADR-0003):
  - Phase 1: Aggregate global metrics (existing)
  - Phase 2: Compute per-agent slices (new)
  - Phase 3: Update per-agent confidence scores (new)
  - Phase 4: Regenerate per-agent routing rules (new)
  - Phase 5: A/B test on 10% of traffic, measure per-agent impact
- Conflict resolution: if global and agent scores diverge
  - Agent confidence takes precedence (local signal > global)
  - Log divergence for human review (may indicate model degradation or agent change)

**5. Agent Feedback Integration**
- API endpoint: `POST /agents/{agent-id}/feedback`
  - Payload: `{ request_id, outcome, metadata }`
  - Outcomes: `success`, `fallback`, `timeout`, `error`, `user_rejected`
  - Metadata: completion_quality (0-10), latency_ms, token_count
- Asynchronous feedback processing
  - Feedback ingested into agent request log (backfill for requests without explicit feedback)
  - Used to update per-agent confidence on next learning cycle
- User feedback from ChatGPT UI
  - Thumbs up/down on completion → agent feedback signal
  - Aggregated into `user_satisfaction` metric per model/agent pair

## Alternatives Considered

### Alternative 1: Global Learning Only
- **Pros**: Simpler implementation, unified signal, fewer moving parts
- **Cons**: Cannot optimize for heterogeneous agents, per-agent feedback lost, cost attribution unclear
- **Why not**: Agents have fundamentally different success criteria (IDE latency ≠ ChatGPT quality)

### Alternative 2: Separate Learning Engines Per Agent
- **Pros**: Complete isolation, agent-specific optimization, no cross-agent interference
- **Cons**: Massive duplication, learning curves 5x longer (fewer samples per agent), no knowledge sharing
- **Why not**: Claude Code and ChatGPT both benefit from qwen models — throwing away cross-agent signal is wasteful

### Alternative 3: Callback-Based Feedback (No Agent Context)
- **Pros**: Minimal changes to learning engine, compatible with existing code
- **Cons**: Cannot attribute feedback to specific agent, routing decisions remain global
- **Why not**: Feedback without agent context is noise — we would not know which agent benefited from routing change

### Alternative 4: Agent Context in Request ID (Ephemeral)
- **Pros**: No new fields, agent context derived from request ID structure
- **Cons**: Fragile (if request ID format changes, tracing breaks), no standardization
- **Why not**: Tight coupling to request ID generation; agent metadata should be explicit

## Consequences

### Positive
- **Per-agent cost attribution**: Identify which agents are expensive (e.g., ChatGPT streaming uses 3x tokens)
- **Latency SLOs per agent**: Claude Code gets optimized for <100ms, ChatGPT for <500ms/chunk
- **Agent-specific routing**: Can prefer qwen2.5:3b for IDE, :32b for ChatGPT without global harm
- **Learning efficiency**: Signal isolation prevents "optimal for ChatGPT" from breaking IDE responsiveness
- **Fallback diversity**: Claude Code can use Ollama, ChatGPT uses external only — no one-size-fits-all risk
- **Early detection of agent issues**: If Claude Code confidence drops 20% in 1h, alert (possible adapter bug)

### Negative
- **Increased storage**: Per-agent metrics = ~10x request logs compared to aggregated global (50GB → 500GB annually)
- **Learning complexity**: Logic for per-agent confidence updates, conflict resolution, feedback ingestion
- **Operational overhead**: Monthly cost reports per agent, per-agent SLO dashboards, alerting rules
- **Agent coupling**: Changes to agent (e.g., ChatGPT client SDK upgrade) may shift confidence — requires relearning
- **Feedback dependency**: Learning quality degrades if agents don't send feedback (must have fallback)

### Risks
- **Stale per-agent data**: If ChatGPT adapter goes offline for 6h, historical confidence becomes misleading → Mitigation: decay confidence over time (10% per day)
- **Contradictory scores**: Global says "model X is bad", agent says "model X works great for me" → Mitigation: log divergence, human review before policy change
- **Cost explosion**: Per-agent metrics + request logs could 10x storage costs → Mitigation: retention policy (30 days hot, 90 days warm, 1yr cold archive)
- **Privacy**: Agent IDs in logs could enable tracking "which agent requested what" → Mitigation: agent_id anonymized (hash), explicit opt-out for sensitive agents

## Implementation Plan

### Phase 2G.4.1: Per-Agent Request Logging (Week 1)
- Add `agent_id` field to `gateway_request_log` table
- Modify client SDK / adapters to inject `X-Agent-ID` header
- Backfill historical requests with agent ID from source IP heuristics (fallback)
- Test with Claude Code + Codex adapters

### Phase 2G.4.2: Per-Agent Confidence Scoring (Week 2)
- Create `agent_confidence_scores` table: `(agent_id, model, score, updated_at)`
- Update learning engine Phase 3 to compute per-agent slices from request log
- Implement per-agent confidence gate in router (override global gate if agent score available)
- A/B test: 10% of traffic uses per-agent routing, 90% uses global (measure impact)

### Phase 2G.4.3: Per-Agent Feedback Loop (Week 2)
- Implement `POST /agents/{agent-id}/feedback` endpoint
- Adapter SDKs: send feedback after each completion (success/fallback/error)
- ChatGPT UI: wire feedback buttons to feedback endpoint
- Asynchronously ingest feedback into learning engine

### Phase 2G.4.4: Cost Attribution & Reporting (Week 3)
- Dashboard: per-agent token consumption, monthly cost, cost per request
- Daily cost report: `daily_agent_costs.csv` (agent_id, tokens_in, tokens_out, cost_usd)
- Alert: if agent cost > historical avg + 2σ (detect runaway requests)

### Phase 2G.4.5: Per-Agent SLO Monitoring (Week 3)
- Latency SLOs: Claude Code ≤100ms p99, ChatGPT ≤500ms p95 (streaming chunk)
- Alert: SLO breach (e.g., IDE completions suddenly >200ms) → investigate model issue
- Dashboard: per-agent latency heatmap (hourly p50/p95/p99)

### Phase 2G.4.6: Documentation & Runbook (Week 4)
- ADR-0006 (this document)
- Runbook: "Agent Confidence Divergence" (what to do if global ≠ agent scores)
- Runbook: "Cost Spike Investigation" (how to debug high-cost agent)

## Open Questions

1. **Feedback Mechanism**: Should adapters automatically send feedback, or require explicit client instrumentation?
   - Current decision: Automatic (adapters track success/fallback)
   - Open: How to detect IDE compilation success without IDE instrumentation?

2. **Confidence Decay**: How aggressively should per-agent confidence decay over time?
   - Current decision: 10% per day (reaches 50% confidence after ~7 days of inactivity)
   - Open: Should decay be different per agent (IDE less decay than ChatGPT)?

3. **Fallback Privacy**: Should fallback usage be logged per agent (privacy concern)?
   - Current decision: Yes, with anonymized agent_id
   - Open: Do sensitive agents need to opt out of logging?

4. **Conflict Resolution**: If global says "model X bad" but agent says "X works great", which wins?
   - Current decision: Agent wins (local > global)
   - Open: Should conflicts trigger human review before policy change?

5. **Cross-Agent Learning**: Can agent A learn from agent B's feedback?
   - Current decision: Yes (global learning phase pools all agent signals)
   - Open: Should some agents be "first-class" (their feedback weighs more)?

## Related ADRs
- [ADR-0001](0001-multi-agent-coworking-architecture.md) — Multi-agent architecture
- [ADR-0002](0002-tier-assignment-strategy.md) — Tier assignment (now per-agent)
- [ADR-0003](0003-confidence-gate-thresholds.md) — Confidence gate (now per-agent override)
- [ADR-0005](0005-agent-integration-protocol.md) — Agent integration protocol (feedback extension)
