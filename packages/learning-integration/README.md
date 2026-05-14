# Learning System Integration

Per-agent metrics collection, feedback processing, and learning system integration for LLM Gateway.

## Overview

Extends the global learning system (Phase 2D) with per-agent signal isolation. Tracks metrics separately for each agent (Claude Code, Codex, ChatGPT, etc.) to enable agent-specific optimization and cost attribution.

## Installation

```bash
npm install @llm-gateway/learning-integration
```

## Core Concepts

### Per-Agent Metrics

Each agent maintains its own metric set tracking success, latency, cost, and confidence:
- **Success Rate**: % of requests that succeeded without fallback
- **Latency**: P50, P95, P99 response time (ms)
- **Cost**: Token consumption × model cost
- **Confidence**: Learned score 0-1 indicating model suitability for agent

### Feedback Loop

Agents report outcomes (success, fallback, error, timeout) enabling closed-loop learning:
- Adapter automatically tracks success/fallback
- Client can provide explicit feedback (quality, satisfaction)
- Learning engine uses feedback to update per-agent confidence scores

### Confidence Scoring

Per-agent confidence (independent of global score):
- Initialized from global baseline
- Updated hourly based on feedback
- Influences routing decisions (per-agent gate overrides global gate)
- Decays 10% per day if inactive

## Usage

### Basic Setup

```typescript
import { LearningIntegration } from '@llm-gateway/learning-integration'
import postgres from 'postgres'

const db = postgres({
  host: 'localhost',
  port: 5432,
  database: 'llm_gateway'
})

const learning = new LearningIntegration(db)

// Initialize tables on startup
await learning.initializeTables()
```

### Logging Requests

```typescript
import { randomUUID } from 'crypto'

const requestId = randomUUID()

// After completion, log the request
await learning.logRequest({
  requestId,
  agentId: 'claude-code',
  model: 'qwen2.5:14b',
  latencyMs: 250,
  tokensIn: 150,
  tokensOut: 450,
  confidence: 0.85,
  fallbackUsed: false,
  success: true
})
```

### Recording Feedback

```typescript
// Automatic (adapter tracks outcome)
await learning.recordFeedback({
  requestId,
  agentId: 'claude-code',
  outcome: 'success',
  completionQuality: 8, // 0-10
  latencyMs: 250
})

// Explicit (from client UI)
await learning.recordFeedback({
  requestId,
  agentId: 'chatgpt',
  outcome: 'success',
  metadata: {
    userSatisfaction: 9 // 0-10 from thumbs up/down
  }
})
```

### Computing Metrics

```typescript
// Per-agent metrics (last 24h)
const metrics = await learning.getAgentMetrics('claude-code')
console.log(metrics)
// [{
//   agentId: 'claude-code',
//   model: 'qwen2.5:14b',
//   requestCount: 1523,
//   successRate: 0.98,
//   avgLatencyMs: 245,
//   totalTokens: 850000,
//   costUsd: 85.00,
//   confidence: 0.87,
//   updatedAt: 2026-04-19T22:00:00Z
// }]

// Per-agent cost tracking
const costs = await learning.getAgentCosts(30) // 30 days
costs.forEach((cost, agentId) => {
  console.log(`${agentId}: $${cost.toFixed(2)}`)
})
// claude-code: $892.50
// chatgpt: $1234.75
// codex: $345.20

// Anomaly detection
const anomalies = await learning.detectAnomalies('claude-code')
anomalies.forEach(a => {
  console.log(`${a.model}: ${a.issue}`)
})
```

### SLO Monitoring

```typescript
import { PerAgentMetrics } from '@llm-gateway/learning-integration/metrics'

const metrics = new PerAgentMetrics(db)

// Check latency SLO
const slo = await metrics.checkLatencySLO('claude-code', 100) // Target: 100ms
console.log(slo)
// {
//   agentId: 'claude-code',
//   targetMs: 100,
//   p50: 45,
//   p95: 89,
//   p99: 98,
//   breached: false
// }

// Daily cost report
const costs = await metrics.generateDailyCostReport('2026-04-19')
console.log(costs)
// [{
//   date: '2026-04-19',
//   agentId: 'claude-code',
//   tokensIn: 50000,
//   tokensOut: 150000,
//   costUsd: 20.00
// }]
```

### Feedback Processing

```typescript
import { FeedbackProcessor } from '@llm-gateway/learning-integration/feedback'

const feedback = new FeedbackProcessor(db)

// Process feedback from any source
await feedback.processFeedback({
  requestId,
  agentId: 'chatgpt',
  outcome: 'success',
  completionQuality: 9,
  userSatisfaction: 10
})

// Get feedback stats
const stats = await feedback.getFeedbackStats('chatgpt')
console.log(stats)
// {
//   agentId: 'chatgpt',
//   totalFeedback: 2450,
//   outcomeBreakdown: {
//     success: 2350,
//     fallback: 50,
//     timeout: 25,
//     error: 20,
//     user_rejected: 5
//   },
//   avgQuality: 8.2,
//   avgSatisfaction: 8.7
// }

// Compute confidence score from feedback
const score = await feedback.computeConfidenceScore('chatgpt', 'gpt-4')
console.log(`Confidence: ${score.toFixed(2)}`) // 0.87
```

## Database Schema

### agent_request_log
```sql
CREATE TABLE agent_request_log (
  request_id UUID PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  model VARCHAR(128) NOT NULL,
  latency_ms INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  confidence DECIMAL(3, 2) NOT NULL,
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  INDEX idx_agent_model (agent_id, model),
  INDEX idx_created (created_at)
)
```

### agent_feedback
```sql
CREATE TABLE agent_feedback (
  id SERIAL PRIMARY KEY,
  request_id UUID NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  completion_quality SMALLINT,
  latency_ms INTEGER,
  token_count INTEGER,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (request_id) REFERENCES agent_request_log (request_id),
  INDEX idx_agent_outcome (agent_id, outcome),
  INDEX idx_created (created_at)
)
```

### agent_confidence_scores
```sql
CREATE TABLE agent_confidence_scores (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  model VARCHAR(128) NOT NULL,
  score DECIMAL(3, 2) NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  trend VARCHAR(16) NOT NULL DEFAULT 'stable',
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, model),
  INDEX idx_agent (agent_id)
)
```

## Integration with Learning Engine

### Learning Cycle (ADR-0003)

Per-agent metrics computed during learning cycles:

**Phase 2**: Aggregate global metrics (existing)
**Phase 2**: Compute per-agent slices (new)
```typescript
for (const agentId of knownAgents) {
  const metrics = await learning.getAgentMetrics(agentId)
  for (const metric of metrics) {
    // Update per-agent confidence
    const newScore = feedback.computeConfidenceScore(agentId, metric.model)
    await learning.updateAgentConfidence(agentId, metric.model, newScore)
  }
}
```

**Phase 3**: Update per-agent confidence scores (new)
```typescript
for (const [agentId, model] of agentModelPairs) {
  const score = await feedback.computeConfidenceScore(agentId, model)
  const shouldUpdate = await feedback.shouldUpdateConfidence(agentId, model, score)
  if (shouldUpdate) {
    await learning.updateAgentConfidence(agentId, model, score)
  }
}
```

**Phase 5**: A/B test per-agent routing (new)
```typescript
// 10% of traffic uses per-agent routing
if (Math.random() < 0.1) {
  const agentConfidence = await learning.getAgentConfidence(agentId, model)
  if (agentConfidence && agentConfidence.score > 0.65) {
    // Use per-agent routing decision
  }
}
```

## Feedback Outcomes

| Outcome | Meaning | Auto | Manual |
|---------|---------|------|--------|
| `success` | Request succeeded, no fallback | Yes | Yes |
| `fallback` | Gateway unavailable, used Ollama | Yes | - |
| `timeout` | Request exceeded timeout | Yes | - |
| `error` | Request failed with error | Yes | Yes |
| `user_rejected` | Client explicitly rejected response | - | Yes |

## Cost Attribution

Monthly cost per agent (token-based):

```
Cost = (tokens_in + tokens_out) × model_rate × 0.0001
```

Default rates:
- qwen2.5:3b = $0.0001 per 1K tokens
- qwen2.5:14b = $0.0001 per 1K tokens
- qwen2.5:32b = $0.0001 per 1K tokens

Configurable via learning engine cost config.

## Testing

```bash
npm test
```

Tests cover:
- Per-agent metric computation
- Feedback ingestion and processing
- Confidence score calculation
- Anomaly detection
- Cost attribution
- SLO monitoring
- Trending analysis

## Performance

- Request logging: <1ms per insertion
- Feedback processing: <1ms per insertion
- Metric computation (24h): 100-500ms per agent
- Cost report generation: 500ms-1s for all agents
- Anomaly detection: 1-2s per agent

## Related ADRs
- [ADR-0002](../adr/0002-tier-assignment-strategy.md) — Tier assignment (per-agent override)
- [ADR-0003](../adr/0003-confidence-gate-thresholds.md) — Confidence gate (per-agent gate)
- [ADR-0006](../adr/0006-learning-system-integration.md) — Learning system specification

## Security Notes

- Agent IDs are stored plaintext (consider hashing for privacy-sensitive deployments)
- User satisfaction scores in metadata (consider encryption at rest)
- Cost reports are per-agent (may expose usage patterns)
