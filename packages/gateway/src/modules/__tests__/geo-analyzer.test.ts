import { describe, it, expect } from 'vitest';
import {
  analyzeGeo,
  extractContent,
  checkAiCrawlerAccess,
  detectLanguage,
  __INTERNALS,
} from '../geo-analyzer.js';

const OPTIMIZED_DE = `# Was ist ein LLM-Gateway?

Ein LLM-Gateway ist eine zentrale Schnittstelle, die Anfragen an mehrere KI-Modelle bündelt. Das Adaptive LLM Gateway ist ein Open-Source-Gateway für Teams mit mehreren KI-Abos.

Aktualisiert am 12. März 2026 von Dr. Anna Beispiel, 12 Jahren Erfahrung im Plattform-Engineering.

## Wie viel kostet der Betrieb?

Der Betrieb kostet in unserem Test rund 40 % weniger als Einzel-APIs. Wir haben getestet: 1.000 Anfragen erzeugten Kosten von 3,20 € statt 5,40 €. Laut einer Studie von Aggarwal et al. steigert GEO die Sichtbarkeit um bis zu 40 %.

„Die größte Ersparnis kommt aus der Wiederverwendung vorhandener Abos", sagt Anna Beispiel.

## Welche Funktionen sind wichtig?

Die wichtigsten Funktionen im Überblick:

- PII-Redaktion mit 10 Kategorien
- Prompt-Injection-Abwehr mit über 20 Mustern
- Kostenbewusstes Routing über 15 Provider

Weitere Details stehen in der [Dokumentation](https://github.com/renefichtmueller/adaptive-llm-gateway) und bei [Wikipedia](https://de.wikipedia.org/wiki/Large_Language_Model).

## FAQ

### Ist das Gateway kostenlos?

Ja, das Gateway ist Apache-2.0-lizenziert und kostenlos nutzbar.
`;

const POOR_CONTENT = `Unser revolutionäres weltklasse Produkt Produkt Produkt ist einzigartig und bahnbrechend. Produkt Produkt Produkt kann alles und ist das beste Produkt. Niemand hat je ein solches Produkt gesehen wie unser Produkt denn das Produkt ist wirklich das allerbeste Produkt von allen Produkten die es gibt und deswegen sollte man das Produkt kaufen weil das Produkt einfach unglaublich revolutionär und einzigartig ist und bleibt für immer und ewig ohne jeden Zweifel und ohne Einschränkung`;

describe('analyzeGeo', () => {
  it('scores optimized content clearly higher than poor content', () => {
    const good = analyzeGeo({ content: OPTIMIZED_DE, format: 'markdown', brand: 'Adaptive LLM Gateway' });
    const bad = analyzeGeo({ content: POOR_CONTENT, format: 'text', brand: 'Produkt' });
    expect(good.geoScore).toBeGreaterThan(bad.geoScore + 20);
    expect(good.geoScore).toBeGreaterThanOrEqual(70);
  });

  it('detects statistics, citations and quotations in optimized content', () => {
    const analysis = analyzeGeo({ content: OPTIMIZED_DE, format: 'markdown' });
    const byId = Object.fromEntries(analysis.factors.map((f) => [f.id, f]));
    expect(byId['statistics']!.score).toBeGreaterThanOrEqual(70);
    expect(byId['statistics']!.metric).toBeGreaterThanOrEqual(3);
    expect(byId['citations']!.score).toBeGreaterThanOrEqual(60);
    expect(byId['quotations']!.score).toBeGreaterThanOrEqual(70);
    expect(byId['direct_answers']!.score).toBeGreaterThanOrEqual(70);
  });

  it('penalizes keyword stuffing', () => {
    const analysis = analyzeGeo({ content: POOR_CONTENT, format: 'text' });
    const hygiene = analysis.factors.find((f) => f.id === 'keyword_hygiene')!;
    expect(hygiene.score).toBeLessThan(50);
    expect(hygiene.recommendations.join(' ')).toContain('produkt');
  });

  it('marks entity clarity inapplicable without a brand and re-normalizes', () => {
    const withoutBrand = analyzeGeo({ content: OPTIMIZED_DE, format: 'markdown' });
    const entity = withoutBrand.factors.find((f) => f.id === 'entity_clarity')!;
    expect(entity.applicable).toBe(false);
    expect(entity.weight).toBe(0);
    expect(withoutBrand.geoScore).toBeGreaterThan(0);
  });

  it('rewards a definitional brand sentence', () => {
    const analysis = analyzeGeo({ content: OPTIMIZED_DE, format: 'markdown', brand: 'Adaptive LLM Gateway' });
    const entity = analysis.factors.find((f) => f.id === 'entity_clarity')!;
    expect(entity.applicable).toBe(true);
    expect(entity.score).toBeGreaterThanOrEqual(70);
  });

  it('reports target query coverage', () => {
    const analysis = analyzeGeo({
      content: OPTIMIZED_DE,
      format: 'markdown',
      targetQueries: ['Was kostet ein LLM-Gateway im Betrieb?', 'Beste Zahnpasta für Kinder'],
    });
    expect(analysis.queryCoverage).toHaveLength(2);
    expect(analysis.queryCoverage[0]!.covered).toBe(true);
    expect(analysis.queryCoverage[1]!.covered).toBe(false);
  });

  it('produces recommendations sorted toward the biggest gaps', () => {
    const analysis = analyzeGeo({ content: POOR_CONTENT, format: 'text' });
    expect(analysis.recommendations.length).toBeGreaterThan(2);
    expect(analysis.grade).toMatch(/[DEF]/);
  });
});

describe('extractContent', () => {
  it('auto-detects and extracts HTML with headings, links and schema', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage"}</script>
      </head><body>
      <h1>Titel der Seite</h1>
      <p>Ein erster Absatz mit genug Wörtern für die Analyse.</p>
      <h2>Erste Frage?</h2><p>Die kurze Antwort steht direkt hier.</p>
      <ul><li>Punkt eins der Liste</li><li>Punkt zwei der Liste</li></ul>
      <a href="https://example.org/quelle">Quelle</a>
      </body></html>`;
    const doc = extractContent(html, 'auto');
    expect(doc.format).toBe('html');
    expect(doc.headings.map((h) => h.level)).toEqual([1, 2]);
    expect(doc.links[0]!.url).toBe('https://example.org/quelle');
    expect(doc.listItemCount).toBe(2);
    expect(doc.schemaTypes).toContain('FAQPage');
    expect(doc.faqDetected).toBe(true);
    expect(doc.text).not.toContain('<');
  });

  it('extracts markdown structure', () => {
    const doc = extractContent('# Titel\n\nAbsatz mit einigen Wörtern hier.\n\n- eins zwei\n- drei vier\n\n[Link](https://example.com/a)', 'auto');
    expect(doc.format).toBe('markdown');
    expect(doc.headings).toHaveLength(1);
    expect(doc.listItemCount).toBe(2);
    expect(doc.links.some((l) => l.url === 'https://example.com/a')).toBe(true);
  });

  it('treats plain prose as text', () => {
    const doc = extractContent('Nur ein einfacher Satz ohne besondere Auszeichnung.', 'auto');
    expect(doc.format).toBe('text');
  });
});

describe('detectLanguage', () => {
  it('detects German and English', () => {
    expect(detectLanguage('Das ist ein Text und er wird für die Analyse verwendet, weil wir das brauchen.')).toBe('de');
    expect(detectLanguage('This is a text and it will be used for the analysis because we need that.')).toBe('en');
  });
});

describe('checkAiCrawlerAccess', () => {
  it('flags explicitly blocked AI bots', () => {
    const robots = `User-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /`;
    const report = checkAiCrawlerAccess(robots);
    const gptbot = report.results.find((r) => r.userAgent === 'GPTBot')!;
    const perplexity = report.results.find((r) => r.userAgent === 'PerplexityBot')!;
    const claudebot = report.results.find((r) => r.userAgent === 'ClaudeBot')!;
    expect(gptbot.allowed).toBe(false);
    expect(perplexity.allowed).toBe(false);
    expect(claudebot.allowed).toBe(true);
    expect(report.blockedTrainingBots).toContain('GPTBot');
    expect(report.blockedSearchBots).toContain('PerplexityBot');
    expect(report.recommendations.join(' ')).toContain('PerplexityBot');
  });

  it('applies a wildcard disallow-all to every bot', () => {
    const report = checkAiCrawlerAccess('User-agent: *\nDisallow: /');
    expect(report.results.every((r) => !r.allowed)).toBe(true);
  });

  it('allows everything when robots.txt is empty', () => {
    const report = checkAiCrawlerAccess('');
    expect(report.results.every((r) => r.allowed)).toBe(true);
    expect(report.blockedSearchBots).toHaveLength(0);
  });

  it('honors longest-path match with Allow overriding Disallow', () => {
    const robots = `User-agent: GPTBot\nDisallow: /\nAllow: /blog/`;
    expect(checkAiCrawlerAccess(robots, '/blog/artikel').results.find((r) => r.userAgent === 'GPTBot')!.allowed).toBe(true);
    expect(checkAiCrawlerAccess(robots, '/intern').results.find((r) => r.userAgent === 'GPTBot')!.allowed).toBe(false);
  });

  it('treats an empty Disallow value as allow-all', () => {
    const report = checkAiCrawlerAccess('User-agent: GPTBot\nDisallow:');
    expect(report.results.find((r) => r.userAgent === 'GPTBot')!.allowed).toBe(true);
  });

  it('groups multiple user-agents sharing one rule block', () => {
    const robots = `User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /`;
    const report = checkAiCrawlerAccess(robots);
    expect(report.results.find((r) => r.userAgent === 'GPTBot')!.allowed).toBe(false);
    expect(report.results.find((r) => r.userAgent === 'ClaudeBot')!.allowed).toBe(false);
    expect(report.results.find((r) => r.userAgent === 'PerplexityBot')!.allowed).toBe(true);
  });
});

describe('__INTERNALS', () => {
  it('factor weights sum to 100', () => {
    const total = Object.values(__INTERNALS.FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('robots path matching supports wildcards and anchors', () => {
    expect(__INTERNALS.robotsPathMatches('/*.pdf$', '/files/a.pdf')).toBe(true);
    expect(__INTERNALS.robotsPathMatches('/*.pdf$', '/files/a.pdf?x=1')).toBe(false);
    expect(__INTERNALS.robotsPathMatches('/blog', '/blog/post')).toBe(true);
    expect(__INTERNALS.robotsPathMatches('', '/anything')).toBe(false);
  });
});
