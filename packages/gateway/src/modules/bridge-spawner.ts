/**
 * Bridge Spawner
 *
 * Auto-starts inline HTTP bridges for detected CLI subscriptions. Each bridge
 * exposes a `POST /api/generate` endpoint that the gateway can call as a regular
 * external provider. Bridges run in-process to avoid the overhead of spawning
 * separate Node processes — they listen on a dedicated port per subscription.
 */

import { execFile } from 'child_process';
import { createServer, type Server } from 'http';
import { logger } from '../observability/logger.js';
import type { SubscriptionDescriptor, SubscriptionStatus } from './subscription-discovery.js';

interface RunningBridge {
  descriptor: SubscriptionDescriptor;
  server: Server;
  port: number;
  url: string;
  startedAt: Date;
}

const runningBridges = new Map<string, RunningBridge>();

/**
 * Run a CLI tool with stdin-piped prompt, return stdout content.
 * Generic implementation that all inline bridges share.
 */
async function runCli(
  command: string,
  args: readonly string[],
  prompt: string,
  timeoutMs: number = 300_000
): Promise<{ success: boolean; content?: string; error?: string }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        command,
        args as string[],
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve({ success: false, error: err.message.slice(0, 500) });
          } else {
            resolve({ success: true, content: stdout.trim() });
          }
        }
      );
      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }
    } catch (err) {
      resolve({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Build the CLI invocation for a given subscription.
 */
function buildCliInvocation(desc: SubscriptionDescriptor, model?: string): { cmd: string; args: string[] } {
  switch (desc.bridgeImplementation) {
    case 'inline-claude': {
      const args = ['--print', '--output-format', 'text'];
      if (model) args.push('--model', model);
      return { cmd: 'claude', args };
    }
    case 'inline-copilot': {
      // gh copilot suggest is interactive; we use the OpenAI-compatible copilot-api proxy if available.
      return { cmd: 'gh', args: ['copilot', 'suggest', '--shell'] };
    }
    case 'inline-openai': {
      // Generic OpenAI-compatible CLI (chatgpt-cli, gemini-cli with OpenAI compat)
      return { cmd: desc.command, args: model ? ['--model', model] : [] };
    }
    case 'external-codex': {
      // codex CLI: read prompt from stdin
      return { cmd: 'codex', args: model ? ['--model', model] : [] };
    }
  }
}

/**
 * Spawn an inline HTTP bridge for a subscription. Returns the URL the gateway
 * should use to talk to it. Idempotent — calling twice returns the same bridge.
 */
export function spawnBridge(desc: SubscriptionDescriptor): Promise<RunningBridge> {
  const existing = runningBridges.get(desc.id);
  if (existing) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (req.method === 'GET' && req.url === '/health') {
        const current = runningBridges.get(desc.id);
        res.writeHead(200);
        res.end(
          JSON.stringify({
            status: 'ok',
            subscription: desc.id,
            label: desc.label,
            command: desc.command,
            uptimeSeconds: current ? Math.floor((Date.now() - current.startedAt.getTime()) / 1000) : 0,
          })
        );
        return;
      }

      if (req.method === 'POST' && (req.url === '/api/generate' || req.url === '/v1/completion')) {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { prompt, system, model } = JSON.parse(body || '{}');
            if (!prompt) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'prompt required' }));
              return;
            }
            const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
            const { cmd, args } = buildCliInvocation(desc, model);
            const result = await runCli(cmd, args, fullPrompt);
            if (result.success) {
              res.writeHead(200);
              res.end(
                JSON.stringify({
                  success: true,
                  content: result.content,
                  provider: desc.providerName,
                  model: model ?? desc.models[0]?.id,
                })
              );
            } else {
              res.writeHead(502);
              res.end(JSON.stringify({ success: false, error: result.error }));
            }
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'parse error' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.on('error', (err) => {
      // Port in use → assume an existing bridge is already running, treat as success
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        logger.info(
          { subscription: desc.id, port: desc.bridgePort },
          'Port already in use — assuming external bridge is healthy'
        );
        const url = `http://127.0.0.1:${desc.bridgePort}`;
        const fakeBridge: RunningBridge = {
          descriptor: desc,
          server, // server failed to bind; OK to keep handle
          port: desc.bridgePort,
          url,
          startedAt: new Date(),
        };
        runningBridges.set(desc.id, fakeBridge);
        resolve(fakeBridge);
      } else {
        reject(err);
      }
    });

    server.listen(desc.bridgePort, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${desc.bridgePort}`;
      const bridge: RunningBridge = {
        descriptor: desc,
        server,
        port: desc.bridgePort,
        url,
        startedAt: new Date(),
      };
      runningBridges.set(desc.id, bridge);
      // Set the env var so the existing external-providers logic finds the bridge
      process.env[desc.bridgeEnvKey] = url;
      logger.info(
        { subscription: desc.id, url, port: desc.bridgePort, envKey: desc.bridgeEnvKey },
        'Inline subscription bridge started'
      );
      resolve(bridge);
    });
  });
}

/**
 * Spawn bridges for every detected, authenticated subscription that doesn't
 * already have a bridge URL configured. Returns the list of started bridges.
 */
export async function spawnDetectedBridges(
  statuses: readonly SubscriptionStatus[]
): Promise<RunningBridge[]> {
  const toSpawn = statuses.filter(
    (s) => s.installed && s.authenticated !== false && !s.bridgeRunning
  );
  const results: RunningBridge[] = [];
  for (const status of toSpawn) {
    try {
      const bridge = await spawnBridge(status.descriptor);
      results.push(bridge);
    } catch (err) {
      logger.warn(
        { err, subscription: status.descriptor.id },
        'Failed to spawn subscription bridge — continuing'
      );
    }
  }
  return results;
}

/**
 * Snapshot of currently running in-process bridges. Used by the dashboard.
 */
export function getRunningBridges(): readonly RunningBridge[] {
  return Array.from(runningBridges.values());
}

/**
 * Stop all inline bridges (used during graceful shutdown).
 */
export async function stopAllBridges(): Promise<void> {
  await Promise.all(
    Array.from(runningBridges.values()).map(
      (bridge) =>
        new Promise<void>((resolve) => {
          try {
            bridge.server.close(() => resolve());
          } catch {
            resolve();
          }
        })
    )
  );
  runningBridges.clear();
}
