# ADR-0005: Multi-Agent Integration Protocol

**Date**: 2026-04-19
**Status**: accepted
**Deciders**: Rene (Architecture, Phase 2G)

## Context

Phase 2F established the LLM Gateway as a central orchestrator with a TypeScript client SDK. Phase 2G must integrate multiple AI agents:
- **Claude Code** (Anthropic CLI) — native client SDK (@llm-gateway/client)
- **Codex/Copilot** (Microsoft) — LSP protocol (Language Server Protocol)
- **ChatGPT** (OpenAI) — REST API
- **Ollama** (local inference) — HTTP API (fallback)

Each agent has different capabilities and communication patterns. We need a unified protocol that:
1. Abstracts gateway complexity from agents
2. Supports synchronous and asynchronous operations
3. Handles streaming responses (code generation, token-by-token)
4. Manages authentication and rate limiting per agent
5. Provides graceful fallback when gateway is unavailable

## Decision

Implement a **three-layer agent integration stack**:

### Layer 1: Transport (HTTP/WebSocket)
- **Core**: Fastify endpoints in LLM Gateway
- **Endpoints**:
  - `POST /agents/{agent-id}/completion` — synchronous completion
  - `GET /agents/{agent-id}/completion?stream=true` — SSE stream
  - `POST /agents/{agent-id}/validate` — prompt validation
  - `GET /agents/{agent-id}/status` — health check

### Layer 2: Agent Adapters
- **Claude Code Adapter**: Node.js module wrapping `@llm-gateway/client`
- **Codex/Copilot Adapter**: LSP server that forwards requests to gateway HTTP API
- **ChatGPT Adapter**: REST API wrapper that translates OpenAI format → Gateway format
- **Ollama Adapter**: HTTP proxy that handles local fallback (already implemented in client SDK)

### Layer 3: Protocol Format
Use JSON-RPC 2.0 over HTTP/WebSocket:
```json
{
  "jsonrpc": "2.0",
  "method": "completion",
  "params": {
    "prompt": "...",
    "model": "claude-3.5-sonnet",
    "temperature": 0.7,
    "max_tokens": 2000,
    "agent_id": "claude-code"
  },
  "id": 1
}
```

## Alternatives Considered

### Alternative 1: Separate Gateway Instance per Agent
- **Pros**: Complete isolation, agent-specific customization
- **Cons**: Operational overhead, duplicate infrastructure, no shared learning
- **Why not**: Contradicts Phase 2F goal of central orchestration

### Alternative 2: Agent-Specific Protocols (No Normalization)
- **Pros**: Native protocol support for each agent
- **Cons**: Gateway becomes protocol translator, complexity explosion
- **Why not**: Gateway becomes a reverse proxy instead of an orchestrator

### Alternative 3: Message Queue (RabbitMQ/Kafka)
- **Pros**: Decouples agents from gateway, supports async workflows
- **Cons**: Added infrastructure, latency for synchronous operations
- **Why not**: Overkill for initial integration; add later if async workflows needed

## Consequences

### Positive
- **Single integration point**: Agents connect to gateway, not directly to models
- **Shared learning**: All agents benefit from confidence gating and model selection
- **Graceful degradation**: Agents fall back to local Ollama independently
- **Extensible**: New agents added by implementing adapter layer only

### Negative
- **Latency**: Additional HTTP round-trip for each request (vs. direct model call)
- **Adapter maintenance**: Each agent needs an adapter; breaks if agent API changes
- **Protocol overhead**: JSON-RPC adds overhead vs. direct integration

### Risks
- **Claude Code integration risk**: Requires subprocess communication with `claude` CLI
- **Mitigation**: claude-bridge already demonstrates working pattern
- **Codex integration risk**: Microsoft LSP server not directly compatible with HTTP
- **Mitigation**: Implement thin LSP-to-HTTP translation layer

## Implementation Plan

### Phase 2G.1: Claude Code Integration (Week 1)
```ts
// Extend @llm-gateway/client with agent metadata.
// createTIPClient is the agent-facing factory of the TIP integration
// protocol; it wraps the gateway with a transparent local-Ollama fallback.
import { createTIPClient } from '@llm-gateway/client';

const client = createTIPClient({
  agentId: 'claude-code',
  gatewayUrl: 'http://localhost:8787',        // optional, env: LLM_GATEWAY_URL
  fallback: { ollamaUrl: 'localhost:11434' }, // or top-level ollamaUrl
});

const result = await client.completion('Explain this code: …', { maxTokens: 500 });
// → { text, model, tokens: {input, output}, confidence: 0–1, fallback, … }
```

### Phase 2G.2: Codex/Copilot (Week 2)
```bash
# Implement LSP server wrapper
npm install -D @types/node-lsp-server
# Create packages/lsp-adapter/
# - Implements LSP protocol
# - Translates completion requests to HTTP
```

### Phase 2G.3: ChatGPT Integration (Week 3)
```bash
# OpenAI API compatibility layer
# POST /agents/chatgpt/chat/completions
# → Translate to gateway completion format
```

### Phase 2G.4: Learning Integration (Week 4)
```bash
# Connect agent-specific metrics to learning engine
# - Track per-agent accuracy, token usage, latency
# - Auto-select models per agent based on performance
```

## Open Questions

1. **Authentication**: How do agents authenticate with gateway?
   - Option A: API keys per agent
   - Option B: OAuth2 with OIDC
   - Option C: mTLS for local agents, keys for remote
   - **Decision pending**: TBD in Phase 2G.1

2. **Rate Limiting**: Per-agent or global quota?
   - Option A: Per-agent limits (Claude Code = 100 req/min)
   - Option B: Global pool shared across agents
   - **Decision pending**: Depends on learning system usage patterns

3. **Response Format**: Streaming vs. buffered?
   - Option A: Always stream (SSE)
   - Option B: Support both (`?stream=true/false`)
   - **Decision pending**: Codex/Copilot compatibility check needed

## Implementation Note (2026-08)

The TIP client now ships in `@llm-gateway/client` (`packages/client/src/tip.ts`):

- `createTIPClient(config)` — ADR-style config object (`agentId`, `gatewayUrl`,
  `ollamaUrl`/`fallback.ollamaUrl`, `timeout`); a legacy `createTIPClient(url)`
  string signature is kept for backwards compatibility.
- Requests go to the gateway's `/v1/completion` (the agent id is sent as
  `caller`); when the gateway is unreachable the client transparently falls
  back to local Ollama and marks the response with `fallback: true`.
- Confidence is normalized to 0–1 for agents (the gateway itself reports 0–10).

Consumers: `packages/claude-code-bridge`, `packages/codex-lsp-adapter`,
`packages/chatgpt-api-adapter`; per-agent learning tables live in
`packages/learning-integration` (Phase 2G.4).
