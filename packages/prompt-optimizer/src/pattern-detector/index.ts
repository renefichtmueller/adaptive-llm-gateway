/**
 * Pattern Detector — 56 patterns: 35 from prompt-master + 21 from Stop-Slop
 * Detects prompt quality issues and AI writing tells
 * Stop-Slop integration: https://github.com/hardikpandya/stop-slop
 */

import { CreditKillingPattern, IntentDimensions, PromptQualityScore } from '../types';

export class PatternDetector {
  // Stop-Slop filler phrase detection (integrated from hardikpandya/stop-slop)
  private stopSlopPhrases = {
    throatClearing: [
      "here's the thing",
      "here's what",
      "here's this",
      "here's that",
      "here's why",
      'the uncomfortable truth is',
      'it turns out',
      'let me be clear',
      'the truth is',
      "i'll say it again",
      "i'm going to be honest",
      'can we talk about',
      "here's what i find interesting",
      "here's the problem though",
    ],
    emphasisCrutches: [
      'full stop',
      'period',
      'let that sink in',
      'this matters because',
      'make no mistake',
      "here's why that matters",
    ],
    businessJargon: [
      'navigate',
      'unpack',
      'lean into',
      'landscape',
      'game-changer',
      'double down',
      'deep dive',
      'take a step back',
      'moving forward',
      'circle back',
      'on the same page',
    ],
    adverbs: [
      'really',
      'just',
      'literally',
      'genuinely',
      'honestly',
      'simply',
      'actually',
      'deeply',
      'truly',
      'fundamentally',
      'inherently',
      'inevitably',
      'interestingly',
      'importantly',
      'crucially',
      'at its core',
      "it's worth noting",
      'at the end of the day',
      'when it comes to',
      'in a world where',
      'the reality is',
    ],
    metaCommentary: [
      'hint:',
      'plot twist:',
      'spoiler:',
      "you already know this, but",
      "but that's another post",
      'is a feature, not a bug',
      'dressed up as',
      'the rest of this essay',
      'let me walk you through',
      'in this section',
      "as we'll see",
      'i want to explore',
    ],
    binaryContrasts: [
      'not because',
      "isn't the problem",
      'the answer is not',
      "isn't this",
      "doesn't mean",
    ],
    falseAgency: [
      'becomes a fix',
      'lives or dies',
      'emerges',
      'the culture shifts',
      'the conversation moves',
      'the data tells us',
      'the market rewards',
      'the decision emerges',
    ],
    passiveVoice: ['was created', 'is believed', 'mistakes were made', 'was reached', 'was built'],
    emDashes: ['—'],
    lazySweeps: ['every', 'always', 'never', 'everyone', 'everybody', 'nobody'],
  };

  private patterns: CreditKillingPattern[] = [
    // AI Writing Patterns (21 - from Stop-Slop integration)
    {
      id: 36,
      category: 'ai-writing',
      pattern: 'Throat-clearing opener',
      before: "Here's what I find interesting: the problem",
      after: 'The problem is...',
      severity: 'high',
      impact: '1-2 wasted tokens',
    },
    {
      id: 37,
      category: 'ai-writing',
      pattern: 'Emphasis crutch (full stop)',
      before: 'This matters. Full stop.',
      after: 'This matters.',
      severity: 'medium',
      impact: 'Filler phrase',
    },
    {
      id: 38,
      category: 'ai-writing',
      pattern: 'Business jargon (navigate)',
      before: 'navigate the challenges',
      after: 'address the challenges',
      severity: 'medium',
      impact: 'AI tell',
    },
    {
      id: 39,
      category: 'ai-writing',
      pattern: 'Adverb softening (really)',
      before: 'really important',
      after: 'important',
      severity: 'medium',
      impact: 'Filler emphasis',
    },
    {
      id: 40,
      category: 'ai-writing',
      pattern: 'Meta-commentary (rest of this)',
      before: 'The rest of this essay explores',
      after: 'Now explore...',
      severity: 'high',
      impact: 'Self-referential',
    },
    {
      id: 41,
      category: 'ai-writing',
      pattern: 'Binary contrast (not X, is Y)',
      before: 'Not a bug. A feature.',
      after: 'This is a feature.',
      severity: 'high',
      impact: 'Formulaic',
    },
    {
      id: 42,
      category: 'ai-writing',
      pattern: 'False agency (emerges)',
      before: 'the solution emerges',
      after: 'we discover the solution',
      severity: 'medium',
      impact: 'Passive voice',
    },
    {
      id: 43,
      category: 'ai-writing',
      pattern: 'Passive voice (was created)',
      before: 'was created by the team',
      after: 'the team created',
      severity: 'medium',
      impact: 'Weak voice',
    },
    {
      id: 44,
      category: 'ai-writing',
      pattern: 'Em-dash usage',
      before: 'This is important — pay attention',
      after: 'This is important. Pay attention.',
      severity: 'low',
      impact: 'Stylistic',
    },
    {
      id: 45,
      category: 'ai-writing',
      pattern: 'Lazy sweep (always)',
      before: 'always remember to',
      after: 'remember to (when relevant)',
      severity: 'low',
      impact: 'Overstatement',
    },
    {
      id: 46,
      category: 'ai-writing',
      pattern: 'Wh- sentence starter',
      before: 'What makes this hard is the constraint',
      after: 'The constraint is what makes this hard',
      severity: 'low',
      impact: 'Awkward flow',
    },
    {
      id: 47,
      category: 'ai-writing',
      pattern: 'Three-item list rhythm',
      before: 'Option A, Option B, and Option C',
      after: 'Option A and Option B',
      severity: 'low',
      impact: 'Rhythm',
    },
    {
      id: 48,
      category: 'ai-writing',
      pattern: 'Narrator-from-distance (Nobody)',
      before: 'Nobody designed this badly',
      after: 'You did not design this badly',
      severity: 'medium',
      impact: 'Disembodied voice',
    },
    {
      id: 49,
      category: 'ai-writing',
      pattern: 'At the end of the day',
      before: 'At the end of the day, this matters',
      after: 'This matters.',
      severity: 'medium',
      impact: 'Filler phrase',
    },
    {
      id: 50,
      category: 'ai-writing',
      pattern: 'Unpack (vague verb)',
      before: 'Let me unpack this',
      after: 'Let me explain this',
      severity: 'low',
      impact: 'Business jargon',
    },
    {
      id: 51,
      category: 'ai-writing',
      pattern: 'In a world where (cliche)',
      before: 'In a world where everything is changing',
      after: 'As everything changes',
      severity: 'low',
      impact: 'AI cliche',
    },
    {
      id: 52,
      category: 'ai-writing',
      pattern: 'Performative emphasis (I promise)',
      before: 'I promise, this matters',
      after: 'This matters.',
      severity: 'low',
      impact: 'False intimacy',
    },
    {
      id: 53,
      category: 'ai-writing',
      pattern: 'This is what X actually looks like',
      before: 'This is what leadership actually looks like',
      after: 'Leadership is [specific example]',
      severity: 'medium',
      impact: 'Telling not showing',
    },
    {
      id: 54,
      category: 'ai-writing',
      pattern: 'Vague declarative (implications)',
      before: 'The implications are significant',
      after: 'This means [specific outcome]',
      severity: 'high',
      impact: 'No substance',
    },
    {
      id: 55,
      category: 'ai-writing',
      pattern: 'Sentence fragment emphasis',
      before: 'This matters. That is all.',
      after: 'This matters.',
      severity: 'low',
      impact: 'Manufactured drama',
    },
    {
      id: 56,
      category: 'ai-writing',
      pattern: 'Can we talk about (setup)',
      before: 'Can we talk about the real issue?',
      after: 'The real issue is [X]',
      severity: 'low',
      impact: 'Rhetorical setup',
    },

    // Task Patterns (7)
    {
      id: 1,
      category: 'task',
      pattern: 'Vague task verb',
      before: 'help me with my code',
      after: 'Refactor getUserData() to use async/await',
      severity: 'critical',
      impact: '3 wasted API calls',
    },
    {
      id: 2,
      category: 'task',
      pattern: 'Two tasks in one prompt',
      before: 'explain AND rewrite this function',
      after: 'Split: explain first, rewrite second',
      severity: 'high',
      impact: '2 wasted calls',
    },
    {
      id: 3,
      category: 'task',
      pattern: 'No success criteria',
      before: 'make it better',
      after: 'Done when function passes existing tests',
      severity: 'critical',
      impact: 'Endless re-prompting',
    },
    {
      id: 4,
      category: 'task',
      pattern: 'Over-permissive agent',
      before: 'do whatever it takes',
      after: 'Explicit allowed + forbidden actions',
      severity: 'high',
      impact: 'Agent goes rogue',
    },
    {
      id: 5,
      category: 'task',
      pattern: 'Emotional task description',
      before: "it's totally broken, fix everything",
      after: 'Throws TypeError on line 43 when user is null',
      severity: 'medium',
      impact: '1-2 wasted calls',
    },
    {
      id: 6,
      category: 'task',
      pattern: 'Build-the-whole-thing',
      before: 'build my entire app',
      after: 'Break into 3 sequential prompts',
      severity: 'high',
      impact: 'Incomplete/broken output',
    },
    {
      id: 7,
      category: 'task',
      pattern: 'Implicit reference',
      before: 'now add the other thing we discussed',
      after: 'Always restate full task',
      severity: 'critical',
      impact: '2-3 wasted calls',
    },

    // Context Patterns (6)
    {
      id: 8,
      category: 'context',
      pattern: 'Assumed prior knowledge',
      before: 'continue where we left off',
      after: 'Include Memory Block with all prior decisions',
      severity: 'critical',
      impact: 'Wrong continuation',
    },
    {
      id: 9,
      category: 'context',
      pattern: 'No project context',
      before: 'write a cover letter',
      after: 'PM role at B2B fintech, 2yr SWE experience',
      severity: 'high',
      impact: 'Generic, useless output',
    },
    {
      id: 10,
      category: 'context',
      pattern: 'Forgotten stack',
      before: 'New prompt contradicts prior tech choice',
      after: 'Always include Memory Block',
      severity: 'high',
      impact: 'Inconsistent codebase',
    },
    {
      id: 11,
      category: 'context',
      pattern: 'Hallucination invite',
      before: 'what do experts say about X?',
      after: 'Cite only sources you are certain of',
      severity: 'high',
      impact: 'False information',
    },
    {
      id: 12,
      category: 'context',
      pattern: 'Undefined audience',
      before: 'write something for users',
      after: 'Non-technical B2B buyers, decision-maker level',
      severity: 'medium',
      impact: 'Wrong tone/depth',
    },
    {
      id: 13,
      category: 'context',
      pattern: 'No mention of prior failures',
      before: '',
      after: 'I already tried X and it failed. Do not suggest X.',
      severity: 'medium',
      impact: 'Repeats mistakes',
    },

    // Format Patterns (6)
    {
      id: 14,
      category: 'format',
      pattern: 'Missing output format',
      before: 'explain this concept',
      after: '3 bullet points, each under 20 words',
      severity: 'high',
      impact: '1 wasted call',
    },
    {
      id: 15,
      category: 'format',
      pattern: 'Implicit length',
      before: 'write a summary',
      after: 'Write a summary in exactly 3 sentences',
      severity: 'medium',
      impact: '1 wasted call',
    },
    {
      id: 16,
      category: 'format',
      pattern: 'No role assignment',
      before: '',
      after: 'You are a senior backend engineer',
      severity: 'medium',
      impact: 'Wrong expertise level',
    },
    {
      id: 17,
      category: 'format',
      pattern: 'Vague aesthetic adjectives',
      before: 'make it look professional',
      after: 'Monochrome, 16px font, 24px line height',
      severity: 'medium',
      impact: 'Wrong visual',
    },
    {
      id: 18,
      category: 'format',
      pattern: 'No negative prompts (image AI)',
      before: 'a portrait of a woman',
      after: 'Add: no watermark, no blur, no distortion',
      severity: 'high',
      impact: 'Wrong image',
    },
    {
      id: 19,
      category: 'format',
      pattern: 'Prose prompt for Midjourney',
      before: 'Full descriptive sentence',
      after: 'Comma-separated descriptors, --ar 16:9 --v 6',
      severity: 'high',
      impact: 'Wrong style',
    },

    // Scope Patterns (6)
    {
      id: 20,
      category: 'scope',
      pattern: 'No scope boundary',
      before: 'fix my app',
      after: 'Fix only login validation in src/auth.js',
      severity: 'critical',
      impact: 'Unintended changes',
    },
    {
      id: 21,
      category: 'scope',
      pattern: 'No stack constraints',
      before: 'build a React component',
      after: 'React 18, TypeScript strict, Tailwind only',
      severity: 'high',
      impact: 'Wrong tech choices',
    },
    {
      id: 22,
      category: 'scope',
      pattern: 'No stop condition for agents',
      before: 'build the whole feature',
      after: 'Explicit stop conditions + checkpoints',
      severity: 'critical',
      impact: 'Runaway agent',
    },
    {
      id: 23,
      category: 'scope',
      pattern: 'No file path for IDE AI',
      before: 'update the login function',
      after: 'Update handleLogin() in src/pages/Login.tsx',
      severity: 'high',
      impact: 'Wrong file edited',
    },
    {
      id: 24,
      category: 'scope',
      pattern: 'Wrong template for tool',
      before: 'GPT-style prose in Cursor',
      after: 'Adapted to File-Scope Template',
      severity: 'high',
      impact: 'Ignored instructions',
    },
    {
      id: 25,
      category: 'scope',
      pattern: 'Pasting entire codebase',
      before: 'Full repo context every prompt',
      after: 'Scoped to relevant function only',
      severity: 'medium',
      impact: 'Token waste',
    },

    // Reasoning Patterns (5)
    {
      id: 26,
      category: 'reasoning',
      pattern: 'No CoT for logic task',
      before: 'which approach is better?',
      after: 'Think through both step by step',
      severity: 'medium',
      impact: '1 wasted call',
    },
    {
      id: 27,
      category: 'reasoning',
      pattern: 'Adding CoT to reasoning models',
      before: 'think step by step (sent to o1/o3)',
      after: 'Removed, they think internally',
      severity: 'high',
      impact: 'Degrades output',
    },
    {
      id: 28,
      category: 'reasoning',
      pattern: 'No self-check on complex output',
      before: '',
      after: 'Before finishing, verify against constraints',
      severity: 'medium',
      impact: '1 wasted call',
    },
    {
      id: 29,
      category: 'reasoning',
      pattern: 'Expecting inter-session memory',
      before: 'you already know my project',
      after: 'Always re-provide Memory Block',
      severity: 'high',
      impact: 'Wrong answer',
    },
    {
      id: 30,
      category: 'reasoning',
      pattern: 'Contradicting prior decisions',
      before: 'New prompt ignores earlier arch',
      after: 'Memory Block with all facts',
      severity: 'high',
      impact: 'Inconsistent output',
    },

    // Agentic Patterns (5)
    {
      id: 31,
      category: 'agentic',
      pattern: 'No starting state',
      before: 'build me a REST API',
      after: 'Empty Node.js project, Express installed',
      severity: 'high',
      impact: 'Wrong assumptions',
    },
    {
      id: 32,
      category: 'agentic',
      pattern: 'No target state',
      before: 'add authentication',
      after: 'POST /login and /register in /src/routes',
      severity: 'high',
      impact: 'Incomplete',
    },
    {
      id: 33,
      category: 'agentic',
      pattern: 'Silent agent',
      before: 'No progress output',
      after: 'Output: ✅ [what was completed]',
      severity: 'medium',
      impact: 'No visibility',
    },
    {
      id: 34,
      category: 'agentic',
      pattern: 'Unlocked filesystem',
      before: 'No file restrictions',
      after: 'Only edit src/. Do not touch package.json',
      severity: 'critical',
      impact: 'Agent goes rogue',
    },
    {
      id: 35,
      category: 'agentic',
      pattern: 'No human review trigger',
      before: 'Agent decides everything',
      after: 'Stop and ask before deleting/adding deps',
      severity: 'critical',
      impact: 'Destructive actions',
    },
  ];

  analyze(prompt: string, intent: IntentDimensions): CreditKillingPattern[] {
    const detected: CreditKillingPattern[] = [];

    for (const pattern of this.patterns) {
      if (this.matchesPattern(prompt, intent, pattern)) {
        detected.push(pattern);
      }
    }

    return detected;
  }

  scoreQuality(patterns: CreditKillingPattern[], _intent: IntentDimensions): PromptQualityScore {
    // Start at 100, deduct per pattern
    let score = 100;
    let clarity = 100;
    let specificity = 100;
    let completeness = 100;
    let efficiency = 100;

    for (const pattern of patterns) {
      const deduction = pattern.severity === 'critical' ? 15 : pattern.severity === 'high' ? 10 : 5;
      score -= deduction;

      if (pattern.category === 'task') clarity -= deduction / 2;
      if (pattern.category === 'scope') specificity -= deduction / 2;
      if (pattern.category === 'context') completeness -= deduction / 2;
      if (pattern.category === 'format') efficiency -= deduction / 2;
      if (pattern.category === 'ai-writing') clarity -= deduction / 3; // Affects clarity
    }

    return {
      overall: Math.max(0, Math.min(100, score)),
      dimensions: {
        clarity: Math.max(0, clarity),
        specificity: Math.max(0, specificity),
        completeness: Math.max(0, completeness),
        efficiency: Math.max(0, efficiency),
      },
      detectedPatterns: patterns,
      suggestedFramework: score > 70 ? 'RTF' : 'CO-STAR',
      estimatedTokenSavings: Math.round(patterns.length * 15),
    };
  }

  private matchesPattern(
    prompt: string,
    intent: IntentDimensions,
    pattern: CreditKillingPattern
  ): boolean {
    const lower = prompt.toLowerCase();

    // Stop-Slop detection (ids 36-56)
    if (pattern.id >= 36 && pattern.id <= 56) {
      return this.detectStopSlopPattern(lower, pattern.id);
    }

    // Original prompt-master patterns
    switch (pattern.id) {
      case 1: // Vague task verb
        return /help me with|fix|work on/.test(lower) && !intent.task;
      case 3: // No success criteria
        return intent.successCriteria.length === 0;
      case 8: // Assumed prior knowledge
        return /continue|where we left off|previously/.test(lower) && intent.memory.length === 0;
      case 9: // No project context
        return intent.context === 'not provided';
      case 14: // Missing output format
        return !intent.output || intent.output === 'text response';
      case 20: // No scope boundary
        return !/^(only|just|limit|scope|touch)/.test(lower);
      case 22: // No stop condition
        return /build|implement|create|add/.test(lower) && intent.successCriteria.length === 0;
      case 34: // Unlocked filesystem
        return /file|delete|create|write/.test(lower) && !prompt.includes('only');
      default:
        return false;
    }
  }

  private detectStopSlopPattern(lower: string, patternId: number): boolean {
    switch (patternId) {
      // Throat-clearing openers
      case 36:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.throatClearing);
      // Emphasis crutches
      case 37:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.emphasisCrutches);
      // Business jargon
      case 38:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.businessJargon);
      // Adverbs
      case 39:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.adverbs);
      // Meta-commentary
      case 40:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.metaCommentary);
      // Binary contrasts
      case 41:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.binaryContrasts);
      // False agency
      case 42:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.falseAgency);
      // Passive voice
      case 43:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.passiveVoice);
      // Em-dashes
      case 44:
        return this.stopSlopPhrases.emDashes.some(p => lower.includes(p));
      // Lazy sweeps (always, never, etc.)
      case 45:
        return this.containsAnyPhrase(lower, this.stopSlopPhrases.lazySweeps);
      // Wh- sentence starters
      case 46:
        return /^(what|when|where|which|who|why|how)\s/m.test(lower);
      // Three-item lists
      case 47:
        return /,\s*\w+\s*,\s*and\s+\w+/.test(lower);
      // Narrator-from-distance
      case 48:
        return /nobody|this happens|this is why|people tend/.test(lower);
      // At the end of the day
      case 49:
        return /at the end of the day|at the end|fundamentally/.test(lower);
      // Unpack
      case 50:
        return /unpack/.test(lower);
      // In a world where
      case 51:
        return /in a world where|in today's/.test(lower);
      // Performative emphasis
      case 52:
        return /i promise|they exist, i promise/.test(lower);
      // This is what X actually looks like
      case 53:
        return /this is what.*actually looks like/.test(lower);
      // Vague declaratives
      case 54:
        return /the implications are|the reasons are|the stakes are|the consequences are/.test(lower);
      // Sentence fragments for emphasis
      case 55:
        return /\.\s+[A-Z][^.]*\.\s*$/.test(lower) && /that is all|period|full stop/.test(lower);
      // Can we talk about (rhetorical setup)
      case 56:
        return /can we talk about|what if|think about it:|here's what i mean/.test(lower);
      default:
        return false;
    }
  }

  private containsAnyPhrase(text: string, phrases: string[]): boolean {
    return phrases.some(phrase => text.includes(phrase));
  }
}
