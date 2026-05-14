/**
 * Memory Graph Builder
 *
 * Returns the persistent-memory facts as a graph: nodes are callers and
 * fact-categories, edges connect callers → facts. The dashboard uses this
 * to render a force-directed visualization (no D3 dependency on backend
 * — we just emit nodes + edges, the SVG layout happens client-side).
 */
import type { Pool } from 'pg';
import { logger } from '../observability/logger.js';

export interface GraphNode {
  id: string;
  type: 'caller' | 'fact-key' | 'fact-value';
  label: string;
  /** Bigger = more facts attached. */
  weight: number;
  /** UI hint: caller-color hex / category icon. */
  group: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  meta?: { confidence?: number; source?: string };
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { callers: number; factKeys: number; totalFacts: number };
}

/**
 * Build the graph by joining caller_knowledge to itself.
 * Caller node ↔ fact-key node ↔ fact-value node.
 */
export async function buildMemoryGraph(db: Pool): Promise<MemoryGraph> {
  try {
    const r = await db.query(`
      SELECT caller_id, fact_key, fact_value, confidence, source
      FROM caller_knowledge
      WHERE superseded_by IS NULL
        AND (valid_until IS NULL OR valid_until > NOW())
      ORDER BY caller_id, fact_key
    `);
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const callerSet = new Set<string>();
    const keySet = new Set<string>();

    for (const row of r.rows) {
      const caller = String(row.caller_id);
      const key = String(row.fact_key);
      const value = String(row.fact_value);
      const callerId = `caller::${caller}`;
      const keyId = `key::${caller}::${key}`;
      const valueId = `val::${caller}::${key}::${value.slice(0, 80)}`;

      callerSet.add(caller);
      keySet.add(`${caller}::${key}`);

      if (!nodes.has(callerId)) {
        nodes.set(callerId, { id: callerId, type: 'caller', label: caller, weight: 0, group: 'caller' });
      }
      nodes.get(callerId)!.weight += 1;

      if (!nodes.has(keyId)) {
        nodes.set(keyId, { id: keyId, type: 'fact-key', label: key, weight: 1, group: caller });
      }
      if (!nodes.has(valueId)) {
        nodes.set(valueId, { id: valueId, type: 'fact-value', label: value.slice(0, 80), weight: 1, group: caller });
      }

      edges.push({
        source: callerId, target: keyId, weight: 1,
      });
      edges.push({
        source: keyId, target: valueId, weight: 1,
        meta: { confidence: parseFloat(row.confidence) || 0.8, source: row.source ?? undefined },
      });
    }

    return {
      nodes: Array.from(nodes.values()),
      edges,
      stats: { callers: callerSet.size, factKeys: keySet.size, totalFacts: r.rows.length },
    };
  } catch (err) {
    logger.warn({ err }, 'memory-graph: build failed');
    return { nodes: [], edges: [], stats: { callers: 0, factKeys: 0, totalFacts: 0 } };
  }
}
