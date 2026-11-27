/**
 * MCP Server Mode
 *
 * Exposes the Adaptive LLM Gateway as a Model Context Protocol (MCP)
 * server, so Claude Desktop, Cursor, Zed AI, Cline, and any MCP-aware
 * agent can call our gateway as a native MCP tool — including auto-
 * routing across all subscriptions + bridges.
 *
 * The MCP protocol is JSON-RPC 2.0 over stdio (for desktop clients) or
 * HTTP / SSE (for hosted use). This implementation supports both transports.
 *
 * We expose three MCP tools:
 *   1. gateway.complete    — route a prompt through the gateway
 *   2. gateway.embed       — generate embeddings
 *   3. gateway.discover    — list available providers + models
 *
 * Spec: https://modelcontextprotocol.io
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../observability/logger.js';

// ─── MCP types ──────────────────────────────────────────────────────────────

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly McpToolDef[] = [
  {
    name: 'gateway.complete',
    description: 'Route a prompt through the Adaptive LLM Gateway. Auto-selects model + provider based on task_type and routing rules.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        task_type: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'integer' },
        temperature: { type: 'number' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gateway.embed',
    description: 'Generate embeddings via the gateway (default backend: local Ollama nomic-embed-text).',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: ['string', 'array'] },
        model: { type: 'string' },
      },
      required: ['input'],
    },
  },
  {
    name: 'gateway.discover',
    description: 'Return the list of available providers, local LLM servers, and routable models.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Tool implementations ────────────────────────────────────────────────────

const INTERNAL_BASE = process.env['INTERNAL_GATEWAY_URL'] ?? `http://localhost:${process.env['PORT'] ?? '8787'}`;

async function callComplete(params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${INTERNAL_BASE}/v1/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      caller: 'mcp',
      task_type: params['task_type'] ?? 'generic_qa',
      input: String(params['prompt'] ?? ''),
      options: {
        model: params['model'],
        max_tokens: params['max_tokens'],
        temperature: params['temperature'],
      },
    }),
  });
  return res.json();
}

async function callEmbed(params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${INTERNAL_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: params['input'], model: params['model'] }),
  });
  return res.json();
}

async function callDiscover(): Promise<unknown> {
  const token = process.env['DASHBOARD_AUTH_TOKEN'];
  const res = await fetch(`${INTERNAL_BASE}/api/dashboard/discover`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.json();
}

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'gateway.complete': return callComplete(args);
    case 'gateway.embed':    return callEmbed(args);
    case 'gateway.discover': return callDiscover();
    default: throw new Error(`Unknown MCP tool: ${name}`);
  }
}

// ─── JSON-RPC dispatcher ─────────────────────────────────────────────────────

async function handleRpc(req: McpRequest): Promise<McpResponse> {
  const id = req.id;
  try {
    if (req.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'adaptive-llm-gateway', version: '0.2.0' },
          capabilities: { tools: {}, resources: {} },
        },
      };
    }

    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }

    if (req.method === 'tools/call') {
      const params = req.params ?? {};
      const name = String(params['name'] ?? '');
      const args = (params['arguments'] as Record<string, unknown>) ?? {};
      const out = await dispatchTool(name, args);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] },
      };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'internal error';
    return { jsonrpc: '2.0', id, error: { code: -32603, message: msg } };
  }
}

// ─── HTTP/SSE transport (Fastify plugin) ─────────────────────────────────────

export async function mcpRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/mcp', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as McpRequest;
    if (!body || body.jsonrpc !== '2.0') {
      return reply.status(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    }
    const response = await handleRpc(body);
    return reply.send(response);
  });

  // Server-Sent Events transport (for clients that prefer streaming MCP)
  fastify.get('/mcp/sse', { config: { rateLimit: false } }, async (request: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    // Announce server info
    const init: McpResponse = await handleRpc({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify(init.result)}\n\n`);
    // Keep-alive pings every 30s
    const ping = setInterval(() => {
      reply.raw.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, 30_000);
    request.raw.on('close', () => clearInterval(ping));
  });

  logger.info('MCP server route registered at POST /mcp and GET /mcp/sse');
}

// ─── stdio transport (for Claude Desktop / local clients) ────────────────────

/**
 * Start a stdio-based MCP server. Each line on stdin is a JSON-RPC
 * request; each response is written as a JSON line on stdout.
 *
 * Run via: `npm --workspace=packages/gateway run mcp-stdio`
 * Configure Claude Desktop to spawn this command.
 */
export async function startStdioMcp(): Promise<void> {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        let parsed: McpRequest;
        try {
          parsed = JSON.parse(line) as McpRequest;
        } catch {
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
          nl = buffer.indexOf('\n');
          continue;
        }
        void handleRpc(parsed).then((resp) => {
          process.stdout.write(`${JSON.stringify(resp)}\n`);
        });
      }
      nl = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  logger.info('MCP stdio transport started');
}
