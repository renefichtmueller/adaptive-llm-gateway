# ADR-0004: External Provider Fallback Chain Ordering

**Date**: 2026-04-19  
**Status**: accepted  
**Deciders**: René Fichtmüller

## Context

When all local Ollama tiers fail (network issue, OOM, crash), the Gateway falls back to external LLM APIs. Current providers available:
- **Cerebras**: API rate 5K req/s, <1s latency, free, but unstable/beta
- **Groq**: 30 req/min (harsh rate limit), 50-200ms latency, free tier
- **Mistral AI**: API key required, 100 req/min, 500ms-2s latency, paid
- **NVIDIA NIM**: No public API (would require self-hosted)
- **Cloudflare Workers AI**: 10K req/day, <2s latency, per-token pricing

**Business constraints**:
- No external API keys should be embedded → use environment variables only
- Cost control: Prefer free tiers; paid APIs only as last resort
- Reliability: Prefer faster APIs (reduce latency cliff when local fails)
- Diversity: Don't depend on single provider (avoid being blocked/degraded)

## Decision

Implement **cost-first fallback chain with rate-limit backoff**:

```
Local Ollama
  ↓ (fails, e.g., OOM)
Cerebras (fastest, free, unstable)
  ↓ (rate limit or error)
Groq (free, slower, stable)
  ↓ (rate limit)
Mistral AI (paid, API key required, most stable)
  ↓ (rate limit or error)
NVIDIA NIM (paid, self-hosted, highest latency)
  ↓ (fails)
Cloudflare Workers AI (paid per-token, last resort, highest cost)
```

**Ordering rationale**:
1. **Cerebras first**: Cheapest, fastest when available; accept instability for that trade-off
2. **Groq second**: Free tier, very stable, moderate rate limit (30/min sufficient for most traffic)
3. **Mistral AI third**: Requires API key (cost), but most reliable for production
4. **NVIDIA NIM fourth**: Would require self-hosted NIM instance; complexity penalty
5. **Cloudflare Workers AI last**: Highest cost (per-token); only when all else exhausted

**Implementation details**:
- Each provider has retry limit (3 attempts with exponential backoff)
- Rate limit state stored in memory (reset hourly)
- Provider failure recorded in metrics + learning engine feedback
- If provider becomes unavailable, skip to next (max 10s overhead)

## Alternatives Considered

### Alternative 1: Quality-First Chain (most capable first)
- **Pros**: Best results for high-complexity tasks
- **Cons**: High cost (Mistral/NVIDIA first); free tier exhausted quickly
- **Why not**: Business constraint: cost control is critical for multi-tenant fairness

### Alternative 2: Simplicity-First (single provider)
- **Pros**: Easier to operate, single vendor relationship
- **Cons**: Single point of failure; if vendor is down, entire Gateway fails
- **Why not**: Diversity + resilience required for production

### Alternative 3: Random Selection (load balance)
- **Pros**: Distribute load evenly
- **Cons**: High-latency providers hurt user experience; Cloudflare last → huge variance
- **Why not**: User cares about latency, not equal load distribution

## Consequences

### Positive
- **Cost optimized**: ~80% of fallback traffic on free providers (Cerebras + Groq)
- **Fast recovery**: Cerebras <1s, Groq 50-200ms for fallback requests
- **Resilient**: If Cerebras is down, Groq takes over; if Groq rate-limited, Mistral handles burst
- **Vendor diversity**: Not locked into single provider; can negotiate better terms

### Negative
- **Cerebras instability**: Beta provider; occasional API errors (500, 503)
  - Mitigate: Aggressive retry + fast failover to Groq
- **Groq rate limit**: 30 req/min = ~1 req/2s; can be exhausted in high-traffic moment
  - Mitigate: Queue + prioritize pending_review requests (lower volume)
- **Mistral API key management**: Must rotate; if key leaked, disable immediately
  - Mitigate: Stored in Keychain + rotated monthly

### Risks
- **Cascading latency**: If all local Ollama tiers fail + Cerebras down, fallback to Groq adds 2-5s latency
  - Mitigate: Health checks on fallback providers; preemptively escalate to next if latency >SLA
- **Cost creep**: If Groq rate limit is frequently hit, Mistral/Cloudflare usage increases
  - Mitigate: Monitor provider usage weekly; alert if Mistral >10% of traffic
- **Learning feedback loop interference**: If fallback providers have different accuracy than Ollama, confidence scores become unreliable
  - Mitigate: Tag responses with `provider` field; learning engine treats fallback differently

## Implementation Notes

1. **Fallback chain in llm-client.ts**:
   ```typescript
   const FALLBACK_CHAIN = [
     { provider: 'cerebras', apiKey: process.env.CEREBRAS_API_KEY },
     { provider: 'groq', apiKey: process.env.GROQ_API_KEY },
     { provider: 'mistral', apiKey: process.env.MISTRAL_API_KEY },
     { provider: 'nvidia-nim', endpoint: process.env.NVIDIA_NIM_ENDPOINT },
     { provider: 'cloudflare-workers-ai', apiKey: process.env.CLOUDFLARE_TOKEN },
   ];
   ```

2. **Rate limit tracking**:
   ```typescript
   const providerState = {
     cerebras: { requests_this_hour: 0, last_reset: Date.now() },
     groq: { requests_this_hour: 0, last_reset: Date.now() },
   };
   ```

3. **Retry strategy**:
   - Attempt 1: Cerebras (timeout 5s)
   - Attempt 2: Groq (timeout 3s)
   - Attempt 3: Mistral (timeout 10s)
   - Attempt 4: NVIDIA NIM (timeout 15s, if configured)
   - Attempt 5: Cloudflare (timeout 10s)
   - Each failure incremented, logged, and sent to learning engine

4. **Monitoring**:
   - Per-provider request count (cumulative)
   - Per-provider error rate (%)
   - Per-provider latency histogram (P50, P95, P99)
   - Fallback chain activation rate (% requests that hit fallback)

## Related Decisions
- ADR-0001: Multi-Agent Coworking Architecture
- ADR-0002: Tier assignment strategy
- ADR-0003: Confidence gate thresholds & learning cycles
