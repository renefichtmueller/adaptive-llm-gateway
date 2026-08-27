/**
 * GEO Knowledge Base — Generative Engine Optimization
 * ---------------------------------------------------
 * Embedded, machine-readable distillation of the GEO discipline so the
 * gateway can analyze, score, and optimize content for AI-generated answers
 * (ChatGPT, Perplexity, Google AI Overviews / AI Mode, Gemini, Copilot).
 *
 * Sources this catalogue is distilled from:
 *  - Evergreen Media "Generative Engine Optimization (GEO)" guide
 *    (https://www.evergreen.media/ratgeber/generative-engine-optimization/)
 *  - Aggarwal et al., "GEO: Generative Engine Optimization", KDD 2024
 *    (https://arxiv.org/abs/2311.09735) — the Princeton/IIT-Delhi study that
 *    measured which content changes raise visibility in generative answers.
 *
 * Consumed by geo-analyzer.ts (factor weights + crawler list), geo-optimizer.ts
 * (technique instructions for the rewrite prompt) and served raw via
 * GET /v1/geo/knowledge so dashboards and agents can self-serve the playbook.
 */

/** Where a technique / claim comes from. */
export type GeoSourceId = 'evergreen-media-guide' | 'princeton-geo-paper' | 'both';

export interface GeoSource {
  id: GeoSourceId | string;
  title: string;
  url: string;
  note: string;
}

export const GEO_SOURCES: GeoSource[] = [
  {
    id: 'evergreen-media-guide',
    title: 'Evergreen Media — Generative Engine Optimization (GEO) Ratgeber',
    url: 'https://www.evergreen.media/ratgeber/generative-engine-optimization/',
    note: 'Practitioner guide: GEO as a layer on top of SEO; entity, validation and community as the three building blocks of AI visibility; prompt monitoring as the measurement loop.',
  },
  {
    id: 'princeton-geo-paper',
    title: 'GEO: Generative Engine Optimization (Aggarwal et al., KDD 2024)',
    url: 'https://arxiv.org/abs/2311.09735',
    note: 'Benchmark of ~10k queries showing content-side optimizations lift visibility in generative answers by up to ~40%; quotations, statistics and cited sources were the strongest levers, keyword stuffing was net negative.',
  },
];

/**
 * The three generative-engine archetypes (Evergreen Media framing). Each type
 * sources brand knowledge differently, so each needs a different strategy.
 */
export interface GeoEngineType {
  id: 'training-based' | 'search-based' | 'hybrid';
  label: string;
  examples: string[];
  howItLearnsAboutYou: string;
  strategy: string;
}

export const GEO_ENGINE_TYPES: GeoEngineType[] = [
  {
    id: 'training-based',
    label: 'Training-based (parametric memory)',
    examples: ['ChatGPT without browsing', 'Claude without web search', 'local Ollama models'],
    howItLearnsAboutYou:
      'Only from the training corpus: third-party mentions, Wikipedia/Wikidata, forums, review sites, documentation mirrors. Changes to your site show up slowly, if at all.',
    strategy:
      'Build a consistent brand entity across the open web (digital PR, directories, communities, open-source presence). Consistent naming + descriptors matter more than on-page tweaks.',
  },
  {
    id: 'search-based',
    label: 'Search/retrieval-based (RAG)',
    examples: ['Perplexity', 'Google AI Overviews / AI Mode', 'Bing Copilot'],
    howItLearnsAboutYou:
      'Live retrieval from a search index; the engine cites the pages it retrieved. Classic SEO rankings and crawlability directly gate whether you can be cited.',
    strategy:
      'Keep classic SEO healthy, allow AI crawlers in robots.txt, and structure pages into self-contained, extractable passages that answer one question each.',
  },
  {
    id: 'hybrid',
    label: 'Hybrid (memory + browsing)',
    examples: ['ChatGPT with search', 'Gemini', 'Copilot in Windows/365'],
    howItLearnsAboutYou:
      'Combines parametric brand knowledge with live retrieval; brand familiarity from training biases which sources get pulled and trusted.',
    strategy: 'Do both: entity building for the memory side, extractable + citable content for the retrieval side.',
  },
];

/**
 * Optimization techniques. `impact` is the approximate relative visibility
 * change measured in the Princeton GEO paper where available (position-adjusted
 * word count / subjective impression metrics), otherwise a qualitative
 * practitioner assessment from the Evergreen Media guide.
 */
export interface GeoTechnique {
  id: string;
  title: string;
  description: string;
  impact: string;
  source: GeoSourceId;
  /** Maps to a geo-analyzer factor id when the analyzer can measure it. */
  analyzerFactor?: string;
}

export const GEO_TECHNIQUES: GeoTechnique[] = [
  {
    id: 'quotation-addition',
    title: 'Add relevant quotations',
    description:
      'Include attributed quotes from experts or primary sources. Generative engines preferentially reuse quotable, attributed statements.',
    impact: 'Strongest single lever in the GEO study — up to ~40% visibility gain.',
    source: 'princeton-geo-paper',
    analyzerFactor: 'quotations',
  },
  {
    id: 'cite-sources',
    title: 'Cite credible sources',
    description:
      'Reference and link authoritative sources (studies, standards bodies, official docs). Citations make passages verifiable and thus safer for an engine to reuse.',
    impact: '~30–40% visibility gain in the GEO study; also a core E-E-A-T signal.',
    source: 'both',
    analyzerFactor: 'citations',
  },
  {
    id: 'statistics-addition',
    title: 'Add statistics and concrete data',
    description:
      'Replace vague claims with numbers: percentages, benchmarks, dates, measured results. Engines prefer passages that carry verifiable data points.',
    impact: '~25–37% visibility gain in the GEO study.',
    source: 'both',
    analyzerFactor: 'statistics',
  },
  {
    id: 'fluency-optimization',
    title: 'Optimize fluency and readability',
    description:
      'Short, active, well-connected sentences; no filler or marketing fluff. Fluent passages are easier for an engine to quote verbatim or summarize faithfully.',
    impact: '~15–30% visibility gain in the GEO study.',
    source: 'princeton-geo-paper',
    analyzerFactor: 'fluency_readability',
  },
  {
    id: 'extractable-structure',
    title: 'Structure content into extractable chunks',
    description:
      'Clear H2/H3 hierarchy, lists, tables, short paragraphs. Each section should stand alone and answer one question — engines retrieve passages, not whole pages.',
    impact: 'Core practitioner lever: AI systems favor clearly structured, extractable content.',
    source: 'evergreen-media-guide',
    analyzerFactor: 'structure',
  },
  {
    id: 'answer-first',
    title: 'Answer first, elaborate after',
    description:
      'Open each section (and the page) with the direct, concise answer to the question in the heading; add FAQ blocks for long-tail questions.',
    impact: 'Raises the chance a passage is selected as the answer seed; also wins featured snippets.',
    source: 'evergreen-media-guide',
    analyzerFactor: 'direct_answers',
  },
  {
    id: 'entity-building',
    title: 'Build a clear, consistent brand entity',
    description:
      'Define who/what the brand is in one sentence, use one canonical name everywhere, and keep facts (offer, location, positioning) identical across your site, Wikipedia/Wikidata, LinkedIn, directories and PR.',
    impact: 'First of the three Evergreen Media building blocks (entity → validation → community).',
    source: 'evergreen-media-guide',
    analyzerFactor: 'entity_clarity',
  },
  {
    id: 'eeat-validation',
    title: 'Show E-E-A-T: authors, dates, first-hand experience',
    description:
      'Named authors with credentials, visible publish/update dates, first-hand test results ("we measured", "in our lab"). Third-party validation (reviews, mentions, awards) reinforces it off-page.',
    impact: 'Second Evergreen Media building block; strong E-E-A-T raises citation likelihood.',
    source: 'evergreen-media-guide',
    analyzerFactor: 'eeat_freshness',
  },
  {
    id: 'schema-markup',
    title: 'Add schema.org structured data',
    description:
      'JSON-LD for Article, FAQPage, HowTo, Product, Organization. Structured data disambiguates entities and helps retrieval systems map content to intents.',
    impact: 'Supporting technical signal for search-based and hybrid engines.',
    source: 'evergreen-media-guide',
    analyzerFactor: 'schema_markup',
  },
  {
    id: 'no-keyword-stuffing',
    title: 'Avoid keyword stuffing',
    description:
      'Repeating the target keyword does not help generative engines and measurably hurts: stuffed passages read as low-quality and get skipped.',
    impact: 'Net NEGATIVE (~-10%) in the GEO study — the only tested technique that reduced visibility.',
    source: 'princeton-geo-paper',
    analyzerFactor: 'keyword_hygiene',
  },
  {
    id: 'ai-crawler-access',
    title: 'Let AI crawlers in',
    description:
      'Search-based engines can only cite what their bots may fetch. Check robots.txt for GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended & co. — blocking them silently removes you from AI answers.',
    impact: 'Binary gate: blocked crawler = zero visibility in that engine.',
    source: 'evergreen-media-guide',
  },
  {
    id: 'community-presence',
    title: 'Be present where engines source opinions',
    description:
      'Reddit, YouTube, Stack Overflow, GitHub, review portals and comparison sites are heavily represented in both training data and retrieval results. Genuine community presence feeds both engine types.',
    impact: 'Third Evergreen Media building block; off-page, so not scored by the analyzer.',
    source: 'evergreen-media-guide',
  },
  {
    id: 'keep-classic-seo',
    title: 'Keep classic SEO healthy',
    description:
      'GEO is a layer on top of SEO, not a replacement: retrieval-based engines pull from search indexes, so crawlability, indexation and rankings still gate AI citations.',
    impact: 'Foundation — pages that do not rank rarely get retrieved, and thus rarely cited.',
    source: 'evergreen-media-guide',
  },
];

/**
 * AI crawlers relevant for GEO. `purpose` distinguishes model-training
 * crawlers from search/answer-retrieval bots — many sites block training bots
 * but MUST allow search bots to stay citable in AI answers.
 */
export interface AiCrawler {
  userAgent: string;
  operator: string;
  purpose: 'training' | 'search' | 'user-request';
  affects: string;
}

export const AI_CRAWLERS: AiCrawler[] = [
  { userAgent: 'GPTBot', operator: 'OpenAI', purpose: 'training', affects: 'ChatGPT model knowledge' },
  { userAgent: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'search', affects: 'ChatGPT search citations' },
  { userAgent: 'ChatGPT-User', operator: 'OpenAI', purpose: 'user-request', affects: 'ChatGPT live page visits' },
  { userAgent: 'ClaudeBot', operator: 'Anthropic', purpose: 'training', affects: 'Claude model knowledge' },
  { userAgent: 'Claude-User', operator: 'Anthropic', purpose: 'user-request', affects: 'Claude web browsing' },
  { userAgent: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'search', affects: 'Claude search citations' },
  { userAgent: 'PerplexityBot', operator: 'Perplexity', purpose: 'search', affects: 'Perplexity answers + citations' },
  { userAgent: 'Perplexity-User', operator: 'Perplexity', purpose: 'user-request', affects: 'Perplexity live page visits' },
  { userAgent: 'Google-Extended', operator: 'Google', purpose: 'training', affects: 'Gemini model knowledge (not Search ranking)' },
  { userAgent: 'Googlebot', operator: 'Google', purpose: 'search', affects: 'Google Search + AI Overviews / AI Mode' },
  { userAgent: 'Bingbot', operator: 'Microsoft', purpose: 'search', affects: 'Bing + Copilot answers (also feeds ChatGPT search)' },
  { userAgent: 'CCBot', operator: 'Common Crawl', purpose: 'training', affects: 'Many open-model training corpora' },
  { userAgent: 'Applebot-Extended', operator: 'Apple', purpose: 'training', affects: 'Apple Intelligence training' },
  { userAgent: 'Meta-ExternalAgent', operator: 'Meta', purpose: 'training', affects: 'Llama training data' },
  { userAgent: 'Amazonbot', operator: 'Amazon', purpose: 'search', affects: 'Alexa / Rufus answers' },
  { userAgent: 'Bytespider', operator: 'ByteDance', purpose: 'training', affects: 'Doubao model training' },
  { userAgent: 'MistralAI-User', operator: 'Mistral', purpose: 'user-request', affects: 'Le Chat live page visits' },
];

/** KPI definitions for the ranking test (Evergreen Media measurement loop). */
export interface GeoKpi {
  id: string;
  label: string;
  definition: string;
}

export const GEO_KPIS: GeoKpi[] = [
  {
    id: 'mention_rate',
    label: 'Mention rate',
    definition: 'Share of monitored prompts whose AI answer mentions the brand at all.',
  },
  {
    id: 'share_of_voice',
    label: 'Share of voice',
    definition: 'Brand mentions divided by all tracked brand + competitor mentions across answers.',
  },
  {
    id: 'citation_rate',
    label: 'Citation rate',
    definition: 'Share of answers that reference one of the brand’s own domains as a source.',
  },
  {
    id: 'avg_position',
    label: 'Average position',
    definition: 'Where in the answer the brand first appears (earlier = more prominent).',
  },
  {
    id: 'sentiment',
    label: 'Sentiment',
    definition: 'Tone of the context around brand mentions (positive / neutral / negative).',
  },
  {
    id: 'visibility_score',
    label: 'Visibility score',
    definition: 'Composite 0–100 per answer: mentioned + early + cited + ranked before competitors.',
  },
];
