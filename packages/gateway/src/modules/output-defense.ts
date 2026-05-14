/**
 * Output-Side Injection Defense
 *
 * While the model streams its response back, watch for patterns that
 * indicate either a successful prompt-injection (system-prompt leakage,
 * exfiltration markers, refusal bypass), or accidental leakage of
 * secrets (API keys, tokens, credit cards) that should never reach the
 * client.
 *
 * When detected, the stream is **cut mid-flight** and replaced with a
 * sanitised completion notice. The original (un-sent) text is logged
 * for audit.
 *
 * Modes (env OUTPUT_DEFENSE_MODE):
 *   - off    → no scanning
 *   - tag    → emit metadata.outputLeak warning but pass everything through
 *   - cut    → stop the stream at the first leak, replace with a notice
 */
import { logger } from '../observability/logger.js';

export type OutputDefenseMode = 'off' | 'tag' | 'cut';

interface OutputPattern {
  id: string;
  category: 'secret_leak' | 'system_prompt_echo' | 'exfil_call' | 'tool_misuse';
  severity: 'low' | 'medium' | 'high' | 'critical';
  pattern: RegExp;
  description: string;
}

const OUTPUT_PATTERNS: readonly OutputPattern[] = [
  // ─── Secret leakage (model accidentally emits credentials) ─────────────
  { id: 'aws-key-leak', category: 'secret_leak', severity: 'critical',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    description: 'AWS access key ID in output' },
  { id: 'github-token-leak', category: 'secret_leak', severity: 'critical',
    pattern: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{30,}\b/,
    description: 'GitHub token in output' },
  { id: 'private-key-leak', category: 'secret_leak', severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/,
    description: 'PEM private-key header in output' },
  { id: 'jwt-leak', category: 'secret_leak', severity: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{30,}\b/,
    description: 'JWT token in output' },

  // ─── System-prompt echoing (injection succeeded) ───────────────────────
  { id: 'sysprompt-echo-hint', category: 'system_prompt_echo', severity: 'high',
    pattern: /(?:my\s+system\s+prompt\s+is|i\s+was\s+instructed\s+to|my\s+initial\s+instructions?\s+(?:are|were))/i,
    description: 'Model echoing back its system prompt' },
  { id: 'role-disclosure', category: 'system_prompt_echo', severity: 'medium',
    pattern: /^(?:as\s+a\s+(?:GPT|Claude|language\s+model)|i\s+am\s+(?:an?\s+)?AI\s+(?:assistant|model)\s+(?:created|developed)\s+by)/im,
    description: 'Identity disclosure that suggests system-prompt leak' },

  // ─── Exfiltration call patterns (LLM is being instructed to send data out) ─
  { id: 'exfil-image', category: 'exfil_call', severity: 'high',
    pattern: /!\[[^\]]*\]\(https?:\/\/[^)]*\?[^)]*(?:data|secret|key|token|password|prompt|message)=/,
    description: 'Markdown image with secret-bearing URL (exfil)' },
  { id: 'exfil-fetch', category: 'exfil_call', severity: 'high',
    pattern: /(?:fetch|http\.get|curl|wget|requests\.get|axios\.get)\s*\(\s*['"]https?:\/\/[^'"]*[?&](?:data|secret|key|token|prompt|conversation)=/i,
    description: 'Code snippet that fetches a URL with sensitive data in query' },
];

const SEVERITY_WEIGHT = { low: 10, medium: 30, high: 60, critical: 100 };

export interface OutputScanResult {
  detected: boolean;
  score: number;
  matches: Array<{ id: string; category: OutputPattern['category']; severity: OutputPattern['severity']; description: string }>;
  /** If we cut, where in the stream we cut */
  cutAtChar: number | null;
}

/**
 * Scan a chunk of output text for any leak pattern. Returns the highest
 * severity match (if any). Designed to be called incrementally during
 * streaming on a rolling window of recently emitted text.
 */
export function scanOutput(text: string): OutputScanResult {
  if (!text || text.length < 4) {
    return { detected: false, score: 0, matches: [], cutAtChar: null };
  }
  const matches: OutputScanResult['matches'] = [];
  let earliestCut: number | null = null;
  for (const p of OUTPUT_PATTERNS) {
    const m = p.pattern.exec(text);
    if (m) {
      matches.push({
        id: p.id,
        category: p.category,
        severity: p.severity,
        description: p.description,
      });
      if (earliestCut === null || (m.index ?? 0) < earliestCut) {
        earliestCut = m.index ?? 0;
      }
    }
  }
  const score = Math.min(100, matches.reduce((acc, m) => acc + SEVERITY_WEIGHT[m.severity], 0));
  return {
    detected: score >= 60,
    score,
    matches,
    cutAtChar: earliestCut,
  };
}

export function getOutputDefenseMode(): OutputDefenseMode {
  const v = (process.env['OUTPUT_DEFENSE_MODE'] ?? 'off').toLowerCase();
  if (v === 'tag' || v === 'cut') return v;
  return 'off';
}

export const REDACTED_NOTICE = '\n\n⚠ [Adaptive LLM Gateway] Response cut: potential data leak detected by output-defense layer. See audit log for details.';

/**
 * Stream wrapper. Wraps an async iterator of text chunks and returns a
 * new iterator that yields chunks but cuts (or tags) on detection.
 *
 * Usage:
 *   for await (const chunk of guardOutputStream(upstreamIter)) {
 *     send_to_client(chunk);
 *   }
 */
export async function* guardOutputStream(
  source: AsyncIterable<string>,
  opts: { mode?: OutputDefenseMode; windowChars?: number; onDetect?: (r: OutputScanResult, accumulated: string) => void } = {},
): AsyncGenerator<string, void, unknown> {
  const mode = opts.mode ?? getOutputDefenseMode();
  if (mode === 'off') {
    for await (const chunk of source) yield chunk;
    return;
  }
  const windowChars = opts.windowChars ?? 2000;
  let buffer = '';
  let cut = false;
  for await (const chunk of source) {
    if (cut) break;
    buffer += chunk;
    // Keep only the last `windowChars` for scanning to limit memory
    const scanText = buffer.slice(-windowChars);
    const result = scanOutput(scanText);
    if (result.detected) {
      opts.onDetect?.(result, buffer);
      if (mode === 'cut') {
        // Yield up to where the issue started (offset in scan window)
        const safePart = buffer.slice(0, buffer.length - scanText.length + (result.cutAtChar ?? scanText.length));
        if (safePart.length > 0 && safePart !== buffer.slice(0, -chunk.length)) {
          yield safePart.slice(buffer.length - chunk.length - (buffer.length - safePart.length));
        }
        yield REDACTED_NOTICE;
        logger.warn({ matches: result.matches, score: result.score }, 'Output-defense cut stream');
        cut = true;
        break;
      } else {
        // tag mode: pass through but log
        logger.warn({ matches: result.matches, score: result.score }, 'Output-defense tagged response');
      }
    }
    yield chunk;
  }
}
