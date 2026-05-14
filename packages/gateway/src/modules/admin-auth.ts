import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';

const TOKEN_ENV_KEYS = ['DASHBOARD_AUTH_TOKEN', 'LLM_GATEWAY_ADMIN_TOKEN', 'ADMIN_TOKEN'] as const;

function configuredToken(): string | undefined {
  for (const key of TOKEN_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenFromAuthorizationHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(/\s+/, 2);
  if (!scheme || !value) return undefined;

  if (scheme.toLowerCase() === 'bearer') return value.trim();

  if (scheme.toLowerCase() === 'basic') {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      return separator >= 0 ? decoded.slice(separator + 1).trim() : decoded.trim();
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function tokenFromRequest(request: FastifyRequest): string | undefined {
  const explicit = request.headers['x-dashboard-token'];
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return tokenFromAuthorizationHeader(request.headers.authorization);
}

export function isDashboardAuthConfigured(): boolean {
  return !!configuredToken();
}

function isLocalDevelopmentRequest(request: FastifyRequest): boolean {
  if (process.env['NODE_ENV'] === 'production') return false;
  const host = request.hostname || request.headers.host || '';
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]');
}

export async function requireDashboardAuth(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (isLocalDevelopmentRequest(request)) return;

  const expected = configuredToken();
  if (!expected) {
    return reply.status(503).send({
      statusCode: 503,
      error: 'Dashboard Auth Not Configured',
      message: 'Set DASHBOARD_AUTH_TOKEN before exposing dashboard data or settings.',
    });
  }

  const received = tokenFromRequest(request);
  if (!received || !safeEqual(received, expected)) {
    reply.header('WWW-Authenticate', 'Bearer realm="llm-gateway-dashboard"');
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Dashboard token required.',
    });
  }
}

export function dashboardAuthStatus(request: FastifyRequest): { configured: boolean; authenticated: boolean } {
  if (isLocalDevelopmentRequest(request)) return { configured: true, authenticated: true };

  const expected = configuredToken();
  if (!expected) return { configured: false, authenticated: false };
  const received = tokenFromRequest(request);
  return { configured: true, authenticated: !!received && safeEqual(received, expected) };
}
