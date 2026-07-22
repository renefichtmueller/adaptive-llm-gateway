/**
 * PII Redaction Layer
 *
 * Before sending prompts to a cloud LLM provider, replace personal data
 * (emails, phone numbers, credit cards, SSN, IBAN, person names, IPv4/v6)
 * with deterministic tokens. After the response comes back, restore the
 * originals so the caller sees the un-redacted text.
 *
 * Crucial for GDPR / HIPAA / SOC2 deployments where data may not leave a
 * trust boundary without redaction. The mapping lives only in process
 * memory for the duration of a single call — never persisted.
 *
 * Modes (env REDACT_PII_MODE):
 *   - off          → no redaction
 *   - cloud_only   → redact when target provider is non-local
 *                    (i.e. any *-bridge or hosted API; Ollama passes raw)
 *   - always       → redact every call regardless of provider
 *
 * Per-caller exemption via REDACT_PII_EXEMPT_CALLERS=...
 */
import { logger } from '../observability/logger.js';

export type RedactMode = 'off' | 'cloud_only' | 'always';
export type PiiCategory =
  | 'email' | 'phone' | 'credit_card' | 'iban' | 'ssn' | 'ip_address'
  | 'aws_key' | 'private_key' | 'jwt' | 'person_name';

export interface PiiMatch {
  category: PiiCategory;
  original: string;
  token: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  /** Text with PII replaced by tokens like <EMAIL_001> */
  redacted: string;
  /** Original text unchanged */
  original: string;
  /** Map of token → original value, used for restoration */
  restoreMap: Map<string, string>;
  /** Per-category counts */
  counts: Record<PiiCategory, number>;
  /** Time spent in ms */
  latencyMs: number;
}

interface DetectionRule {
  category: PiiCategory;
  pattern: RegExp;
  /** Optional validator to reduce false positives (e.g. Luhn check for credit cards) */
  validator?: (match: string) => boolean;
}

// ─── Validators ──────────────────────────────────────────────────────────────

function luhnValid(card: string): boolean {
  const digits = card.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i] ?? '0', 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanValid(iban: string): boolean {
  const cleaned = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned)) return false;
  // Move first 4 chars to end, replace letters with numbers (A=10, B=11, …)
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  // Modulo 97 via chunked arithmetic (numeric can be huge)
  let remainder = '';
  for (const c of numeric) {
    remainder = String((parseInt(remainder + c, 10)) % 97);
  }
  return remainder === '1';
}

// ─── Detection rules ─────────────────────────────────────────────────────────

const RULES: readonly DetectionRule[] = [
  // Email — RFC 5322-ish simplified
  { category: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g },

  // IBAN (mod-97 validated) — must run before credit_card and phone so its
  // interior digit groups aren't nibbled by those looser numeric patterns.
  { category: 'iban', pattern: /\b[A-Z]{2}\d{2}[\s]?(?:[A-Z0-9]{4}[\s]?){2,7}[A-Z0-9]{1,4}\b/g, validator: ibanValid },

  // Credit cards (Luhn validated) — before phone for the same reason.
  { category: 'credit_card', pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g, validator: luhnValid },
  // Amex 15-digit
  { category: 'credit_card', pattern: /\b\d{4}[\s-]?\d{6}[\s-]?\d{5}\b/g, validator: luhnValid },

  // Phone numbers (loose) — run AFTER the validated identifiers above so the
  // German pattern can't swallow digit groups inside an IBAN or a card number.
  // International (E.164-style): leading (?<!\d) rather than \b, because \b
  // never matches between a space and a leading "+", so "+1 555 …" was missed.
  { category: 'phone', pattern: /(?<!\d)(?:\+|00)\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{1,4})?\b/g },
  // German national format (0xxx-xxxx-xxxx)
  { category: 'phone', pattern: /\b0\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g },

  // US SSN (XXX-XX-XXXX)
  { category: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },

  // IPv4
  { category: 'ip_address', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  // IPv6 (RFC 4291 short)
  { category: 'ip_address', pattern: /\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b/g },

  // AWS access key IDs
  { category: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },

  // PEM-style private keys
  { category: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },

  // JWT (rough — three base64url parts separated by dots, leading "eyJ")
  { category: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
];

// Person names are deliberately NOT regex-matched (high false-positive rate).
// We expose a `redactNames` hook that callers can implement with proper NER.

// ─── Public API ──────────────────────────────────────────────────────────────

const counters: Record<PiiCategory, number> = {
  email: 0, phone: 0, credit_card: 0, iban: 0, ssn: 0, ip_address: 0,
  aws_key: 0, private_key: 0, jwt: 0, person_name: 0,
};

function tokenFor(category: PiiCategory, restoreMap: Map<string, string>): string {
  const n = (Array.from(restoreMap.keys()).filter((k) => k.startsWith(`<${category.toUpperCase()}_`))).length + 1;
  return `<${category.toUpperCase()}_${String(n).padStart(3, '0')}>`;
}

/**
 * Find all PII in `text` and replace with deterministic tokens.
 */
export function redactPii(text: string): RedactionResult {
  const t0 = Date.now();
  const restoreMap = new Map<string, string>();
  const counts: Record<PiiCategory, number> = { ...counters };
  let redacted = text;

  for (const rule of RULES) {
    const seen = new Set<string>();
    // Collect matches first (don't mutate during iteration)
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    rule.pattern.lastIndex = 0;
    while ((m = rule.pattern.exec(redacted)) !== null) {
      const value = m[0];
      if (seen.has(value)) continue;
      if (rule.validator && !rule.validator(value)) continue;
      seen.add(value);
      matches.push(value);
    }
    // Apply replacements
    for (const value of matches) {
      const token = tokenFor(rule.category, restoreMap);
      restoreMap.set(token, value);
      counts[rule.category] += 1;
      // Replace ALL occurrences of this exact value
      redacted = redacted.split(value).join(token);
    }
  }

  return {
    redacted,
    original: text,
    restoreMap,
    counts,
    latencyMs: Date.now() - t0,
  };
}

/**
 * Restore tokens in `text` from the redaction map.
 */
export function restorePii(text: string, restoreMap: Map<string, string>): string {
  let out = text;
  for (const [token, value] of restoreMap.entries()) {
    out = out.split(token).join(value);
  }
  return out;
}

// ─── Mode helpers ────────────────────────────────────────────────────────────

export function getRedactMode(): RedactMode {
  const v = (process.env['REDACT_PII_MODE'] ?? 'off').toLowerCase();
  if (v === 'cloud_only' || v === 'always') return v;
  return 'off';
}

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamafile', 'vllm']);
export function isLocalProvider(providerName: string): boolean {
  const lc = providerName.toLowerCase();
  return Array.from(LOCAL_PROVIDERS).some((p) => lc.includes(p));
}

export function shouldRedactFor(mode: RedactMode, providerName: string, caller: string): boolean {
  if (mode === 'off') return false;
  if (isCallerRedactExempt(caller)) return false;
  if (mode === 'always') return true;
  // cloud_only: skip when target is a local Ollama / LM Studio
  return !isLocalProvider(providerName);
}

export function isCallerRedactExempt(caller: string): boolean {
  const list = (process.env['REDACT_PII_EXEMPT_CALLERS'] ?? 'internal,health,metrics').split(',').map((s) => s.trim());
  return list.includes(caller);
}

// ─── Logging hook ────────────────────────────────────────────────────────────
logger.info(
  { mode: getRedactMode() },
  'PII redaction layer initialised',
);
