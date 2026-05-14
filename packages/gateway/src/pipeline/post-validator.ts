import { validateSchema, type SchemaValidatorResult } from '../validation/schema-validator.js';
import { checkBanlist, type BanlistResult, type BanViolation } from '../validation/banlist-checker.js';
import { checkLanguage, type LanguageCheckResult } from '../validation/language-checker.js';
import { checkFacts, type FactCheckResult } from '../validation/fact-checker.js';
import { validateJWT, type JWTValidationResult } from '../validation/jwt-validator.js';

export interface ValidationResult {
  validator: string;
  passed: boolean;
  score_impact: number;
  details: Record<string, unknown>;
}

export interface PostValidationOutput {
  all_passed: boolean;
  total_score_impact: number;
  results: ValidationResult[];
  ban_violations: BanViolation[];
  retry_requested: boolean;
}

export interface ValidatorConfig {
  validators: string[];
  language?: 'de' | 'en';
  formality?: 'du' | 'Sie';
  output_format?: string;
  requires_fact_check?: boolean;
  schema?: Record<string, unknown>;
  min_length?: number;
  max_length?: number;
  jwt_token?: string;
}

function checkLength(
  text: string,
  minChars = 50,
  maxChars = 20000,
): ValidationResult {
  const len = text.length;
  if (len < minChars) {
    return {
      validator: 'length',
      passed: false,
      score_impact: -1.0,
      details: { length: len, min: minChars, reason: 'Output too short' },
    };
  }
  if (len > maxChars) {
    return {
      validator: 'length',
      passed: false,
      score_impact: -1.0,
      details: { length: len, max: maxChars, reason: 'Output too long' },
    };
  }
  return {
    validator: 'length',
    passed: true,
    score_impact: 0,
    details: { length: len },
  };
}

function checkQuestionCloser(text: string): ValidationResult {
  const QUESTION_CLOSER_PATTERNS = [
    /what do you think\??/i,
    /what are your thoughts\??/i,
    /let me know in the comments/i,
    /feel free to reach out/i,
    /share your thoughts/i,
    /i'd love to hear from you/i,
    /follow for more/i,
    /wie seht ihr das\??/i,
    /was denkt ihr\??/i,
    /schreibt .* in die kommentare/i,
    /teilt .* gedanken/i,
  ];

  const trimmed = text.slice(-300); // Check last 300 chars
  const found = QUESTION_CLOSER_PATTERNS.find((p) => p.test(trimmed));

  if (found) {
    return {
      validator: 'question_closer',
      passed: false,
      score_impact: -1.5,
      details: { reason: 'Output ends with engagement-bait question or call-to-action' },
    };
  }

  return {
    validator: 'question_closer',
    passed: true,
    score_impact: 0,
    details: {},
  };
}

async function validateWithSchema(
  output: string,
  schema?: Record<string, unknown>,
): Promise<{ result: ValidationResult; retry: boolean }> {
  const schemaResult: SchemaValidatorResult = validateSchema(output, schema);
  return {
    result: {
      validator: 'schema',
      passed: schemaResult.passed,
      score_impact: schemaResult.score_impact,
      details: { errors: schemaResult.errors },
    },
    retry: schemaResult.retry,
  };
}

async function validateWithBanlist(
  output: string,
  language?: 'de' | 'en',
): Promise<{ result: ValidationResult; violations: BanViolation[] }> {
  const banResult: BanlistResult = checkBanlist(output, language ?? 'auto');
  return {
    result: {
      validator: 'banlist',
      passed: banResult.passed,
      score_impact: banResult.score_penalty,
      details: {
        violations: banResult.violations.map((v) => ({
          term: v.term,
          category: v.category,
          language: v.language,
        })),
        count: banResult.violations.length,
      },
    },
    violations: banResult.violations,
  };
}

async function validateWithLanguage(
  output: string,
  language?: 'de' | 'en',
  formality?: 'du' | 'Sie',
): Promise<ValidationResult> {
  const langResult: LanguageCheckResult = checkLanguage(output, language, formality);
  return {
    validator: 'language',
    passed: langResult.passed,
    score_impact: langResult.score_impact,
    details: {
      detected: langResult.detected_language,
      required: langResult.required_language,
      formality_issue: langResult.formality_issue,
      details: langResult.details,
    },
  };
}

async function validateWithFacts(output: string): Promise<ValidationResult> {
  const factResult: FactCheckResult = await checkFacts(output, 5000);
  return {
    validator: 'fact_checker',
    passed: factResult.passed,
    score_impact: factResult.score_impact,
    details: {
      checks_performed: factResult.checks_performed,
      failures: factResult.failures,
    },
  };
}

async function validateRequestJWT(token?: string): Promise<ValidationResult> {
  if (!token) {
    return {
      validator: 'jwt',
      passed: false,
      score_impact: -2.0,
      details: { reason: 'No JWT token provided' },
    };
  }

  const jwtResult: JWTValidationResult = await validateJWT(token);
  return {
    validator: 'jwt',
    passed: jwtResult.passed,
    score_impact: jwtResult.score_impact,
    details: {
      errors: jwtResult.errors,
      algorithm_pinned: jwtResult.passed,
      decoded: jwtResult.decoded ? { sub: jwtResult.decoded.sub, iat: jwtResult.decoded.iat } : undefined,
    },
  };
}

export async function runPostValidation(
  output: string,
  config: ValidatorConfig,
): Promise<PostValidationOutput> {
  const results: ValidationResult[] = [];
  const validatorSet = new Set(config.validators ?? []);
  let banViolations: BanViolation[] = [];
  let retryRequested = false;

  if (validatorSet.has('schema')) {
    const { result, retry } = await validateWithSchema(output, config.schema);
    results.push(result);
    retryRequested = retryRequested || retry;
  }

  if (validatorSet.has('banlist')) {
    const { result, violations } = await validateWithBanlist(output, config.language);
    results.push(result);
    banViolations = violations;
  }

  if (validatorSet.has('language')) {
    results.push(await validateWithLanguage(output, config.language, config.formality));
  }

  if (validatorSet.has('fact_checker') && config.requires_fact_check) {
    results.push(await validateWithFacts(output));
  }

  if (validatorSet.has('jwt')) {
    results.push(await validateRequestJWT(config.jwt_token));
  }

  if (validatorSet.has('length')) {
    results.push(checkLength(output, config.min_length ?? 50, config.max_length ?? 20000));
  }

  if (validatorSet.has('question_closer')) {
    results.push(checkQuestionCloser(output));
  }

  const totalScoreImpact = results.reduce((sum, r) => sum + r.score_impact, 0);
  const allPassed = results.every((r) => r.passed);

  return {
    all_passed: allPassed,
    total_score_impact: totalScoreImpact,
    results,
    ban_violations: banViolations,
    retry_requested: retryRequested,
  };
}
