# ADR-0001: Multi-Agent Coworking Architecture with LLM Gateway Orchestrator

**Date**: 2026-04-19  
**Status**: accepted  
**Deciders**: Project maintainers

## Context

The LLM Gateway currently operates as a monolithic orchestrator that directly routes requests to multiple LLM providers (Ollama, Cerebras, Groq, Mistral AI, NVIDIA NIM, Cloudflare Workers AI). As the system grows, multiple specialized AI agents (Claude Code, Codex, Copilot, ChatGPT) need to participate in a coordinated workflow without each implementing their own routing, fallback chains, authentication, and cost tracking logic.

**Key constraints:**
- Cost optimization is critical: local Ollama reduces external API calls
- No external dependencies beyond fallback chain providers
- Learning system must improve routing decisions over time
- Each agent brings different capabilities and should operate autonomously while benefiting from shared infrastructure

## Decision

Establish the LLM Gateway as the **central orchestrator** in a multi-agent coworking architecture:

1. **Gateway as Central Hub**: All agent requests funnel through the Gateway via HTTP (or future MCP) interface
2. **Agent Connection Model**: Agents (Claude Code, Codex, Copilot, ChatGPT) connect as clients, not workers
3. **Local-First Strategy**: Ollama on Mac Studio as primary provider; external APIs as fallback chain only
4. **Learning System**: Autonomous 6h/12h/24h cycles continuously improve routing decisions based on historical performance
5. **Shared Infrastructure**: Authentication, rate limiting, cost tracking, confidence gates, and audit logging centralized in Gateway

## Alternatives Considered

### Alternative 1: Agent-Centric P2P Model
- **Pros**: Each agent is fully autonomous, no single point of failure at Gateway
- **Cons**: Duplicated routing logic, inconsistent fallback chains, cost tracking fragmentation, learning cannot be shared
- **Why not**: Violates DRY principle, makes system harder to maintain and improve; Gateway exists to solve exactly this problem

### Alternative 2: Microservices Architecture (separate routers, LLM clients, learning engines)
- **Pros**: Perfect horizontal scalability, independent deployment cycles
- **Cons**: Operational complexity (12+ services), message queue infrastructure, network overhead, latency increase by 50-200ms per hop
- **Why not**: Premature complexity; monorepo + monolith can handle current and near-future load; split only when single-machine limits are hit

### Alternative 3: Distributed Learning (each agent learns independently)
- **Pros**: No centralized bottleneck for learning
- **Cons**: Inconsistent models, agents converge to different optima, learning takes 3x longer
- **Why not**: Shared learning pool is one of Gateway's core strengths; agents should benefit from collective experience

## Consequences

### Positive
- **Single source of truth**: All routing decisions logged, auditable, and improvable
- **Cost visibility**: Gateway tracks true cost-per-request across all agents; savings from compression visible globally
- **Unified learning**: One learning engine improves routing for all agents simultaneously
- **Reduced duplication**: Agents focus on their domain; gateway owns infrastructure
- **Fallback chain consistency**: All agents benefit from the same circuit breaker and retry logic
- **Authentication centralized**: Single token management; agents delegate security to Gateway

### Negative
- **Gateway becomes critical path**: If Gateway is down, all agents are blocked (mitigated by local Ollama fallback)
- **Latency overhead**: ~50-100ms per request added by HTTP round-trip to Gateway (acceptable for LLM calls, which are 1-10s)
- **Coupling**: Agents tightly coupled to Gateway API; API changes require client coordination
- **Scaling bottleneck**: Single Gateway instance handles all traffic (addressed by horizontal replication if needed)

### Risks
- **Single point of failure**: Mitigate with health checks, automatic restart, and offline Ollama fallback
- **Gateway becomes monolithic**: Mitigate by splitting instrumentation/learning into separate worker processes early
- **Learning feedback loops**: If routing decisions are poor, all agents suffer equally; mitigate with confidence gate and human review queue

## Implementation Notes

1. **Client SDKs**: Provide @llm-gateway/client library with built-in retry, exponential backoff, and request timeout
2. **API Stability**: Treat POST /v1/completion as stable contract; versioning any future breaking changes
3. **Health Checks**: Agents poll Gateway health endpoint; if offline, fall back to direct local Ollama
4. **Monitoring**: Prometheus metrics expose Gateway health to monitoring dashboards (Shield Dashboard)
5. **Learning Feedback**: Review queue and manual approvals feed back into prompt templates automatically

## Related Decisions
- Gateway routing tier assignment (fast, medium, large) — ADR-0002 (pending)
- Confidence gate thresholds and learning cycle intervals — ADR-0003 (pending)
- External provider fallback chain ordering — ADR-0004 (pending)
