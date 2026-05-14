-- ─── 010: Feature tables for v0.2 ─────────────────────────────────────────
-- Adds tables required by reasoning-trace capture, adaptive routing,
-- and federated stats.

-- Reasoning traces: separate storage for chain-of-thought from o1 / r1 / thinking models
CREATE TABLE IF NOT EXISTS reasoning_traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         UUID NOT NULL UNIQUE,
  marker          TEXT NOT NULL,                  -- 'thinking_tag' | 'think_tag' | 'json_field' | 'markdown_header'
  content         TEXT NOT NULL,
  estimated_tokens INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reasoning_traces_call_id ON reasoning_traces (call_id);
CREATE INDEX IF NOT EXISTS idx_reasoning_traces_created_at ON reasoning_traces (created_at DESC);

-- Adaptive routing recommendations from the learner
CREATE TABLE IF NOT EXISTS adaptive_routing (
  task_type        TEXT PRIMARY KEY,
  preferred_model  TEXT NOT NULL,
  fallback_chain   TEXT[] NOT NULL DEFAULT '{}',
  samples          INT NOT NULL,
  success_rate     NUMERIC(5,4) NOT NULL,
  avg_cost_usd     NUMERIC(10,7) NOT NULL,
  avg_latency_ms   INT NOT NULL,
  alternatives     INT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Federated stats received from peers (for the local learner to consult)
CREATE TABLE IF NOT EXISTS federated_peer_stats (
  id               BIGSERIAL PRIMARY KEY,
  node_id          TEXT NOT NULL,
  gateway_version  TEXT NOT NULL,
  task_type_hash   TEXT NOT NULL,                 -- sha256(task_type).slice(0,12)
  model            TEXT NOT NULL,
  samples          INT NOT NULL,
  success_rate     NUMERIC(5,4) NOT NULL,
  avg_latency_ms   INT NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_federated_peer_stats_task_hash ON federated_peer_stats (task_type_hash);
CREATE INDEX IF NOT EXISTS idx_federated_peer_stats_received_at ON federated_peer_stats (received_at DESC);

-- PII redaction stats (anonymous counts only; no values stored)
CREATE TABLE IF NOT EXISTS pii_redaction_log (
  id            BIGSERIAL PRIMARY KEY,
  call_id       UUID NOT NULL,
  category      TEXT NOT NULL,                    -- 'email' | 'phone' | 'credit_card' | ...
  count         INT NOT NULL,
  redacted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pii_redaction_log_call_id ON pii_redaction_log (call_id);
