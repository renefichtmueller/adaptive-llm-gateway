-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 011 — Learning-service tables
--
-- The standalone learning engine (packages/learning) runs six autonomous
-- jobs (ban learner, few-shot curator, routing optimizer, prompt optimizer,
-- learning report, fine-tuning trigger). These are the tables those jobs
-- read and write. Without them every job crashes on its first query.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Ban learner ────────────────────────────────────────────────────────────
-- Candidate phrases detected in approved/edited outputs; auto-promoted to the
-- banlist once they show up often enough.
CREATE TABLE IF NOT EXISTS ban_candidates (
  id                 BIGSERIAL PRIMARY KEY,
  term               TEXT NOT NULL,
  language           VARCHAR(8) NOT NULL DEFAULT 'auto',
  category           VARCHAR(16) NOT NULL DEFAULT 'filler',
  occurrence_count   INTEGER NOT NULL DEFAULT 0,
  source_task_types  TEXT[] NOT NULL DEFAULT '{}',
  example_contexts   TEXT[] NOT NULL DEFAULT '{}',
  promoted           BOOLEAN NOT NULL DEFAULT FALSE,
  promoted_at        TIMESTAMPTZ,
  rejected           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (term, language)
);

CREATE INDEX IF NOT EXISTS idx_ban_candidates_promoted
  ON ban_candidates (promoted) WHERE promoted = TRUE;
CREATE INDEX IF NOT EXISTS idx_ban_candidates_created
  ON ban_candidates (created_at DESC);

-- ─── Few-shot curator ───────────────────────────────────────────────────────
-- High-confidence outputs promoted into prompt templates as few-shot
-- examples; rejected outputs stored as negative examples.
CREATE TABLE IF NOT EXISTS few_shot_candidates (
  id                     BIGSERIAL PRIMARY KEY,
  task_type              TEXT NOT NULL,
  llm_call_id            UUID REFERENCES llm_calls(id) ON DELETE SET NULL,
  input_text             TEXT,
  output_text            TEXT,
  confidence             NUMERIC(4,2) NOT NULL DEFAULT 0,
  similarity_to_existing NUMERIC(5,4),
  is_negative            BOOLEAN NOT NULL DEFAULT FALSE,
  negative_reason        TEXT,
  promoted               BOOLEAN NOT NULL DEFAULT FALSE,
  promoted_at            TIMESTAMPTZ,
  template_version       TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (llm_call_id)
);

CREATE INDEX IF NOT EXISTS idx_few_shot_candidates_task
  ON few_shot_candidates (task_type, promoted);
CREATE INDEX IF NOT EXISTS idx_few_shot_candidates_created
  ON few_shot_candidates (created_at DESC);

-- ─── Routing optimizer ──────────────────────────────────────────────────────
-- Model-swap candidates derived from routing_metrics; safe ones are
-- auto-applied to routing-rules.yaml.
CREATE TABLE IF NOT EXISTS routing_candidates (
  id                        BIGSERIAL PRIMARY KEY,
  task_type                 TEXT NOT NULL,
  current_model             TEXT NOT NULL,
  candidate_model           TEXT NOT NULL,
  current_avg_confidence    NUMERIC(4,2),
  candidate_avg_confidence  NUMERIC(4,2),
  current_p95_latency_ms    INTEGER,
  candidate_p95_latency_ms  INTEGER,
  sample_size               INTEGER NOT NULL DEFAULT 0,
  auto_applied              BOOLEAN NOT NULL DEFAULT FALSE,
  applied_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routing_candidates_task
  ON routing_candidates (task_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_routing_candidates_applied
  ON routing_candidates (auto_applied, applied_at);

-- A/B tests between the current model (control) and a challenger.
CREATE TABLE IF NOT EXISTS ab_tests (
  id                  BIGSERIAL PRIMARY KEY,
  task_type           TEXT NOT NULL,
  control_model       TEXT NOT NULL,
  challenger_model    TEXT NOT NULL,
  traffic_percent     INTEGER NOT NULL DEFAULT 10,
  control_calls       INTEGER NOT NULL DEFAULT 0,
  challenger_calls    INTEGER NOT NULL DEFAULT 0,
  control_avg_conf    NUMERIC(4,2),
  challenger_avg_conf NUMERIC(4,2),
  winner              TEXT,
  auto_promoted       BOOLEAN NOT NULL DEFAULT FALSE,
  status              VARCHAR(16) NOT NULL DEFAULT 'running',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ab_tests_status
  ON ab_tests (status, task_type);

-- ─── Prompt optimizer ───────────────────────────────────────────────────────
-- Improved system-prompt candidates with quality analysis; safe ones are
-- auto-applied, sensitive task types await human approval.
CREATE TABLE IF NOT EXISTS prompt_candidates (
  id                       BIGSERIAL PRIMARY KEY,
  template_id              TEXT NOT NULL,
  current_version          TEXT NOT NULL,
  candidate_version        TEXT NOT NULL,
  current_system_prompt    TEXT,
  candidate_system_prompt  TEXT,
  improvement_rationale    TEXT,
  changes_made             TEXT[] NOT NULL DEFAULT '{}',
  expected_improvements    TEXT[] NOT NULL DEFAULT '{}',
  test_confidence_delta    NUMERIC(6,3),
  current_quality_score    NUMERIC(6,3),
  improved_quality_score   NUMERIC(6,3),
  current_dimensions       JSONB,
  improved_dimensions      JSONB,
  pattern_reduction_count  INTEGER,
  suggested_framework      TEXT,
  estimated_token_savings  INTEGER,
  auto_applied             BOOLEAN NOT NULL DEFAULT FALSE,
  applied_at               TIMESTAMPTZ,
  human_approved           BOOLEAN,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_candidates_template
  ON prompt_candidates (template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_candidates_pending
  ON prompt_candidates (auto_applied, human_approved)
  WHERE auto_applied = FALSE AND human_approved IS NULL;

-- ─── Column fixes on existing tables ───────────────────────────────────────
-- success_rate is a fraction 0–1 (NUMERIC(5,2) gave only 1% resolution);
-- confidence_avg must hold 10.00 (NUMERIC(3,2) capped at 9.99).
ALTER TABLE model_performance ALTER COLUMN success_rate TYPE NUMERIC(6,4);
ALTER TABLE model_performance ALTER COLUMN confidence_avg TYPE NUMERIC(4,2);

-- ─── Learning report ────────────────────────────────────────────────────────
-- Weekly/daily roll-up of everything the learning engine did.
CREATE TABLE IF NOT EXISTS learning_reports (
  id           BIGSERIAL PRIMARY KEY,
  period_from  TIMESTAMPTZ NOT NULL,
  period_to    TIMESTAMPTZ NOT NULL,
  report_data  JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_reports_period
  ON learning_reports (period_to DESC);
