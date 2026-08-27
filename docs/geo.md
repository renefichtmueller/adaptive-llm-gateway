# GEO — Generative Engine Optimization

The gateway ships a complete GEO toolkit: it **scores** content against the
factors that make AI engines cite you, **rewrites** it through the gateway's
own LLM pipeline, and **measures your ranking** in generative answers with a
recurring prompt-monitoring test — so you can optimize, verify, repeat.

Distilled from two sources (also served machine-readable via
`GET /v1/geo/knowledge`):

- **Evergreen Media — Generative Engine Optimization (GEO) Ratgeber**
  <https://www.evergreen.media/ratgeber/generative-engine-optimization/>
  Practitioner framing: GEO is a layer on top of SEO; visibility comes from
  *entity → validation → community*; success is measured with prompt monitoring.
- **Aggarwal et al., "GEO: Generative Engine Optimization", KDD 2024**
  <https://arxiv.org/abs/2311.09735>
  The Princeton/IIT-Delhi benchmark (~10k queries): adding quotations,
  statistics and cited sources lifts visibility in generative answers by up to
  ~40%; keyword stuffing measurably *reduces* it.

## Why this lives in the gateway

The gateway already talks to every engine family that matters — local models,
subscription bridges (ChatGPT, Claude, Gemini, Copilot) and API providers
(including Perplexity, a real search-based engine). That makes it the natural
place to close the GEO loop:

```
   write/edit content ──► POST /v1/geo/analyze     (deterministic score, 0-100)
          ▲                        │
          │                        ▼
   fix [GEO-TODO]s  ◄── POST /v1/geo/optimize      (LLM rewrite via gateway routing)
          │                        │
          ▼                        ▼
   publish ────────────► POST /v1/geo/ranking-test (prompt set × models)
                                   │
                                   ▼
                        GET /v1/geo/ranking-history (trend: better or worse?)
```

## 1. Analyze content — `POST /v1/geo/analyze`

Deterministic, sub-millisecond scoring (no LLM call). Accepts raw text,
markdown or HTML — or a URL the gateway fetches for you.

```bash
curl -s localhost:0000/v1/geo/analyze -H 'Content-Type: application/json' -d '{
  "content": "# Was ist ein LLM-Gateway?\nEin LLM-Gateway bündelt ...",
  "format": "markdown",
  "brand": "Adaptive LLM Gateway",
  "target_queries": ["Was ist das beste Open-Source-LLM-Gateway?"]
}'
```

Returns `analysis.geoScore` (0–100), a grade (A–F), and per-factor scores with
evidence + concrete recommendations. Factors and weights:

| Factor | Weight | Backed by |
|---|---|---|
| Cited sources | 15 | GEO study: +30–40% visibility |
| Statistics & data points | 14 | GEO study: +25–37% |
| Extractable structure (H2/H3, lists, tables, short ¶) | 12 | Evergreen Media |
| Direct answers & FAQ (answer-first) | 12 | Evergreen Media |
| Expert quotations | 10 | GEO study: strongest single lever (~+40%) |
| Fluency & readability | 10 | GEO study: +15–30% |
| Brand entity clarity | 9 | Evergreen Media (entity building) |
| E-E-A-T & freshness | 9 | Evergreen Media (validation) |
| Structured data (schema.org, HTML only) | 5 | Evergreen Media |
| Keyword hygiene | 4 | GEO study: stuffing is net **negative** |

Factors that don't apply (no `brand` passed, non-HTML input for schema) are
excluded and the score re-normalizes. `target_queries` adds a per-query term
coverage report. Passing `robots_txt` inline appends a crawler audit.

## 2. Audit AI crawler access — `POST /v1/geo/crawler-check`

A blocked search bot means zero citations in that engine, no matter how good
the content is. The audit parses robots.txt for 17 AI crawlers (GPTBot,
OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, …), separates
**search/answer bots** from **training bots**, and flags what the blocks mean:

```bash
curl -s localhost:0000/v1/geo/crawler-check -H 'Content-Type: application/json' \
  -d '{"url": "https://www.example.com"}'   # fetches /robots.txt itself
```

## 3. Optimize content — `POST /v1/geo/optimize`

Runs the content through the gateway's LLM pipeline (default
`GEO_OPTIMIZER_MODEL`, with fallback chain + external-provider fallback) and
applies the validated techniques: answer-first restructuring, extractable
chunks, fluent active sentences, consistent entity naming.

**The model is forbidden to invent facts.** Where a claim needs a statistic,
quote or source, it inserts `[GEO-TODO: …]` markers instead, returned as a
`todos` list — your editorial research backlog. The response contains the
rewritten markdown plus before/after analyses, so you see exactly what the
rewrite gained (`score_delta`). `iterations: 2|3` re-optimizes while the score
keeps improving.

```bash
curl -s localhost:0000/v1/geo/optimize -H 'Content-Type: application/json' -d '{
  "content": "...", "brand": "Adaptive LLM Gateway", "iterations": 2
}'
```

## 4. Test your ranking — `POST /v1/geo/ranking-test`

The Evergreen Media measurement loop, automated: a fixed prompt set (the
questions your prospects actually ask an AI) runs against the models the
gateway can reach, and every answer is evaluated for:

- **mention rate** — did the brand appear at all?
- **share of voice** — brand mentions vs. brand + competitor mentions
- **citation rate** — is one of your domains referenced?
- **first-mention position** and **brand rank** (before or after competitors?)
- **sentiment** around the mentions (positive / neutral / negative)
- a composite **visibility score** (0–100) per answer

Configuration lives in `packages/gateway/src/config/geo-targets.yaml`
(brand + aliases + domains, competitors, models, prompts). The shipped default
dogfoods the gateway itself against LiteLLM, Portkey, OneAPI and OpenRouter.
**Point `GEO_TARGETS_PATH` at your own copy** for your brand — that keeps your
competitor lists and prompt sets out of the repo.

```bash
curl -s localhost:0000/v1/geo/ranking-test -H 'Content-Type: application/json' -d '{}'
# or ad-hoc, without touching the yaml:
curl -s localhost:0000/v1/geo/ranking-test -H 'Content-Type: application/json' -d '{
  "brand": {"name": "ACME GmbH", "domains": ["acme.de"]},
  "competitors": [{"name": "Contoso"}],
  "prompts": [{"text": "Welcher Anbieter ist der beste für X?"}],
  "models": ["qwen2.5:14b"]
}'
```

Runs persist to Postgres (`geo_ranking_runs` / `geo_ranking_results`);
`GET /v1/geo/ranking-history` returns them with a **trend** delta vs. the
previous run of the same brand.

### Automated monitoring

```bash
GEO_RANKING_SCHEDULE_ENABLED=1     # opt-in
GEO_RANKING_INTERVAL_MS=86400000   # daily (default)
GEO_RANKING_MODELS=qwen2.5:14b,llama3.1:8b   # optional override
```

The monitor runs the test on boot (after a 3-minute grace period) and then on
the interval, persisting every run — visibility trends accumulate without
anyone remembering to click.

## Honest limitations

- The ranking test measures **model-side visibility**: what the model families
  reachable through your gateway say. Consumer products (ChatGPT web,
  Perplexity, AI Overviews) add live web retrieval on top, so treat the scores
  as a comparable trend signal, not as a 1:1 replica of what a user sees.
  Adding a Perplexity model (via `PERPLEXITY_API_KEY`) gets you closest to a
  real search-based engine.
- Keep the prompt set stable — the trend is only meaningful when you compare
  like with like. Add prompts rather than rewriting existing ones.
- Low temperature (0.2) is used deliberately: we measure the model's stable
  preference, not sampling noise.
- Off-page GEO (digital PR, Wikipedia/Wikidata, Reddit/YouTube presence — the
  Evergreen Media "community" pillar) can't be automated from here; the
  knowledge endpoint documents it, the ranking test tells you whether it works.

## Files

| File | Purpose |
|---|---|
| `src/modules/geo-knowledge.ts` | Embedded playbook: techniques, engine types, AI crawlers, KPIs |
| `src/modules/geo-analyzer.ts` | Deterministic scoring + robots.txt crawler audit |
| `src/modules/geo-optimizer.ts` | LLM rewrite with `[GEO-TODO]` fact-guard |
| `src/modules/geo-ranking.ts` | Prompt monitoring: evaluation, aggregation, persistence |
| `src/modules/geo-monitor.ts` | Default LLM runner + recurring schedule |
| `src/routes/geo.ts` | `/v1/geo/*` API |
| `src/config/geo-targets.yaml` | Brand / competitors / models / prompt set |
| `src/db/migrations/011-geo.sql` | `geo_ranking_runs`, `geo_ranking_results` |
