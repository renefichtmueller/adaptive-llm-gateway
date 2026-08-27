-- ─── 011: GEO (Generative Engine Optimization) ranking tests ──────────────
-- Stores prompt-monitoring runs: how visible the configured brand is in
-- AI-generated answers, per model and per prompt, tracked over time.

CREATE TABLE IF NOT EXISTS geo_ranking_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand           TEXT NOT NULL,
  triggered_by    TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'scheduled'
  models          TEXT[] NOT NULL DEFAULT '{}',
  prompt_count    INT NOT NULL DEFAULT 0,
  answer_count    INT NOT NULL DEFAULT 0,
  mention_rate    NUMERIC(5,4) NOT NULL DEFAULT 0,  -- answers mentioning the brand / all answers
  citation_rate   NUMERIC(5,4) NOT NULL DEFAULT 0,  -- answers citing an own domain / all answers
  share_of_voice  NUMERIC(5,4) NOT NULL DEFAULT 0,  -- brand mentions / (brand + competitor mentions)
  avg_visibility  NUMERIC(6,2) NOT NULL DEFAULT 0,  -- composite 0-100 per answer, averaged
  summary         JSONB NOT NULL DEFAULT '{}',      -- perModel, sentimentBreakdown, avgFirstMentionPos, ...
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_geo_ranking_runs_started_at ON geo_ranking_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_geo_ranking_runs_brand ON geo_ranking_runs (brand);

CREATE TABLE IF NOT EXISTS geo_ranking_results (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              UUID NOT NULL,
  model               TEXT NOT NULL,
  prompt_id           TEXT NOT NULL,
  prompt_text         TEXT NOT NULL,
  answered            BOOLEAN NOT NULL DEFAULT TRUE,
  brand_mentioned     BOOLEAN NOT NULL DEFAULT FALSE,
  mention_count       INT NOT NULL DEFAULT 0,
  first_mention_pos   NUMERIC(5,4),                 -- 0 = answer start, 1 = answer end
  domain_cited        BOOLEAN NOT NULL DEFAULT FALSE,
  brand_rank          INT,                          -- 1-based order among tracked brands
  competitor_mentions JSONB NOT NULL DEFAULT '{}',
  sentiment           TEXT NOT NULL DEFAULT 'neutral', -- 'positive' | 'neutral' | 'negative'
  visibility_score    NUMERIC(6,2) NOT NULL DEFAULT 0,
  answer_excerpt      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_geo_ranking_results_run_id ON geo_ranking_results (run_id);
CREATE INDEX IF NOT EXISTS idx_geo_ranking_results_created_at ON geo_ranking_results (created_at DESC);
