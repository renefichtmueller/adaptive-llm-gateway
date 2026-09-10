/**
 * @llm-gateway/client
 *
 * TypeScript client library for the Adaptive LLM Gateway.
 *
 * Two entry points:
 *
 * 1. Task-oriented (`LLMGatewayClient`) — for projects that submit typed
 *    tasks (summarize, classify, …) to the gateway:
 *
 *      import { createInteractiveClient } from '@llm-gateway/client';
 *      const client = createInteractiveClient('my-app');
 *      const result = await client.completion({ task_type: 'summarize', input: '…' });
 *
 * 2. Agent-oriented (`createTIPClient`) — the TIP integration protocol from
 *    ADR-0005 used by the agent adapters (Claude Code bridge, Codex LSP
 *    adapter, ChatGPT API adapter, …):
 *
 *      import { createTIPClient } from '@llm-gateway/client';
 *      const client = createTIPClient({ agentId: 'claude-code' });
 *      const result = await client.completion('Explain this code: …');
 *
 * Both share the same behavior: gateway first, transparent fallback to a
 * local Ollama when the gateway is unavailable.
 */

export * from './core.js';
export * from './tip.js';
