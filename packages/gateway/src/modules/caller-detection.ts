/**
 * caller-detection — figure out which client originated a request.
 *
 * Layered detection in order of precedence:
 *   1. Explicit header `x-llm-gateway-caller`
 *   2. Body field (request-specific, e.g. `user` in OpenAI requests)
 *   3. User-Agent string heuristic (Codex / Claude Desktop / Cursor / ...)
 *   4. Provided default
 *
 * Returns the resolved caller ID plus the method that produced it, for audit.
 */
import type { FastifyRequest } from 'fastify';

export interface CallerDetectionResult {
  caller: string;
  source: 'header' | 'body' | 'user-agent' | 'default';
}

const USER_AGENT_HEURISTICS: Array<{ pattern: RegExp; caller: string }> = [
  { pattern: /codex(-cli)?/i, caller: 'codex-cli' },
  { pattern: /Codex\.app|Electron.*Codex/i, caller: 'codex-app' },
  { pattern: /claude-code/i, caller: 'claude-code' },
  { pattern: /Claude\.app|Electron.*Claude/i, caller: 'claude-desktop' },
  { pattern: /cursor/i, caller: 'cursor' },
  { pattern: /zed/i, caller: 'zed-ai' },
  { pattern: /cline/i, caller: 'cline' },
  { pattern: /aider/i, caller: 'aider' },
  { pattern: /OpenAI\/[\d.]+/, caller: 'openai-sdk' },
  { pattern: /@anthropic-ai\/sdk/i, caller: 'anthropic-sdk' },
];

export function detectCaller(
  request: FastifyRequest,
  fallback: string,
  bodyCaller?: string | null,
): CallerDetectionResult {
  // 1. Explicit header wins
  const headerCaller = request.headers['x-llm-gateway-caller'];
  if (typeof headerCaller === 'string' && headerCaller.trim().length > 0) {
    return { caller: headerCaller.trim(), source: 'header' };
  }

  // 2. Body-supplied caller (e.g. OpenAI `user` field)
  if (typeof bodyCaller === 'string' && bodyCaller.trim().length > 0) {
    return { caller: bodyCaller.trim(), source: 'body' };
  }

  // 3. User-Agent heuristic
  const ua = (request.headers['user-agent'] as string | undefined) ?? '';
  for (const rule of USER_AGENT_HEURISTICS) {
    if (rule.pattern.test(ua)) {
      return { caller: rule.caller, source: 'user-agent' };
    }
  }

  // 4. Fallback
  return { caller: fallback, source: 'default' };
}
