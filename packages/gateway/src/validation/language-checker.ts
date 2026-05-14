// franc is a pure ESM package — import as default
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — franc typings are CommonJS-shaped
import { franc } from 'franc';

export interface LanguageCheckResult {
  passed: boolean;
  detected_language: string;
  required_language: string;
  formality_issue: boolean;
  sie_count: number;
  du_count: number;
  score_impact: number;
  details: string[];
}

// German Sie-form indicators (formal)
const SIE_PATTERNS = [
  /\bSie\b/g,
  /\bIhnen\b/g,
  /\bIhr\b/g,
  /\bIhre\b/g,
  /\bIhrem\b/g,
  /\bIhren\b/g,
  /\bIhres\b/g,
];

// German du-form indicators (informal)
const DU_PATTERNS = [
  /\bdu\b/gi,
  /\bdich\b/gi,
  /\bdir\b/gi,
  /\bdein\b/gi,
  /\bdeine\b/gi,
  /\bdeinem\b/gi,
  /\bdeinen\b/gi,
  /\bdeines\b/gi,
];

function countPatterns(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => {
    const fresh = new RegExp(pattern.source, pattern.flags);
    return count + (text.match(fresh) ?? []).length;
  }, 0);
}

function mapFrancToLang(francCode: string): 'de' | 'en' | 'other' {
  if (francCode === 'deu') return 'de';
  if (francCode === 'eng') return 'en';
  return 'other';
}

export function checkLanguage(
  text: string,
  requiredLanguage?: 'de' | 'en',
  formalityMode?: 'du' | 'Sie',
): LanguageCheckResult {
  const francResult = franc(text, { minLength: 20 });
  const detected = mapFrancToLang(francResult);
  const required = requiredLanguage ?? 'en';
  const details: string[] = [];
  let scoreImpact = 0;

  const wrongLanguage = requiredLanguage !== undefined && detected !== requiredLanguage && detected !== 'other';

  if (wrongLanguage) {
    scoreImpact -= 2.0;
    details.push(`Wrong language: expected ${required}, detected ${detected}`);
  }

  // Check German formality
  let sieCount = 0;
  let duCount = 0;
  let formalityIssue = false;

  if (detected === 'de' || required === 'de') {
    sieCount = countPatterns(text, SIE_PATTERNS);
    duCount = countPatterns(text, DU_PATTERNS);

    if (formalityMode === 'du' && sieCount > 2) {
      // Should use du-form but uses Sie
      scoreImpact -= 1.0;
      formalityIssue = true;
      details.push(`Formality mismatch: du-form required but found ${sieCount} Sie occurrences`);
    } else if (formalityMode === 'Sie' && duCount > 2) {
      // Should use Sie-form but uses du
      scoreImpact -= 0.5;
      formalityIssue = true;
      details.push(`Formality mismatch: Sie-form required but found ${duCount} du occurrences`);
    }
  }

  const passed = !wrongLanguage && !formalityIssue;

  return {
    passed,
    detected_language: detected,
    required_language: required,
    formality_issue: formalityIssue,
    sie_count: sieCount,
    du_count: duCount,
    score_impact: scoreImpact,
    details,
  };
}
