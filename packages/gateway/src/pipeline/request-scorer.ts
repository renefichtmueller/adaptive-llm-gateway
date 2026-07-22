/**
 * 23-Dimension Request Scoring Algorithm
 * Adapted from mnfst/manifest router (MIT licensed).
 *
 * Scores incoming LLM requests across 14 keyword dimensions and
 * 9 structural dimensions to determine the optimal model tier.
 */

import { KeywordTrie } from './keyword-trie.js';
import type { DimensionMatches } from './keyword-trie.js';
import { logger } from '../observability/logger.js';

// ── Public Types ───────────────────────────────────────────────────────────

export type Tier = 'fast' | 'medium' | 'large' | 'reasoning' | 'code_generation';

export interface ScorerInput {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly tools?: readonly unknown[];
  readonly tool_choice?: string;
  readonly max_tokens?: number;
}

export interface DimensionScore {
  readonly name: string;
  readonly rawScore: number;
  readonly weight: number;
  readonly weighted: number;
}

export interface ScoringResult {
  readonly tier: Tier;
  readonly score: number;
  readonly confidence: number;
  readonly reason: string;
  readonly dimensions: readonly DimensionScore[];
}

// ── Dimension Direction ────────────────────────────────────────────────────

type Direction = 'up' | 'down';

interface DimensionDef {
  readonly name: string;
  readonly weight: number;
  readonly direction: Direction;
}

// ── Keyword Dimension Definitions ──────────────────────────────────────────

const KEYWORD_DIMENSIONS: ReadonlyArray<DimensionDef & { readonly keywords: readonly string[] }> = [
  {
    name: 'formalLogic',
    weight: 0.07,
    direction: 'up',
    keywords: [
      'prove', 'theorem', 'lemma', 'axiom', 'qed', 'contradiction', 'corollary', 'iff',
      'proof by induction', 'proof by contradiction', 'first order logic', 'predicate logic',
      'propositional logic', 'modus ponens', 'modus tollens', 'syllogism', 'tautology',
      'satisfiability', 'entailment', 'formal verification', 'deductive', 'inductive proof',
      'logical equivalence', 'boolean algebra', 'quantifier', 'existential', 'universal quantifier',
    ],
  },
  {
    name: 'analyticalReasoning',
    weight: 0.06,
    direction: 'up',
    keywords: [
      'compare', 'evaluate', 'trade-offs', 'analyze', 'implications', 'pros and cons',
      'advantages', 'disadvantages', 'cost-benefit', 'risk assessment', 'swot analysis',
      'root cause', 'correlate', 'causation', 'benchmark', 'metrics', 'kpi',
      'hypothesis', 'conclusion', 'evidence', 'assessment', 'critique', 'weigh',
      'consider the impact', 'long-term effects', 'short-term effects',
    ],
  },
  {
    name: 'codeGeneration',
    weight: 0.06,
    direction: 'up',
    keywords: [
      'write a function', 'implement', 'create a class', 'scaffold', 'boilerplate',
      'write code', 'generate code', 'code snippet', 'write a script', 'write a module',
      'create an api', 'build a component', 'write a test', 'implement the interface',
      'create a service', 'write a handler', 'write middleware', 'generate types',
      'write a query', 'create a schema', 'implement crud', 'write unit test',
      'create endpoint', 'write migration', 'scaffold project',
      // Flexible phrasings — the keyword trie matches contiguous substrings, so
      // "write a function" misses "write a TypeScript function"; these catch the
      // common "<verb> a <lang> function/script/component/class …" prompts.
      'function that', 'script that', 'class that', 'react component',
      'vue component', 'create a component', 'create a react', 'python script',
      'write a program', 'write a class',
    ],
  },
  {
    name: 'codeReview',
    weight: 0.05,
    direction: 'up',
    keywords: [
      'fix this bug', 'debug', 'refactor', 'race condition', 'memory leak', 'code review',
      'null pointer', 'segfault', 'stack overflow', 'deadlock', 'infinite loop',
      'off by one', 'type error', 'runtime error', 'compile error', 'syntax error',
      'performance issue', 'bottleneck', 'optimize', 'code smell', 'technical debt',
      'security vulnerability', 'injection', 'xss', 'csrf', 'buffer overflow',
    ],
  },
  {
    name: 'technicalTerms',
    weight: 0.07,
    direction: 'up',
    keywords: [
      'kubernetes', 'algorithm', 'encryption', 'graphql', 'docker', 'postgresql', 'api',
      'microservice', 'distributed system', 'load balancer', 'reverse proxy', 'nginx',
      'terraform', 'ansible', 'ci/cd', 'pipeline', 'container', 'orchestration',
      'message queue', 'kafka', 'redis', 'elasticsearch', 'mongodb', 'grpc',
      'websocket', 'rest api', 'oauth', 'jwt', 'ssl', 'tls', 'dns', 'cdn',
      'serverless', 'lambda', 'cloudflare workers', 'wasm', 'webassembly',
      'machine learning', 'neural network', 'transformer', 'embedding', 'vector database',
    ],
  },
  {
    name: 'simpleIndicators',
    weight: 0.08,
    direction: 'down',
    keywords: [
      'what is', 'translate', 'thanks', 'hi', 'bye', 'ok', 'hello', 'yes', 'no',
      'thank you', 'good morning', 'good night', 'please', 'sure', 'fine',
      'sounds good', 'got it', 'understood', 'cool', 'great', 'nice',
      'define', 'meaning of', 'who is', 'when was', 'where is',
      'how do you say', 'spell', 'abbreviation', 'acronym',
    ],
  },
  {
    name: 'multiStep',
    weight: 0.07,
    direction: 'up',
    keywords: [
      'first', 'then', 'after that', 'step 1', 'workflow', 'pipeline', 'phase',
      'next step', 'followed by', 'subsequently', 'step 2', 'step 3', 'step 4',
      'step by step', 'in sequence', 'procedure', 'process', 'stages',
      'prerequisites', 'dependencies', 'before this', 'once complete',
      'finally', 'lastly', 'in order to', 'chain of', 'sequential',
    ],
  },
  {
    name: 'creative',
    weight: 0.03,
    direction: 'up',
    keywords: [
      'story', 'poem', 'brainstorm', 'fiction', 'narrative', 'imagine',
      'creative writing', 'character', 'dialogue', 'plot', 'setting',
      'metaphor', 'simile', 'allegory', 'haiku', 'sonnet', 'limerick',
      'screenplay', 'monologue', 'worldbuilding', 'fantasy', 'sci-fi',
    ],
  },
  {
    name: 'questionComplexity',
    weight: 0.03,
    direction: 'up',
    keywords: [
      'how does x relate to y', 'what are the implications',
      'why would', 'under what circumstances', 'in what scenario',
      'what happens when', 'how would you approach', 'what factors',
      'how do these interact', 'what is the relationship between',
      'how might this affect', 'what would be the consequence',
      'can you explain the mechanism', 'what distinguishes',
    ],
  },
  {
    name: 'imperativeVerbs',
    weight: 0.02,
    direction: 'up',
    keywords: [
      'build', 'create', 'deploy', 'configure', 'install', 'setup',
      'construct', 'assemble', 'provision', 'initialize', 'bootstrap',
      'migrate', 'transform', 'convert', 'generate', 'compile', 'render',
      'launch', 'publish', 'release', 'ship', 'push', 'pull',
    ],
  },
  {
    name: 'outputFormat',
    weight: 0.02,
    direction: 'up',
    keywords: [
      'as json', 'in yaml', 'as csv', 'markdown', 'as a table', 'format as',
      'in xml', 'as html', 'as toml', 'structured output', 'in columns',
      'as a list', 'bullet points', 'numbered list', 'as code block',
      'return as object', 'output schema', 'response format',
    ],
  },
  {
    name: 'domainSpecificity',
    weight: 0.05,
    direction: 'up',
    keywords: [
      'p-value', 'regression', 'hipaa', 'gdpr', 'bayesian', 'eigenvalue',
      'transceiver', 'bgp', 'ospf', 'mpls', 'sfp', 'qsfp', 'cwdm', 'dwdm',
      'optical fiber', 'wavelength', 'attenuation', 'ber', 'snr',
      'peering', 'ix', 'ixp', 'route server', 'looking glass', 'as path',
      'rpki', 'roa', 'irr', 'peeringdb', 'autonomous system', 'asn',
      'fourier transform', 'laplace', 'differential equation', 'stochastic',
      'genome', 'proteomics', 'phylogenetic', 'bioinformatics',
      'compliance', 'sox', 'iso 27001', 'nist', 'cve', 'mitre',
    ],
  },
  {
    name: 'agenticTasks',
    weight: 0.03,
    direction: 'up',
    keywords: [
      'triage', 'audit', 'orchestrate', 'prioritize', 'migrate', 'automate',
      'coordinate', 'delegate', 'schedule', 'monitor', 'alert', 'escalate',
      'classify', 'categorize', 'route', 'dispatch', 'assign', 'queue',
      'batch process', 'parallel execution', 'fan out', 'aggregate results',
    ],
  },
  {
    name: 'relay',
    weight: 0.02,
    direction: 'down',
    keywords: [
      'forward to', 'just say', 'acknowledge', 'pass along',
      'relay this', 'send to', 'hand off', 'transfer to', 'redirect',
      'simply respond', 'just reply', 'repeat back', 'echo', 'mirror',
      'copy paste', 'forward this message',
    ],
  },
];

// ── Structural Dimension Definitions ───────────────────────────────────────

const STRUCTURAL_DIMENSIONS: readonly DimensionDef[] = [
  { name: 'tokenCount', weight: 0.05, direction: 'up' },
  { name: 'nestedListDepth', weight: 0.03, direction: 'up' },
  { name: 'conditionalLogic', weight: 0.03, direction: 'up' },
  { name: 'codeToProse', weight: 0.02, direction: 'up' },
  { name: 'constraintDensity', weight: 0.03, direction: 'up' },
  { name: 'expectedOutputLength', weight: 0.04, direction: 'up' },
  { name: 'repetitionRequests', weight: 0.02, direction: 'up' },
  { name: 'toolCount', weight: 0.04, direction: 'up' },
  { name: 'conversationDepth', weight: 0.03, direction: 'up' },
];

// ── Tier Boundaries ────────────────────────────────────────────────────────

const TIER_BOUNDARIES = {
  fast: -0.1,        // score < -0.1
  medium: 0.08,      // -0.1 <= score < 0.08
  large: 0.35,       // 0.08 <= score < 0.35
  reasoning: 0.55,   // 0.35 <= score < 0.55
  // code_generation: score >= 0.55
} as const;

// ── Session Momentum ───────────────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSION_HISTORY = 5;

interface SessionEntry {
  readonly tier: Tier;
  readonly timestamp: number;
}

const sessionState: SessionEntry[] = [];

// ── Build the Trie (singleton) ─────────────────────────────────────────────

function buildTrie(): KeywordTrie {
  const dimMap = new Map<string, readonly string[]>();
  for (const dim of KEYWORD_DIMENSIONS) {
    dimMap.set(dim.name, dim.keywords);
  }
  return new KeywordTrie(dimMap);
}

let trieInstance: KeywordTrie | null = null;

function getTrie(): KeywordTrie {
  if (!trieInstance) {
    trieInstance = buildTrie();
  }
  return trieInstance;
}

// ── Position-Weighted Text Extraction ──────────────────────────────────────

interface WeightedMessage {
  readonly text: string;
  readonly weight: number;
}

function extractUserMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly content: string }>,
): readonly WeightedMessage[] {
  const userMessages = messages.filter(
    (m) => m.role === 'user' && typeof m.content === 'string',
  );

  if (userMessages.length === 0) return [];

  const result: WeightedMessage[] = [];
  const lastIdx = userMessages.length - 1;

  for (let i = 0; i < userMessages.length; i++) {
    let weight: number;
    if (i === lastIdx) {
      weight = 1.0;
    } else if (i === lastIdx - 1) {
      weight = 0.5;
    } else {
      weight = 0.25;
    }
    result.push({ text: userMessages[i]!.content, weight });
  }

  return result;
}

// ── Keyword Scoring ────────────────────────────────────────────────────────

function scoreKeywordDimensions(
  weightedMessages: readonly WeightedMessage[],
): ReadonlyMap<string, number> {
  const trie = getTrie();
  const scores = new Map<string, number>();

  // Initialize all keyword dimensions to 0
  for (const dim of KEYWORD_DIMENSIONS) {
    scores.set(dim.name, 0);
  }

  for (const { text, weight } of weightedMessages) {
    const matches = trie.scan(text);
    const aggregated = trie.aggregate(matches);

    for (const [dimName, dimMatches] of aggregated) {
      const current = scores.get(dimName) ?? 0;
      const contribution = normalizeKeywordScore(dimMatches) * weight;
      scores.set(dimName, current + contribution);
    }
  }

  return scores;
}

/**
 * Normalize keyword match count into a 0..1 score.
 * Uses effectiveCount (includes density bonus).
 * 1 match = 0.3, 2 = 0.5, 3 = 0.7, 4 = 0.8, 5+ = 0.9, 8+ = 1.0
 */
function normalizeKeywordScore(dimMatches: DimensionMatches): number {
  const count = dimMatches.effectiveCount;
  if (count <= 0) return 0;
  if (count < 1) return 0.2;
  if (count < 2) return 0.3;
  if (count < 3) return 0.5;
  if (count < 4) return 0.7;
  if (count < 5) return 0.8;
  if (count < 8) return 0.9;
  return 1.0;
}

// ── Structural Dimension Scoring ───────────────────────────────────────────

function scoreStructuralDimensions(
  input: ScorerInput,
  fullText: string,
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();

  scores.set('tokenCount', scoreTokenCount(fullText));
  scores.set('nestedListDepth', scoreNestedListDepth(fullText));
  scores.set('conditionalLogic', scoreConditionalLogic(fullText));
  scores.set('codeToProse', scoreCodeToProse(fullText));
  scores.set('constraintDensity', scoreConstraintDensity(fullText));
  scores.set('expectedOutputLength', scoreExpectedOutputLength(fullText, input.max_tokens));
  scores.set('repetitionRequests', scoreRepetitionRequests(fullText));
  scores.set('toolCount', scoreToolCount(input.tools, input.tool_choice));
  scores.set('conversationDepth', scoreConversationDepth(input.messages));

  return scores;
}

function scoreTokenCount(text: string): number {
  const estimatedTokens = text.length / 4;
  if (estimatedTokens < 50) return -0.5;
  if (estimatedTokens < 200) return lerp(-0.5, 0, (estimatedTokens - 50) / 150);
  if (estimatedTokens < 500) return lerp(0, 0.3, (estimatedTokens - 200) / 300);
  return 0.5;
}

function scoreNestedListDepth(text: string): number {
  const lines = text.split('\n');
  let maxDepth = 0;

  for (const line of lines) {
    const match = line.match(/^(\s*)/);
    if (match && (line.trim().startsWith('-') || line.trim().startsWith('*') || /^\d+\./.test(line.trim()))) {
      const indent = match[1]!.length;
      const depth = Math.floor(indent / 2);
      maxDepth = Math.max(maxDepth, depth);
    }
  }

  if (maxDepth === 0) return 0;
  if (maxDepth === 1) return 0.3;
  if (maxDepth === 2) return 0.6;
  return 0.9;
}

function scoreConditionalLogic(text: string): number {
  const patterns = [
    /\bif\b.*\bthen\b/gi,
    /\bunless\b/gi,
    /\bdepending on\b/gi,
    /\bwhen\b.*\bthen\b/gi,
    /\bif\b.*\belse\b/gi,
    /\bonly if\b/gi,
    /\bprovided that\b/gi,
    /\bassuming\b/gi,
    /\bin case\b/gi,
    /\bcontingent on\b/gi,
    /\bcondition\b/gi,
    /\bwhereas\b/gi,
  ];

  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }

  if (count === 0) return 0;
  if (count <= 2) return 0.3;
  if (count <= 5) return 0.6;
  return 0.9;
}

function scoreCodeToProse(text: string): number {
  const codeBlockPattern = /```[\s\S]*?```/g;
  const codeBlocks = text.match(codeBlockPattern);
  if (!codeBlocks) return 0;

  const codeLength = codeBlocks.reduce((sum, block) => sum + block.length, 0);
  const ratio = codeLength / Math.max(text.length, 1);

  if (ratio < 0.1) return 0;
  if (ratio < 0.3) return 0.2;
  if (ratio < 0.5) return 0.4;
  if (ratio < 0.7) return 0.6;
  return 0.8;
}

function scoreConstraintDensity(text: string): number {
  const patterns = [
    /\bat most\b/gi,
    /\bmust be\b/gi,
    /\bexactly \d+/gi,
    /\bno more than\b/gi,
    /\bno fewer than\b/gi,
    /\bat least\b/gi,
    /\bminimum\b/gi,
    /\bmaximum\b/gi,
    /\brequired\b/gi,
    /\bmandatory\b/gi,
    /\bshall not\b/gi,
    /\bmust not\b/gi,
    /O\([^)]+\)/g,  // Big-O notation
    /\bcomplexity\b/gi,
    /\bbound\b/gi,
  ];

  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }

  const density = count / Math.max(text.length / 100, 1);
  if (density < 0.5) return 0;
  if (density < 1.5) return 0.3;
  if (density < 3) return 0.6;
  return 0.9;
}

function scoreExpectedOutputLength(text: string, maxTokens?: number): number {
  const longOutputPatterns = [
    /\bcomprehensive\b/gi,
    /\bdetailed\b/gi,
    /\bfull report\b/gi,
    /\bthorough\b/gi,
    /\bin-depth\b/gi,
    /\bexhaustive\b/gi,
    /\bcomplete analysis\b/gi,
    /\bfull breakdown\b/gi,
    /\bextensive\b/gi,
    /\ball aspects\b/gi,
    /\bevery detail\b/gi,
  ];

  let score = 0;
  for (const pattern of longOutputPatterns) {
    if (pattern.test(text)) {
      score += 0.15;
    }
  }

  if (maxTokens !== undefined && maxTokens > 8000) {
    score += 0.4;
  } else if (maxTokens !== undefined && maxTokens > 4000) {
    score += 0.2;
  }

  return Math.min(score, 1.0);
}

function scoreRepetitionRequests(text: string): number {
  const patterns = [
    /\b(\d+)\s*variations?\b/gi,
    /\b(\d+)\s*options?\b/gi,
    /\b(\d+)\s*alternatives?\b/gi,
    /\b(\d+)\s*examples?\b/gi,
    /\b(\d+)\s*versions?\b/gi,
    /\b(\d+)\s*different\b/gi,
    /\b(\d+)\s*ways?\b/gi,
    /\bmultiple\b/gi,
    /\bseveral\b/gi,
  ];

  let maxCount = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const num = match[1] ? parseInt(match[1], 10) : 3;
      maxCount = Math.max(maxCount, num);
    }
  }

  if (maxCount === 0) return 0;
  if (maxCount <= 2) return 0.2;
  if (maxCount <= 5) return 0.5;
  return 0.8;
}

function scoreToolCount(tools?: readonly unknown[], toolChoice?: string): number {
  const count = tools?.length ?? 0;
  let score: number;

  if (count === 0) {
    score = 0;
  } else if (count <= 2) {
    score = 0.1;
  } else if (count <= 5) {
    score = 0.3;
  } else if (count <= 10) {
    score = 0.6;
  } else {
    score = 0.9;
  }

  // Bonus for specific tool_choice (not "auto" or "none")
  if (toolChoice && toolChoice !== 'auto' && toolChoice !== 'none') {
    score += 0.2;
  }

  return Math.min(score, 1.0);
}

function scoreConversationDepth(
  messages: ReadonlyArray<{ readonly role: string; readonly content: string }>,
): number {
  const count = messages.length;
  if (count <= 2) return 0;
  if (count <= 5) return 0.1;
  if (count <= 10) return 0.3;
  if (count <= 20) return 0.5;
  return 0.7;
}

// ── Session Momentum ───────────────────────────────────────────────────────

const TIER_NUMERIC: Record<Tier, number> = {
  fast: -0.2,
  medium: 0.0,
  large: 0.2,
  reasoning: 0.5,
  code_generation: 0.7,
};

function computeSessionMomentum(charCount: number): number {
  const now = Date.now();

  // Prune expired entries
  while (sessionState.length > 0 && now - sessionState[0]!.timestamp > SESSION_TTL_MS) {
    sessionState.shift();
  }

  if (sessionState.length === 0) return 0;

  // Determine momentum weight based on message length
  let momentumWeight: number;
  if (charCount < 30) {
    momentumWeight = 0.45; // midpoint of 0.3-0.6
  } else if (charCount < 100) {
    momentumWeight = lerp(0.3, 0, (charCount - 30) / 70);
  } else {
    momentumWeight = 0;
  }

  if (momentumWeight === 0) return 0;

  // Average recent tier scores
  const avgTierScore =
    sessionState.reduce((sum, e) => sum + TIER_NUMERIC[e.tier], 0) / sessionState.length;

  return avgTierScore * momentumWeight;
}

function recordSessionTier(tier: Tier): void {
  sessionState.push({ tier, timestamp: Date.now() });
  while (sessionState.length > MAX_SESSION_HISTORY) {
    sessionState.shift();
  }
}

// ── Formal Logic Override Check ────────────────────────────────────────────

const FORMAL_LOGIC_KEYWORDS = new Set(
  KEYWORD_DIMENSIONS.find((d) => d.name === 'formalLogic')!.keywords.map((k) => k.toLowerCase()),
);

function hasFormalLogicKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  for (const keyword of FORMAL_LOGIC_KEYWORDS) {
    const idx = lower.indexOf(keyword);
    if (idx === -1) continue;
    // Word boundary check
    const before = idx > 0 ? lower.charCodeAt(idx - 1) : 32;
    const after = idx + keyword.length < lower.length ? lower.charCodeAt(idx + keyword.length) : 32;
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
  }
  return false;
}

function isWordChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95
  );
}

// ── Confidence Calculation ─────────────────────────────────────────────────

function computeConfidence(score: number): number {
  const boundaries = [TIER_BOUNDARIES.fast, TIER_BOUNDARIES.medium, TIER_BOUNDARIES.large];
  let minDist = Infinity;

  for (const boundary of boundaries) {
    const dist = Math.abs(score - boundary);
    if (dist < minDist) minDist = dist;
  }

  // Sigmoid: 1 / (1 + exp(-8 * minDist))
  return 1 / (1 + Math.exp(-8 * minDist));
}

// ── Tier Assignment ────────────────────────────────────────────────────────

function assignTier(score: number): Tier {
  if (score < TIER_BOUNDARIES.fast) return 'fast';
  if (score < TIER_BOUNDARIES.medium) return 'medium';
  if (score < TIER_BOUNDARIES.large) return 'large';
  if (score < TIER_BOUNDARIES.reasoning) return 'reasoning';
  return 'code_generation';
}

// ── Helper: Short Message Fast Path ────────────────────────────────────────

function handleShortMessageFastPath(
  lastUserText: string,
  input: ScorerInput,
): ScoringResult | null {
  if (
    lastUserText.length < 50 &&
    (!input.tools || input.tools.length === 0) &&
    !hasFormalLogicKeyword(lastUserText)
  ) {
    const quickMatches = getTrie().scan(lastUserText);
    const quickAgg = getTrie().aggregate(quickMatches);
    const hasComplex = Array.from(quickAgg.values()).some(
      (d) => d.dimension !== 'simpleIndicators' && d.dimension !== 'relay' && d.effectiveCount > 0,
    );

    if (!hasComplex) {
      const result: ScoringResult = {
        tier: 'medium',
        score: 0.05,
        confidence: 0.8,
        reason: 'short message - simple request',
        dimensions: [],
      };
      recordSessionTier('medium');
      logger.debug({ tier: 'medium', reason: 'short_simple_path' }, 'Request scored via short simple path');
      return result;
    }
  }
  return null;
}

// ── Helper: Formal Logic Override ──────────────────────────────────────────

function handleFormalLogicOverride(
  fullText: string,
  input: ScorerInput,
  userMessages: readonly WeightedMessage[],
): ScoringResult | null {
  if (!hasFormalLogicKeyword(fullText)) {
    return null;
  }
  const dimensions = computeAllDimensions(input, userMessages, fullText);
  const result: ScoringResult = {
    tier: 'reasoning',
    score: 0.5,
    confidence: 0.95,
    reason: 'formal logic keyword detected',
    dimensions,
  };
  recordSessionTier('reasoning');
  logger.debug({ tier: 'reasoning', reason: 'formal_logic_override' }, 'Request scored via formal logic override');
  return result;
}

// ── Helper: Apply Score Overrides ──────────────────────────────────────────

interface ScoreOverridesInput {
  tier: Tier;
  score: number;
  confidence: number;
  reason: string;
}

interface ScoreOverridesOutput {
  tier: Tier;
  score: number;
  confidence: number;
  reason: string;
}

function applyScoreOverrides(
  state: ScoreOverridesInput,
  dimensions: readonly DimensionScore[],
  input: ScorerInput,
  totalChars: number,
): ScoreOverridesOutput {
  let { tier, score, confidence, reason } = state;

  // Tool floor
  if (input.tools && input.tools.length > 0 && tier === 'fast') {
    tier = 'medium';
    reason = 'tool floor applied (minimum medium with tools)';
  }

  // Context floor
  const estimatedTotalTokens = totalChars / 4;
  if (estimatedTotalTokens > 50_000 && (tier === 'fast' || tier === 'medium')) {
    tier = 'large';
    reason = 'context floor applied (>50k estimated tokens)';
  }

  // Ambiguity check
  if (confidence < 0.45) {
    tier = 'medium';
    reason = 'ambiguous (confidence < 0.45, defaulting to medium)';
  }

  // Code generation override — authoritative, runs last so a detected code-gen
  // signal wins over the tool/context/ambiguity floors above (a short but clear
  // "write a function …" must not be demoted to medium). When it fires we also
  // pin score + confidence into the code_generation band so all three agree.
  const codeGenDim = dimensions.find((d) => d.name === 'codeGeneration');
  if (codeGenDim && codeGenDim.rawScore > 0.25) {
    tier = 'code_generation';
    reason = 'code generation keywords detected';
    score = Math.max(score, TIER_BOUNDARIES.reasoning + 0.01);
    confidence = Math.max(confidence, 0.8);
  }

  return { tier, score, confidence, reason };
}

// ── Main Scoring Function ──────────────────────────────────────────────────

export function scoreRequest(
  input: ScorerInput,
  _sessionHistory?: readonly string[],
): ScoringResult {
  const userMessages = extractUserMessages(input.messages);
  const fullText = userMessages.map((m) => m.text).join('\n');
  const lastUserText = userMessages.length > 0 ? userMessages[userMessages.length - 1]!.text : '';

  const shortPathResult = handleShortMessageFastPath(lastUserText, input);
  if (shortPathResult) return shortPathResult;

  const formalLogicResult = handleFormalLogicOverride(fullText, input, userMessages);
  if (formalLogicResult) return formalLogicResult;

  const dimensions = computeAllDimensions(input, userMessages, fullText);
  let rawScore = 0;
  for (const dim of dimensions) {
    rawScore += dim.weighted;
  }

  const momentum = computeSessionMomentum(lastUserText.length);
  let score = rawScore + momentum;

  let tier = assignTier(score);
  let confidence = computeConfidence(score);
  let reason = `scored ${score.toFixed(4)} across 23 dimensions`;

  const totalChars = input.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const overrides = applyScoreOverrides({ tier, score, confidence, reason }, dimensions, input, totalChars);
  ({ tier, score, confidence, reason } = overrides);

  recordSessionTier(tier);

  logger.debug(
    { tier, score: score.toFixed(4), confidence: confidence.toFixed(3), reason, momentum: momentum.toFixed(4) },
    'Request scored',
  );

  return { tier, score, confidence, reason, dimensions };
}

// ── Compute All 23 Dimensions ──────────────────────────────────────────────

function computeAllDimensions(
  input: ScorerInput,
  weightedMessages: readonly WeightedMessage[],
  fullText: string,
): DimensionScore[] {
  const keywordScores = scoreKeywordDimensions(weightedMessages);
  const structuralScores = scoreStructuralDimensions(input, fullText);

  const dimensions: DimensionScore[] = [];

  // Keyword dimensions
  for (const dim of KEYWORD_DIMENSIONS) {
    const rawScore = keywordScores.get(dim.name) ?? 0;
    const directedScore = dim.direction === 'down' ? -rawScore : rawScore;
    const weighted = directedScore * dim.weight;
    dimensions.push({
      name: dim.name,
      rawScore,
      weight: dim.weight,
      weighted,
    });
  }

  // Structural dimensions
  for (const dim of STRUCTURAL_DIMENSIONS) {
    const rawScore = structuralScores.get(dim.name) ?? 0;
    const directedScore = dim.direction === 'down' ? -rawScore : rawScore;
    const weighted = directedScore * dim.weight;
    dimensions.push({
      name: dim.name,
      rawScore,
      weight: dim.weight,
      weighted,
    });
  }

  return dimensions;
}

// ── Utility ────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}
