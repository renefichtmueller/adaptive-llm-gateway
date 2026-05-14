-- LLM Gateway Learning Engine Schema
-- Run after 001_initial.sql
-- psql -U llm -d llm_gateway -f 002_learning.sql

-- ─── BAN CANDIDATES ────────────────────────────────────────────────────────
-- Auto-detected suspicious phrases waiting for promotion to banlist
CREATE TABLE IF NOT EXISTS ban_candidates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  term              VARCHAR(256) NOT NULL,
  language          VARCHAR(4) NOT NULL CHECK (language IN ('en', 'de', 'auto')),
  category          VARCHAR(32) NOT NULL CHECK (category IN ('buzzword', 'filler', 'opener', 'closer', 'transition')),
  occurrence_count  INTEGER NOT NULL DEFAULT 1,
  source_task_types TEXT[] NOT NULL DEFAULT '{}',
  example_contexts  TEXT[],
  promoted          BOOLEAN NOT NULL DEFAULT false,
  promoted_at       TIMESTAMPTZ,
  rejected          BOOLEAN NOT NULL DEFAULT false,
  rejected_at       TIMESTAMPTZ,
  rejected_reason   TEXT,
  UNIQUE(term, language)
);

CREATE INDEX IF NOT EXISTS idx_ban_candidates_term ON ban_candidates (term, language);
CREATE INDEX IF NOT EXISTS idx_ban_candidates_count ON ban_candidates (occurrence_count DESC) WHERE promoted = false AND rejected = false;

-- ─── FEW-SHOT CANDIDATES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS few_shot_candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_type             VARCHAR(64) NOT NULL,
  llm_call_id           UUID REFERENCES llm_calls(id) ON DELETE SET NULL,
  input_text            TEXT NOT NULL,
  output_text           TEXT NOT NULL,
  confidence            NUMERIC(3,1) NOT NULL,
  similarity_to_existing NUMERIC(4,3),
  promoted              BOOLEAN NOT NULL DEFAULT false,
  promoted_at           TIMESTAMPTZ,
  template_version      VARCHAR(16),
  is_negative           BOOLEAN NOT NULL DEFAULT false,
  negative_reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_few_shot_candidates_task ON few_shot_candidates (task_type, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_few_shot_candidates_pending ON few_shot_candidates (task_type) WHERE promoted = false;

-- ─── ROUTING CANDIDATES ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routing_candidates (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_type                 VARCHAR(64) NOT NULL,
  current_model             VARCHAR(128) NOT NULL,
  candidate_model           VARCHAR(128) NOT NULL,
  current_avg_confidence    NUMERIC(4,2),
  candidate_avg_confidence  NUMERIC(4,2),
  current_p95_latency_ms    INTEGER,
  candidate_p95_latency_ms  INTEGER,
  sample_size               INTEGER NOT NULL,
  auto_applied              BOOLEAN NOT NULL DEFAULT false,
  applied_at                TIMESTAMPTZ,
  rollback_at               TIMESTAMPTZ,
  rollback_reason           TEXT
);

CREATE INDEX IF NOT EXISTS idx_routing_candidates_task ON routing_candidates (task_type, created_at DESC);

-- ─── PROMPT CANDIDATES ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prompt_candidates (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  template_id              VARCHAR(128) NOT NULL,
  current_version          VARCHAR(16) NOT NULL,
  candidate_version        VARCHAR(16) NOT NULL,
  current_system_prompt    TEXT NOT NULL,
  candidate_system_prompt  TEXT NOT NULL,
  improvement_rationale    TEXT NOT NULL,
  changes_made             TEXT[] NOT NULL DEFAULT '{}',
  expected_improvements    TEXT[] NOT NULL DEFAULT '{}',
  test_confidence_delta    NUMERIC(4,2),
  auto_applied             BOOLEAN NOT NULL DEFAULT false,
  human_approved           BOOLEAN,
  applied_at               TIMESTAMPTZ,
  review_queue_id          UUID REFERENCES review_queue(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_candidates_template ON prompt_candidates (template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_candidates_pending ON prompt_candidates (template_id) WHERE auto_applied = false AND human_approved IS NULL;

-- ─── LEARNING REPORTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS learning_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_from  TIMESTAMPTZ NOT NULL,
  period_to    TIMESTAMPTZ NOT NULL,
  report_data  JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_reports_period ON learning_reports (period_from DESC);

-- ─── A/B TEST TRACKING ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ab_tests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  task_type           VARCHAR(64) NOT NULL,
  control_model       VARCHAR(128) NOT NULL,
  challenger_model    VARCHAR(128) NOT NULL,
  traffic_percent     INTEGER NOT NULL DEFAULT 10,
  control_calls       INTEGER NOT NULL DEFAULT 0,
  challenger_calls    INTEGER NOT NULL DEFAULT 0,
  control_avg_conf    NUMERIC(4,2),
  challenger_avg_conf NUMERIC(4,2),
  winner              VARCHAR(128),
  auto_promoted       BOOLEAN NOT NULL DEFAULT false,
  status              VARCHAR(16) NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS idx_ab_tests_task ON ab_tests (task_type, status);

-- ─── ADDITIONAL INDEXES ON EXISTING TABLES ──────────────────────────────────
-- Safe to run even if already exist
CREATE INDEX IF NOT EXISTS idx_routing_metrics_lookup
  ON routing_metrics (task_type, model_used, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_corpus_task
  ON learning_corpus (task_type, quality_score DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ban_analytics_task_term
  ON ban_analytics (task_type, term, created_at DESC);
