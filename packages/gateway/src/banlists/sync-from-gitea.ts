// Sync ban list additions from Gitea CSV
// CSV format: term,category,language,wholeWord
// URL: process.env['BANLIST_SOURCE_URL'] or 'https://your-org.github.io/banlists/'

import { logger } from '../observability/logger.js';

const GITEA_BASE =
  'process.env['BANLIST_SOURCE_URL'] or 'https://your-org.github.io/banlists/'';

export interface GiteaBanEntry {
  term: string;
  category: string;
  language: 'en' | 'de' | 'auto';
  wholeWord: boolean;
}

let syncedEntries: GiteaBanEntry[] = [];
let lastSyncAt: Date | null = null;
const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function parseCSV(raw: string): GiteaBanEntry[] {
  const lines = raw.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const entries: GiteaBanEntry[] = [];

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
  const url = `${GITEA_BASE}${filename}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from Gitea`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function syncBanlistsFromGitea(): Promise<GiteaBanEntry[]> {
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

    const entries: GiteaBanEntry[] = [];

    if (enCsv.status === 'fulfilled') {
      entries.push(...parseCSV(enCsv.value));
    } else {
      logger.warn({ reason: enCsv.reason }, 'Failed to fetch en-additions.csv from Gitea');
    }

    if (deCsv.status === 'fulfilled') {
      entries.push(...parseCSV(deCsv.value));
    } else {
      logger.warn({ reason: deCsv.reason }, 'Failed to fetch de-additions.csv from Gitea');
    }

    if (autoCsv.status === 'fulfilled') {
      entries.push(...parseCSV(autoCsv.value));
    } else {
      logger.warn({ reason: autoCsv.reason }, 'Failed to fetch auto-additions.csv from Gitea');
    }

    syncedEntries = entries;
    lastSyncAt = now;
    logger.info({ count: entries.length }, 'Ban list synced from Gitea');
  } catch (err) {
    logger.error({ err }, 'Failed to sync ban lists from Gitea');
  }

  return syncedEntries;
}

export function getGiteaEntries(): GiteaBanEntry[] {
  return syncedEntries;
}

// Trigger background sync without blocking
export function triggerBackgroundSync(): void {
  syncBanlistsFromGitea().catch((err) => {
    logger.warn({ err }, 'Background ban list sync failed');
  });
}
