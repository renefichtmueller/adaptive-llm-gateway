# Adaptive LLM Gateway

> One unified API for every LLM you already pay for.

The Adaptive LLM Gateway is a self-hosted control plane that **auto-discovers** the AI subscriptions and local models on your machine, **wraps them into OpenAI- and Anthropic-compatible HTTP bridges**, and **routes every request** through a single endpoint with caller-aware compression, savings tracking, and gamified analytics.

You bring your own subscriptions — Claude Code Max, ChatGPT Plus, GitHub Copilot, Microsoft 365 Copilot, Gemini Advanced, OpenAI Codex CLI, Aider — plus any local Ollama / LM Studio / vLLM models you run. The gateway makes them all addressable from one place, tracks how much each call costs (or would have cost on pay-per-token APIs), and gives you a single dashboard that shows where your savings actually come from.

---

## Why this exists

If you pay for several AI subscriptions, you're already covering the cost of thousands of calls per month per plan. The problem is that every app, IDE plugin, and CLI tool wants its own integration: OpenAI's SDK, Anthropic's SDK, a Copilot extension, a Codex socket, a Cursor session… each separately auth'd, separately metered, and none of them aware of the others.

The Adaptive LLM Gateway sits in front of all of them. Apps talk OpenAI- or Anthropic-shaped JSON to one URL. The gateway picks the right backend, compresses the prompt if it makes sense, runs validation, caches what it can, and logs the call to a dashboard so you can finally see what your AI budget is doing.

---

## Core features

| Feature | What it does |
|---|---|
| **Auto-Discovery** | One click ("⚡ discover & connect all") scans for installed CLI subscriptions, local LLM servers (Ollama, LM Studio, llamafile, vLLM), and configured API-key providers (Groq, Cerebras, Mistral, NVIDIA, Cloudflare AI). Auto-spawns HTTP bridges on free ports. |
| **OpenAI-compatible** | `POST /v1/chat/completions` works with the official `openai` SDK. Drop-in replacement: change one URL and you're routed through the gateway. |
| **Anthropic-compatible** | `POST /v1/messages` works with `@anthropic-ai/sdk`. Same drop-in benefit. |
| **Native API** | `POST /v1/completion` accepts a `caller` field for per-caller stats, plus `task_type` for routing-rule selection and a compression options block. |
| **Context Compression** | Independent TypeScript compressor (verbatim-compact, repeated-line collapse, code-aware budgeting, signature-map mode). Tracks tokens-before / tokens-after / saved per call. |
| **Caller-aware Routing** | `routing-rules.yaml` maps `task_type` to a model tier (fast / medium / large / reasoning) and a primary + fallback chain. |
| **Savings Tracking** | Five-axis accounting: cache hits, compression savings, subscription bridge usage (vs. pay-per-token cost), tier downgrades, and external fallback shifts. Live dashboard. |
| **Build-Drift Guard** | Refuses to start if a TypeScript source file is newer than its compiled artifact — prevents stale-build bugs in production. |
| **Subscription Bridges** | Inline HTTP wrappers around `claude`, `chatgpt`, `gh copilot`, `codex`, `gemini`, `aider`, M365 Copilot — flat-rate plan usage instead of metered API tokens. |

---

## Quick start

### Local install (Node 20+, Postgres 17+)

```bash
git clone https://github.com/<your-handle>/adaptive-llm-gateway.git
cd adaptive-llm-gateway
npm install
cp .env.example .env
# edit .env — at minimum, set DATABASE_URL
npm --workspace=packages/gateway run build
npm --workspace=packages/gateway start
```

Then open `http://localhost:3103` and click **⚡ discover & connect all**.

### Docker Compose

```bash
cp .env.example .env
docker compose up -d
```

This brings up the gateway plus a Postgres instance. Subscription CLIs still need to live on the host — Docker can't authenticate your Claude Max subscription for you.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Your apps (IDE plugins, agents, CLI tools, scripts)            │
│                                                                  │
│         OpenAI SDK         Anthropic SDK         curl            │
└──────────────┬─────────────────┬──────────────────┬──────────────┘
               │                 │                  │
               ▼                 ▼                  ▼
        /v1/chat/completions  /v1/messages  /v1/completion
        ┌──────────────────────────────────────────────────┐
        │            Adaptive LLM Gateway :3103            │
        │  ┌──────────────────────────────────────────┐    │
        │  │  Pre-classify ▸ Compress ▸ Route ▸ Audit │    │
        │  └──────────────────────────────────────────┘    │
        └─────┬────────────┬─────────────┬────────────┬────┘
              │            │             │            │
        ┌─────▼─────┐ ┌────▼──────────┐ ┌▼───────┐ ┌──▼──────────┐
        │  Ollama   │ │ Subscription  │ │ Hosted │ │ Free Tier   │
        │  (local)  │ │ bridges       │ │ APIs   │ │ fallback    │
        │           │ │ :3250-3257    │ │        │ │             │
        │  qwen2.5  │ │ Claude Code   │ │ OpenAI │ │ Groq /      │
        │  llama3.x │ │ ChatGPT       │ │ Anthr. │ │ Cerebras /  │
        │  …        │ │ Copilot,      │ │        │ │ Mistral /   │
        │           │ │ Codex, Gemini │ │        │ │ NVIDIA NIM  │
        └───────────┘ └───────────────┘ └────────┘ └─────────────┘
```

---

## What's inside

```
packages/
├── gateway/                 # The HTTP server itself (Fastify, TypeScript)
│   ├── src/
│   │   ├── pipeline/        # pre-classify → compress → route → validate
│   │   ├── routes/          # /v1/completion, /chat/completions, /messages …
│   │   ├── modules/         # auto-discovery, bridge-spawner, gamification
│   │   ├── circuit-breaker/ # per-model failure isolation
│   │   └── observability/   # audit-log, cost-calculator, metrics
│   └── public/dashboard.html
├── client/                  # Typed JS/TS client (`createClient`)
├── learning/                # Cron-based prompt + routing improver
├── prompt-optimizer/        # Versioned prompt templates
└── mcp-server/              # Model Context Protocol server (optional)

claude-code-bridge/          # Subscription wrappers
openai-bridge/
copilot-bridge/
m365-copilot-bridge/
codex-lsp-adapter/
```

---

## Endpoints

| Method | Path | Compatible with |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI `chat.completions.create` |
| `POST` | `/v1/messages` | Anthropic `messages.create` |
| `POST` | `/v1/completion` | Native — accepts `caller`, `task_type`, `options.compression` |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/race` | Multi-model race (returns first-good or all-side-by-side) |
| `POST` | `/v1/batch` | Batched submission |
| `GET`  | `/v1/models` | List every routable model |
| `GET`  | `/health` | Liveness + circuit-breaker state |

The dashboard's **api** tab shows live copy-paste examples and a try-it-out playground.

---

## Configuration

All knobs are environment variables. See [`.env.example`](.env.example).

The most common ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `OLLAMA_URL` | Where your local Ollama lives (default `http://localhost:11434`) |
| `AUTO_SPAWN_BRIDGES` | `1` to auto-spawn detected CLI bridges at boot |
| `DASHBOARD_AUTH_TOKEN` | Bearer token required to access dashboard endpoints |
| `LLM_GATEWAY_MIN_TOKENS` | Minimum prompt length before compression engages (default 700) |
| `LLM_GATEWAY_TARGET_TOKENS` | Target compressed size (default 2400) |
| `CEREBRAS_API_KEY` / `GROQ_API_KEY` / etc. | Free-tier provider keys (optional) |

Routing rules live in `packages/gateway/src/config/routing-rules.yaml` and ship with sensible defaults.

---

## Compression

The compressor is a 530-line independent implementation (`packages/gateway/src/modules/context-compressor.ts`). It runs in four modes:

- `none` — short inputs (< 700 tokens) pass through verbatim
- `verbatim_compact` — strip ANSI, whitespace-normalize, collapse repeated lines
- `budgeted_high_signal` — drop low-signal lines (boilerplate, error tails, etc.) to hit a token budget
- `aggressive_code` / `signature_map` — for code-heavy inputs, retain only signatures + tail context

Each result includes `applied`, `method`, `strategy`, `tokens_before`, `tokens_after`, `tokens_saved`, `ratio`, and a `notes` array. Stored in `metadata.compression` of every audit-log row.

---

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

## Prior art

See [`ACKNOWLEDGMENTS.md`](ACKNOWLEDGMENTS.md). The compression approach is independent code, but the broader "shrink LLM context before sending" pattern has been pioneered by several earlier OSS projects.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports, routing-rule additions, and bridge implementations for new subscriptions are especially welcome.

## Security

Found a vulnerability? See [`SECURITY.md`](SECURITY.md) for the responsible-disclosure process.
