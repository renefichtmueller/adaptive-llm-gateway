import { logger } from '../observability/logger.js';

const PEERINGDB_BASE = 'https://www.peeringdb.com/api';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 5000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface PeeringDbOrg {
  id: number;
  name: string;
  website: string;
  social_media: unknown[];
}

interface PeeringDbNet {
  id: number;
  org_id: number;
  org: PeeringDbOrg;
  name: string;
  aka: string;
  website: string;
  asn: number;
  info_type: string;
  info_prefixes4: number;
  info_prefixes6: number;
  policy_general: string;
  status: string;
}

interface PeeringDbIx {
  id: number;
  name: string;
  name_long: string;
  city: string;
  country: string;
  website: string;
  status: string;
}

interface PeeringDbResponse<T> {
  data: T[];
  meta: Record<string, unknown>;
}

// In-memory LRU-style cache (simple map with TTL)
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached<T>(key: string, value: T): void {
  // Evict old entries if cache grows large
  if (cache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) {
        cache.delete(k);
      }
    }
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function fetchPeeringDb<T>(path: string): Promise<PeeringDbResponse<T>> {
  const url = `${PEERINGDB_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'llm-gateway/1.0 (github.com/<your-org>/adaptive-llm-gateway)',
      },
    });

    if (!response.ok) {
      throw new Error(`PeeringDB HTTP ${response.status}`);
    }

    return await response.json() as PeeringDbResponse<T>;
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupAsn(asn: number): Promise<PeeringDbNet | null> {
  const cacheKey = `asn:${asn}`;
  const cached = getCached<PeeringDbNet | null>(cacheKey);
  if (cached !== null || cache.has(cacheKey)) return cached;

  try {
    const result = await fetchPeeringDb<PeeringDbNet>(`/net?asn=${asn}&status=ok&depth=2`);
    const net = result.data[0] ?? null;
    setCached(cacheKey, net);
    return net;
  } catch (err) {
    logger.debug({ err, asn }, 'PeeringDB ASN lookup failed');
    return null;
  }
}

export async function lookupIx(name: string): Promise<PeeringDbIx | null> {
  const cacheKey = `ix:${name.toLowerCase()}`;
  const cached = getCached<PeeringDbIx | null>(cacheKey);
  if (cached !== null || cache.has(cacheKey)) return cached;

  try {
    const result = await fetchPeeringDb<PeeringDbIx>(`/ix?name__icontains=${encodeURIComponent(name)}&status=ok`);
    const ix = result.data[0] ?? null;
    setCached(cacheKey, ix);
    return ix;
  } catch (err) {
    logger.debug({ err, name }, 'PeeringDB IX lookup failed');
    return null;
  }
}

export async function lookupOrgByAsn(asn: number): Promise<PeeringDbOrg | null> {
  const net = await lookupAsn(asn);
  if (!net) return null;
  return net.org ?? null;
}

export function clearCache(): void {
  cache.clear();
}

export function getCacheSize(): number {
  return cache.size;
}
