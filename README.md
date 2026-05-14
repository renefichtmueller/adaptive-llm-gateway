<div align="center">

# Adaptive LLM Gateway

**One unified API for every LLM you already pay for.**

[![CI](https://github.com/renefichtmueller/adaptive-llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/renefichtmueller/adaptive-llm-gateway/actions/workflows/ci.yml)
[![Security](https://github.com/renefichtmueller/adaptive-llm-gateway/actions/workflows/security.yml/badge.svg)](https://github.com/renefichtmueller/adaptive-llm-gateway/actions/workflows/security.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)

</div>

The Adaptive LLM Gateway is a self-hosted control plane that **auto-discovers** the AI subscriptions and local models on your machine, **wraps them into OpenAI- and Anthropic-compatible HTTP bridges**, and **routes every request** through a single endpoint with caller-aware compression, savings tracking, and a live dashboard.

You bring your own subscriptions — **Claude Code Max, ChatGPT Plus, GitHub Copilot, Microsoft 365 Copilot, Gemini Advanced, OpenAI Codex CLI, Aider** — plus any local **Ollama / LM Studio / vLLM** server you run. The gateway makes them all addressable from one place.

---

## The unique angle

Every other LLM gateway assumes you have a stack of pay-per-token API keys. **We assume you have subscriptions.**

| You already pay for | Per-token API would cost | We route through |
|---|---|---|
| Claude Code Max ($200/mo flat) | ~$0.003 / 1k tokens | `claude-bridge` :3250 |
| ChatGPT Plus ($20/mo flat) | ~$0.01 / 1k tokens | `openai-bridge` :3251 |
| GitHub Copilot ($10/mo flat) | (no public API) | `copilot-bridge` :3252 |
| OpenAI Codex CLI ($20/mo flat) | ~$0.01 / 1k tokens | `codex-bridge` :3253 |
| Microsoft 365 Copilot ($30/mo flat) | (no public API) | `m365-copilot-bridge` :3257 |
| Gemini Advanced ($20/mo flat) | ~$0.005 / 1k tokens | `gemini-bridge` :3254 |
| Aider (free) | (depends on backing LLM) | `aider-bridge` :3256 |

Apps talk OpenAI- or Anthropic-shaped JSON to one URL. The gateway picks the right backend, compresses the prompt if it makes sense, runs validation, caches what it can, logs the call.

---

## Compared to other gateways

| | Adaptive LLM Gateway | LiteLLM | Portkey | OneAPI | OpenRouter |
|---|---|---|---|---|---|
| Open source | ✓ Apache 2.0 | ✓ MIT | ✓ MIT | ✓ MIT | (commercial) |
| OpenAI-compatible endpoint | ✓ | ✓ | ✓ | ✓ | ✓ |
| Anthropic-compatible endpoint | ✓ | ✓ | partial | – | ✓ |
| **Wraps CLI subscriptions as bridges** | **✓ (8 CLIs)** | – | – | – | – |
| Auto-discovery of installed CLIs | ✓ | – | – | – | – |
| Context compression built-in | ✓ (verbatim/code/signature) | – (use cache) | – | – | – |
| Provider count | ~15 + 8 bridges | 100+ | ~50 | ~30 | ~200 |
| Caller-aware routing rules | ✓ YAML | ✓ Python | ✓ JSON | – | – |
| Savings tracking dashboard | ✓ gamified | basic | ✓ | ✓ billing | – |
| Build-drift guard at boot | ✓ | – | – | – | – |
| Cost model | flat-rate subscription | pay-per-token | pay-per-token + virtual keys | billed credits | pay-per-call |
| Best for | Solo / small teams with 3+ AI subscriptions | High-scale prod, many providers | Enterprise gateways | Multi-tenant SaaS | Marketplace pricing |

**TL;DR:** If you pay $200+/month for AI subscriptions and want a single endpoint to use them all, this is built for you. For 100-provider production scale, use LiteLLM.

---

## Core features

| Feature | What it does |
|---|---|
| **Auto-Discovery** | One click ("⚡ discover & connect all") scans for installed CLI subscriptions, local LLM servers (Ollama, LM Studio, llamafile, vLLM), and configured API-key providers (Groq, Cerebras, Mistral, NVIDIA, Together, Fireworks, DeepSeek, Replicate, Anyscale, Perplexity, xAI, Cloudflare AI, OpenAI, Anthropic, Google). Auto-spawns HTTP bridges on free ports. |
| **OpenAI-compatible** | `POST /v1/chat/completions` works with the official `openai` SDK. |
| **Anthropic-compatible** | `POST /v1/messages` works with `@anthropic-ai/sdk`. |
| **Native API** | `POST /v1/completion` accepts a `caller` field for per-caller stats, `task_type` for routing-rule selection, and compression options. |
| **Context Compression** | Independent TypeScript compressor with verbatim-compact, code-aware budgeting, and signature-map modes. Stored as `metadata.compression` per call. |
| **Caller-aware Routing** | `routing-rules.yaml` maps `task_type` → model tier + primary + fallback chain. |
| **Savings Tracking** | Five-axis accounting: cache hits, compression, subscription-bridge usage, tier downgrades, free-tier fallback shifts. |
| **Build-Drift Guard** | Refuses to start if a TypeScript source file is newer than its compiled artifact. |
| **Bridge Watchdog** | Optional auto-recovery: probes every running bridge, respawns dead ones. |
| **Live Dashboard** | 11-tab UI: overview · subscriptions · providers · activity · savings · wallet · memory · races · share · report · api (with try-it-out playground). |

---

## Quick start

### Local install (Node 20+, Postgres 17+)

```bash
git clone https://github.com/renefichtmueller/adaptive-llm-gateway.git
cd adaptive-llm-gateway
npm install
cp .env.example .env
# edit .env — at minimum, set DATABASE_URL
npm --workspace=packages/gateway run build
npm --workspace=packages/gateway start
```

Open `http://localhost:3103` → click **⚡ discover & connect all**.

### Docker Compose

```bash
cp .env.example .env
docker compose up -d
```

The gateway plus a Postgres instance start in two containers. Subscription CLIs still need to live on the host — Docker can't authenticate your Claude Max subscription for you.

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
        │  …        │ │ Copilot,      │ │ Google │ │ Mistral /   │
        │           │ │ Codex, Gemini │ │        │ │ NVIDIA NIM  │
        └───────────┘ └───────────────┘ └────────┘ └─────────────┘
```

---

## Endpoints

| Method | Path | Compatible with |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI `chat.completions.create` |
| `POST` | `/v1/messages` | Anthropic `messages.create` |
| `POST` | `/v1/completion` | Native — `caller`, `task_type`, `options.compression` |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/race` | Multi-model race |
| `POST` | `/v1/batch` | Batched submission |
| `GET`  | `/v1/models` | List every routable model |
| `GET`  | `/health` | Liveness + circuit-breaker state |
| `GET`  | `/api/dashboard/discover` | Full provider scan |

The dashboard's **api** tab shows live copy-paste examples and a try-it-out playground.

---

## Configuration

All knobs are environment variables. See [`.env.example`](.env.example).

Most important:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (required) |
| `OLLAMA_URL` | Local Ollama (default `http://localhost:11434`) |
| `AUTO_SPAWN_BRIDGES` | `1` to auto-spawn detected CLI bridges at boot |
| `WATCHDOG_ENABLED` | `1` to enable bridge-watchdog auto-recovery |
| `DASHBOARD_AUTH_TOKEN` | Bearer token for `/api/dashboard/*` endpoints |
| `LLM_GATEWAY_MIN_TOKENS` | Min prompt length before compression (default 700) |
| `*_API_KEY` | API keys for free-tier and hosted providers (all optional) |

Routing rules: `packages/gateway/src/config/routing-rules.yaml`.

---

## Compression

The compressor is a 530-line independent implementation (`packages/gateway/src/modules/context-compressor.ts`). Four modes:

- `none` — short inputs (<700 tokens) pass verbatim
- `verbatim_compact` — strip ANSI, normalize whitespace, collapse repeats
- `budgeted_high_signal` — drop low-signal lines to hit token budget
- `aggressive_code` / `signature_map` — for code-heavy inputs

Each result includes `applied`, `method`, `strategy`, `tokens_before`, `tokens_after`, `tokens_saved`, `ratio`, and `notes`. Stored in `metadata.compression` of every audit-log row.

---

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

## Prior art

See [`ACKNOWLEDGMENTS.md`](ACKNOWLEDGMENTS.md). The compression approach is independent code; the broader "shrink LLM context before sending" idea was pioneered by `lean-ctx` and `rtk`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Found a vulnerability? See [`SECURITY.md`](SECURITY.md) for the responsible-disclosure process.
