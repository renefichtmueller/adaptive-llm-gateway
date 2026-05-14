// German ban list — Marketing-Sprache, KI-Erkennungszeichen, Klischees
// Category tags: 'marketing' | 'ai_tell' | 'cliche' | 'filler'

export interface BanEntryDe {
  term: string;
  category: 'marketing' | 'ai_tell' | 'cliche' | 'filler';
  wholeWord: boolean;
}

export const DE_BANLIST: BanEntryDe[] = [
  // Marketing-Buzzwords
  { term: 'zukunftsweisend', category: 'marketing', wholeWord: true },
  { term: 'wegweisend', category: 'marketing', wholeWord: true },
  { term: 'revolutionär', category: 'marketing', wholeWord: true },
  { term: 'innovativ', category: 'marketing', wholeWord: true },
  { term: 'nachhaltig', category: 'marketing', wholeWord: true },
  { term: 'ganzheitlich', category: 'marketing', wholeWord: true },
  { term: 'synergetisch', category: 'marketing', wholeWord: true },
  { term: 'Synergie', category: 'marketing', wholeWord: true },
  { term: 'Synergien', category: 'marketing', wholeWord: true },
  { term: 'disruptiv', category: 'marketing', wholeWord: true },
  { term: 'bahnbrechend', category: 'marketing', wholeWord: true },
  { term: 'Ökosystem', category: 'marketing', wholeWord: true },
  { term: 'Mehrwert schaffen', category: 'marketing', wholeWord: false },
  { term: 'Mehrwert bieten', category: 'marketing', wholeWord: false },
  { term: 'state of the art', category: 'marketing', wholeWord: false },
  { term: 'Best Practices', category: 'marketing', wholeWord: false },
  { term: 'Thought Leadership', category: 'marketing', wholeWord: false },
  { term: 'nahtlos', category: 'marketing', wholeWord: true },
  { term: 'skalierbar', category: 'marketing', wholeWord: true },
  { term: 'robust', category: 'marketing', wholeWord: true },
  { term: 'transformativ', category: 'marketing', wholeWord: true },
  { term: 'ermächtigen', category: 'marketing', wholeWord: true },
  { term: 'Paradigmenwechsel', category: 'marketing', wholeWord: true },
  { term: 'Wettbewerbsvorteil', category: 'marketing', wholeWord: true },
  { term: 'Alleinstellungsmerkmal', category: 'marketing', wholeWord: true },
  { term: 'digitale Transformation', category: 'marketing', wholeWord: false },
  { term: 'Digitalisierung vorantreiben', category: 'marketing', wholeWord: false },
  { term: 'fit für die Zukunft', category: 'marketing', wholeWord: false },
  { term: 'zukunftsfähig', category: 'marketing', wholeWord: true },
  { term: 'agil', category: 'marketing', wholeWord: true },
  { term: 'New Work', category: 'marketing', wholeWord: false },
  { term: 'Out of the Box', category: 'marketing', wholeWord: false },

  // KI-Erkennungszeichen
  { term: 'Als KI', category: 'ai_tell', wholeWord: false },
  { term: 'Als Sprachmodell', category: 'ai_tell', wholeWord: false },
  { term: 'Ich kann keine', category: 'ai_tell', wholeWord: false },
  { term: 'Es ist zu beachten', category: 'ai_tell', wholeWord: false },
  { term: 'Es sei darauf hingewiesen', category: 'ai_tell', wholeWord: false },
  { term: 'Es ist erwähnenswert', category: 'ai_tell', wholeWord: false },
  { term: 'Es sei angemerkt', category: 'ai_tell', wholeWord: false },
  { term: 'Es sei erwähnt', category: 'ai_tell', wholeWord: false },
  { term: 'Lassen Sie uns', category: 'ai_tell', wholeWord: false },
  { term: 'Tauchen wir ein', category: 'ai_tell', wholeWord: false },
  { term: 'Zunächst einmal', category: 'ai_tell', wholeWord: false },
  { term: 'Nicht zuletzt', category: 'ai_tell', wholeWord: false },
  { term: 'einerseits… andererseits', category: 'ai_tell', wholeWord: false },

  // Klischees
  { term: 'Zum Schluss', category: 'cliche', wholeWord: false },
  { term: 'Zusammenfassend', category: 'cliche', wholeWord: true },
  { term: 'Zusammenfassend lässt sich sagen', category: 'cliche', wholeWord: false },
  { term: 'Abschließend', category: 'cliche', wholeWord: true },
  { term: 'Abschließend lässt sich festhalten', category: 'cliche', wholeWord: false },
  { term: 'Im heutigen schnelllebigen', category: 'cliche', wholeWord: false },
  { term: 'In der heutigen Zeit', category: 'cliche', wholeWord: false },
  { term: 'In der modernen Welt', category: 'cliche', wholeWord: false },
  { term: 'im Zeitalter der', category: 'cliche', wholeWord: false },
  { term: 'Im Kern geht es', category: 'cliche', wholeWord: false },
  { term: 'auf den Punkt gebracht', category: 'cliche', wholeWord: false },
  { term: 'auf den Punkt', category: 'cliche', wholeWord: false },
  { term: 'die Reise', category: 'cliche', wholeWord: false },
  { term: 'Reise beginnt', category: 'cliche', wholeWord: false },

  // Füllwörter / Floskel
  { term: 'nicht vergessen', category: 'filler', wholeWord: false },
  { term: 'im Endeffekt', category: 'filler', wholeWord: false },
  { term: 'letztendlich', category: 'filler', wholeWord: true },
  { term: 'letztlich', category: 'filler', wholeWord: true },
  { term: 'ganz klar', category: 'filler', wholeWord: false },
  { term: 'auf jeden Fall', category: 'filler', wholeWord: false },
  { term: 'definitiv', category: 'filler', wholeWord: true },
  { term: 'selbstverständlich', category: 'filler', wholeWord: true },
  { term: 'natürlich', category: 'filler', wholeWord: true },
  { term: 'offensichtlich', category: 'filler', wholeWord: true },
  { term: 'grundsätzlich', category: 'filler', wholeWord: true },
  { term: 'im Grunde genommen', category: 'filler', wholeWord: false },
  { term: 'ohne Frage', category: 'filler', wholeWord: false },
  { term: 'zweifellos', category: 'filler', wholeWord: true },
  { term: 'zweifelsohne', category: 'filler', wholeWord: true },
];

export const DE_TERMS_SET: Set<string> = new Set(DE_BANLIST.map((e) => e.term.toLowerCase()));
