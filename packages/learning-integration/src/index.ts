import type { Sql } from 'postgres'

export interface AgentMetrics {
  agentId: string
  model: string
  requestCount: number
  successRate: number
  avgLatencyMs: number
  totalTokens: number
  costUsd: number
  confidence: number
  updatedAt: Date
}

export interface RequestLog {
  requestId: string
  agentId: string
  model: string
  latencyMs: number
  tokensIn: number
  tokensOut: number
  confidence: number
  fallbackUsed: boolean
  success: boolean
  timestamp: Date
}

export interface AgentFeedback {
  requestId: string
  agentId: string
  outcome: 'success' | 'fallback' | 'timeout' | 'error' | 'user_rejected'
  completionQuality?: number
  latencyMs?: number
  tokenCount?: number
  metadata?: Record<string, unknown>
  timestamp: Date
}

export interface PerAgentConfidence {
  agentId: string
  model: string
  score: number
  sampleSize: number
  lastUpdated: Date
  trend: 'improving' | 'stable' | 'degrading'
}

export class LearningIntegration {
  private db: Sql

  constructor(dbConnection: Sql) {
    this.db = dbConnection
  }

  async initializeTables(): Promise<void> {
    await this.db`
      CREATE TABLE IF NOT EXISTS agent_request_log (
        request_id UUID PRIMARY KEY,
        agent_id VARCHAR(64) NOT NULL,
        model VARCHAR(128) NOT NULL,
        latency_ms INTEGER NOT NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        confidence DECIMAL(3, 2) NOT NULL,
        fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
        success BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `
    await this.db`
      CREATE INDEX IF NOT EXISTS idx_request_log_agent_model
        ON agent_request_log (agent_id, model)
    `
    await this.db`
      CREATE INDEX IF NOT EXISTS idx_request_log_created
        ON agent_request_log (created_at)
    `

    await this.db`
      CREATE TABLE IF NOT EXISTS agent_feedback (
        id SERIAL PRIMARY KEY,
        request_id UUID NOT NULL REFERENCES agent_request_log (request_id),
        agent_id VARCHAR(64) NOT NULL,
        outcome VARCHAR(32) NOT NULL,
        completion_quality SMALLINT,
        latency_ms INTEGER,
        token_count INTEGER,
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `
    await this.db`
      CREATE INDEX IF NOT EXISTS idx_feedback_agent_outcome
        ON agent_feedback (agent_id, outcome)
    `
    await this.db`
      CREATE INDEX IF NOT EXISTS idx_feedback_created
        ON agent_feedback (created_at)
    `

    await this.db`
      CREATE TABLE IF NOT EXISTS agent_confidence_scores (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(64) NOT NULL,
        model VARCHAR(128) NOT NULL,
        score DECIMAL(3, 2) NOT NULL,
        sample_size INTEGER NOT NULL DEFAULT 0,
        trend VARCHAR(16) NOT NULL DEFAULT 'stable',
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (agent_id, model)
      )
    `
    await this.db`
      CREATE INDEX IF NOT EXISTS idx_confidence_agent
        ON agent_confidence_scores (agent_id)
    `
  }

  async logRequest(log: Omit<RequestLog, 'timestamp'>): Promise<void> {
    await this.db`
      INSERT INTO agent_request_log (
        request_id, agent_id, model, latency_ms, tokens_in, tokens_out,
        confidence, fallback_used, success
      ) VALUES (
        ${log.requestId}, ${log.agentId}, ${log.model}, ${log.latencyMs},
        ${log.tokensIn}, ${log.tokensOut}, ${log.confidence},
        ${log.fallbackUsed}, ${log.success}
      )
    `
  }

  async recordFeedback(feedback: Omit<AgentFeedback, 'timestamp'>): Promise<void> {
    await this.db`
      INSERT INTO agent_feedback (
        request_id, agent_id, outcome, completion_quality, latency_ms,
        token_count, metadata
      ) VALUES (
        ${feedback.requestId}, ${feedback.agentId}, ${feedback.outcome},
        ${feedback.completionQuality ?? null}, ${feedback.latencyMs ?? null},
        ${feedback.tokenCount ?? null}, ${JSON.stringify(feedback.metadata ?? {})}
      )
    `
  }

  async getAgentMetrics(agentId: string, hours: number = 24): Promise<AgentMetrics[]> {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000)

    const results = await this.db`
      SELECT
        agent_id,
        model,
        COUNT(*) as request_count,
        COUNT(CASE WHEN success = true THEN 1 END)::float / COUNT(*) as success_rate,
        AVG(latency_ms)::float as avg_latency_ms,
        SUM(tokens_in + tokens_out) as total_tokens,
        SUM(tokens_in + tokens_out) * 0.0001 as cost_usd,
        AVG(confidence)::float as confidence,
        MAX(created_at) as updated_at
      FROM agent_request_log
      WHERE agent_id = ${agentId} AND created_at > ${cutoffTime}
      GROUP BY agent_id, model
      ORDER BY request_count DESC
    `

    return results.map((row: any) => ({
      agentId: row.agent_id,
      model: row.model,
      requestCount: Number(row.request_count),
      successRate: Number(row.success_rate),
      avgLatencyMs: Number(row.avg_latency_ms),
      totalTokens: Number(row.total_tokens),
      costUsd: Number(row.cost_usd),
      confidence: Number(row.confidence),
      updatedAt: new Date(row.updated_at)
    }))
  }

  async updateAgentConfidence(
    agentId: string,
    model: string,
    newScore: number
  ): Promise<void> {
    await this.db`
      INSERT INTO agent_confidence_scores (agent_id, model, score, sample_size)
      VALUES (${agentId}, ${model}, ${newScore}, 1)
      ON CONFLICT (agent_id, model)
      DO UPDATE SET
        score = ${newScore},
        sample_size = agent_confidence_scores.sample_size + 1,
        updated_at = NOW()
    `
  }

  async getAgentConfidence(agentId: string, model: string): Promise<PerAgentConfidence | null> {
    const results = await this.db`
      SELECT * FROM agent_confidence_scores
      WHERE agent_id = ${agentId} AND model = ${model}
    `

    if (results.length === 0) return null

    const row = results[0] as any
    return {
      agentId: row.agent_id,
      model: row.model,
      score: Number(row.score),
      sampleSize: Number(row.sample_size),
      lastUpdated: new Date(row.updated_at),
      trend: row.trend as 'improving' | 'stable' | 'degrading'
    }
  }

  async computePerAgentMetrics(agentId: string): Promise<AgentMetrics[]> {
    // Compute metrics for past 24 hours
    return this.getAgentMetrics(agentId, 24)
  }

  async getAgentCosts(days: number = 30): Promise<Map<string, number>> {
    const cutoffTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const results = await this.db`
      SELECT
        agent_id,
        SUM(tokens_in + tokens_out) * 0.0001 as cost_usd
      FROM agent_request_log
      WHERE created_at > ${cutoffTime}
      GROUP BY agent_id
      ORDER BY cost_usd DESC
    `

    const costs = new Map<string, number>()
    for (const row of results as any[]) {
      costs.set(row.agent_id, Number(row.cost_usd))
    }
    return costs
  }

  async detectAnomalies(
    agentId: string,
    threshold: number = 2
  ): Promise<{ model: string; issue: string }[]> {
    const metrics = await this.getAgentMetrics(agentId, 24)
    const baseline = await this.getAgentMetrics(agentId, 24 * 30) // 30-day baseline

    const anomalies: { model: string; issue: string }[] = []

    for (const current of metrics) {
      const baselineMetric = baseline.find(m => m.model === current.model)
      if (!baselineMetric) continue

      // Check latency spike
      if (current.avgLatencyMs > baselineMetric.avgLatencyMs * (1 + threshold * 0.1)) {
        anomalies.push({
          model: current.model,
          issue: `Latency spike: ${current.avgLatencyMs}ms (baseline: ${baselineMetric.avgLatencyMs}ms)`
        })
      }

      // Check success rate drop
      if (current.successRate < baselineMetric.successRate * (1 - threshold * 0.1)) {
        anomalies.push({
          model: current.model,
          issue: `Success rate drop: ${(current.successRate * 100).toFixed(1)}% (baseline: ${(baselineMetric.successRate * 100).toFixed(1)}%)`
        })
      }

      // Check confidence drop
      if (current.confidence < baselineMetric.confidence * 0.8) {
        anomalies.push({
          model: current.model,
          issue: `Confidence degradation: ${current.confidence.toFixed(2)} (baseline: ${baselineMetric.confidence.toFixed(2)})`
        })
      }
    }

    return anomalies
  }
}

export default LearningIntegration
