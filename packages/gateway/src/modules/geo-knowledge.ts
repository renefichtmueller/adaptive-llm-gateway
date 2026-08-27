/**
 * GEO/AEO/LLMO Knowledge Base — the AI-visibility discipline family
 * -----------------------------------------------------------------
 * Embedded, machine-readable distillation of the disciplines that decide
 * whether AI systems recommend a brand: GEO (Generative Engine Optimization,
 * being cited in generated answers), AEO (Answer Engine Optimization, being
 * THE direct answer in snippets/voice/quick answers) and LLMO (Large Language
 * Model Optimization, being known by the models themselves) — all layered on
 * top of classic SEO, never replacing it.
 *
 * Sources this catalogue is distilled from:
 *  - Evergreen Media guides: GEO (https://www.evergreen.media/ratgeber/generative-engine-optimization/),
 *    AEO (https://www.evergreen.media/en/guide/answer-engine-optimization/),
 *    LLMO (https://www.evergreen.media/en/guide/large-language-model-optimization/),
 *    AI visibility (https://www.evergreen.media/en/guide/ai-search-visibility/)
 *  - Aggarwal et al., "GEO: Generative Engine Optimization", KDD 2024
 *    (https://arxiv.org/abs/2311.09735) — the Princeton/IIT-Delhi study that
 *    measured which content changes raise visibility in generative answers.
 *
 * Consumed by geo-analyzer.ts (factor weights, discipline lenses, crawler
 * list), geo-optimizer.ts (technique instructions for the rewrite prompt) and
 * served raw via GET /v1/geo/knowledge so dashboards and agents can
 * self-serve the playbook.
 */

/** The AI-visibility discipline family. */
export type AiVisibilityDiscipline = 'seo' | 'aeo' | 'geo' | 'llmo';

/** Where a technique / claim comes from. */
export type GeoSourceId =
  | 'evergreen-media-guide'
  | 'evergreen-media-aeo-guide'
  | 'evergreen-media-llmo-guide'
  | 'princeton-geo-paper'
  | 'both'
  | 'industry-practice';

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
    id: 'evergreen-media-aeo-guide',
    title: 'Evergreen Media — Answer Engine Optimization (AEO) guide',
    url: 'https://www.evergreen.media/en/guide/answer-engine-optimization/',
    note: 'Being THE direct answer: question-based content, concise liftable answer blocks, FAQ/QA structured data — for featured snippets, People Also Ask, voice assistants and AI quick answers.',
  },
  {
    id: 'evergreen-media-llmo-guide',
    title: 'Evergreen Media — Large Language Model Optimization (LLMO) guide',
    url: 'https://www.evergreen.media/en/guide/large-language-model-optimization/',
    note: 'Being known by the model itself: entity presence in the corpora LLMs train on (Wikipedia/Wikidata, news, communities), consistent brand facts, digital PR.',
  },
  {
    id: 'evergreen-media-ai-visibility',
    title: 'Evergreen Media — AI visibility guide',
    url: 'https://www.evergreen.media/en/guide/ai-search-visibility/',
    note: 'Umbrella framing: AI visibility is built from entity, validation and community — and SEO vs. GEO/AEO is a false dichotomy, they are layers of one funnel.',
  },
  {
    id: 'princeton-geo-paper',
    title: 'GEO: Generative Engine Optimization (Aggarwal et al., KDD 2024)',
    url: 'https://arxiv.org/abs/2311.09735',
    note: 'Benchmark of ~10k queries showing content-side optimizations lift visibility in generative answers by up to ~40%; quotations, statistics and cited sources were the strongest levers, keyword stuffing was net negative.',
  },
  {
    id: 'llmstxt-spec',
    title: 'llms.txt specification',
    url: 'https://llmstxt.org/',
    note: 'Emerging convention: a markdown file at /llms.txt that gives LLMs a curated overview of the site — analogous to robots.txt, but for content discovery instead of access control.',
  },
];

/**
 * The discipline family. Not alternatives — layers of one funnel
 * (Evergreen Media: "SEO vs. GEO ist ein Denkfehler").
 */
export interface AiVisibilityDisciplineInfo {
  id: AiVisibilityDiscipline;
  label: string;
  goal: string;
  surfaces: string[];
  keyLevers: string[];
  relationship: string;
}

export const GEO_DISCIPLINES: AiVisibilityDisciplineInfo[] = [
  {
    id: 'seo',
    label: 'SEO — Search Engine Optimization',
    goal: 'Rank in classic search results so both humans and retrieval-based AI engines find the content.',
    surfaces: ['Google/Bing SERPs', 'the search indexes RAG engines retrieve from'],
    keyLevers: ['crawlability & indexation', 'rankings for target queries', 'internal linking', 'page performance'],
    relationship: 'The foundation: retrieval-based AI engines pull from search indexes, so pages that do not rank rarely get retrieved — and thus rarely cited.',
  },
  {
    id: 'aeo',
    label: 'AEO — Answer Engine Optimization',
    goal: 'Be THE direct answer an engine lifts verbatim: featured snippets, People Also Ask, voice assistants, AI quick answers.',
    surfaces: ['Google featured snippets & PAA', 'voice assistants (Assistant, Siri, Alexa)', 'AI quick-answer boxes'],
    keyLevers: ['question-phrased headings', '40–60-word liftable answer blocks', 'FAQ/QAPage/Speakable/HowTo schema', 'conversational phrasing'],
    relationship: 'Sharpens SEO content into extractable answers; the same answer-first blocks are what generative engines quote, so AEO feeds GEO directly.',
  },
  {
    id: 'geo',
    label: 'GEO — Generative Engine Optimization',
    goal: 'Be cited and recommended inside AI-generated answers.',
    surfaces: ['ChatGPT (incl. search)', 'Perplexity', 'Google AI Overviews / AI Mode', 'Gemini', 'Copilot'],
    keyLevers: ['statistics & data points', 'attributed quotes', 'cited sources', 'fluent extractable passages', 'AI-crawler access'],
    relationship: 'The citation layer on top of SEO/AEO: content must not just rank and answer — it must be safe and attractive for an engine to reuse and attribute.',
  },
  {
    id: 'llmo',
    label: 'LLMO — Large Language Model Optimization',
    goal: 'Be known (and described correctly) by the models themselves, even without live retrieval.',
    surfaces: ['parametric answers of ChatGPT/Claude/Gemini/Llama', 'training-based local models'],
    keyLevers: ['Wikipedia/Wikidata presence', 'consistent entity facts everywhere', 'digital PR & brand mentions in authoritative corpora', 'community presence (Reddit, YouTube, Stack Overflow, GitHub)'],
    relationship: 'The slowest, most durable layer: what the training corpus says about the brand becomes what every future model "knows". Mostly off-page work; measured by the ranking test, not the content analyzer.',
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
  /** Which disciplines of the family this technique serves. */
  disciplines: AiVisibilityDiscipline[];
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
    disciplines: ['geo'],
    analyzerFactor: 'quotations',
  },
  {
    id: 'cite-sources',
    title: 'Cite credible sources',
    description:
      'Reference and link authoritative sources (studies, standards bodies, official docs). Citations make passages verifiable and thus safer for an engine to reuse.',
    impact: '~30–40% visibility gain in the GEO study; also a core E-E-A-T signal.',
    source: 'both',
    disciplines: ['geo'],
    analyzerFactor: 'citations',
  },
  {
    id: 'statistics-addition',
    title: 'Add statistics and concrete data',
    description:
      'Replace vague claims with numbers: percentages, benchmarks, dates, measured results. Engines prefer passages that carry verifiable data points.',
    impact: '~25–37% visibility gain in the GEO study.',
    source: 'both',
    disciplines: ['geo'],
    analyzerFactor: 'statistics',
  },
  {
    id: 'fluency-optimization',
    title: 'Optimize fluency and readability',
    description:
      'Short, active, well-connected sentences; no filler or marketing fluff. Fluent passages are easier for an engine to quote verbatim or summarize faithfully.',
    impact: '~15–30% visibility gain in the GEO study.',
    source: 'princeton-geo-paper',
    disciplines: ['geo', 'aeo'],
    analyzerFactor: 'fluency_readability',
  },
  {
    id: 'extractable-structure',
    title: 'Structure content into extractable chunks',
    description:
      'Clear H2/H3 hierarchy, lists, tables, short paragraphs. Each section should stand alone and answer one question — engines retrieve passages, not whole pages.',
    impact: 'Core practitioner lever: AI systems favor clearly structured, extractable content.',
    source: 'evergreen-media-guide',
    disciplines: ['geo', 'aeo'],
    analyzerFactor: 'structure',
  },
  {
    id: 'answer-first',
    title: 'Answer first, elaborate after',
    description:
      'Open each section (and the page) with the direct, concise answer to the question in the heading; add FAQ blocks for long-tail questions.',
    impact: 'Raises the chance a passage is selected as the answer seed; also wins featured snippets.',
    source: 'evergreen-media-guide',
    disciplines: ['aeo', 'geo'],
    analyzerFactor: 'direct_answers',
  },
  {
    id: 'snippet-ready-answers',
    title: 'Format liftable 40–60-word answer blocks',
    description:
      'Directly under each question heading, give a self-contained answer of roughly 40–60 words that an engine can lift verbatim — the classic featured-snippet and voice-answer format. Details, caveats and examples follow after the block.',
    impact: 'The core AEO lever: snippet-format answers win featured snippets, People Also Ask and voice answers.',
    source: 'evergreen-media-aeo-guide',
    disciplines: ['aeo'],
    analyzerFactor: 'direct_answers',
  },
  {
    id: 'conversational-queries',
    title: 'Match conversational and voice queries',
    description:
      'Phrase headings and FAQ items the way people actually ask — full natural-language questions ("Wie viel kostet …?", "How do I …?") rather than keyword stubs. Voice assistants and chat engines match against conversational phrasing.',
    impact: 'Aligns content with how AI/voice queries are phrased; prerequisite for answer selection.',
    source: 'evergreen-media-aeo-guide',
    disciplines: ['aeo'],
    analyzerFactor: 'direct_answers',
  },
  {
    id: 'entity-building',
    title: 'Build a clear, consistent brand entity',
    description:
      'Define who/what the brand is in one sentence, use one canonical name everywhere, and keep facts (offer, location, positioning) identical across your site, Wikipedia/Wikidata, LinkedIn, directories and PR.',
    impact: 'First of the three Evergreen Media building blocks (entity → validation → community).',
    source: 'evergreen-media-guide',
    disciplines: ['llmo', 'geo'],
    analyzerFactor: 'entity_clarity',
  },
  {
    id: 'wikipedia-wikidata-presence',
    title: 'Establish Wikipedia/Wikidata presence',
    description:
      'Wikipedia and Wikidata are among the highest-weighted sources in LLM training corpora and knowledge graphs. A neutral, well-sourced entry (where notability allows) anchors what every model "knows" about the brand.',
    impact: 'Highest-leverage LLMO signal for parametric brand knowledge.',
    source: 'evergreen-media-llmo-guide',
    disciplines: ['llmo'],
  },
  {
    id: 'digital-pr-brand-mentions',
    title: 'Earn brand mentions in authoritative corpora',
    description:
      'Digital PR, trade press, industry studies and directories put the brand into the text corpora future models train on — with the framing you want. Unlinked mentions count too: models learn from text, not from backlinks.',
    impact: 'Second Evergreen Media building block (validation), applied off-page; compounds over model generations.',
    source: 'evergreen-media-llmo-guide',
    disciplines: ['llmo', 'geo'],
  },
  {
    id: 'eeat-validation',
    title: 'Show E-E-A-T: authors, dates, first-hand experience',
    description:
      'Named authors with credentials, visible publish/update dates, first-hand test results ("we measured", "in our lab"). Third-party validation (reviews, mentions, awards) reinforces it off-page.',
    impact: 'Second Evergreen Media building block; strong E-E-A-T raises citation likelihood.',
    source: 'evergreen-media-guide',
    disciplines: ['geo', 'llmo'],
    analyzerFactor: 'eeat_freshness',
  },
  {
    id: 'schema-markup',
    title: 'Add schema.org structured data',
    description:
      'JSON-LD for Article, FAQPage, QAPage, Speakable, HowTo, Product, Organization. Structured data disambiguates entities and helps answer/retrieval systems map content to intents.',
    impact: 'Supporting technical signal; FAQPage/QAPage/Speakable directly feed answer engines.',
    source: 'evergreen-media-guide',
    disciplines: ['aeo', 'seo'],
    analyzerFactor: 'schema_markup',
  },
  {
    id: 'no-keyword-stuffing',
    title: 'Avoid keyword stuffing',
    description:
      'Repeating the target keyword does not help generative engines and measurably hurts: stuffed passages read as low-quality and get skipped.',
    impact: 'Net NEGATIVE (~-10%) in the GEO study — the only tested technique that reduced visibility.',
    source: 'princeton-geo-paper',
    disciplines: ['geo', 'aeo', 'llmo'],
    analyzerFactor: 'keyword_hygiene',
  },
  {
    id: 'ai-crawler-access',
    title: 'Let AI crawlers in',
    description:
      'Search-based engines can only cite what their bots may fetch. Check robots.txt for GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended & co. — blocking them silently removes you from AI answers.',
    impact: 'Binary gate: blocked crawler = zero visibility in that engine.',
    source: 'evergreen-media-guide',
    disciplines: ['geo', 'aeo'],
  },
  {
    id: 'llms-txt',
    title: 'Publish an llms.txt overview',
    description:
      'The emerging llms.txt convention (markdown at /llms.txt: H1 title, one-line summary, curated link sections) gives LLM crawlers and agents a token-efficient map of your most citable pages. Low effort, growing adoption.',
    impact: 'Emerging signal — no measured lift yet, but it steers which pages agents read first.',
    source: 'industry-practice',
    disciplines: ['geo', 'aeo'],
  },
  {
    id: 'community-presence',
    title: 'Be present where engines source opinions',
    description:
      'Reddit, YouTube, Stack Overflow, GitHub, review portals and comparison sites are heavily represented in both training data and retrieval results. Genuine community presence feeds both engine types.',
    impact: 'Third Evergreen Media building block; off-page, so not scored by the analyzer.',
    source: 'evergreen-media-guide',
    disciplines: ['llmo', 'geo'],
  },
  {
    id: 'keep-classic-seo',
    title: 'Keep classic SEO healthy',
    description:
      'GEO/AEO/LLMO are layers on top of SEO, not replacements: retrieval-based engines pull from search indexes, so crawlability, indexation and rankings still gate AI citations.',
    impact: 'Foundation — pages that do not rank rarely get retrieved, and thus rarely cited.',
    source: 'evergreen-media-guide',
    disciplines: ['seo', 'geo', 'aeo'],
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
