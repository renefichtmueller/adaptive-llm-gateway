import { Client } from 'postgres'

export type FeedbackOutcome = 'success' | 'fallback' | 'timeout' | 'error' | 'user_rejected'

export interface FeedbackRequest {
  requestId: string
  agentId: string
  outcome: FeedbackOutcome
  completionQuality?: number // 0-10
  latencyMs?: number
  tokenCount?: number
  userSatisfaction?: number // 0-10 from UI
  metadata?: Record<string, unknown>
}

export interface FeedbackStats {
  agentId: string
  totalFeedback: number
  outcomeBreakdown: Record<FeedbackOutcome, number>
  avgQuality: number
  avgSatisfaction: number
}

export class FeedbackProcessor {
  constructor(private db: Client) {}

  async processFeedback(feedback: FeedbackRequest): Promise<void> {
    const timestamp = new Date()

    await this.db`
      INSERT INTO agent_feedback (
        request_id, agent_id, outcome, completion_quality, latency_ms,
        token_count, metadata, created_at
      ) VALUES (
        ${feedback.requestId},
        ${feedback.agentId},
        ${feedback.outcome},
        ${feedback.completionQuality || null},
        ${feedback.latencyMs || null},
        ${feedback.tokenCount || null},
        ${JSON.stringify({
          userSatisfaction: feedback.userSatisfaction,
          ...feedback.metadata
        })},
        ${timestamp}
      )
    `
  }

  async getFeedbackStats(
    agentId: string,
    hours: number = 24
  ): Promise<FeedbackStats> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

    const results = await this.db`
      SELECT
        outcome,
        COUNT(*) as count,
        AVG(completion_quality) as avg_quality,
        AVG((metadata->>'userSatisfaction')::int) as avg_satisfaction
      FROM agent_feedback
      WHERE agent_id = ${agentId} AND created_at > ${cutoff}
      GROUP BY outcome
    `

    const outcomeBreakdown: Record<FeedbackOutcome, number> = {
      success: 0,
      fallback: 0,
      timeout: 0,
      error: 0,
      user_rejected: 0
    }

    let totalFeedback = 0
    let totalQuality = 0
    let qualityCount = 0
    let totalSatisfaction = 0
    let satisfactionCount = 0

    for (const row of results as any[]) {
      const outcome = row.outcome as FeedbackOutcome
      const count = Number(row.count)
      outcomeBreakdown[outcome] = count
      totalFeedback += count

      if (row.avg_quality) {
        totalQuality += Number(row.avg_quality)
        qualityCount++
      }
      if (row.avg_satisfaction) {
        totalSatisfaction += Number(row.avg_satisfaction)
        satisfactionCount++
      }
    }

    return {
      agentId,
      totalFeedback,
      outcomeBreakdown,
      avgQuality: qualityCount > 0 ? totalQuality / qualityCount : 0,
      avgSatisfaction: satisfactionCount > 0 ? totalSatisfaction / satisfactionCount : 0
    }
  }

  async getOutcomeDistribution(
    agentId: string,
    hours: number = 24
  ): Promise<{ outcome: FeedbackOutcome; percentage: number }[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

    const results = await this.db`
      SELECT outcome, COUNT(*) as count
      FROM agent_feedback
      WHERE agent_id = ${agentId} AND created_at > ${cutoff}
      GROUP BY outcome
    `

    const total = results.reduce((sum, row: any) => sum + Number(row.count), 0)
    if (total === 0) return []

    return results.map((row: any) => ({
      outcome: row.outcome as FeedbackOutcome,
      percentage: (Number(row.count) / total) * 100
    }))
  }

  async identifySuccessfulModels(agentId: string): Promise<string[]> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const results = await this.db`
      SELECT DISTINCT log.model
      FROM agent_request_log log
      INNER JOIN agent_feedback fb ON log.request_id = fb.request_id
      WHERE log.agent_id = ${agentId}
        AND log.created_at > ${cutoff}
        AND fb.outcome = 'success'
      ORDER BY log.model
    `

    return results.map((row: any) => row.model)
  }

  async computeConfidenceScore(
    agentId: string,
    model: string
  ): Promise<number> {
    const day = new Date()
    day.setDate(day.getDate() - 1)

    const feedback = await this.db`
      SELECT
        COUNT(CASE WHEN outcome = 'success' THEN 1 END)::float / COUNT(*) as success_rate,
        AVG(completion_quality) as avg_quality,
        AVG((metadata->>'userSatisfaction')::int) as avg_satisfaction
      FROM agent_feedback fb
      INNER JOIN agent_request_log log ON fb.request_id = log.request_id
      WHERE fb.agent_id = ${agentId}
        AND log.model = ${model}
        AND fb.created_at > ${day}
    `

    if (feedback.length === 0) return 0.5 // Default neutral confidence

    const row = feedback[0] as any
    const successRate = Number(row.success_rate || 0)
    const avgQuality = Number(row.avg_quality || 5) / 10 // Normalize to 0-1
    const avgSatisfaction = Number(row.avg_satisfaction || 5) / 10 // Normalize to 0-1

    // Weighted average: 50% success, 25% quality, 25% satisfaction
    const score = successRate * 0.5 + avgQuality * 0.25 + avgSatisfaction * 0.25
    return Math.min(1, Math.max(0, score))
  }

  async shouldUpdateConfidence(
    agentId: string,
    model: string,
    newScore: number,
    threshold: number = 0.1
  ): Promise<boolean> {
    // Get current confidence
    const current = await this.db`
      SELECT score FROM agent_confidence_scores
      WHERE agent_id = ${agentId} AND model = ${model}
    `

    if (current.length === 0) return true // Always update if no history

    const currentScore = Number(current[0].score)
    return Math.abs(newScore - currentScore) > threshold
  }

  async processUserFeedback(
    requestId: string,
    agentId: string,
    satisfaction: number // 0-10
  ): Promise<void> {
    const metadata = { userSatisfaction: satisfaction }

    await this.db`
      INSERT INTO agent_feedback (
        request_id, agent_id, outcome, metadata
      ) VALUES (
        ${requestId},
        ${agentId},
        'success',
        ${JSON.stringify(metadata)}
      )
      ON CONFLICT (request_id) DO UPDATE SET
        metadata = ${JSON.stringify(metadata)}
    `
  }
}

export default FeedbackProcessor
