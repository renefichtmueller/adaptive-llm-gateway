-- Migration: Add Tokenvault & Cost Tracking Tables
-- Created: 2026-04-19
-- Purpose: Track token compression and cost analytics
-- PostgreSQL compatible version (version 16+)

-- Table: Token compression metrics (LeanCTX, RTK)
CREATE TABLE IF NOT EXISTS tokenvault_metrics (
  id SERIAL PRIMARY KEY,
  file_path VARCHAR(255),
  mode VARCHAR(50),
  tokens_before INT NOT NULL,
  tokens_after INT NOT NULL,
  savings_pct NUMERIC(5,2) NOT NULL,
  tool_used VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_created ON tokenvault_metrics (tool_used, created_at);
CREATE INDEX IF NOT EXISTS idx_tokenvault_created ON tokenvault_metrics (created_at);

-- Table: Cost analytics per task
CREATE TABLE IF NOT EXISTS cost_analytics (
  id SERIAL PRIMARY KEY,
  call_id VARCHAR(50),
  project VARCHAR(100),
  task_type VARCHAR(50),
  model VARCHAR(100),
  agent_id VARCHAR(50),
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  tokens_compressed INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  cost_saved_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  provider VARCHAR(50),
  confidence_score NUMERIC(3,2),
  request_hash VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_created ON cost_analytics (project, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_created ON cost_analytics (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_created ON cost_analytics (model, created_at);
CREATE INDEX IF NOT EXISTS idx_call_id ON cost_analytics (call_id);

-- Table: Compression savings summary (daily aggregate)
CREATE TABLE IF NOT EXISTS compression_summary (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  tool VARCHAR(50) NOT NULL,
  total_tokens_before INT NOT NULL,
  total_tokens_after INT NOT NULL,
  total_savings_pct NUMERIC(5,2),
  count INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, tool)
);

-- Table: Cost alerts configuration
CREATE TABLE IF NOT EXISTS cost_alert_config (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(100),
  project VARCHAR(100),
  alert_type VARCHAR(50),
  threshold NUMERIC(8,2),
  threshold_type VARCHAR(20),
  enabled BOOLEAN DEFAULT TRUE,
  weekly_budget_usd NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, alert_type)
);

-- Table: Alert history
CREATE TABLE IF NOT EXISTS alert_log (
  id SERIAL PRIMARY KEY,
  alert_type VARCHAR(50),
  severity VARCHAR(20),
  message TEXT,
  metadata JSONB,
  acknowledged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_severity_created ON alert_log (severity, created_at);
CREATE INDEX IF NOT EXISTS idx_alert_created ON alert_log (created_at);

-- Create additional indexes with PostgreSQL syntax
-- Note: Removed WHERE clauses as they used NOW() which is VOLATILE, not allowed in partial index predicates
CREATE INDEX IF NOT EXISTS idx_cost_analytics_week ON cost_analytics (created_at);
CREATE INDEX IF NOT EXISTS idx_compression_daily ON tokenvault_metrics (created_at);

-- Add cost tracking columns to batch_jobs table
ALTER TABLE IF EXISTS batch_jobs
  ADD COLUMN IF NOT EXISTS total_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_saved_usd NUMERIC(10,6) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_batch_jobs_cost_created ON batch_jobs (total_cost_usd, created_at);

-- Table: Fallback chain execution metrics
CREATE TABLE IF NOT EXISTS fallback_chain_metrics (
  id SERIAL PRIMARY KEY,
  call_id VARCHAR(50),
  task_type VARCHAR(50),
  primary_model VARCHAR(100) NOT NULL,
  fallback_step INT NOT NULL,
  fallback_model VARCHAR(100),
  provider VARCHAR(50),
  success BOOLEAN NOT NULL,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL,
  reason_switched VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fallback_call_created ON fallback_chain_metrics (call_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fallback_model_created ON fallback_chain_metrics (primary_model, created_at);
CREATE INDEX IF NOT EXISTS idx_fallback_task_created ON fallback_chain_metrics (task_type, created_at);

-- Table: Model performance metrics (for learning engine)
CREATE TABLE IF NOT EXISTS model_performance (
  id SERIAL PRIMARY KEY,
  model VARCHAR(100) NOT NULL,
  task_type VARCHAR(50),
  success_rate NUMERIC(5,2),
  avg_latency_ms INT,
  avg_tokens_in INT,
  avg_tokens_out INT,
  total_calls INT DEFAULT 0,
  total_failures INT DEFAULT 0,
  confidence_avg NUMERIC(3,2),
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(model, task_type)
);

CREATE INDEX IF NOT EXISTS idx_success_rate ON model_performance (success_rate);
CREATE INDEX IF NOT EXISTS idx_latency ON model_performance (avg_latency_ms);

-- Table: Learning engine cycle logs
CREATE TABLE IF NOT EXISTS learning_cycles (
  id SERIAL PRIMARY KEY,
  cycle_id VARCHAR(50) NOT NULL UNIQUE,
  cycle_duration VARCHAR(20),
  improvements_found INT DEFAULT 0,
  routing_changes INT DEFAULT 0,
  template_updates INT DEFAULT 0,
  model_rankings_updated BOOLEAN DEFAULT FALSE,
  confidence_threshold_adjusted NUMERIC(3,2),
  metrics JSONB,
  status VARCHAR(50),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cycle_duration ON learning_cycles (cycle_duration, completed_at);
CREATE INDEX IF NOT EXISTS idx_cycle_status ON learning_cycles (status);
CREATE INDEX IF NOT EXISTS idx_cycle_completed ON learning_cycles (completed_at);

-- Table: Routing decisions and performance
CREATE TABLE IF NOT EXISTS routing_decisions (
  id SERIAL PRIMARY KEY,
  call_id VARCHAR(50),
  task_type VARCHAR(50) NOT NULL,
  caller VARCHAR(100),
  routing_model VARCHAR(100) NOT NULL,
  routing_tier VARCHAR(20),
  actual_model_used VARCHAR(100),
  was_fallback BOOLEAN DEFAULT FALSE,
  success BOOLEAN NOT NULL,
  confidence_final NUMERIC(3,2),
  tokens_in INT,
  tokens_out INT,
  latency_ms INT,
  cost_usd NUMERIC(10,6),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routing_task_created ON routing_decisions (task_type, created_at);
CREATE INDEX IF NOT EXISTS idx_routing_model_created ON routing_decisions (routing_model, created_at);
CREATE INDEX IF NOT EXISTS idx_routing_success ON routing_decisions (success, created_at);

-- Initialize default alert config for Rene
INSERT INTO cost_alert_config
  (user_id, alert_type, threshold, threshold_type, enabled, weekly_budget_usd)
VALUES
  ('rene', 'compression_below', 40, 'percent', TRUE, 50),
  ('rene', 'external_api', 0, 'usd', TRUE, NULL),
  ('rene', 'weekly_budget', 50, 'usd', TRUE, 50)
ON CONFLICT (user_id, alert_type) DO UPDATE SET enabled = EXCLUDED.enabled;
