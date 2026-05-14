import { lookupAsn, lookupIx } from '../integrations/peeringdb.js';
import { logger } from '../observability/logger.js';

export interface FactCheckResult {
  passed: boolean;
  checks_performed: number;
  failures: string[];
  score_impact: number;
}

// ASN regex: AS followed by 1-10 digits
const ASN_REGEX = /\bAS(\d{1,10})\b/g;
// IX name patterns — rough heuristic
const IX_NAME_REGEX = /\b([A-Z]{2,6}-IX|DE-CIX|LINX|AMS-IX|ECIX|BCIX|FNIX|KIXP)\b/g;

export async function checkFacts(
  text: string,
  timeoutMs = 5000,
): Promise<FactCheckResult> {
  const failures: string[] = [];
  let checksPerformed = 0;
  let scoreImpact = 0;

  // Extract ASNs
  const asnMatches = [...text.matchAll(ASN_REGEX)];
  const asns = [...new Set(asnMatches.map((m) => parseInt(m[1] ?? '0', 10)).filter((n) => n > 0))];

  // Extract IX names
  const ixMatches = [...text.matchAll(IX_NAME_REGEX)];
  const ixNames = [...new Set(ixMatches.map((m) => m[1] ?? '').filter(Boolean))];

  const asnChecks = asns.slice(0, 3).map(async (asn) => {
    checksPerformed++;
    try {
      const result = await Promise.race([
        lookupAsn(asn),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);

      if (result === null) {
        // Could not find in PeeringDB — not necessarily wrong
        logger.debug({ asn }, 'ASN not found in PeeringDB');
      }
    } catch (err) {
      if ((err as Error).message === 'timeout') {
        logger.debug({ asn }, 'PeeringDB ASN lookup timed out');
      } else {
        logger.warn({ err, asn }, 'PeeringDB ASN lookup error');
      }
    }
  });

  const ixChecks = ixNames.slice(0, 2).map(async (ixName) => {
    checksPerformed++;
    try {
      const result = await Promise.race([
        lookupIx(ixName),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);

      if (result === null) {
        // IX name not found — flag as potential fabrication
        failures.push(`IX "${ixName}" not found in PeeringDB`);
        scoreImpact -= 2.0;
      }
    } catch (err) {
      if ((err as Error).message !== 'timeout') {
        logger.warn({ err, ixName }, 'PeeringDB IX lookup error');
      }
    }
  });

  await Promise.allSettled([...asnChecks, ...ixChecks]);

  return {
    passed: failures.length === 0,
    checks_performed: checksPerformed,
    failures,
    score_impact: scoreImpact,
  };
}
