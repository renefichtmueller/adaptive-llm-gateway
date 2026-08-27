import { describe, it, expect } from 'vitest';
import { optimizeContentForGeo, __INTERNALS } from '../geo-optimizer.js';

const ORIGINAL = `Unser Produkt ist eine Lösung für Netzwerktechnik und wird von vielen Kunden weltweit eingesetzt weil es gut funktioniert und viele Funktionen hat die andere nicht haben und die sehr praktisch sind im täglichen Einsatz in Rechenzentren und Unternehmensnetzen.`;

const IMPROVED = `# Was ist Produkt?

Produkt ist eine Lösung für Netzwerktechnik in Rechenzentren. Kunden in 40 Ländern setzen sie ein [GEO-TODO: genaue Kundenzahl belegen].

## Welche Funktionen bietet Produkt?

Die wichtigsten Funktionen:

- Konfiguration in unter 5 Minuten [GEO-TODO: Messwert verifizieren]
- Kompatibel mit über 100 Plattformen

Laut einer Studie von Aggarwal et al. steigern belegte Zahlen die Sichtbarkeit um bis zu 40 % ([Quelle](https://arxiv.org/abs/2311.09735)).

„Die Umstellung dauerte einen Tag", sagt ein Kunde [GEO-TODO: echtes Kundenzitat mit Namen einholen].
`;

describe('optimizeContentForGeo', () => {
  it('keeps the better-scoring rewrite and extracts GEO-TODOs', async () => {
    const result = await optimizeContentForGeo(
      { content: ORIGINAL, format: 'text', brand: 'Produkt' },
      async () => ({ response: IMPROVED, model: 'fake-model' }),
    );
    expect(result.optimizedContent).toBe(IMPROVED.trim());
    expect(result.scoreDelta).toBeGreaterThan(0);
    expect(result.after.geoScore).toBeGreaterThan(result.before.geoScore);
    expect(result.todos).toHaveLength(3);
    expect(result.todos[0]).toContain('Kundenzahl');
    expect(result.modelUsed).toBe('fake-model');
    expect(result.iterationsRun).toBe(1);
  });

  it('strips markdown code fences from the model response', async () => {
    const fenced = '```markdown\n' + IMPROVED + '\n```';
    const result = await optimizeContentForGeo(
      { content: ORIGINAL, format: 'text', brand: 'Produkt' },
      async () => ({ response: fenced, model: 'fake-model' }),
    );
    expect(result.optimizedContent.startsWith('```')).toBe(false);
    expect(result.optimizedContent).toContain('# Was ist Produkt?');
  });

  it('discards suspiciously short rewrites and keeps the original', async () => {
    const result = await optimizeContentForGeo(
      { content: ORIGINAL, format: 'text' },
      async () => ({ response: 'zu kurz' }),
    );
    expect(result.optimizedContent).toBe(ORIGINAL);
    expect(result.scoreDelta).toBe(0);
    expect(result.iterationsRun).toBe(0);
  });

  it('survives a failing LLM call and returns the original', async () => {
    const result = await optimizeContentForGeo(
      { content: ORIGINAL, format: 'text' },
      async () => { throw new Error('model down'); },
    );
    expect(result.optimizedContent).toBe(ORIGINAL);
    expect(result.scoreDelta).toBe(0);
  });

  it('stops iterating once the score no longer improves', async () => {
    let calls = 0;
    const result = await optimizeContentForGeo(
      { content: ORIGINAL, format: 'text', brand: 'Produkt', iterations: 3 },
      async () => {
        calls++;
        return { response: IMPROVED, model: 'fake-model' };
      },
    );
    // 1st call improves, 2nd returns the identical text (same score) → stop.
    expect(calls).toBe(2);
    expect(result.iterationsRun).toBe(2);
    expect(result.optimizedContent).toBe(IMPROVED.trim());
  });

  it('builds a prompt that names the weakest factors and hard rules', () => {
    const prompt = __INTERNALS.buildUserPrompt(
      { content: ORIGINAL, brand: 'Produkt', targetQueries: ['Beste Netzwerktechnik-Lösung?'] },
      // Cheap fake analysis via the real analyzer path is covered above; here
      // we only check prompt assembly with a minimal shape.
      {
        geoScore: 30,
        grade: 'E',
        disciplineScores: { aeo: 25, geo: 30, llmo: 40 },
        factors: [
          { id: 'statistics', label: 'Statistics & data points', score: 10, weight: 14, applicable: true, disciplines: ['geo'], evidence: [], recommendations: ['Add concrete statistics.'] },
        ],
        recommendations: [],
        stats: { format: 'text', language: 'de', words: 50, sentences: 2, paragraphs: 1, headings: 0, links: 0, listItems: 0, tables: 0, statisticsFound: 0, quotationsFound: 0, schemaTypes: [] },
        queryCoverage: [],
      },
    );
    expect(prompt).toContain('Current GEO score: 30/100');
    expect(prompt).toContain('Brand entity: Produkt');
    expect(prompt).toContain('Beste Netzwerktechnik-Lösung?');
    expect(prompt).toContain('Statistics & data points (10/100)');
    expect(__INTERNALS.SYSTEM_PROMPT).toContain('[GEO-TODO:');
  });
});
