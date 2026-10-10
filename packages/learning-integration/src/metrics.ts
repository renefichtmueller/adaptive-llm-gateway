import type { Sql } from 'postgres'

export interface DailyAgentCost {
  date: string
  agentId: string
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface LatencySLO {
  agentId: string
  targetMs: number
  p50: number
  p95: number
  p99: number
  breached: boolean
}

export class PerAgentMetrics {
  constructor(private db: Sql) {}

  async generateDailyCostReport(date: string): Promise<DailyAgentCost[]> {
    const startOfDay = new Date(date)
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)

    const results = await this.db`
      SELECT
        agent_id,
        SUM(tokens_in) as tokens_in,
        SUM(tokens_out) as tokens_out,
        (SUM(tokens_in) + SUM(tokens_out)) * 0.0001 as cost_usd
      FROM agent_request_log
      WHERE created_at >= ${startOfDay} AND created_at < ${endOfDay}
      GROUP BY agent_id
      ORDER BY cost_usd DESC
    `

    return results.map((row: any) => ({
      date,
      agentId: row.agent_id,
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      costUsd: Number(row.cost_usd)
    }))
  }

  async checkLatencySLO(
    agentId: string,
    targetMs: number = 500
  ): Promise<LatencySLO> {
    const hour = new Date()
    hour.setHours(hour.getHours() - 1)

    const results = await this.db`
      SELECT
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) as p99
      FROM agent_request_log
      WHERE agent_id = ${agentId} AND created_at > ${hour}
    `

    if (results.length === 0) {
      return {
        agentId,
        targetMs,
        p50: 0,
        p95: 0,
        p99: 0,
        breached: false
      }
    }

    const row = results[0] as any
    const p99 = Number(row.p99 || 0)
    const breached = p99 > targetMs

    return {
      agentId,
      targetMs,
      p50: Number(row.p50 || 0),
      p95: Number(row.p95 || 0),
      p99,
      breached
    }
  }

  async getAgentSuccessRate(
    agentId: string,
    hours: number = 24
  ): Promise<{ total: number; successful: number; rate: number }> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

    const results = await this.db`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN success = true THEN 1 END) as successful
      FROM agent_request_log
      WHERE agent_id = ${agentId} AND created_at > ${cutoff}
    `

    if (results.length === 0) {
      return { total: 0, successful: 0, rate: 0 }
    }

    const row = results[0] as any
    const total = Number(row.total)
    const successful = Number(row.successful)

    return {
      total,
      successful,
      rate: total > 0 ? successful / total : 0
    }
  }

  async getFallbackRate(
    agentId: string,
    hours: number = 24
  ): Promise<{ fallbacks: number; total: number; rate: number }> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

    const results = await this.db`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN fallback_used = true THEN 1 END) as fallbacks
      FROM agent_request_log
      WHERE agent_id = ${agentId} AND created_at > ${cutoff}
    `

    if (results.length === 0) {
      return { fallbacks: 0, total: 0, rate: 0 }
    }

    const row = results[0] as any
    const total = Number(row.total)
    const fallbacks = Number(row.fallbacks)

    return {
      fallbacks,
      total,
      rate: total > 0 ? fallbacks / total : 0
    }
  }

  async getModelPerformance(
    agentId: string,
    model: string,
    hours: number = 24
  ): Promise<{
    model: string
    requests: number
    avgLatency: number
    successRate: number
    confidence: number
  }> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

    const results = await this.db`
      SELECT
        COUNT(*) as requests,
        AVG(latency_ms) as avg_latency,
        COUNT(CASE WHEN success = true THEN 1 END)::float / COUNT(*) as success_rate,
        AVG(confidence) as confidence
      FROM agent_request_log
      WHERE agent_id = ${agentId} AND model = ${model} AND created_at > ${cutoff}
    `

    if (results.length === 0) {
      return { model, requests: 0, avgLatency: 0, successRate: 0, confidence: 0 }
    }

    const row = results[0] as any
    return {
      model,
      requests: Number(row.requests),
      avgLatency: Number(row.avg_latency || 0),
      successRate: Number(row.success_rate || 0),
      confidence: Number(row.confidence || 0)
    }
  }

  async compareAgentPerformance(): Promise<
    { agentId: string; requests: number; avgLatency: number; costUsd: number }[]
  > {
    const day = new Date()
    day.setDate(day.getDate() - 1)
    const startOfDay = new Date(day)
    startOfDay.setHours(0, 0, 0, 0)

    const results = await this.db`
      SELECT
        agent_id,
        COUNT(*) as requests,
        AVG(latency_ms) as avg_latency,
        (SUM(tokens_in) + SUM(tokens_out)) * 0.0001 as cost_usd
      FROM agent_request_log
      WHERE created_at >= ${startOfDay}
      GROUP BY agent_id
      ORDER BY requests DESC
    `

    return results.map((row: any) => ({
      agentId: row.agent_id,
      requests: Number(row.requests),
      avgLatency: Number(row.avg_latency || 0),
      costUsd: Number(row.cost_usd || 0)
    }))
  }

  async getAgentTrending(
    agentId: string,
    model: string
  ): Promise<{ trend: 'improving' | 'stable' | 'degrading'; signal: number }> {
    // Compare success rate: last 24h vs previous 24h
    const now24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const now48h = new Date(Date.now() - 48 * 60 * 60 * 1000)

    const recent = await this.db`
      SELECT COUNT(CASE WHEN success = true THEN 1 END)::float / COUNT(*) as rate
      FROM agent_request_log
      WHERE agent_id = ${agentId} AND model = ${model} AND created_at > ${now24h}
    `

    const previous = await this.db`
      SELECT COUNT(CASE WHEN success = true THEN 1 END)::float / COUNT(*) as rate
      FROM agent_request_log
      WHERE agent_id = ${agentId} AND model = ${model}
        AND created_at > ${now48h} AND created_at <= ${now24h}
    `

    const recentRate = recent.length > 0 ? Number(recent[0].rate || 0) : 0
    const previousRate = previous.length > 0 ? Number(previous[0].rate || 0) : 0
    const signal = recentRate - previousRate

    let trend: 'improving' | 'stable' | 'degrading' = 'stable'
    if (signal > 0.05) trend = 'improving'
    if (signal < -0.05) trend = 'degrading'

    return { trend, signal }
  }
}

export default PerAgentMetrics
