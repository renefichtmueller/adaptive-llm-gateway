/**
 * GEO Analyzer — deterministic content scoring for Generative Engine Optimization
 * -------------------------------------------------------------------------------
 * Scores a piece of content (HTML, Markdown or plain text) against the GEO
 * factors distilled in geo-knowledge.ts: statistics, citations, quotations,
 * extractable structure, answer-first style, fluency, entity clarity, E-E-A-T
 * signals, schema.org markup and keyword hygiene. Pure + synchronous — no LLM,
 * no network, no DB — so it can run on every save and inside unit tests.
 *
 * Heuristics are bilingual (EN + DE), matching the gateway's injection-defense
 * conventions. Also includes an AI-crawler robots.txt audit
 * (checkAiCrawlerAccess), because a blocked search bot means zero visibility
 * in that engine no matter how good the content is.
 */

import { AI_CRAWLERS, type AiCrawler } from './geo-knowledge.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type GeoContentFormat = 'auto' | 'html' | 'markdown' | 'text';

export interface GeoAnalyzeInput {
  content: string;
  format?: GeoContentFormat;
  /** Brand / company / product the content should build an entity for. */
  brand?: string;
  brandAliases?: string[];
  /** Questions/prompts this content should be the answer to. */
  targetQueries?: string[];
}

export interface GeoFactorResult {
  id: string;
  label: string;
  /** 0–100. Higher = better GEO readiness for this factor. */
  score: number;
  /** Relative weight in the total score (0 when not applicable). */
  weight: number;
  applicable: boolean;
  evidence: string[];
  recommendations: string[];
  /** Raw count behind the score where one exists (e.g. data points found). */
  metric?: number;
}

export interface GeoQueryCoverage {
  query: string;
  coveredTerms: string[];
  missingTerms: string[];
  covered: boolean;
}

export interface GeoContentStats {
  format: 'html' | 'markdown' | 'text';
  language: 'de' | 'en' | 'unknown';
  words: number;
  sentences: number;
  paragraphs: number;
  headings: number;
  links: number;
  listItems: number;
  tables: number;
  statisticsFound: number;
  quotationsFound: number;
  schemaTypes: string[];
}

export interface GeoAnalysis {
  /** Weighted total 0–100. */
  geoScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  factors: GeoFactorResult[];
  /** Top recommendations across factors, worst factors first. */
  recommendations: string[];
  stats: GeoContentStats;
  queryCoverage: GeoQueryCoverage[];
}

export interface ExtractedDoc {
  format: 'html' | 'markdown' | 'text';
  text: string;
  headings: { level: number; text: string }[];
  links: { url: string; text: string }[];
  paragraphs: string[];
  listItemCount: number;
  tableCount: number;
  blockquoteCount: number;
  schemaTypes: string[];
  faqDetected: boolean;
}

// ─── Factor weights (sum = 100) ────────────────────────────────────────────
// Derived from measured impact in the Princeton GEO study (citations,
// statistics, quotations, fluency) plus the Evergreen Media practitioner
// emphasis on structure, answer-first style and entity/E-E-A-T building.

const FACTOR_WEIGHTS: Record<string, number> = {
  citations: 15,
  statistics: 14,
  structure: 12,
  direct_answers: 12,
  quotations: 10,
  fluency_readability: 10,
  entity_clarity: 9,
  eeat_freshness: 9,
  schema_markup: 5,
  keyword_hygiene: 4,
};

// ─── Language + tokenization helpers ───────────────────────────────────────

const DE_MARKERS = /\b(und|oder|nicht|eine?|der|die|das|ist|sind|wird|werden|für|mit|auch|bei|dass|wir|sie|haben|sich|auf|durch|können|müssen)\b/gi;
const EN_MARKERS = /\b(and|or|not|the|is|are|will|for|with|also|that|this|have|has|can|must|should|which|from|their|your)\b/gi;

const STOPWORDS = new Set([
  // EN
  'this', 'that', 'with', 'from', 'have', 'will', 'your', 'their', 'about', 'which', 'when', 'what', 'they',
  'them', 'then', 'than', 'also', 'more', 'most', 'some', 'such', 'into', 'over', 'only', 'other', 'these',
  'those', 'been', 'being', 'were', 'does', 'each', 'much', 'many', 'very', 'like', 'just', 'should', 'would',
  // DE
  'eine', 'einer', 'eines', 'einem', 'einen', 'nicht', 'auch', 'sich', 'dass', 'sind', 'wird', 'werden',
  'kann', 'können', 'müssen', 'haben', 'aber', 'oder', 'wenn', 'dann', 'noch', 'nach', 'beim', 'durch',
  'über', 'unter', 'mehr', 'sehr', 'alle', 'allen', 'aller', 'diese', 'dieser', 'dieses', 'diesem', 'ihre',
  'ihrer', 'sowie', 'beide', 'zwischen', 'wurden', 'wurde', 'damit', 'dabei', 'dafür', 'ohne', 'schon',
]);

export function detectLanguage(text: string): 'de' | 'en' | 'unknown' {
  const sample = text.slice(0, 6_000);
  const de = (sample.match(DE_MARKERS) ?? []).length;
  const en = (sample.match(EN_MARKERS) ?? []).length;
  if (de === 0 && en === 0) return 'unknown';
  if (de > en * 1.2) return 'de';
  if (en > de * 1.2) return 'en';
  return 'unknown';
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9„"«])/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// ─── Content extraction ────────────────────────────────────────────────────

function detectFormat(content: string): 'html' | 'markdown' | 'text' {
  if (/<\s*(html|body|div|p|h[1-6]|article|section|span|table)[\s>]/i.test(content)) return 'html';
  if (/^#{1,6}\s+\S/m.test(content) || /\[[^\]]+\]\([^)]+\)/.test(content)) return 'markdown';
  return 'text';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&auml;/gi, 'ä').replace(/&ouml;/gi, 'ö').replace(/&uuml;/gi, 'ü').replace(/&szlig;/gi, 'ß');
}

function extractSchemaTypes(html: string): string[] {
  const types: string[] = [];
  const blocks = html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    try {
      const parsed: unknown = JSON.parse(block[1] ?? '');
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(collect); return; }
        if (node && typeof node === 'object') {
          const t = (node as Record<string, unknown>)['@type'];
          if (typeof t === 'string') types.push(t);
          if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.push(x));
          const graph = (node as Record<string, unknown>)['@graph'];
          if (graph) collect(graph);
        }
      };
      collect(parsed);
    } catch {
      // invalid JSON-LD — ignore, the schema factor will flag absence
    }
  }
  return [...new Set(types)];
}

function extractFromHtml(raw: string): ExtractedDoc {
  const schemaTypes = extractSchemaTypes(raw);
  let html = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ');

  const headings: { level: number; text: string }[] = [];
  for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text) headings.push({ level: parseInt(m[1] ?? '2', 10), text });
  }

  const links: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    links.push({ url: m[1] ?? '', text });
  }

  const listItemCount = (html.match(/<li[\s>]/gi) ?? []).length;
  const tableCount = (html.match(/<table[\s>]/gi) ?? []).length;
  const blockquoteCount = (html.match(/<blockquote[\s>]/gi) ?? []).length;

  // Block-level tags become paragraph breaks, then strip remaining tags.
  html = html.replace(/<(p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n');
  const text = decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const paragraphs = text.split('\n').map((p) => p.trim()).filter((p) => p.split(/\s+/).length >= 3);

  const faqDetected =
    schemaTypes.includes('FAQPage') ||
    /\bFAQ\b|häufig gestellte fragen|frequently asked questions/i.test(raw);

  return { format: 'html', text: paragraphs.join('\n'), headings, links, paragraphs, listItemCount, tableCount, blockquoteCount, schemaTypes, faqDetected };
}

function extractFromMarkdown(raw: string): ExtractedDoc {
  const headings: { level: number; text: string }[] = [];
  for (const m of raw.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    headings.push({ level: (m[1] ?? '#').length, text: (m[2] ?? '').replace(/[#*_`]/g, '').trim() });
  }

  const links: { url: string; text: string }[] = [];
  for (const m of raw.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)[^)]*\)/g)) {
    links.push({ url: m[2] ?? '', text: m[1] ?? '' });
  }
  for (const m of raw.matchAll(/(?<![("\][])\bhttps?:\/\/[^\s)\]>"']+/g)) {
    links.push({ url: m[0], text: '' });
  }

  const listItemCount =
    (raw.match(/^\s*[-*+]\s+\S/gm) ?? []).length + (raw.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
  const tableCount = (raw.match(/^\s*\|.+\|.+\|/gm) ?? []).length > 1 ? 1 : 0;
  const blockquoteCount = (raw.match(/^>\s+\S/gm) ?? []).length;

  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.split(/\s+/).length >= 3);

  const faqDetected = /\bFAQ\b|häufig gestellte fragen|frequently asked questions/i.test(raw);

  return { format: 'markdown', text: paragraphs.join('\n'), headings, links, paragraphs, listItemCount, tableCount, blockquoteCount, schemaTypes: [], faqDetected };
}

function extractFromText(raw: string): ExtractedDoc {
  const paragraphs = raw.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.split(/\s+/).length >= 3);
  const links: { url: string; text: string }[] = [];
  for (const m of raw.matchAll(/\bhttps?:\/\/[^\s)\]>"']+/g)) links.push({ url: m[0], text: '' });
  const listItemCount = (raw.match(/^\s*[-*•]\s+\S/gm) ?? []).length;
  const faqDetected = /\bFAQ\b|häufig gestellte fragen|frequently asked questions/i.test(raw);
  return { format: 'text', text: paragraphs.join('\n'), headings: [], links, paragraphs, listItemCount, tableCount: 0, blockquoteCount: 0, schemaTypes: [], faqDetected };
}

export function extractContent(content: string, format: GeoContentFormat = 'auto'): ExtractedDoc {
  const resolved = format === 'auto' ? detectFormat(content) : format;
  if (resolved === 'html') return extractFromHtml(content);
  if (resolved === 'markdown') return extractFromMarkdown(content);
  return extractFromText(content);
}

// ─── Factor analyzers ──────────────────────────────────────────────────────

const STAT_PATTERNS: RegExp[] = [
  /\d+(?:[.,]\d+)?\s?%/g,                                        // percentages
  /(?:€|\$|£)\s?\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*\s?(?:EUR|USD|Euro|Dollar)\b/g, // money
  /\d+(?:[.,]\d+)?\s?(?:ms|sek(?:unden)?|min(?:uten)?|std|h\b|GB|MB|TB|kB|GHz|MHz|km|kg|g\b|mm|cm|nm|Gbit\/?s|Mbit\/?s|W\b|kW|°C|dB)/gi, // measurements
  /\b\d+(?:[.,]\d+)?\s?(?:x|fach|times|mal)\b/gi,               // multipliers
  /\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?\b/g,                     // large numbers 10.000 / 10,000
  /\b\d+\s?(?:von|out of|of)\s?\d+\b/gi,                        // n out of m
  /\b(?:über|unter|rund|etwa|ca\.|more than|less than|about|approx\.?)\s\d+/gi, // approximations
];

function analyzeStatistics(doc: ExtractedDoc): GeoFactorResult {
  const found: string[] = [];
  for (const pattern of STAT_PATTERNS) {
    for (const m of doc.text.matchAll(pattern)) {
      found.push(m[0].trim());
      if (found.length >= 40) break;
    }
  }
  const unique = [...new Set(found)];
  const wordCount = Math.max(1, words(doc.text).length);
  const per100 = (unique.length / wordCount) * 100;
  // ~1.2 verifiable data points per 100 words ≈ fully saturated.
  const score = unique.length === 0 ? 5 : clamp(per100 * 83 + 10);

  const recommendations: string[] = [];
  if (score < 70) {
    recommendations.push(
      'Add concrete statistics and measured data (percentages, benchmarks, dates) — the GEO study measured ~25–37% more visibility for passages carrying verifiable numbers.',
    );
  }
  return {
    id: 'statistics', label: 'Statistics & data points', score,
    weight: FACTOR_WEIGHTS['statistics'] ?? 0, applicable: true,
    evidence: unique.slice(0, 8).map((e) => `data point: "${e}"`),
    recommendations,
    metric: unique.length,
  };
}

const CITATION_PHRASES = /\b(laut|gemäß|zufolge|according to|sources?:|quellen?:|studie (?:von|der|des)|study (?:by|from)|research (?:by|from)|report (?:by|from)|belegt durch|zeigt eine studie)\b/gi;
const AUTHORITY_DOMAINS = /\b(?:[a-z0-9-]+\.)*(wikipedia\.org|arxiv\.org|doi\.org|nature\.com|sciencedirect\.com|ieee\.org|iso\.org|statista\.com|acm\.org|nist\.gov|europa\.eu|[a-z0-9-]+\.gov|[a-z0-9-]+\.edu)\b/gi;

function analyzeCitations(doc: ExtractedDoc): GeoFactorResult {
  const externalLinks = doc.links.filter((l) => /^https?:\/\//i.test(l.url));
  const phrases = [...doc.text.matchAll(CITATION_PHRASES)];
  const authority = [...new Set([...doc.text.matchAll(AUTHORITY_DOMAINS), ...externalLinks.flatMap((l) => [...l.url.matchAll(AUTHORITY_DOMAINS)])].map((m) => m[1] ?? m[0]))];

  const wordCount = Math.max(1, words(doc.text).length);
  const linksPer1000 = (externalLinks.length / wordCount) * 1000;
  let score = clamp(linksPer1000 * 25 + Math.min(3, phrases.length) * 12 + Math.min(2, authority.length) * 10);
  if (externalLinks.length === 0 && phrases.length === 0) score = Math.min(score, 10);

  const evidence: string[] = [];
  if (externalLinks.length > 0) evidence.push(`${externalLinks.length} external link(s), e.g. ${externalLinks[0]?.url}`);
  if (phrases.length > 0) evidence.push(`${phrases.length} citation phrase(s), e.g. "${phrases[0]?.[0]}"`);
  if (authority.length > 0) evidence.push(`authority sources referenced: ${authority.slice(0, 4).join(', ')}`);

  const recommendations: string[] = [];
  if (score < 70) {
    recommendations.push(
      'Cite and link credible sources (studies, standards, official docs) — "cite sources" lifted visibility ~30–40% in the GEO study and doubles as an E-E-A-T signal.',
    );
  }
  return { id: 'citations', label: 'Cited sources', score, weight: FACTOR_WEIGHTS['citations'] ?? 0, applicable: true, evidence, recommendations };
}

const QUOTE_PATTERN = /[„“"«]([^„“”"«»]{15,400}?)[”"“»]/g;
const ATTRIBUTION_NEARBY = /(sagt|sagte|erklärt|betont|meint|so\s+[A-ZÄÖÜ]|says|said|explains|notes|laut|according to|—|–)/;

function analyzeQuotations(doc: ExtractedDoc): GeoFactorResult {
  const evidence: string[] = [];
  let attributed = 0;
  let total = 0;
  for (const m of doc.text.matchAll(QUOTE_PATTERN)) {
    const quote = m[1] ?? '';
    if (words(quote).length < 4) continue; // skip inline terms like "GEO"
    total++;
    const idx = m.index ?? 0;
    const context = doc.text.slice(Math.max(0, idx - 120), idx + m[0].length + 120);
    if (ATTRIBUTION_NEARBY.test(context)) attributed++;
    if (evidence.length < 4) evidence.push(`quote: "${quote.slice(0, 70)}${quote.length > 70 ? '…' : ''}"`);
  }
  total += doc.blockquoteCount;
  attributed += doc.blockquoteCount; // blockquotes are usually attributed citations

  let score: number;
  if (total === 0) score = 15;
  else if (attributed === 0) score = 45;
  else if (attributed === 1) score = 75;
  else score = 100;

  const recommendations: string[] = [];
  if (score < 70) {
    recommendations.push(
      'Add attributed expert quotes ("…", says <name>, <role>) — quotation addition was the single strongest lever in the GEO study (~40% visibility gain).',
    );
  }
  return { id: 'quotations', label: 'Expert quotations', score, weight: FACTOR_WEIGHTS['quotations'] ?? 0, applicable: true, evidence, recommendations, metric: total };
}

function analyzeStructure(doc: ExtractedDoc): GeoFactorResult {
  const wordCount = Math.max(1, words(doc.text).length);
  const evidence: string[] = [];
  const recommendations: string[] = [];

  // Heading density: ideal ≥1 per ~300 words (short content needs ≥1 overall).
  const headingTarget = Math.max(1, Math.floor(wordCount / 300));
  const headingScore = clamp((doc.headings.length / headingTarget) * 100);
  const hasHierarchy = doc.headings.some((h) => h.level === 2) && doc.headings.some((h) => h.level >= 3);
  const listScore = doc.listItemCount >= 3 ? 100 : doc.listItemCount > 0 ? 60 : 0;
  const tableScore = doc.tableCount > 0 ? 100 : 40;
  const avgParagraphWords =
    doc.paragraphs.length > 0
      ? doc.paragraphs.reduce((sum, p) => sum + words(p).length, 0) / doc.paragraphs.length
      : wordCount;
  const paragraphScore = avgParagraphWords <= 60 ? 100 : avgParagraphWords <= 100 ? 70 : avgParagraphWords <= 150 ? 40 : 10;

  const score = clamp(
    headingScore * 0.35 + (hasHierarchy ? 100 : 40) * 0.15 + listScore * 0.2 + tableScore * 0.1 + paragraphScore * 0.2,
  );

  evidence.push(`${doc.headings.length} heading(s), ${doc.listItemCount} list item(s), ${doc.tableCount} table(s)`);
  evidence.push(`average paragraph length: ${Math.round(avgParagraphWords)} words`);

  if (headingScore < 70) recommendations.push('Break the content into more sections with descriptive H2/H3 headings — engines retrieve self-contained passages, not whole pages.');
  if (listScore < 60) recommendations.push('Convert enumerations into bullet or numbered lists; list items are highly extractable.');
  if (paragraphScore < 70) recommendations.push('Shorten paragraphs to ~2–4 sentences so each chunk can stand alone in an AI answer.');

  return { id: 'structure', label: 'Extractable structure', score, weight: FACTOR_WEIGHTS['structure'] ?? 0, applicable: true, evidence, recommendations };
}

const QUESTION_START = /^(was|wie|warum|wieso|weshalb|welche[rs]?|wann|wo|womit|wofür|what|how|why|which|when|where|who|is|are|can|does|do|should|ist|sind|kann|sollte)\b/i;

function analyzeDirectAnswers(doc: ExtractedDoc): GeoFactorResult {
  const evidence: string[] = [];
  const recommendations: string[] = [];

  const questionHeadings = doc.headings.filter((h) => h.text.endsWith('?') || QUESTION_START.test(h.text));
  // Does a question heading get a concise answer right below it?
  let answeredDirectly = 0;
  for (const qh of questionHeadings) {
    const headingPos = doc.text.indexOf(qh.text.replace(/\?$/, ''));
    if (headingPos < 0) continue;
    const following = doc.paragraphs.find((p) => doc.text.indexOf(p) > headingPos);
    if (following && words(following).length <= 65) answeredDirectly++;
  }

  const firstParagraph = doc.paragraphs[0] ?? '';
  const answerFirstOpening = firstParagraph.length > 0 && words(firstParagraph).length <= 80;

  let score = 20;
  if (questionHeadings.length > 0) score += 25;
  if (answeredDirectly > 0) score += 25;
  if (doc.faqDetected) score += 15;
  if (answerFirstOpening) score += 15;
  score = clamp(score);

  if (questionHeadings.length > 0) evidence.push(`${questionHeadings.length} question-style heading(s), ${answeredDirectly} answered concisely below`);
  if (doc.faqDetected) evidence.push('FAQ section detected');
  if (answerFirstOpening) evidence.push('opening paragraph is short (answer-first)');

  if (questionHeadings.length === 0) recommendations.push('Phrase key headings as the questions users actually ask ("Was ist …?", "How does …?") and answer them in the first sentence below.');
  if (!doc.faqDetected) recommendations.push('Add an FAQ section for long-tail questions (ideally with FAQPage schema).');
  if (!answerFirstOpening) recommendations.push('Open with the direct answer in 2–3 sentences; put background and details after it.');

  return { id: 'direct_answers', label: 'Direct answers & FAQ', score, weight: FACTOR_WEIGHTS['direct_answers'] ?? 0, applicable: true, evidence, recommendations };
}

const PASSIVE_EN = /\b(?:is|are|was|were|been|being)\s+\w+(?:ed|en)\b/gi;
const PASSIVE_DE = /\b(?:wird|werden|wurde|wurden|worden)\s+(?:\w+\s+){0,3}?(?:ge\w+t|ge\w+en|\w+iert)\b/gi;
const FLUFF_WORDS = /\b(revolution(?:ary|är)|world[- ]?class|weltklasse|cutting[- ]?edge|best[- ]?in[- ]?class|einzigartig|unvergleichlich|game[- ]?chang(?:er|ing)|bahnbrechend|next[- ]?level|synerg\w+)\b/gi;

function analyzeFluency(doc: ExtractedDoc): GeoFactorResult {
  const sentences = splitSentences(doc.text);
  const evidence: string[] = [];
  const recommendations: string[] = [];
  if (sentences.length === 0) {
    return { id: 'fluency_readability', label: 'Fluency & readability', score: 30, weight: FACTOR_WEIGHTS['fluency_readability'] ?? 0, applicable: true, evidence: ['no complete sentences found'], recommendations: ['Write complete, fluent sentences — fragments are hard for engines to reuse.'] };
  }

  const lengths = sentences.map((s) => words(s).length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const longRatio = lengths.filter((l) => l > 30).length / lengths.length;
  const lengthScore = avgLen <= 19 ? 100 : avgLen >= 40 ? 0 : clamp(100 - ((avgLen - 19) / 21) * 100);

  const passiveCount = (doc.text.match(PASSIVE_EN) ?? []).length + (doc.text.match(PASSIVE_DE) ?? []).length;
  const passivePerSentence = passiveCount / sentences.length;
  const passiveScore = passivePerSentence <= 0.15 ? 100 : passivePerSentence >= 0.6 ? 0 : clamp(100 - ((passivePerSentence - 0.15) / 0.45) * 100);

  const fluff = doc.text.match(FLUFF_WORDS) ?? [];
  const fluffScore = fluff.length === 0 ? 100 : fluff.length === 1 ? 70 : fluff.length <= 3 ? 40 : 10;

  const score = clamp(lengthScore * 0.55 + passiveScore * 0.25 + fluffScore * 0.2 - longRatio * 15);

  evidence.push(`average sentence length: ${avgLen.toFixed(1)} words (${sentences.length} sentences)`);
  if (passiveCount > 0) evidence.push(`${passiveCount} passive construction(s)`);
  if (fluff.length > 0) evidence.push(`marketing fluff: ${[...new Set(fluff.map((f) => f.toLowerCase()))].slice(0, 4).join(', ')}`);

  if (lengthScore < 70) recommendations.push('Shorten sentences to ~15–20 words on average; engines quote fluent, compact statements (fluency optimization: ~15–30% gain in the GEO study).');
  if (passiveScore < 70) recommendations.push('Rewrite passive constructions into active voice.');
  if (fluffScore < 70) recommendations.push('Replace marketing superlatives with verifiable claims — engines skip fluff.');

  return { id: 'fluency_readability', label: 'Fluency & readability', score, weight: FACTOR_WEIGHTS['fluency_readability'] ?? 0, applicable: true, evidence, recommendations };
}

function analyzeEntityClarity(doc: ExtractedDoc, brand?: string, aliases: string[] = []): GeoFactorResult {
  if (!brand || brand.trim().length === 0) {
    return {
      id: 'entity_clarity', label: 'Brand entity clarity', score: 0, weight: 0, applicable: false,
      evidence: [], recommendations: ['Pass "brand" to score entity clarity (who/what the content builds authority for).'],
    };
  }
  const names = [brand, ...aliases].filter((n) => n.trim().length > 0);
  const nameAlternation = names.map(escapeRegExp).join('|');
  const mentions = doc.text.match(new RegExp(nameAlternation, 'gi')) ?? [];
  const firstSlice = doc.text.slice(0, Math.max(400, Math.floor(doc.text.length * 0.15)));
  const inOpening = new RegExp(nameAlternation, 'i').test(firstSlice);
  const inHeading = doc.headings.some((h) => new RegExp(nameAlternation, 'i').test(h.text));
  const definitional = new RegExp(`(?:${names.map(escapeRegExp).join('|')})[^.!?\n]{0,80}\\s(?:ist|sind|is|are)\\s`, 'i').test(doc.text);

  let score = 0;
  if (mentions.length > 0) score += 25;
  if (mentions.length >= 3) score += 15;
  if (inOpening) score += 20;
  if (inHeading) score += 15;
  if (definitional) score += 25;
  score = clamp(score);

  const evidence: string[] = [`${mentions.length} brand mention(s)`];
  if (definitional) evidence.push('definitional sentence found ("<brand> ist/is …")');
  if (inOpening) evidence.push('brand appears in the opening');

  const recommendations: string[] = [];
  if (!definitional) recommendations.push(`Add one canonical definition sentence early ("${brand} ist/is …") — engines reuse definitional statements to describe entities.`);
  if (!inOpening) recommendations.push('Mention the brand within the first paragraph.');
  if (mentions.length < 3) recommendations.push('Use the canonical brand name consistently (avoid switching between spellings).');

  return { id: 'entity_clarity', label: 'Brand entity clarity', score, weight: FACTOR_WEIGHTS['entity_clarity'] ?? 0, applicable: true, evidence, recommendations };
}

const DATE_PATTERNS = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.\s?(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s?\d{4}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s\d{1,2},?\s\d{4}\b|\b\d{1,2}\.\d{1,2}\.\d{4}\b/g;
const UPDATED_MARKERS = /\b(aktualisiert|zuletzt geprüft|letzte aktualisierung|stand:|updated|last reviewed|last updated)\b/gi;
const AUTHOR_MARKERS = /\b(autor(?:in)?|verfasst von|geschrieben von|author|written by|by\s+[A-Z][a-zäöüß]+\s+[A-Z][a-zäöüß]+|von\s+[A-Z][a-zäöüß]+\s+[A-Z][a-zäöüß]+)\b/g;
const CREDENTIAL_MARKERS = /\b(Dr\.|Prof\.|Dipl\.|M\.?Sc\.?|B\.?Sc\.?|PhD|MBA|zertifiziert|certified|\d+\s?(?:jahren?|years?)\s(?:erfahrung|of experience))\b/gi;
const EXPERIENCE_MARKERS = /\b(wir haben getestet|in unserem test|selbst gemessen|aus unserer praxis|unsere messungen|we tested|in our test(?:s|ing)?|hands-on|we measured|our benchmark|first-hand)\b/gi;

function analyzeEeatFreshness(doc: ExtractedDoc): GeoFactorResult {
  const dates = doc.text.match(DATE_PATTERNS) ?? [];
  const updated = doc.text.match(UPDATED_MARKERS) ?? [];
  const authors = doc.text.match(AUTHOR_MARKERS) ?? [];
  const credentials = doc.text.match(CREDENTIAL_MARKERS) ?? [];
  const experience = doc.text.match(EXPERIENCE_MARKERS) ?? [];

  let score = 10;
  if (dates.length > 0) score += 20;
  if (updated.length > 0) score += 20;
  if (authors.length > 0) score += 20;
  if (credentials.length > 0) score += 15;
  if (experience.length > 0) score += 15;
  score = clamp(score);

  const evidence: string[] = [];
  if (dates.length > 0) evidence.push(`date(s) found, e.g. "${dates[0]}"`);
  if (updated.length > 0) evidence.push('freshness marker found (updated/aktualisiert)');
  if (authors.length > 0) evidence.push('author attribution found');
  if (credentials.length > 0) evidence.push('credentials found');
  if (experience.length > 0) evidence.push(`first-hand experience marker, e.g. "${experience[0]}"`);

  const recommendations: string[] = [];
  if (authors.length === 0) recommendations.push('Name the author with role/credentials — anonymous content scores low on E-E-A-T.');
  if (dates.length === 0 && updated.length === 0) recommendations.push('Show a visible publish/updated date; stale-looking content gets skipped by retrieval engines.');
  if (experience.length === 0) recommendations.push('Add first-hand experience ("wir haben getestet …", "we measured …") — the first E in E-E-A-T.');

  return { id: 'eeat_freshness', label: 'E-E-A-T & freshness', score, weight: FACTOR_WEIGHTS['eeat_freshness'] ?? 0, applicable: true, evidence, recommendations };
}

const VALUABLE_SCHEMA_TYPES = new Set([
  'Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'FAQPage', 'HowTo', 'Product',
  'Organization', 'LocalBusiness', 'Person', 'WebSite', 'BreadcrumbList', 'Review', 'SoftwareApplication',
]);

function analyzeSchemaMarkup(doc: ExtractedDoc): GeoFactorResult {
  if (doc.format !== 'html') {
    return {
      id: 'schema_markup', label: 'Structured data (schema.org)', score: 0, weight: 0, applicable: false,
      evidence: [], recommendations: ['Structured data is only checked for HTML input — analyze the published page to score it.'],
    };
  }
  const valuable = doc.schemaTypes.filter((t) => VALUABLE_SCHEMA_TYPES.has(t));
  let score: number;
  if (doc.schemaTypes.length === 0) score = 10;
  else if (valuable.length === 0) score = 40;
  else if (valuable.length === 1) score = 70;
  else score = 100;

  const evidence = doc.schemaTypes.length > 0 ? [`JSON-LD types: ${doc.schemaTypes.join(', ')}`] : ['no JSON-LD structured data found'];
  const recommendations: string[] = [];
  if (score < 70) recommendations.push('Add JSON-LD structured data (Article/TechArticle + Organization; FAQPage for FAQ sections) to disambiguate the entity and content type.');
  else if (!doc.schemaTypes.includes('FAQPage') && doc.faqDetected) recommendations.push('The FAQ section lacks FAQPage schema — add it.');

  return { id: 'schema_markup', label: 'Structured data (schema.org)', score, weight: FACTOR_WEIGHTS['schema_markup'] ?? 0, applicable: true, evidence, recommendations };
}

function analyzeKeywordHygiene(doc: ExtractedDoc): GeoFactorResult {
  const tokens = words(doc.text.toLowerCase())
    .map((w) => w.replace(/[^a-zäöüß0-9-]/gi, ''))
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (tokens.length < 30) {
    return { id: 'keyword_hygiene', label: 'Keyword hygiene', score: 100, weight: FACTOR_WEIGHTS['keyword_hygiene'] ?? 0, applicable: true, evidence: ['content too short for stuffing analysis'], recommendations: [] };
  }
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let topTerm = '';
  let topCount = 0;
  for (const [term, count] of counts) {
    if (count > topCount) { topTerm = term; topCount = count; }
  }
  const ratio = topCount / tokens.length;
  const score = ratio <= 0.025 ? 100 : ratio >= 0.08 ? 0 : clamp(100 - ((ratio - 0.025) / 0.055) * 100);

  const evidence = [`most frequent term: "${topTerm}" (${(ratio * 100).toFixed(1)}% of significant words)`];
  const recommendations: string[] = [];
  if (score < 70) {
    recommendations.push(
      `Reduce repetition of "${topTerm}" — keyword stuffing was the only technique that DECREASED visibility (~-10%) in the GEO study. Use synonyms and pronouns.`,
    );
  }
  return { id: 'keyword_hygiene', label: 'Keyword hygiene', score, weight: FACTOR_WEIGHTS['keyword_hygiene'] ?? 0, applicable: true, evidence, recommendations };
}

// ─── Query coverage ────────────────────────────────────────────────────────

function analyzeQueryCoverage(doc: ExtractedDoc, targetQueries: string[]): GeoQueryCoverage[] {
  const haystack = doc.text.toLowerCase();
  return targetQueries.map((query) => {
    const terms = [...new Set(words(query.toLowerCase()).map((w) => w.replace(/[^a-zäöüß0-9-]/gi, '')).filter((w) => w.length >= 4 && !STOPWORDS.has(w)))];
    const coveredTerms = terms.filter((t) => haystack.includes(t));
    const missingTerms = terms.filter((t) => !haystack.includes(t));
    return { query, coveredTerms, missingTerms, covered: terms.length > 0 && coveredTerms.length / terms.length >= 0.6 };
  });
}

// ─── Main entry ────────────────────────────────────────────────────────────

export function analyzeGeo(input: GeoAnalyzeInput): GeoAnalysis {
  const doc = extractContent(input.content, input.format ?? 'auto');

  const factors: GeoFactorResult[] = [
    analyzeCitations(doc),
    analyzeStatistics(doc),
    analyzeStructure(doc),
    analyzeDirectAnswers(doc),
    analyzeQuotations(doc),
    analyzeFluency(doc),
    analyzeEntityClarity(doc, input.brand, input.brandAliases ?? []),
    analyzeEeatFreshness(doc),
    analyzeSchemaMarkup(doc),
    analyzeKeywordHygiene(doc),
  ];

  const applicable = factors.filter((f) => f.applicable);
  const totalWeight = applicable.reduce((sum, f) => sum + f.weight, 0);
  const geoScore = totalWeight > 0
    ? clamp(applicable.reduce((sum, f) => sum + f.score * f.weight, 0) / totalWeight)
    : 0;

  const grade: GeoAnalysis['grade'] =
    geoScore >= 85 ? 'A' : geoScore >= 70 ? 'B' : geoScore >= 55 ? 'C' : geoScore >= 40 ? 'D' : geoScore >= 25 ? 'E' : 'F';

  // Worst applicable factors first, weighted by how much score they leave on the table.
  const recommendations = [...applicable]
    .sort((a, b) => (100 - a.score) * a.weight - ((100 - b.score) * b.weight))
    .reverse()
    .flatMap((f) => f.recommendations)
    .slice(0, 8);

  const sentences = splitSentences(doc.text);
  const stats: GeoContentStats = {
    format: doc.format,
    language: detectLanguage(doc.text),
    words: words(doc.text).length,
    sentences: sentences.length,
    paragraphs: doc.paragraphs.length,
    headings: doc.headings.length,
    links: doc.links.length,
    listItems: doc.listItemCount,
    tables: doc.tableCount,
    statisticsFound: factors.find((f) => f.id === 'statistics')?.metric ?? 0,
    quotationsFound: factors.find((f) => f.id === 'quotations')?.metric ?? 0,
    schemaTypes: doc.schemaTypes,
  };

  return {
    geoScore,
    grade,
    factors,
    recommendations,
    stats,
    queryCoverage: analyzeQueryCoverage(doc, input.targetQueries ?? []),
  };
}

// ─── AI crawler robots.txt audit ───────────────────────────────────────────

export interface CrawlerAccessResult {
  userAgent: string;
  operator: string;
  purpose: AiCrawler['purpose'];
  affects: string;
  allowed: boolean;
  matchedGroup: string;
  matchedRule: string | null;
}

export interface CrawlerAccessReport {
  results: CrawlerAccessResult[];
  blockedSearchBots: string[];
  blockedTrainingBots: string[];
  recommendations: string[];
}

interface RobotsGroup {
  agents: string[];
  rules: { type: 'allow' | 'disallow'; path: string }[];
}

function parseRobotsTxt(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (current) current.rules.push({ type: field, path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function robotsPathMatches(rulePath: string, path: string): boolean {
  if (rulePath === '') return false; // "Disallow:" empty = allow everything
  const pattern = rulePath
    .split('*').map(escapeRegExp).join('.*');
  const anchored = pattern.endsWith('\\$') ? `^${pattern.slice(0, -2)}$` : `^${pattern}`;
  return new RegExp(anchored).test(path);
}

/**
 * Evaluate robots.txt access for the AI crawlers that matter for GEO.
 * `path` defaults to '/' — the homepage as a proxy for "the whole site".
 */
export function checkAiCrawlerAccess(robotsTxt: string, path = '/'): CrawlerAccessReport {
  const groups = parseRobotsTxt(robotsTxt);
  const results: CrawlerAccessResult[] = [];

  for (const crawler of AI_CRAWLERS) {
    const ua = crawler.userAgent.toLowerCase();
    // Most specific group wins: longest agent token contained in the UA name.
    let best: { group: RobotsGroup; token: string } | null = null;
    for (const group of groups) {
      for (const token of group.agents) {
        if (token === '*') continue;
        if (ua.includes(token) || token.includes(ua)) {
          if (!best || token.length > best.token.length) best = { group, token };
        }
      }
    }
    if (!best) {
      const wildcard = groups.find((g) => g.agents.includes('*'));
      if (wildcard) best = { group: wildcard, token: '*' };
    }

    if (!best) {
      results.push({ ...crawlerBase(crawler), allowed: true, matchedGroup: '(no group — default allow)', matchedRule: null });
      continue;
    }

    // Longest-path-match wins; allow beats disallow on ties (Google semantics).
    let winner: { type: 'allow' | 'disallow'; path: string } | null = null;
    for (const rule of best.group.rules) {
      if (!robotsPathMatches(rule.path, path)) continue;
      if (!winner || rule.path.length > winner.path.length || (rule.path.length === winner.path.length && rule.type === 'allow')) {
        winner = rule;
      }
    }
    const allowed = !winner || winner.type === 'allow';
    results.push({
      ...crawlerBase(crawler),
      allowed,
      matchedGroup: best.token,
      matchedRule: winner ? `${winner.type === 'allow' ? 'Allow' : 'Disallow'}: ${winner.path}` : null,
    });
  }

  const blockedSearchBots = results.filter((r) => !r.allowed && (r.purpose === 'search' || r.purpose === 'user-request')).map((r) => r.userAgent);
  const blockedTrainingBots = results.filter((r) => !r.allowed && r.purpose === 'training').map((r) => r.userAgent);

  const recommendations: string[] = [];
  if (blockedSearchBots.length > 0) {
    recommendations.push(
      `Search/answer bots are blocked (${blockedSearchBots.join(', ')}) — these engines cannot cite you at all. Allow them unless exclusion is intentional.`,
    );
  }
  if (blockedTrainingBots.length > 0) {
    recommendations.push(
      `Training crawlers are blocked (${blockedTrainingBots.join(', ')}) — future model generations will know less about you. A deliberate trade-off, but be aware of it for GEO.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('All monitored AI crawlers may access the site — no robots.txt-side GEO blockers.');
  }

  return { results, blockedSearchBots, blockedTrainingBots, recommendations };
}

function crawlerBase(c: AiCrawler): Pick<CrawlerAccessResult, 'userAgent' | 'operator' | 'purpose' | 'affects'> {
  return { userAgent: c.userAgent, operator: c.operator, purpose: c.purpose, affects: c.affects };
}

/** Exposed for unit tests. */
export const __INTERNALS = {
  FACTOR_WEIGHTS,
  detectFormat,
  parseRobotsTxt,
  robotsPathMatches,
  splitSentences,
};
