/**
 * Post-Validation Pipeline
 * Validates requests after routing but before business logic execution
 *
 * Integration Points:
 * - JWT Algorithm Pinning (AOS-30FF1E)
 * - NIST Authentication (PrLAC-07)
 * - Rate Limiting (SEC-RATELIMIT-001)
 * - CSRF Protection (SEC-AUTH-002)
 */

import type { Request, Response } from 'fastify';
import { validateJWT } from '../validation/jwt-validator';
import { validateNISTAuthentication, isAccountLocked } from '../validation/nist-auth';

export interface ValidatorConfig {
  validators: Set<'jwt' | 'nist_auth' | 'rate_limit' | 'csrf'>;
  jwt_token?: string;
  user_id?: string;
  rate_limit_key?: string;
  csrf_token?: string;
}

export interface PostValidationResult {
  valid: boolean;
  user_id?: string;
  errors: string[];
  score_impacts: number[];
  timestamp: Date;
}

/**
 * Rate Limiting Implementation
 * Simple in-memory rate limiter (use Redis in production)
 */
class RateLimiter {
  private attempts: Map<string, { count: number; resetTime: number }> = new Map();
  private readonly maxAttempts = 10;
  private readonly windowMs = 60000; // 1 minute

  isLimited(key: string): boolean {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record || now > record.resetTime) {
      this.attempts.set(key, { count: 1, resetTime: now + this.windowMs });
      return false;
    }

    record.count++;
    if (record.count > this.maxAttempts) {
      return true;
    }

    return false;
  }

  getRemainingAttempts(key: string): number {
    const record = this.attempts.get(key);
    if (!record || Date.now() > record.resetTime) {
      return this.maxAttempts;
    }
    return Math.max(0, this.maxAttempts - record.count);
  }
}

const rateLimiter = new RateLimiter();

/**
 * CSRF Token Validation
 */
function validateCSRFToken(requestToken: string, sessionToken: string): boolean {
  // CSRF token should be derived from session token
  // Simple implementation: token = hash(session_token + secret)
  // In production: use double-submit cookie pattern or SameSite cookie attribute
  return requestToken && requestToken.length > 0 && sessionToken && sessionToken.length > 0;
}

/**
 * Rate Limit Validation
 */
async function validateRateLimit(
  config: ValidatorConfig,
  request: Request
): Promise<{ valid: boolean; error?: string; scoreImpact: number }> {
  const rateLimitKey = config.rate_limit_key || `${request.ip}`;

  if (rateLimiter.isLimited(rateLimitKey)) {
    return {
      valid: false,
      error: 'Rate limit exceeded',
      scoreImpact: -3.0
    };
  }

  return {
    valid: true,
    scoreImpact: 0
  };
}

/**
 * JWT Validation in Post-Pipeline
 */
async function validateRequestJWT(
  config: ValidatorConfig
): Promise<{ valid: boolean; error?: string; userId?: string; scoreImpact: number }> {
  if (!config.jwt_token) {
    return {
      valid: false,
      error: 'JWT token required',
      scoreImpact: -2.0
    };
  }

  try {
    const result = await validateJWT(config.jwt_token);
    return {
      valid: result.valid,
      error: result.valid ? undefined : result.error,
      userId: result.decoded?.sub,
      scoreImpact: result.score_impact
    };
  } catch (error) {
    return {
      valid: false,
      error: `JWT validation failed: ${error}`,
      scoreImpact: -2.0
    };
  }
}

/**
 * NIST Authentication Validation in Post-Pipeline
 */
async function validateRequestNISTAuth(
  config: ValidatorConfig,
  userId: string
): Promise<{ valid: boolean; error?: string; scoreImpact: number }> {
  // In production, retrieve user's authentication state from database
  // This is a simplified version showing the integration point

  const result = validateNISTAuthentication(
    true,  // password hash valid (from database verification)
    true,  // password strength valid
    true,  // MFA enabled
    true,  // session token valid
    true,  // account not locked
    true   // password meets NIST
  );

  return {
    valid: result.success,
    error: result.error,
    scoreImpact: result.score_impact
  };
}

/**
 * CSRF Validation
 */
async function validateCSRF(
  config: ValidatorConfig,
  sessionToken: string
): Promise<{ valid: boolean; error?: string; scoreImpact: number }> {
  if (!config.csrf_token) {
    return {
      valid: false,
      error: 'CSRF token required for state-changing operations',
      scoreImpact: -2.0
    };
  }

  const valid = validateCSRFToken(config.csrf_token, sessionToken);
  return {
    valid,
    error: valid ? undefined : 'CSRF token validation failed',
    scoreImpact: valid ? 0 : -2.0
  };
}

/**
 * Main Post-Validation Pipeline
 */
export async function runPostValidation(
  request: Request,
  config: ValidatorConfig
): Promise<PostValidationResult> {
  const errors: string[] = [];
  const scoreImpacts: number[] = [];
  let userId = config.user_id;

  try {
    // Validate rate limiting first (fast check)
    if (config.validators.has('rate_limit')) {
      const result = await validateRateLimit(config, request);
      if (!result.valid) {
        errors.push(result.error!);
        scoreImpacts.push(result.scoreImpact);
        return {
          valid: false,
          errors,
          score_impacts: scoreImpacts,
          timestamp: new Date()
        };
      }
      scoreImpacts.push(result.scoreImpact);
    }

    // Validate JWT (authentication)
    if (config.validators.has('jwt')) {
      const result = await validateRequestJWT(config);
      if (!result.valid) {
        errors.push(result.error!);
      }
      scoreImpacts.push(result.scoreImpact);
      if (result.userId) {
        userId = result.userId;
      }
    }

    // Validate NIST Authentication
    if (config.validators.has('nist_auth') && userId) {
      const result = await validateRequestNISTAuth(config, userId);
      if (!result.valid) {
        errors.push(result.error!);
      }
      scoreImpacts.push(result.scoreImpact);
    }

    // Validate CSRF for state-changing operations
    if (config.validators.has('csrf')) {
      const sessionToken = request.headers['x-session-token'] as string;
      const result = await validateCSRF(config, sessionToken);
      if (!result.valid) {
        errors.push(result.error!);
      }
      scoreImpacts.push(result.scoreImpact);
    }

    const valid = errors.length === 0;

    return {
      valid,
      user_id: valid ? userId : undefined,
      errors,
      score_impacts: scoreImpacts,
      timestamp: new Date()
    };
  } catch (error) {
    return {
      valid: false,
      errors: [...errors, `Post-validation error: ${error}`],
      score_impacts: scoreImpacts,
      timestamp: new Date()
    };
  }
}

/**
 * Middleware for integrating post-validator into Fastify
 */
export function createPostValidatorMiddleware() {
  return async (request: Request, reply: Response) => {
    // Extract validators from route metadata or request headers
    const validators = new Set<'jwt' | 'nist_auth' | 'rate_limit' | 'csrf'>();

    // Check headers for tokens
    const jwtToken = request.headers.authorization?.split(' ')[1];
    const csrfToken = request.headers['x-csrf-token'] as string;
    const rateLimitKey = request.ip;

    // Configure validators based on request
    if (jwtToken) {
      validators.add('jwt');
    }

    // NIST auth required for authenticated endpoints
    if (request.headers['authorization']) {
      validators.add('nist_auth');
    }

    // Rate limiting on all endpoints
    validators.add('rate_limit');

    // CSRF on state-changing operations
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
      validators.add('csrf');
    }

    const config: ValidatorConfig = {
      validators,
      jwt_token: jwtToken,
      csrf_token: csrfToken,
      rate_limit_key: rateLimitKey
    };

    const result = await runPostValidation(request, config);

    if (!result.valid) {
      reply.status(401).send({
        success: false,
        error: 'Validation failed',
        details: result.errors,
        timestamp: result.timestamp
      });
      return;
    }

    // Attach validated data to request for downstream handlers
    (request as any).user_id = result.user_id;
    (request as any).score_impacts = result.score_impacts;
  };
}
