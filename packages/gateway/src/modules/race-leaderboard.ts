/**
 * Race Mode Leaderboard
 *
 * Aggregates `race_mode_results` to produce a weekly model leaderboard:
 * who finished first most often, who had highest confidence, who was
 * fastest on average. Used by the dashboard for the leaderboard tab and
 * by the router (future) to bias against perpetually losing models.
 */
import type { Pool } from 'pg';
import { logger } from '../observability/logger.js';

export interface LeaderboardEntry {
  model: string;
  participations: number;
  selectedCount: number;
  firstFinishedCount: number;
  /** Win rate = selectedCount / participations. */
  winRate: number;
  /** Speed rate = firstFinishedCount / participations. */
  speedRate: number;
  avgLatencyMs: number;
  avgConfidence: number | null;
  totalCost: number;
  /** Composite score: 60% speed + 40% confidence, used to rank. */
  rank: number;
  rankPosition: number;
  badge: 'gold' | 'silver' | 'bronze' | null;
}

export async function getRaceLeaderboard(
  db: Pool,
  daysBack: number = 7
): Promise<{
  totalRaces: number;
  daysCovered: number;
  entries: LeaderboardEntry[];
  fastestThisWeek: { model: string; latencyMs: number } | null;
  mostReliable: { model: string; winRate: number } | null;
}> {
  try {
    const r = await db.query(`
      SELECT candidate_model AS model,
             COUNT(*)::INT AS participations,
             SUM(CASE WHEN selected THEN 1 ELSE 0 END)::INT AS selected_count,
             SUM(CASE WHEN finished_first THEN 1 ELSE 0 END)::INT AS first_finished_count,
             COALESCE(AVG(latency_ms), 0)::NUMERIC(10,1) AS avg_latency,
             AVG(confidence)::NUMERIC(4,2) AS avg_confidence,
             COALESCE(SUM(cost_usd), 0)::NUMERIC AS total_cost
      FROM race_mode_results
      WHERE created_at > NOW() - MAKE_INTERVAL(days => $1)
      GROUP BY candidate_model
      ORDER BY first_finished_count DESC, avg_confidence DESC NULLS LAST
    `, [daysBack]);

    const totalRow = await db.query(`
      SELECT COUNT(DISTINCT call_id)::INT AS total_races
      FROM race_mode_results
      WHERE created_at > NOW() - MAKE_INTERVAL(days => $1)
    `, [daysBack]);

    const entries: LeaderboardEntry[] = r.rows.map((row: any) => {
      const participations = parseInt(row.participations, 10) || 0;
      const selectedCount = parseInt(row.selected_count, 10) || 0;
      const firstFinished = parseInt(row.first_finished_count, 10) || 0;
      const avgLatency = parseFloat(row.avg_latency) || 0;
      const avgConfidence = row.avg_confidence ? parseFloat(row.avg_confidence) : null;
      const winRate = participations > 0 ? selectedCount / participations : 0;
      const speedRate = participations > 0 ? firstFinished / participations : 0;
      // Composite rank: 60% speed + 40% confidence (or 50/50 if no confidence)
      const confScore = avgConfidence !== null ? (avgConfidence / 10) : 0.5;
      const rank = speedRate * 0.6 + confScore * 0.4;
      return {
        model: row.model,
        participations,
        selectedCount,
        firstFinishedCount: firstFinished,
        winRate: parseFloat(winRate.toFixed(3)),
        speedRate: parseFloat(speedRate.toFixed(3)),
        avgLatencyMs: avgLatency,
        avgConfidence,
        totalCost: parseFloat(row.total_cost) || 0,
        rank: parseFloat(rank.toFixed(3)),
        rankPosition: 0,
        badge: null,
      };
    });

    // Sort by rank desc and assign positions / badges
    entries.sort((a, b) => b.rank - a.rank);
    entries.forEach((e, i) => {
      e.rankPosition = i + 1;
      if (i === 0) e.badge = 'gold';
      else if (i === 1) e.badge = 'silver';
      else if (i === 2) e.badge = 'bronze';
    });

    const fastest = [...entries].sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)[0];
    const reliable = [...entries].filter((e) => e.participations >= 2).sort((a, b) => b.winRate - a.winRate)[0];

    return {
      totalRaces: parseInt(totalRow.rows[0]?.total_races ?? '0', 10),
      daysCovered: daysBack,
      entries,
      fastestThisWeek: fastest ? { model: fastest.model, latencyMs: fastest.avgLatencyMs } : null,
      mostReliable: reliable ? { model: reliable.model, winRate: reliable.winRate } : null,
    };
  } catch (err) {
    logger.warn({ err }, 'race-leaderboard: aggregation failed');
    return { totalRaces: 0, daysCovered: daysBack, entries: [], fastestThisWeek: null, mostReliable: null };
  }
}
