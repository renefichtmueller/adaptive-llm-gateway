/**
 * KeywordTrie — O(n) multi-keyword scanner with word boundary detection
 * Adapted from mnfst/manifest router (MIT licensed).
 *
 * Builds a trie from dimension keyword lists, then scans text in a single
 * pass to find all matches. Supports density bonuses when multiple matches
 * from the same dimension cluster within a window.
 */

const MAX_SCAN_LENGTH = 100_000;
const DENSITY_WINDOW = 200;
const DENSITY_THRESHOLD = 3;
const DENSITY_MULTIPLIER = 1.5;

// ── Types ──────────────────────────────────────────────────────────────────

export interface TrieMatch {
  readonly keyword: string;
  readonly dimension: string;
  readonly position: number;
}

export interface DimensionMatches {
  readonly dimension: string;
  readonly matches: readonly TrieMatch[];
  readonly rawCount: number;
  readonly densityMultiplier: number;
  readonly effectiveCount: number;
}

interface TrieNode {
  readonly children: Map<number, TrieNode>;
  readonly outputs: ReadonlyArray<{ readonly keyword: string; readonly dimension: string }>;
}

function createNode(): TrieNode {
  return { children: new Map(), outputs: [] };
}

// ── KeywordTrie ────────────────────────────────────────────────────────────

export class KeywordTrie {
  private readonly root: TrieNode = createNode();

  /**
   * Build the trie from a map of dimension name -> keyword list.
   * All keywords are lowercased during insertion.
   */
  constructor(dimensions: ReadonlyMap<string, readonly string[]>) {
    for (const [dimension, keywords] of dimensions) {
      for (const keyword of keywords) {
        this.insert(keyword.toLowerCase(), dimension);
      }
    }
  }

  private insert(keyword: string, dimension: string): void {
    let node = this.root;
    for (let i = 0; i < keyword.length; i++) {
      const code = keyword.charCodeAt(i);
      let child = node.children.get(code);
      if (!child) {
        child = createNode();
        (node.children as Map<number, TrieNode>).set(code, child);
      }
      node = child;
    }
    (node.outputs as Array<{ keyword: string; dimension: string }>).push({ keyword, dimension });
  }

  /**
   * Scan text for all keyword matches, respecting word boundaries.
   * Returns raw matches — call `aggregate()` for dimension-level results.
   */
  scan(text: string): readonly TrieMatch[] {
    const input = text.toLowerCase().slice(0, MAX_SCAN_LENGTH);
    const matches: TrieMatch[] = [];
    const len = input.length;

    for (let start = 0; start < len; start++) {
      // Word boundary check: the character before `start` must be
      // a non-word character (or start == 0).
      if (start > 0 && isWordChar(input.charCodeAt(start - 1))) {
        continue;
      }

      let node = this.root;
      for (let pos = start; pos < len; pos++) {
        const code = input.charCodeAt(pos);
        const child = node.children.get(code);
        if (!child) break;
        node = child;

        if (node.outputs.length > 0) {
          // Word boundary check: the character after the match end must be
          // a non-word character (or end of string).
          const afterEnd = pos + 1;
          if (afterEnd < len && isWordChar(input.charCodeAt(afterEnd))) {
            continue;
          }
          for (const output of node.outputs) {
            matches.push({
              keyword: output.keyword,
              dimension: output.dimension,
              position: start,
            });
          }
        }
      }
    }

    return matches;
  }

  /**
   * Aggregate raw matches into per-dimension results with density bonuses.
   * If 3+ matches from the same dimension occur within a 200-char window,
   * a 1.5x multiplier is applied to that dimension's effective count.
   */
  aggregate(matches: readonly TrieMatch[]): ReadonlyMap<string, DimensionMatches> {
    const byDimension = new Map<string, TrieMatch[]>();

    for (const match of matches) {
      let list = byDimension.get(match.dimension);
      if (!list) {
        list = [];
        byDimension.set(match.dimension, list);
      }
      list.push(match);
    }

    const result = new Map<string, DimensionMatches>();

    for (const [dimension, dimMatches] of byDimension) {
      const multiplier = computeDensityMultiplier(dimMatches);
      result.set(dimension, {
        dimension,
        matches: dimMatches,
        rawCount: dimMatches.length,
        densityMultiplier: multiplier,
        effectiveCount: dimMatches.length * multiplier,
      });
    }

    return result;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isWordChar(code: number): boolean {
  // a-z, A-Z, 0-9, _
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) ||  // A-Z
    (code >= 48 && code <= 57) ||  // 0-9
    code === 95                    // _
  );
}

/**
 * Check if any sliding window of DENSITY_WINDOW chars contains
 * DENSITY_THRESHOLD or more matches. If so, return DENSITY_MULTIPLIER.
 */
function computeDensityMultiplier(matches: readonly TrieMatch[]): number {
  if (matches.length < DENSITY_THRESHOLD) return 1.0;

  // Sort by position
  const sorted = [...matches].sort((a, b) => a.position - b.position);

  for (let i = 0; i <= sorted.length - DENSITY_THRESHOLD; i++) {
    const windowStart = sorted[i]!.position;
    const windowEnd = windowStart + DENSITY_WINDOW;
    let count = 0;

    for (let j = i; j < sorted.length; j++) {
      if (sorted[j]!.position <= windowEnd) {
        count++;
      } else {
        break;
      }
    }

    if (count >= DENSITY_THRESHOLD) {
      return DENSITY_MULTIPLIER;
    }
  }

  return 1.0;
}
