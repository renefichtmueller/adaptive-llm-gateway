-- LLM Gateway Initial Schema
-- Run with: psql -U llm_gateway -d llm_gateway -f 001_initial.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enum types
CREATE TYPE call_status AS ENUM ('approved', 'warning', 'pending_review', 'rejected');
CREATE TYPE review_decision AS ENUM ('approved', 'rejected', 'edited');
CREATE TYPE model_tier AS ENUM ('fast', 'medium', 'large');

-- Main audit log for all LLM calls
CREATE TABLE IF NOT EXISTS llm_calls (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  caller          TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  model_used      TEXT NOT NULL,
  prompt_id       TEXT NOT NULL,
  prompt_version  TEXT NOT NULL DEFAULT '1.0.0',
  input_hash      TEXT NOT NULL,
  output_text     TEXT,
  output_hash     TEXT NOT NULL,
  token_count_in  INTEGER NOT NULL DEFAULT 0,
  token_count_out INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  confidence      NUMERIC(4,2) NOT NULL DEFAULT 0,
  status          call_status NOT NULL DEFAULT 'pending_review',
  validation_log  JSONB NOT NULL DEFAULT '[]',
  ban_hits        JSONB NOT NULL DEFAULT '[]',
  metadata        JSONB
);

CREATE INDEX idx_llm_calls_created_at ON llm_calls (created_at DESC);
CREATE INDEX idx_llm_calls_caller ON llm_calls (caller);
CREATE INDEX idx_llm_calls_task_type ON llm_calls (task_type);
CREATE INDEX idx_llm_calls_status ON llm_calls (status);
CREATE INDEX idx_llm_calls_model_used ON llm_calls (model_used);

-- Review queue for low-confidence outputs
CREATE TABLE IF NOT EXISTS review_queue (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  call_id         UUID REFERENCES llm_calls(id) ON DELETE CASCADE,
  caller          TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  input_text      TEXT NOT NULL,
  output_text     TEXT,
  confidence      NUMERIC(4,2) NOT NULL,
  validation_log  JSONB NOT NULL DEFAULT '[]',
  decision        review_decision,
  edited_output   TEXT,
  reviewer_notes  TEXT,
  notified        BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_review_queue_created_at ON review_queue (created_at DESC);
CREATE INDEX idx_review_queue_decision ON review_queue (decision) WHERE decision IS NULL;
CREATE INDEX idx_review_queue_caller ON review_queue (caller);

-- Prompt version tracking
CREATE TABLE IF NOT EXISTS prompt_versions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prompt_id       TEXT NOT NULL,
  version         TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  template_yaml   TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  deployed_by     TEXT,
  notes           TEXT,
  UNIQUE(prompt_id, version)
);

CREATE INDEX idx_prompt_versions_prompt_id ON prompt_versions (prompt_id, active);

-- Ban list hit analytics
CREATE TABLE IF NOT EXISTS ban_analytics (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  call_id         UUID REFERENCES llm_calls(id) ON DELETE SET NULL,
  term            TEXT NOT NULL,
  category        TEXT NOT NULL,
  language        TEXT NOT NULL CHECK (language IN ('en', 'de', 'auto')),
  caller          TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  context_snippet TEXT
);

CREATE INDEX idx_ban_analytics_term ON ban_analytics (term);
CREATE INDEX idx_ban_analytics_created_at ON ban_analytics (created_at DESC);
CREATE INDEX idx_ban_analytics_caller ON ban_analytics (caller);

-- TIP enrichment log (transceiver-specific)
CREATE TABLE IF NOT EXISTS tip_enrichment_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  call_id         UUID REFERENCES llm_calls(id) ON DELETE SET NULL,
  part_number     TEXT,
  form_factor     TEXT,
  data_rate_gbps  NUMERIC,
  wavelength_nm   NUMERIC,
  connector       TEXT,
  fiber_type      TEXT,
  vendor          TEXT,
  sff8024_code    TEXT,
  validation_pass BOOLEAN NOT NULL DEFAULT FALSE,
  failures        JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_tip_enrichment_log_part_number ON tip_enrichment_log (part_number);
CREATE INDEX idx_tip_enrichment_log_created_at ON tip_enrichment_log (created_at DESC);

-- Learning corpus for fine-tuning (approved outputs only)
CREATE TABLE IF NOT EXISTS learning_corpus (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  call_id         UUID REFERENCES llm_calls(id) ON DELETE SET NULL,
  task_type       TEXT NOT NULL,
  prompt_text     TEXT NOT NULL,
  completion_text TEXT NOT NULL,
  quality_score   NUMERIC(4,2) NOT NULL,
  included_in_run UUID,
  tags            TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_learning_corpus_task_type ON learning_corpus (task_type);
CREATE INDEX idx_learning_corpus_quality ON learning_corpus (quality_score DESC);

-- Fine-tuning run tracking
CREATE TABLE IF NOT EXISTS fine_tuning_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  base_model      TEXT NOT NULL,
  output_model    TEXT,
  sample_count    INTEGER NOT NULL DEFAULT 0,
  task_types      TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',
  metrics         JSONB,
  notes           TEXT
);

-- Routing performance metrics
CREATE TABLE IF NOT EXISTS routing_metrics (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  task_type       TEXT NOT NULL,
  model_used      TEXT NOT NULL,
  latency_ms      INTEGER NOT NULL,
  token_count_in  INTEGER NOT NULL,
  token_count_out INTEGER NOT NULL,
  confidence      NUMERIC(4,2) NOT NULL,
  status          call_status NOT NULL,
  circuit_breaker_state TEXT NOT NULL DEFAULT 'closed'
);

CREATE INDEX idx_routing_metrics_recorded_at ON routing_metrics (recorded_at DESC);
CREATE INDEX idx_routing_metrics_task_type ON routing_metrics (task_type, model_used);

-- Batch job tracking
CREATE TABLE IF NOT EXISTS batch_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  caller          TEXT NOT NULL,
  task_count      INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  webhook_url     TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  results         JSONB,
  pg_boss_id      TEXT
);

CREATE INDEX idx_batch_jobs_caller ON batch_jobs (caller);
CREATE INDEX idx_batch_jobs_status ON batch_jobs (status);
CREATE INDEX idx_batch_jobs_created_at ON batch_jobs (created_at DESC);

-- Fact check cache
CREATE TABLE IF NOT EXISTS fact_check_cache (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  source          TEXT NOT NULL,
  lookup_key      TEXT NOT NULL,
  result          JSONB NOT NULL,
  UNIQUE(source, lookup_key)
);

CREATE INDEX idx_fact_check_cache_expires ON fact_check_cache (expires_at);
CREATE INDEX idx_fact_check_cache_lookup ON fact_check_cache (source, lookup_key);
