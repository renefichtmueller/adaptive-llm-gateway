/**
 * Internal HTTP client for calling the LLM Gateway API.
 * Used by learning jobs to run internal inference calls.
 */

import { logger } from './observability/logger.js';

const GATEWAY_URL = process.env['GATEWAY_URL'] ?? 'http://localhost:0000';
const INTERNAL_SECRET = process.env['INTERNAL_SECRET'] ?? 'internal-learning-secret';

export interface GatewayCallOptions {
  taskType: string;
  input: string;
  userContext?: string;
  caller?: string;
}

export interface GatewayCallResult {
  output: string;
  confidence: number;
  model: string;
  latencyMs: number;
}

export async function callGateway(opts: GatewayCallOptions): Promise<GatewayCallResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(`${GATEWAY_URL}/v1/completion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Caller': opts.caller ?? 'internal',
        'X-Internal-Secret': INTERNAL_SECRET,
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        task_type: opts.taskType,
        input: opts.input,
        user_context: opts.userContext ?? '',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gateway returned ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      output: string;
      confidence: number;
      model: string;
      latency_ms: number;
    };

    return {
      output: data.output,
      confidence: data.confidence,
      model: data.model,
      latencyMs: data.latency_ms,
    };
  } catch (err) {
    logger.error({ err, taskType: opts.taskType }, 'Gateway call failed');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function postInternal(path: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${GATEWAY_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn({ path, status: response.status, text: text.slice(0, 200) }, 'Internal POST non-OK');
    }
  } catch (err) {
    logger.error({ err, path }, 'Internal POST failed');
  } finally {
    clearTimeout(timeout);
  }
}
