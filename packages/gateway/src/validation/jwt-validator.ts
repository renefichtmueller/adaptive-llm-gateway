import { jwtVerify } from 'jose';
import { logger } from '../observability/logger.js';

const ALLOWED_ALGORITHMS = ['RS256', 'HS256'] as const;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-in-production';

export interface JWTValidationResult {
  passed: boolean;
  score_impact: number;
  errors: string[];
  decoded?: Record<string, unknown>;
}

export async function validateJWT(token: string): Promise<JWTValidationResult> {
  const errors: string[] = [];

  if (!token) {
    return {
      passed: false,
      score_impact: -2.0,
      errors: ['No JWT token provided'],
    };
  }

  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return {
        passed: false,
        score_impact: -2.0,
        errors: ['Invalid JWT format (expected 3 parts)'],
      };
    }

    const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());

    if (!header.alg) {
      errors.push('Missing algorithm in JWT header');
      return { passed: false, score_impact: -2.0, errors };
    }

    if (!ALLOWED_ALGORITHMS.includes(header.alg)) {
      errors.push(
        `Algorithm "${header.alg}" not allowed. Allowed: ${ALLOWED_ALGORITHMS.join(', ')}`,
      );
      return { passed: false, score_impact: -2.0, errors };
    }

    if (header.alg === 'none') {
      errors.push('Algorithm "none" is not allowed (security risk)');
      return { passed: false, score_impact: -2.0, errors };
    }

    const secret = new TextEncoder().encode(JWT_SECRET);
    const verified = await jwtVerify(token, secret, {
      algorithms: [...ALLOWED_ALGORITHMS],
    } as any);

    return {
      passed: true,
      score_impact: 0,
      errors: [],
      decoded: verified.payload as Record<string, unknown>,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ err, token_prefix: token.slice(0, 20) }, 'JWT validation failed');
    errors.push(`JWT verification failed: ${message}`);

    return {
      passed: false,
      score_impact: -1.5,
      errors,
    };
  }
}

export function validateJWTAlgorithm(algorithm: string): boolean {
  return ALLOWED_ALGORITHMS.includes(algorithm as (typeof ALLOWED_ALGORITHMS)[number]);
}
