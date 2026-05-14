import { describe, it, expect } from 'vitest';
import { validateJWT, validateJWTAlgorithm } from '../jwt-validator.js';

describe('JWT Validator', () => {
  describe('validateJWTAlgorithm', () => {
    it('should allow RS256', () => {
      expect(validateJWTAlgorithm('RS256')).toBe(true);
    });

    it('should allow HS256', () => {
      expect(validateJWTAlgorithm('HS256')).toBe(true);
    });

    it('should reject none algorithm', () => {
      expect(validateJWTAlgorithm('none')).toBe(false);
    });

    it('should reject HS512', () => {
      expect(validateJWTAlgorithm('HS512')).toBe(false);
    });

    it('should reject unknown algorithms', () => {
      expect(validateJWTAlgorithm('XYZ')).toBe(false);
    });
  });

  describe('validateJWT', () => {
    it('should reject empty token', async () => {
      const result = await validateJWT('');
      expect(result.passed).toBe(false);
      expect(result.score_impact).toBe(-2.0);
      expect(result.errors).toContain('No JWT token provided');
    });

    it('should reject malformed JWT (wrong part count)', async () => {
      const result = await validateJWT('invalid.jwt');
      expect(result.passed).toBe(false);
      expect(result.score_impact).toBe(-2.0);
      expect(result.errors.some((e) => e.includes('3 parts'))).toBe(true);
    });

    it('should reject JWT without algorithm in header', async () => {
      const headerWithoutAlg = Buffer.from(JSON.stringify({ typ: 'JWT' })).toString('base64');
      const token = `${headerWithoutAlg}.payload.signature`;
      const result = await validateJWT(token);
      expect(result.passed).toBe(false);
      expect(result.errors).toContain('Missing algorithm in JWT header');
    });

    it('should reject JWT with disallowed algorithm', async () => {
      const headerWithHS512 = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64');
      const token = `${headerWithHS512}.payload.signature`;
      const result = await validateJWT(token);
      expect(result.passed).toBe(false);
      expect(result.errors.some((e) => e.includes('not allowed'))).toBe(true);
    });

    it('should reject JWT with none algorithm', async () => {
      const headerWithNone = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64');
      const token = `${headerWithNone}.payload.`;
      const result = await validateJWT(token);
      expect(result.passed).toBe(false);
      expect(result.errors.some((e) => e.includes('not allowed'))).toBe(true);
    });

    it('should return appropriate score impact on failure', async () => {
      const result = await validateJWT('invalid.token.format');
      expect(result.score_impact).toBe(-1.5);
    });
  });
});
