import { EN_BANLIST } from '../banlists/en.js';
import { DE_BANLIST } from '../banlists/de.js';
import { AUTO_DETECTED_BANLIST } from '../banlists/auto-detected.js';
import { getBanlistEntries } from '../banlists/sync-banlists.js';

export interface BanViolation {
  term: string;
  category: string;
  language: string;
  position: number;
  context: string;
}

export interface BanlistResult {
  passed: boolean;
  violations: BanViolation[];
  score_penalty: number;
}

const PENALTY_PER_VIOLATION = 1.0;
const MAX_PENALTY = 5.0;
const CONTEXT_WINDOW = 50;

function escapeForRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern(term: string, wholeWord: boolean): RegExp {
  const escaped = escapeForRegex(term);
  const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
  return new RegExp(pattern, 'gi');
}

function extractContext(text: string, position: number): string {
  const start = Math.max(0, position - CONTEXT_WINDOW);
  const end = Math.min(text.length, position + CONTEXT_WINDOW);
  return text.slice(start, end).replace(/\n/g, ' ');
}

function checkList(
  text: string,
  entries: Array<{ term: string; category: string; wholeWord: boolean }>,
  language: string,
): BanViolation[] {
  const violations: BanViolation[] = [];

  for (const entry of entries) {
    const regex = buildPattern(entry.term, entry.wholeWord);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const position = match.index;
      violations.push({
        term: entry.term,
        category: entry.category,
        language,
        position,
        context: extractContext(text, position),
      });
      // Avoid infinite loop on zero-length match
      if (match.index === regex.lastIndex) {
        regex.lastIndex++;
      }
    }
  }

  return violations;
}

export function checkBanlist(
  text: string,
  language: 'en' | 'de' | 'auto' = 'auto',
): BanlistResult {
  const violations: BanViolation[] = [];

  // Always check auto-detected patterns
  violations.push(...checkList(text, AUTO_DETECTED_BANLIST, 'auto'));

  // Language-specific checks
  if (language === 'en' || language === 'auto') {
    violations.push(...checkList(text, EN_BANLIST, 'en'));
  }

  if (language === 'de' || language === 'auto') {
    violations.push(...checkList(text, DE_BANLIST, 'de'));
  }

  // Gitea synced additions
  const giteaEntries = getBanlistEntries();
  const relevantGiteaEntries = giteaEntries.filter(
    (e) => e.language === 'auto' || e.language === language,
  );
  violations.push(...checkList(text, relevantGiteaEntries, 'gitea'));

  // Deduplicate by term+position
  const seen = new Set<string>();
  const unique = violations.filter((v) => {
    const key = `${v.term}:${v.position}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const penalty = Math.min(unique.length * PENALTY_PER_VIOLATION, MAX_PENALTY);

  return {
    passed: unique.length === 0,
    violations: unique,
    score_penalty: -penalty,
  };
}
