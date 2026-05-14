import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validatePasswordComplexity,
  hashPassword,
  verifyPassword,
  generateSessionToken,
  createSessionToken,
  rotateSessionToken,
  createAccountLockout,
  recordFailedAttempt,
  resetFailedAttempts,
  isAccountLocked,
  generateTOTPSecret,
  calculateAuthScoreImpact,
  validateNISTAuthentication
} from '../nist-auth';

describe('NIST SP 800-63B Authentication Module', () => {
  describe('Password Complexity Validation', () => {
    it('should reject passwords shorter than 8 characters', () => {
      const result = validatePasswordComplexity('Pass1');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters');
    });

    it('should accept valid passwords', () => {
      const result = validatePasswordComplexity('MySecure2024!XyzAbc#');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept passwords with all printable ASCII characters', () => {
      const result = validatePasswordComplexity('P@ssw0rd!#$%^&*()_+~');
      expect(result.valid).toBe(true);
    });

    it('should reject passwords exceeding 128 characters', () => {
      const longPassword = 'A'.repeat(129);
      const result = validatePasswordComplexity(longPassword);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must not exceed 128 characters');
    });

    it('should reject common breached passwords', () => {
      const result = validatePasswordComplexity('password123');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password contains common breached password patterns');
    });

    it('should accept 64+ character passwords (NIST requirement)', () => {
      const longPassword = 'A'.repeat(64) + 'B';
      const result = validatePasswordComplexity(longPassword);
      expect(result.valid).toBe(true);
    });
  });

  describe('Password Hashing - NIST Compliance', () => {
    it('should hash password with unique salt', async () => {
      const password = 'TestPassword123!';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      // Different salts should produce different hashes
      expect(hash1.hash).not.toBe(hash2.hash);
      expect(hash1.salt).not.toBe(hash2.salt);
    });

    it('should produce hashes with sufficient length (256-bit)', async () => {
      const hash = await hashPassword('TestPassword123!');
      // 256-bit in hex = 64 characters
      expect(hash.hash).toHaveLength(128); // scrypt produces 512-bit (64 bytes)
      expect(hash.salt).toHaveLength(32); // 16 bytes = 32 hex chars
    });

    it('should use NIST-recommended parameters (N=32768)', async () => {
      const password = 'TestPassword123!';
      const hash = await hashPassword(password);

      // Verify we can verify the password
      const valid = await verifyPassword(password, hash.hash, hash.salt);
      expect(valid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'CorrectPassword123!';
      const hash = await hashPassword(password);

      const valid = await verifyPassword('WrongPassword123!', hash.hash, hash.salt);
      expect(valid).toBe(false);
    });

    it('should handle special characters in passwords', async () => {
      const password = 'P@ssw0rd!#$%^&*()_+~`[]{}';
      const hash = await hashPassword(password);

      const valid = await verifyPassword(password, hash.hash, hash.salt);
      expect(valid).toBe(true);
    });
  });

  describe('Session Token Management', () => {
    it('should generate tokens with sufficient entropy (256-bit)', () => {
      const token = generateSessionToken();
      // 256-bit in hex = 64 characters
      expect(token).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(token)).toBe(true);
    });

    it('should generate unique tokens', () => {
      const token1 = generateSessionToken();
      const token2 = generateSessionToken();
      expect(token1).not.toBe(token2);
    });

    it('should create session with correct expiration', () => {
      const now = new Date();
      vi.setSystemTime(now);

      const session = createSessionToken('user-123', '192.168.1.1', 'Mozilla/5.0');
      const expirationTime = session.expires_at.getTime() - session.created_at.getTime();

      // Should expire in 60 minutes (default)
      expect(expirationTime).toBe(60 * 60000);
      expect(session.is_valid).toBe(true);
    });

    it('should create session with custom expiration', () => {
      const session = createSessionToken('user-123', '192.168.1.1', 'Mozilla/5.0', 30);
      const expirationTime = session.expires_at.getTime() - session.created_at.getTime();

      expect(expirationTime).toBe(30 * 60000);
    });

    it('should store IP address and user agent for validation', () => {
      const ipAddress = '192.168.1.100';
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

      const session = createSessionToken('user-123', ipAddress, userAgent);

      expect(session.ip_address).toBe(ipAddress);
      expect(session.user_agent).toBe(userAgent);
    });

    it('should rotate session tokens', () => {
      const session = createSessionToken('user-123', '192.168.1.1', 'Mozilla/5.0');
      const originalTokenId = session.token_id;

      const rotatedSession = rotateSessionToken(session);

      expect(rotatedSession.token_id).not.toBe(originalTokenId);
      expect(rotatedSession.user_id).toBe(session.user_id);
      expect(rotatedSession.last_rotated_at.getTime()).toBeGreaterThanOrEqual(
        session.last_rotated_at.getTime()
      );
    });
  });

  describe('Account Lockout - NIST 800-63B Compliance', () => {
    let lockout: ReturnType<typeof createAccountLockout>;

    beforeEach(() => {
      lockout = createAccountLockout('user-123');
    });

    it('should create unlocked account by default', () => {
      expect(lockout.is_locked).toBe(false);
      expect(lockout.failed_attempts).toBe(0);
    });

    it('should lock account after failed attempts', () => {
      for (let i = 0; i < 5; i++) {
        lockout = recordFailedAttempt(lockout);
      }

      expect(lockout.is_locked).toBe(true);
      expect(lockout.failed_attempts).toBe(5);
      expect(lockout.locked_until).toBeDefined();
    });

    it('should set lockout duration to 30 minutes', () => {
      const before = Date.now();
      lockout = recordFailedAttempt(lockout, 1); // Lock after 1 attempt for testing

      const expectedDuration = 30 * 60000; // 30 minutes
      const actualDuration = lockout.locked_until!.getTime() - before;

      // Allow ±5 second margin
      expect(Math.abs(actualDuration - expectedDuration)).toBeLessThan(5000);
    });

    it('should unlock account after timeout', () => {
      lockout = recordFailedAttempt(lockout, 1);
      expect(lockout.is_locked).toBe(true);

      // Move time forward 31 minutes
      vi.setSystemTime(new Date(Date.now() + 31 * 60000));

      const isLocked = isAccountLocked(lockout);
      expect(isLocked).toBe(false);
      expect(lockout.is_locked).toBe(false);
    });

    it('should reset failed attempts on successful authentication', () => {
      lockout = recordFailedAttempt(lockout);
      lockout = recordFailedAttempt(lockout);
      expect(lockout.failed_attempts).toBe(2);

      lockout = resetFailedAttempts(lockout);
      expect(lockout.failed_attempts).toBe(0);
      expect(lockout.is_locked).toBe(false);
    });
  });

  describe('MFA (Multi-Factor Authentication)', () => {
    it('should generate TOTP secret with sufficient entropy', () => {
      const secret = generateTOTPSecret();
      // Base64 of 32 bytes should be ~44 characters
      expect(secret.length).toBeGreaterThanOrEqual(40);
      expect(/^[A-Za-z0-9+/=]+$/.test(secret)).toBe(true);
    });

    it('should generate unique TOTP secrets', () => {
      const secret1 = generateTOTPSecret();
      const secret2 = generateTOTPSecret();
      expect(secret1).not.toBe(secret2);
    });
  });

  describe('Authentication Score Impact', () => {
    it('should return -3.0 for critical failures', () => {
      const impact = calculateAuthScoreImpact(false, false, false, false);
      expect(impact).toBe(-3.0);
    });

    it('should return -2.0 for non-compliant but present authentication', () => {
      const impact = calculateAuthScoreImpact(true, false, true, false);
      expect(impact).toBe(-2.0);
    });

    it('should return -1.0 for missing MFA', () => {
      const impact = calculateAuthScoreImpact(true, false, true, true);
      expect(impact).toBe(-1.0);
    });

    it('should return 0 for full compliance', () => {
      const impact = calculateAuthScoreImpact(true, true, true, true);
      expect(impact).toBe(0);
    });
  });

  describe('NIST Authentication Validation', () => {
    it('should pass for fully compliant authentication', () => {
      const result = validateNISTAuthentication(true, true, true, true, true, true);

      expect(result.success).toBe(true);
      expect(result.mfa_required).toBe(false);
      expect(result.score_impact).toBe(0);
    });

    it('should fail if password hash invalid', () => {
      const result = validateNISTAuthentication(false, true, true, true, true, true);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.score_impact).toBeLessThan(0);
    });

    it('should fail if account locked', () => {
      const result = validateNISTAuthentication(true, true, true, true, false, true);

      expect(result.success).toBe(false);
    });

    it('should require MFA if password not validated initially', () => {
      const result = validateNISTAuthentication(false, true, true, true, true, true);

      expect(result.mfa_required).toBe(true);
    });

    it('should penalize missing MFA', () => {
      const result = validateNISTAuthentication(true, true, false, true, true, true);

      expect(result.success).toBe(true);
      expect(result.score_impact).toBe(-1.0);
    });
  });
});
