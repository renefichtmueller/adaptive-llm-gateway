-- Migration: Dashboard & Real-Time Metrics
-- Created: 2026-04-19
-- Purpose: Support management dashboard with real-time request tracking and aggregated metrics
-- PostgreSQL compatible version

-- Table: Dashboard request log (append-only, 72-hour retention)
CREATE TABLE IF NOT EXISTS dashboard_request_log (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(50) NOT NULL UNIQUE,
  caller VARCHAR(100) NOT NULL,
  task_type VARCHAR(50),
  model VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL,
  confidence_score NUMERIC(3,2),
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL DEFAULT 0,
  fallback_used BOOLEAN DEFAULT FALSE,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_created_desc ON dashboard_request_log (created_at);
CREATE INDEX IF NOT EXISTS idx_caller_created ON dashboard_request_log (caller, created_at);
CREATE INDEX IF NOT EXISTS idx_status_created ON dashboard_request_log (status, created_at);
CREATE INDEX IF NOT EXISTS idx_model_created ON dashboard_request_log (model, created_at);
CREATE INDEX IF NOT EXISTS idx_task_created ON dashboard_request_log (task_type, created_at);
CREATE INDEX IF NOT EXISTS idx_epoch ON dashboard_request_log (created_at_epoch);

-- Table: Pre-aggregated metrics timeseries (1-minute buckets, 90-day retention)
CREATE TABLE IF NOT EXISTS metrics_timeseries (
  id SERIAL PRIMARY KEY,
  bucket_time TIMESTAMPTZ NOT NULL,
  bucket_time_epoch BIGINT NOT NULL,

  -- Counts
  request_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  fallback_count INT NOT NULL DEFAULT 0,

  -- Latency metrics (ms)
  avg_latency_ms NUMERIC(10,2),
  p50_latency_ms INT,
  p95_latency_ms INT,
  p99_latency_ms INT,
  max_latency_ms INT,

  -- Token metrics
  total_tokens_in INT NOT NULL DEFAULT 0,
  total_tokens_out INT NOT NULL DEFAULT 0,
  avg_tokens_in NUMERIC(10,2),
  avg_tokens_out NUMERIC(10,2),

  -- Cost metrics (USD)
  total_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  avg_cost_usd NUMERIC(10,6),

  -- Confidence metrics
  avg_confidence NUMERIC(3,2),
  min_confidence NUMERIC(3,2),

  -- Model distribution (top 3)
  top_model_1 VARCHAR(100),
  top_model_1_count INT,
  top_model_2 VARCHAR(100),
  top_model_2_count INT,
  top_model_3 VARCHAR(100),
  top_model_3_count INT,

  -- Status distribution
  status_approved INT DEFAULT 0,
  status_warning INT DEFAULT 0,
  status_rejected INT DEFAULT 0,
  status_pending INT DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bucket_time)
);

CREATE INDEX IF NOT EXISTS idx_bucket_time_desc ON metrics_timeseries (bucket_time);
CREATE INDEX IF NOT EXISTS idx_bucket_epoch ON metrics_timeseries (bucket_time_epoch);

-- Table: Per-caller metrics (1-minute buckets)
CREATE TABLE IF NOT EXISTS caller_metrics_timeseries (
  id SERIAL PRIMARY KEY,
  bucket_time TIMESTAMPTZ NOT NULL,
  caller VARCHAR(100) NOT NULL,
  request_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  avg_latency_ms NUMERIC(10,2),
  total_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  avg_confidence NUMERIC(3,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bucket_time, caller)
);

CREATE INDEX IF NOT EXISTS idx_caller_bucket_time_desc ON caller_metrics_timeseries (bucket_time);
CREATE INDEX IF NOT EXISTS idx_caller_name ON caller_metrics_timeseries (caller);

-- Table: Per-model metrics (1-minute buckets)
CREATE TABLE IF NOT EXISTS model_metrics_timeseries (
  id SERIAL PRIMARY KEY,
  bucket_time TIMESTAMPTZ NOT NULL,
  model VARCHAR(100) NOT NULL,
  request_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  avg_latency_ms NUMERIC(10,2),
  total_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  avg_confidence NUMERIC(3,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bucket_time, model)
);

CREATE INDEX IF NOT EXISTS idx_model_bucket_time_desc ON model_metrics_timeseries (bucket_time);
CREATE INDEX IF NOT EXISTS idx_model_name ON model_metrics_timeseries (model);

-- Table: Dashboard cache (frequently accessed aggregates)
CREATE TABLE IF NOT EXISTS dashboard_cache (
  id SERIAL PRIMARY KEY,
  cache_key VARCHAR(255) NOT NULL UNIQUE,
  cache_value JSONB NOT NULL,
  ttl_seconds INT NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expires_at ON dashboard_cache (expires_at);

-- Note: PostgreSQL doesn't support automatic scheduled cleanup like MySQL's CREATE EVENT.
-- Use pg_cron extension if available, or implement cleanup in application code.
-- Example pg_cron setup (if extension is installed):
-- SELECT cron.schedule('cleanup_dashboard_requests', '0 * * * *', 
--   'DELETE FROM dashboard_request_log WHERE created_at < NOW() - INTERVAL ''72 hours''');
-- SELECT cron.schedule('cleanup_metrics_timeseries', '0 * * * *',
--   'DELETE FROM metrics_timeseries WHERE bucket_time < NOW() - INTERVAL ''90 days''');
-- SELECT cron.schedule('cleanup_dashboard_cache', '*/5 * * * *',
--   'DELETE FROM dashboard_cache WHERE expires_at < NOW()');

-- Note: For the aggregation procedure, we can create a PostgreSQL function instead.
-- This should be called by application code or via pg_cron scheduling.
-- A simplified version is shown below for reference, but the application should
-- handle the actual aggregation and insertion into metrics_timeseries.
