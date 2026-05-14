import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db/client.js';

export async function learningInsightsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/learning/insights', async (_request: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    try {
      // Get latest improvements
      const improvements = await pool.query(
        `SELECT cycle_id, cycle_duration, improvements_found, routing_changes, status, completed_at, metrics
         FROM learning_cycles
         ORDER BY completed_at DESC
         LIMIT 10`,
      );

      // Get model performance rankings
      const rankings = await pool.query(
        `SELECT model, task_type, success_rate, avg_latency_ms, total_calls, confidence_avg
         FROM model_performance
         WHERE total_calls > 5
         ORDER BY task_type, success_rate DESC`,
      );

      // Get recent improvements by type
      const improvements_by_type = await pool.query(
        `SELECT
          cycle_id,
          metrics->'improvementsByType' as types,
          completed_at
         FROM learning_cycles
         WHERE metrics IS NOT NULL
         ORDER BY completed_at DESC
         LIMIT 5`,
      );

      return reply.status(200).send({
        latest_cycles: improvements.rows,
        model_rankings: rankings.rows,
        recent_improvements: improvements_by_type.rows,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to fetch learning insights',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  fastify.get('/learning/model-stats/:model', async (request: FastifyRequest, reply: FastifyReply) => {
    const { model } = request.params as { model: string };
    const pool = getPool();

    try {
      // Get overall stats for the model
      const stats = await pool.query(
        `SELECT model, task_type, success_rate, avg_latency_ms, total_calls, confidence_avg, last_updated
         FROM model_performance
         WHERE model = $1
         ORDER BY task_type`,
        [model],
      );

      // Get recent routing decisions
      const decisions = await pool.query(
        `SELECT task_type, success, confidence_final, latency_ms, cost_usd, created_at
         FROM routing_decisions
         WHERE actual_model_used = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [model],
      );

      // Get fallback chain stats
      const fallbacks = await pool.query(
        `SELECT fallback_model, COUNT(*) as attempts, SUM(CASE WHEN success THEN 1 ELSE 0 END) as successes
         FROM fallback_chain_metrics
         WHERE primary_model = $1
         GROUP BY fallback_model
         ORDER BY attempts DESC`,
        [model],
      );

      return reply.status(200).send({
        model,
        performance_by_task: stats.rows,
        recent_decisions: decisions.rows,
        fallback_usage: fallbacks.rows,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return reply.status(500).send({
        error: `Failed to fetch stats for model ${model}`,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  fastify.get('/learning/task-routing/:taskType', async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskType } = request.params as { taskType: string };
    const pool = getPool();

    try {
      // Get best-performing models for this task
      const best_models = await pool.query(
        `SELECT routing_model, AVG(CASE WHEN success THEN 1 ELSE 0 END)::numeric(3,2) as success_rate,
                AVG(latency_ms) as avg_latency, COUNT(*) as total_attempts
         FROM routing_decisions
         WHERE task_type = $1 AND created_at > NOW() - INTERVAL '7 day'
         GROUP BY routing_model
         ORDER BY success_rate DESC, avg_latency ASC`,
        [taskType],
      );

      // Get routing decision distribution
      const distribution = await pool.query(
        `SELECT routing_model, COUNT(*) as uses, SUM(CASE WHEN success THEN 1 ELSE 0 END) as successes,
                SUM(CASE WHEN was_fallback THEN 1 ELSE 0 END) as fallback_uses
         FROM routing_decisions
         WHERE task_type = $1 AND created_at > NOW() - INTERVAL '7 day'
         GROUP BY routing_model
         ORDER BY uses DESC`,
        [taskType],
      );

      return reply.status(200).send({
        task_type: taskType,
        recommended_routing: best_models.rows,
        current_distribution: distribution.rows,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return reply.status(500).send({
        error: `Failed to fetch routing info for task ${taskType}`,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });
}
