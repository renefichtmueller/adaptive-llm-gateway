import { describe, it, expect } from 'vitest';
import { redactPii, restorePii, isLocalProvider, shouldRedactFor } from '../pii-redaction.js';

describe('redactPii — common PII categories', () => {
  it('redacts an email and preserves restoration', () => {
    const r = redactPii('Please contact klaus.mueller@acme.de about order 42.');
    expect(r.redacted).not.toContain('klaus.mueller@acme.de');
    expect(r.redacted).toMatch(/<EMAIL_001>/);
    expect(r.counts.email).toBe(1);
    expect(restorePii(r.redacted, r.restoreMap)).toContain('klaus.mueller@acme.de');
  });

  it('redacts German phone numbers', () => {
    const r = redactPii('Ruf 030-1234-5678 an oder schreib mir.');
    expect(r.redacted).not.toContain('030-1234-5678');
    expect(r.counts.phone).toBeGreaterThanOrEqual(1);
  });

  it('redacts international phone numbers', () => {
    const r = redactPii('Call +1 555 123 4567 or +49 30 12345678');
    expect(r.counts.phone).toBeGreaterThanOrEqual(1);
  });

  it('redacts valid credit card numbers (Luhn check)', () => {
    // 4532-0151-1283-0366 is a valid Luhn test number
    const r = redactPii('Card: 4532-0151-1283-0366. Use it once.');
    expect(r.counts.credit_card).toBe(1);
    expect(r.redacted).toMatch(/<CREDIT_CARD_001>/);
  });

  it('does NOT redact random 16-digit numbers that fail Luhn', () => {
    const r = redactPii('Random sequence: 1234-5678-9012-3456 (not a card)');
    expect(r.counts.credit_card).toBe(0);
  });

  it('redacts IBANs (with mod-97 validation)', () => {
    // DE89 3704 0044 0532 0130 00 is a valid example IBAN
    const r = redactPii('Konto: DE89 3704 0044 0532 0130 00 für Überweisung');
    expect(r.counts.iban).toBe(1);
  });

  it('redacts SSNs', () => {
    const r = redactPii('My SSN is 123-45-6789');
    expect(r.counts.ssn).toBe(1);
  });

  it('redacts IPv4 addresses', () => {
    const r = redactPii('Connect to 10.0.0.42 on port 8080');
    expect(r.counts.ip_address).toBe(1);
  });

  it('redacts AWS keys', () => {
    const r = redactPii('AWS key: AKIAIOSFODNN7EXAMPLE for staging');
    expect(r.counts.aws_key).toBe(1);
  });

  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const r = redactPii(`Here is the key:\n${pem}\nuse carefully`);
    expect(r.counts.private_key).toBe(1);
  });

  it('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = redactPii(`Token: ${jwt}`);
    expect(r.counts.jwt).toBe(1);
  });

  it('handles text with no PII gracefully', () => {
    const r = redactPii('What is the capital of France?');
    expect(r.redacted).toBe('What is the capital of France?');
    expect(r.restoreMap.size).toBe(0);
  });
});

describe('isLocalProvider', () => {
  it('recognises local backends', () => {
    expect(isLocalProvider('ollama')).toBe(true);
    expect(isLocalProvider('lmstudio')).toBe(true);
    expect(isLocalProvider('vllm-prod')).toBe(true);
    expect(isLocalProvider('claude-bridge')).toBe(false);
    expect(isLocalProvider('groq')).toBe(false);
  });
});

describe('shouldRedactFor — mode logic', () => {
  it('off → never redacts', () => {
    expect(shouldRedactFor('off', 'claude-bridge', 'any')).toBe(false);
  });
  it('always → redacts regardless', () => {
    expect(shouldRedactFor('always', 'ollama', 'any')).toBe(true);
  });
  it('cloud_only → skips local', () => {
    expect(shouldRedactFor('cloud_only', 'ollama', 'any')).toBe(false);
    expect(shouldRedactFor('cloud_only', 'claude-bridge', 'any')).toBe(true);
  });
  it('exempt callers are never redacted', () => {
    expect(shouldRedactFor('always', 'claude-bridge', 'internal')).toBe(false);
  });
});
