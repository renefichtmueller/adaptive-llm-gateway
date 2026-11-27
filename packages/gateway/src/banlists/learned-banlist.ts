/**
 * Learned banlist — closes the ban-learner loop.
 *
 * The learning engine promotes frequently detected filler/buzzword phrases
 * into ban_candidates (promoted = true). This module loads those promoted
 * candidates from the database into the active banlist, so what the system
 * learns actually affects validation — without a gateway restart.
 *
 * Refreshes every 30 minutes (and once at boot). Disable with
 * LEARNED_BANLIST_ENABLED=0.
 */
import { logger } from '../observability/logger.js';

const ENABLED = process.env['LEARNED_BANLIST_ENABLED'] !== '0';
const REFRESH_MS = parseInt(process.env['LEARNED_BANLIST_REFRESH_MS'] ?? '1800000', 10); // 30 min

export interface LearnedBanEntry {
  term: string;
  category: string;
  language: 'en' | 'de' | 'auto';
  wholeWord: boolean;
}

type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

let entries: LearnedBanEntry[] = [];
let refreshTimer: NodeJS.Timeout | null = null;

export function getLearnedBanlistEntries(): readonly LearnedBanEntry[] {
  if (!ENABLED) return [];
  return entries;
}

export async function refreshLearnedBanlist(db: PgClient): Promise<{ loaded: number }> {
  if (!ENABLED) return { loaded: 0 };

  try {
    const result = await db.query(
      `SELECT term, category, language
       FROM ban_candidates
       WHERE promoted = true AND rejected = false
       ORDER BY occurrence_count DESC
       LIMIT 500`,
    );

    entries = result.rows.map((r) => ({
      term: String(r['term']),
      category: String(r['category'] ?? 'filler'),
      language: (['en', 'de'].includes(String(r['language'])) ? String(r['language']) : 'auto') as LearnedBanEntry['language'],
      wholeWord: true,
    }));

    logger.info({ terms: entries.length }, 'Learned banlist refreshed from ban_candidates');
    return { loaded: entries.length };
  } catch (err) {
    logger.warn({ err }, 'Learned banlist refresh failed (keeping current entries)');
    return { loaded: 0 };
  }
}

export function scheduleLearnedBanlistRefresh(db: PgClient): void {
  if (!ENABLED) {
    logger.info('Learned banlist disabled (LEARNED_BANLIST_ENABLED=0)');
    return;
  }
  if (refreshTimer) return;
  void refreshLearnedBanlist(db);
  refreshTimer = setInterval(() => {
    void refreshLearnedBanlist(db);
  }, REFRESH_MS);
  logger.info({ refreshMs: REFRESH_MS }, 'Learned banlist refresh scheduled');
}

export function stopLearnedBanlistRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** For tests: replace entries directly. */
export function __setLearnedEntries(newEntries: LearnedBanEntry[]): void {
  entries = newEntries;
}
