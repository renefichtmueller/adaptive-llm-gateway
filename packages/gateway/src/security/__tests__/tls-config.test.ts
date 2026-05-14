import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getTLSConfig,
  loadTLSCertificates,
  validateTLSConfig,
  validateDatabaseSSL,
  validateNoMixedContent,
} from '../tls-config.js';

describe('TLS Configuration Module (CIS 3.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe('getTLSConfig', () => {
    it('should return TLS 1.3 as minimum and maximum version', () => {
      const config = getTLSConfig();
      expect(config.minVersion).toBe('TLSv1.3');
      expect(config.maxVersion).toBe('TLSv1.3');
    });

    it('should include NIST-approved TLS 1.3 ciphers', () => {
      const config = getTLSConfig();
      expect(config.ciphers).toContain('TLS_AES_256_GCM_SHA384');
      expect(config.ciphers).toContain('TLS_CHACHA20_POLY1305_SHA256');
      expect(config.ciphers).toContain('TLS_AES_128_GCM_SHA256');
    });

    it('should set HSTS max-age to 1 year by default', () => {
      const config = getTLSConfig();
      expect(config.hstsMaxAge).toBe(31536000); // 1 year in seconds
    });

    it('should enable HSTS includeSubdomains by default', () => {
      const config = getTLSConfig();
      expect(config.hstIncludeSubdomains).toBe(true);
    });

    it('should enable HSTS preload by default', () => {
      const config = getTLSConfig();
      expect(config.hstsPreload).toBe(true);
    });

    it('should respect TLS_ENABLED environment variable', () => {
      vi.stubEnv('TLS_ENABLED', 'false');
      const config = getTLSConfig();
      expect(config.enabled).toBe(false);
    });

    it('should use custom HSTS max-age from environment', () => {
      vi.stubEnv('HSTS_MAX_AGE', '2592000'); // 30 days
      const config = getTLSConfig();
      expect(config.hstsMaxAge).toBe(2592000);
    });
  });

  describe('validateTLSConfig', () => {
    it('should pass validation for proper TLS 1.3 config', () => {
      const config = {
        enabled: true,
        minVersion: 'TLSv1.3' as const,
        maxVersion: 'TLSv1.3' as const,
        ciphers: ['TLS_AES_256_GCM_SHA384'],
        certificatePath: '/path/to/cert.pem',
        keyPath: '/path/to/key.pem',
        hstsMaxAge: 31536000,
        hstIncludeSubdomains: true,
        hstsPreload: true,
      };

      const errors = validateTLSConfig(config);
      expect(errors).toHaveLength(0);
    });

    it('should reject TLS configuration without certificates when enabled', () => {
      const config = {
        enabled: true,
        minVersion: 'TLSv1.3' as const,
        maxVersion: 'TLSv1.3' as const,
        ciphers: ['TLS_AES_256_GCM_SHA384'],
        hstsMaxAge: 31536000,
        hstIncludeSubdomains: true,
        hstsPreload: true,
      };

      const errors = validateTLSConfig(config);
      expect(errors).toContain('TLS enabled but certificates not configured');
    });

    it('should reject non-TLS 1.3 minimum version', () => {
      const config = {
        enabled: true,
        minVersion: 'TLSv1.2' as any,
        maxVersion: 'TLSv1.3' as const,
        ciphers: ['TLS_AES_256_GCM_SHA384'],
        certificatePath: '/path/to/cert.pem',
        keyPath: '/path/to/key.pem',
        hstsMaxAge: 31536000,
        hstIncludeSubdomains: true,
        hstsPreload: true,
      };

      const errors = validateTLSConfig(config);
      expect(errors).toContain('TLS version must be TLSv1.3 or higher');
    });

    it('should reject empty cipher list', () => {
      const config = {
        enabled: true,
        minVersion: 'TLSv1.3' as const,
        maxVersion: 'TLSv1.3' as const,
        ciphers: [],
        certificatePath: '/path/to/cert.pem',
        keyPath: '/path/to/key.pem',
        hstsMaxAge: 31536000,
        hstIncludeSubdomains: true,
        hstsPreload: true,
      };

      const errors = validateTLSConfig(config);
      expect(errors).toContain('No TLS ciphers configured');
    });
  });

  describe('validateDatabaseSSL', () => {
    it('should pass when DATABASE_URL has sslmode=require', () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost/db?sslmode=require');
      vi.stubEnv('NODE_ENV', 'production');

      const result = validateDatabaseSSL();
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should fail in production without sslmode=require', () => {
      vi.stubEnv(
        'DATABASE_URL',
        'postgresql://user:pass@localhost/db?sslmode=prefer'
      );
      vi.stubEnv('NODE_ENV', 'production');

      const result = validateDatabaseSSL();
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Database SSL mode must be 'require'");
    });

    it('should pass in development with sslmode=prefer', () => {
      vi.stubEnv(
        'DATABASE_URL',
        'postgresql://user:pass@localhost/db?sslmode=prefer'
      );
      vi.stubEnv('NODE_ENV', 'development');

      const result = validateDatabaseSSL();
      expect(result.valid).toBe(true);
    });

    it('should fail when DATABASE_URL is not set', () => {
      vi.stubEnv('DATABASE_URL', undefined as any);

      const result = validateDatabaseSSL();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('DATABASE_URL not set');
    });

    it('should default to sslmode=prefer if not specified', () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost/db');
      vi.stubEnv('NODE_ENV', 'development');

      const result = validateDatabaseSSL();
      expect(result.valid).toBe(true);
    });
  });

  describe('validateNoMixedContent', () => {
    it('should pass when all assets use HTTPS', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const assetUrls = [
        'https://cdn.example.com/script.js',
        'https://cdn.example.com/style.css',
        '/local/asset.js',
        'https://example.com/image.png',
      ];

      const result = await validateNoMixedContent(assetUrls);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect mixed content with HTTP URLs in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const assetUrls = [
        'https://cdn.example.com/script.js',
        'http://cdn.example.com/style.css', // HTTP in production
        'https://example.com/image.png',
      ];

      const result = await validateNoMixedContent(assetUrls);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Mixed content detected: http://cdn.example.com/style.css');
    });

    it('should allow HTTP URLs in development', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const assetUrls = ['http://localhost:3000/script.js', 'http://cdn.local/style.css'];

      const result = await validateNoMixedContent(assetUrls);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect multiple mixed content issues', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const assetUrls = [
        'http://cdn.example.com/script.js',
        'http://fonts.example.com/font.woff',
        'https://example.com/image.png',
      ];

      const result = await validateNoMixedContent(assetUrls);
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(2);
    });
  });

  describe('loadTLSCertificates', () => {
    it('should return null when TLS is disabled', () => {
      const config = {
        enabled: false,
        minVersion: 'TLSv1.3' as const,
        maxVersion: 'TLSv1.3' as const,
        ciphers: ['TLS_AES_256_GCM_SHA384'],
        hstsMaxAge: 31536000,
        hstIncludeSubdomains: true,
        hstsPreload: true,
      };

      const result = loadTLSCertificates(config);
      expect(result).toBeNull();
    });

    it('should return null when certificate paths are not provided', () => {
      const config = {
        enabled: true,
        minVersion: 'TLSv1.3' as const,
        maxVersion: 'TLSv1.3' as const,
        ciphers: ['TLS_AES_256_GCM_SHA384'],
        hstsMaxAge: 31536000,
        hstIncludeSubdomains: true,
        hstsPreload: true,
      };

      const result = loadTLSCertificates(config);
      expect(result).toBeNull();
    });

    it('should throw error when certificate files do not exist', () => {
      const config = {
        enabled: true,
        minVersion: 'TLSv1.3' as const,
        maxVersion: 'TLSv1.3' as const,
        ciphers: ['TLS_AES_256_GCM_SHA384'],
        certificatePath: '/nonexistent/cert.pem',
        keyPath: '/nonexistent/key.pem',
        hstsMaxAge: 31536000,
        hstIncludeSubdomains: true,
        hstsPreload: true,
      };

      expect(() => loadTLSCertificates(config)).toThrow(
        'Failed to load TLS certificates'
      );
    });
  });

  describe('CIS 3.2 Compliance Summary', () => {
    it('should enforce TLS 1.3 only (no TLS 1.2)', () => {
      const config = getTLSConfig();
      expect(config.minVersion).toBe('TLSv1.3');
      expect(config.maxVersion).toBe('TLSv1.3');
    });

    it('should include NIST-approved ciphers', () => {
      const config = getTLSConfig();
      // All ciphers should be TLS 1.3 approved
      const nistApproved = [
        'TLS_AES_256_GCM_SHA384',
        'TLS_AES_128_GCM_SHA256',
        'TLS_CHACHA20_POLY1305_SHA256',
      ];
      expect(config.ciphers.every((c: string) => nistApproved.includes(c))).toBe(true);
    });

    it('should enable HSTS with preload', () => {
      const config = getTLSConfig();
      expect(config.hstIncludeSubdomains).toBe(true);
      expect(config.hstsPreload).toBe(true);
      expect(config.hstsMaxAge).toBeGreaterThanOrEqual(31536000); // At least 1 year
    });

    it('should validate database SSL requirement', () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost/db?sslmode=require');
      vi.stubEnv('NODE_ENV', 'production');

      const result = validateDatabaseSSL();
      expect(result.valid).toBe(true);
    });

    it('should prevent mixed content in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const assetUrls = ['https://example.com/script.js', 'https://example.com/style.css'];

      const result = await validateNoMixedContent(assetUrls);
      expect(result.valid).toBe(true);
    });
  });
});
