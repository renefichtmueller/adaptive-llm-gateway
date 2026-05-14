-- Tokenvault & Cost Tracking Schema Extensions
-- Created: 2026-04-19
-- Purpose: Track token compression (LeanCTX + RTK) and cost analytics

-- Table: Token compression metrics (LeanCTX, RTK)
CREATE TABLE IF NOT EXISTS tokenvault_metrics (
  id SERIAL PRIMARY KEY,
  file_path VARCHAR(255),
  mode VARCHAR(50),          -- 'lean-aggressive', 'lean-map', 'rtk-max', etc.
  tokens_before INT,
  tokens_after INT,
  savings_pct DECIMAL(5,2),
  tool_used VARCHAR(50),     -- 'claude-code', 'ollama', 'fallback', 'gateway'
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_tool_created (tool_used, created_at),
  INDEX idx_created (created_at)
);

-- Table: Cost analytics per task
CREATE TABLE IF NOT EXISTS cost_analytics (
  id SERIAL PRIMARY KEY,
  call_id VARCHAR(50),       -- Links to audit_log
  project VARCHAR(100),
  task_type VARCHAR(50),     -- 'code_review', 'architecture', 'security', etc.
  model VARCHAR(100),        -- 'qwen:3b', 'llama3.3:70b', 'groq', etc.
  agent_id VARCHAR(50),      -- 'claude-code', 'qwen-reviewer', etc.
  tokens_in INT,
  tokens_out INT,
  tokens_compressed INT,     -- After LeanCTX + RTK
  cost_usd DECIMAL(10,6),
  cost_saved_usd DECIMAL(10,6),
  provider VARCHAR(50),      -- 'ollama', 'cerebras', 'groq', 'claude', etc.
  confidence_score DECIMAL(3,2),
  request_hash VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_project_created (project, created_at),
  INDEX idx_agent_created (agent_id, created_at),
  INDEX idx_model_created (model, created_at),
  INDEX idx_call_id (call_id)
);

-- Table: Compression savings summary (daily aggregate)
CREATE TABLE IF NOT EXISTS compression_summary (
  id SERIAL PRIMARY KEY,
  date DATE,
  tool VARCHAR(50),
  total_tokens_before INT,
  total_tokens_after INT,
  total_savings_pct DECIMAL(5,2),
  count INT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE KEY unique_date_tool (date, tool)
);

-- Table: Cost alerts configuration (per user/project)
CREATE TABLE IF NOT EXISTS cost_alert_config (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(100),      -- 'rene' or 'erik'
  project VARCHAR(100),      -- NULL = global threshold
  alert_type VARCHAR(50),    -- 'compression_below', 'weekly_budget', 'external_api', 'cost_spike'
  threshold DECIMAL(8,2),    -- Percentage or absolute USD
  threshold_type VARCHAR(20), -- 'percent', 'usd', 'weekly_budget'
  enabled BOOLEAN DEFAULT TRUE,
  weekly_budget_usd DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP
);

-- Table: Alert history (logged when triggered)
CREATE TABLE IF NOT EXISTS alert_log (
  id SERIAL PRIMARY KEY,
  alert_type VARCHAR(50),
  severity VARCHAR(20),      -- 'info', 'warning', 'critical'
  message TEXT,
  metadata JSON,             -- Additional context
  acknowledged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_severity_created (severity, created_at),
  INDEX idx_created (created_at)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cost_analytics_week
  ON cost_analytics(created_at DESC)
  WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY);

CREATE INDEX IF NOT EXISTS idx_compression_daily
  ON tokenvault_metrics(created_at DESC)
  WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 DAY);

-- View: Daily cost breakdown
CREATE OR REPLACE VIEW daily_costs AS
SELECT
  DATE(created_at) as date,
  project,
  task_type,
  model,
  COUNT(*) as task_count,
  SUM(tokens_in + tokens_out) as total_tokens,
  SUM(tokens_compressed) as compressed_tokens,
  SUM(cost_usd) as total_cost,
  SUM(cost_saved_usd) as total_saved,
  ROUND((SUM(cost_saved_usd) / NULLIF(SUM(cost_usd + cost_saved_usd), 0)) * 100, 2) as savings_pct
FROM cost_analytics
GROUP BY DATE(created_at), project, task_type, model;

-- View: Weekly compression stats
CREATE OR REPLACE VIEW weekly_compression_stats AS
SELECT
  WEEK(created_at) as week,
  YEAR(created_at) as year,
  tool_used,
  COUNT(*) as operations,
  SUM(tokens_before) as total_raw,
  SUM(tokens_after) as total_compressed,
  ROUND(AVG(savings_pct), 2) as avg_savings_pct,
  SUM(CAST(tokens_before AS SIGNED) - CAST(tokens_after AS SIGNED)) as total_tokens_saved
FROM tokenvault_metrics
GROUP BY WEEK(created_at), YEAR(created_at), tool_used;
