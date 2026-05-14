/**
 * TLS Configuration Module
 * Implements CIS 3.2: Data in Transit Encryption
 *
 * Requirements:
 * - TLS 1.3 only (no TLS 1.2 or earlier)
 * - Strong ciphers
 * - HSTS (HTTP Strict-Transport-Security)
 * - No mixed content
 * - Database connections use sslmode=require
 */

import { readFileSync } from 'fs';
import { FastifyInstance } from 'fastify';

export interface TLSConfig {
  enabled: boolean;
  minVersion: 'TLSv1.3';
  maxVersion: 'TLSv1.3';
  ciphers: string[];
  certificatePath?: string;
  keyPath?: string;
  hstsMaxAge: number;
  hstIncludeSubdomains: boolean;
  hstsPreload: boolean;
}

/**
 * Get TLS configuration from environment
 */
export function getTLSConfig(): TLSConfig {
  const enabled = process.env['TLS_ENABLED'] !== 'false';
  const certPath = process.env['TLS_CERT_PATH'];
  const keyPath = process.env['TLS_KEY_PATH'];

  // TLS 1.3 recommended ciphers (NIST-approved)
  const ciphers = [
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'TLS_AES_128_GCM_SHA256',
  ];

  return {
    enabled,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    ciphers,
    certificatePath: certPath,
    keyPath: keyPath,
    hstsMaxAge: parseInt(process.env['HSTS_MAX_AGE'] ?? '31536000', 10), // 1 year
    hstIncludeSubdomains: process.env['HSTS_INCLUDE_SUBDOMAINS'] !== 'false',
    hstsPreload: process.env['HSTS_PRELOAD'] !== 'false',
  };
}

/**
 * Load TLS certificates from disk
 */
export function loadTLSCertificates(config: TLSConfig): { key: Buffer; cert: Buffer } | null {
  if (!config.enabled || !config.certificatePath || !config.keyPath) {
    return null;
  }

  try {
    const cert = readFileSync(config.certificatePath);
    const key = readFileSync(config.keyPath);
    return { key, cert };
  } catch (error) {
    throw new Error(`Failed to load TLS certificates: ${error}`);
  }
}

/**
 * HSTS Header Middleware
 * Enforces HTTPS for all future requests
 * Only sends HSTS header on secure (HTTPS) connections
 */
export async function registerHSTSMiddleware(server: FastifyInstance, config: TLSConfig) {
  server.addHook('onSend', async (request, reply) => {
    // Only send HSTS header on secure connections (HTTPS)
    const isSecure =
      request.protocol === 'https' ||
      (request.headers['x-forwarded-proto'] === 'https');

    if (!isSecure) {
      return; // Don't set HSTS header on HTTP connections
    }

    const hstsValue = [
      `max-age=${config.hstsMaxAge}`,
      ...(config.hstIncludeSubdomains ? ['includeSubdomains'] : []),
      ...(config.hstsPreload ? ['preload'] : []),
    ].join('; ');

    reply.header('Strict-Transport-Security', hstsValue);
  });
}

/**
 * HTTPS Redirect Middleware
 * Redirects HTTP requests to HTTPS
 */
export async function registerHTTPSRedirectMiddleware(server: FastifyInstance) {
  server.addHook('onRequest', async (request, reply) => {
    // Skip for health checks
    if (request.url === '/health' || request.url.startsWith('/metrics')) {
      return;
    }

    // Skip for localhost/loopback callers (infra-health, fix-engine, internal services)
    const reqHost = String(request.headers['host'] ?? '');
    if (reqHost.startsWith('localhost') || reqHost.startsWith('127.0.0.1')) {
      return;
    }

    // Check if connection is not secure
    // In production, X-Forwarded-Proto is set by reverse proxy (Cloudflare)
    const isSecure =
      request.protocol === 'https' ||
      (request.headers['x-forwarded-proto'] === 'https');

    if (!isSecure && process.env['NODE_ENV'] === 'production') {
      const host = request.headers['x-forwarded-host'] || request.headers['host'];
      return reply.redirect(`https://${host}${request.url}`);
    }
  });
}

/**
 * Security Headers Middleware
 * Adds comprehensive security headers
 */
export async function registerSecurityHeadersMiddleware(server: FastifyInstance) {
  server.addHook('onSend', async (request, reply) => {
    // Content Security Policy — route handlers may set a narrower CSP before this hook.
    // Default allows 'unsafe-inline' for the dashboard UI.
    if (!reply.getHeader('Content-Security-Policy')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
    }

    // Prevent clickjacking
    reply.header('X-Frame-Options', 'DENY');

    // Prevent MIME type sniffing
    reply.header('X-Content-Type-Options', 'nosniff');

    // Enable XSS protection
    reply.header('X-XSS-Protection', '1; mode=block');

    // Referrer policy - don't leak info to external sites
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Permissions policy - disable powerful APIs
    reply.header(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
    );

    // Cross-Origin policies
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  });
}

/**
 * Validate TLS Configuration
 */
export function validateTLSConfig(config: TLSConfig): string[] {
  const errors: string[] = [];

  if (config.enabled && (!config.certificatePath || !config.keyPath)) {
    errors.push('TLS enabled but certificates not configured');
  }

  if (config.minVersion !== 'TLSv1.3') {
    errors.push('TLS version must be TLSv1.3 or higher');
  }

  if (config.maxVersion !== 'TLSv1.3') {
    errors.push('TLS version must be TLSv1.3 only');
  }

  if (!config.ciphers || config.ciphers.length === 0) {
    errors.push('No TLS ciphers configured');
  }

  return errors;
}

/**
 * Validate Database SSL Connection
 */
export function validateDatabaseSSL(): { valid: boolean; error?: string } {
  const dbUrl = process.env['DATABASE_URL'];

  if (!dbUrl) {
    return { valid: false, error: 'DATABASE_URL not set' };
  }

  // Parse connection string
  const sslmodeMatch = dbUrl.match(/sslmode=([^&\s]+)/);
  const sslmode = sslmodeMatch ? sslmodeMatch[1] : 'prefer';

  // Require SSL for production
  if (process.env['NODE_ENV'] === 'production') {
    if (sslmode !== 'require') {
      return {
        valid: false,
        error: `Database SSL mode must be 'require' in production, got '${sslmode}'`,
      };
    }
  }

  return { valid: true };
}

/**
 * Check for Mixed Content
 * Validates that static assets are served via HTTPS
 */
export async function validateNoMixedContent(
  assetUrls: string[]
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];

  for (const url of assetUrls) {
    if (url.startsWith('http://') && process.env['NODE_ENV'] === 'production') {
      issues.push(`Mixed content detected: ${url}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
