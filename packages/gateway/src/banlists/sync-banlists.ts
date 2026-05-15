// Sync ban list additions from a remote CSV source
// CSV format: term,category,language,wholeWord
// URL: set BANLIST_SOURCE_URL env var; default points at a placeholder.

import { logger } from '../observability/logger.js';

const BANLIST_SOURCE_URL = process.env['BANLIST_SOURCE_URL'] ?? 'https://example.invalid/banlists/';

export interface BanlistEntry {
  term: string;
  category: string;
  language: 'en' | 'de' | 'auto';
  wholeWord: boolean;
}

let syncedEntries: BanlistEntry[] = [];
let lastSyncAt: Date | null = null;
const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function parseCSV(raw: string): BanlistEntry[] {
  const lines = raw.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const entries: BanlistEntry[] = [];

  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 4) continue;

    const term = (parts[0] ?? '').trim().replace(/^"|"$/g, '');
    const category = (parts[1] ?? '').trim();
    const language = (parts[2] ?? '').trim() as 'en' | 'de' | 'auto';
    const wholeWord = (parts[3] ?? '').trim().toLowerCase() === 'true';

    if (term && ['en', 'de', 'auto'].includes(language)) {
      entries.push({ term, category, language, wholeWord });
    }
  }

  return entries;
}

async function fetchCsv(filename: string): Promise<string> {
  const url = `${BANLIST_SOURCE_URL}${filename}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from remote source`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function syncBanlists(): Promise<BanlistEntry[]> {
  const now = new Date();
  if (lastSyncAt && now.getTime() - lastSyncAt.getTime() < SYNC_INTERVAL_MS) {
    return syncedEntries;
  }

  try {
    const [enCsv, deCsv, autoCsv] = await Promise.allSettled([
      fetchCsv('en-additions.csv'),
      fetchCsv('de-additions.csv'),
      fetchCsv('auto-additions.csv'),
    ]);

    const entries: BanlistEntry[] = [];

    if (enCsv.status === 'fulfilled') {
      entries.push(...parseCSV(enCsv.value));
    } else {
      logger.warn({ reason: enCsv.reason }, 'Failed to fetch en-additions.csv from remote source');
    }

    if (deCsv.status === 'fulfilled') {
      entries.push(...parseCSV(deCsv.value));
    } else {
      logger.warn({ reason: deCsv.reason }, 'Failed to fetch de-additions.csv from remote source');
    }

    if (autoCsv.status === 'fulfilled') {
      entries.push(...parseCSV(autoCsv.value));
    } else {
      logger.warn({ reason: autoCsv.reason }, 'Failed to fetch auto-additions.csv from remote source');
    }

    syncedEntries = entries;
    lastSyncAt = now;
    logger.info({ count: entries.length }, 'Ban list synced from remote source');
  } catch (err) {
    logger.error({ err }, 'Failed to sync ban lists from remote source');
  }

  return syncedEntries;
}

export function getBanlistEntries(): BanlistEntry[] {
  return syncedEntries;
}

// Trigger background sync without blocking
export function triggerBackgroundSync(): void {
  syncBanlists().catch((err) => {
    logger.warn({ err }, 'Background ban list sync failed');
  });
}
