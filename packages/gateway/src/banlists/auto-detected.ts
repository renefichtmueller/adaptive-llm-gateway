// Auto-detected ban list — language-agnostic patterns that indicate LLM output
// These are detected regardless of content language

export interface AutoDetectedEntry {
  term: string;
  category: 'structural' | 'ai_pattern' | 'formatting';
  wholeWord: boolean;
  isRegex: boolean;
}

export const AUTO_DETECTED_BANLIST: AutoDetectedEntry[] = [
  // Structural AI patterns
  { term: 'In conclusion,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'To summarize,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'In summary,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Overall,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Firstly,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Secondly,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Thirdly,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Furthermore,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Moreover,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Additionally,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Notably,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Importantly,', category: 'structural', wholeWord: false, isRegex: false },
  { term: 'Interestingly,', category: 'structural', wholeWord: false, isRegex: false },

  // AI self-referential patterns
  { term: 'as an AI language model', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'I\'m an AI', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'I am an AI', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'my training data', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'my knowledge cutoff', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'I don\'t have access to real-time', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'I cannot browse the internet', category: 'ai_pattern', wholeWord: false, isRegex: false },

  // Formatting anti-patterns (often sign of AI over-structuring)
  { term: '**Important:**', category: 'formatting', wholeWord: false, isRegex: false },
  { term: '**Note:**', category: 'formatting', wholeWord: false, isRegex: false },
  { term: '**Key takeaway:**', category: 'formatting', wholeWord: false, isRegex: false },
  { term: '**Bottom line:**', category: 'formatting', wholeWord: false, isRegex: false },
  { term: '**TL;DR:**', category: 'formatting', wholeWord: false, isRegex: false },

  // Closing questions (unwanted in most content)
  { term: 'What do you think?', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'What are your thoughts?', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Let me know in the comments', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Feel free to reach out', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Drop a comment below', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Share your thoughts', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'I\'d love to hear from you', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Follow for more', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Like and share', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Don\'t forget to', category: 'ai_pattern', wholeWord: false, isRegex: false },

  // German equivalents
  { term: 'Wie seht ihr das?', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Was denkt ihr?', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Schreibt es in die Kommentare', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Teilt eure Gedanken', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Folgt mir für mehr', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Schreibt mir gerne', category: 'ai_pattern', wholeWord: false, isRegex: false },
  { term: 'Ich freue mich auf eure', category: 'ai_pattern', wholeWord: false, isRegex: false },
];
