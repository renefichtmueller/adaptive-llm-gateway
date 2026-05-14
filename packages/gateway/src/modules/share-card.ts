/**
 * Public Share Card Generator
 *
 * Renders a shareable SVG image showing your gateway savings — useful for
 * social posts, blog headers, README badges. Tokens are rounded; no
 * personally identifying information leaks (caller IDs, model names etc.
 * are NOT included). Just headline numbers + brand.
 *
 * Output is always a valid SVG so it can be embedded as `<img src="...">`
 * or downloaded directly.
 */
import type { Pool } from 'pg';
import { getComprehensiveSavings } from './savings-calculator.js';
import { getBuddyState } from './gamification.js';

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return Math.round(n).toString();
}
function fmtCost(c: number): string {
  if (c < 0.01) return `$${c.toFixed(6)}`;
  if (c < 1) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}
function escSvg(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type ShareCardPeriod = 'day' | 'week' | 'month' | 'all';
export type ShareCardTheme = 'dark' | 'light';

const PERIOD_HOURS: Record<ShareCardPeriod, number> = {
  day: 24, week: 168, month: 720, all: 24 * 365 * 5,
};

export async function generateShareCard(
  db: Pool,
  opts: { period?: ShareCardPeriod; theme?: ShareCardTheme } = {}
): Promise<string> {
  const period: ShareCardPeriod = opts.period ?? 'month';
  const theme: ShareCardTheme = opts.theme ?? 'dark';
  const hours = PERIOD_HOURS[period];

  const [savings, buddy] = await Promise.all([
    getComprehensiveSavings(db, hours),
    getBuddyState(db, 'gateway'),
  ]);

  // Theme palette
  const palette = theme === 'dark' ? {
    bg: '#0a0a0a', surface: '#161616', text: '#e8e8e8', dim: '#888888',
    accent: '#d4ff00', accentDim: '#8aa800', border: '#2a2a2a',
  } : {
    bg: '#f4f7fa', surface: '#ffffff', text: '#24313d', dim: '#667684',
    accent: '#0f766e', accentDim: '#8ab9b5', border: '#d6e0e7',
  };

  const periodLabel = period === 'day' ? 'Last 24 hours'
    : period === 'week' ? 'Last 7 days'
    : period === 'month' ? 'Last 30 days'
    : 'All-time';

  const W = 1200, H = 630; // Open Graph standard
  const totalTokens = savings.totalTokensSaved;
  const totalCost = savings.totalCostSaved;
  const reqCount = savings.totals.requests;
  const efficacy = savings.costWithoutGateway > 0
    ? ((savings.costWithoutGateway - savings.costWithGateway) / savings.costWithoutGateway) * 100
    : 0;

  // Source-bar widths
  const total = Math.max(0.0000001, savings.totalCostSaved);
  const wCache = (savings.bySource.cache.cost / total) * 100;
  const wComp  = (savings.bySource.compression.cost / total) * 100;
  const wSub   = (savings.bySource.subscriptionBridge.cost / total) * 100;
  const wLocal = (savings.bySource.localRouting.cost / total) * 100;
  const wRace  = (savings.bySource.raceMode.cost / total) * 100;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"  stop-color="${palette.bg}"/>
      <stop offset="100%" stop-color="${palette.surface}"/>
    </linearGradient>
    <radialGradient id="glow" cx="20%" cy="0%" r="80%">
      <stop offset="0%"  stop-color="${palette.accent}" stop-opacity="0.20"/>
      <stop offset="60%" stop-color="${palette.accent}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${palette.bg}"     stop-opacity="0"/>
    </radialGradient>
    <style>
      .mono   { font-family: 'JetBrains Mono', 'SF Mono', monospace; }
      .sans   { font-family: 'Inter', -apple-system, sans-serif; }
      .num    { font-weight: 700; letter-spacing: -0.02em; }
      .label  { letter-spacing: 0.16em; text-transform: uppercase; }
    </style>
  </defs>

  <!-- background -->
  <rect width="${W}" height="${H}" fill="url(#bgGrad)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="none" stroke="${palette.border}" stroke-width="2"/>

  <!-- brand mark -->
  <g transform="translate(48 48)">
    <rect x="0" y="0" width="14" height="14" fill="${palette.accent}"/>
    <text x="24" y="12" class="mono" font-size="20" font-weight="700" fill="${palette.text}">llm.gateway</text>
    <text x="180" y="12" class="mono" font-size="13" fill="${palette.dim}">— ${escSvg(periodLabel)}</text>
  </g>

  <!-- top-right: brand tag / version -->
  <g transform="translate(${W - 48} 48)">
    <text x="0" y="12" text-anchor="end" class="mono" font-size="11" fill="${palette.dim}" letter-spacing="0.1em">LLM GATEWAY</text>
  </g>

  <!-- HUGE counter — eyebrow above, big number well below to avoid overlap -->
  <g transform="translate(48 ${H/2 - 110})">
    <text x="0" y="0" class="mono label" font-size="14" fill="${palette.dim}">tokens prevented · ${escSvg(periodLabel.toLowerCase())}</text>
    <text x="0" y="135" class="mono num" font-size="120" fill="${palette.accent}">${fmtNum(totalTokens)}</text>
    <text x="0" y="180" class="mono" font-size="18" fill="${palette.text}">
      <tspan>${fmtCost(totalCost)} saved</tspan>
      <tspan dx="20" fill="${palette.dim}">·</tspan>
      <tspan dx="14">${fmtNum(reqCount)} calls</tspan>
      <tspan dx="20" fill="${palette.dim}">·</tspan>
      <tspan dx="14">${efficacy.toFixed(1)}% efficiency</tspan>
    </text>
  </g>

  <!-- 5-axis breakdown bar -->
  <g transform="translate(48 ${H - 180})">
    <text x="0" y="0" class="mono label" font-size="12" fill="${palette.dim}">savings sources · 5-axis breakdown</text>
    <rect x="0" y="14" width="${W - 96}" height="22" fill="${palette.surface}" stroke="${palette.border}"/>
    ${(() => {
      let x = 0;
      const segs: string[] = [];
      const w = W - 96;
      const pieces = [
        { p: wCache, c: '#d4ff00', label: '⚡' },
        { p: wComp,  c: '#2dd4bf', label: '🗜' },
        { p: wSub,   c: '#60a5fa', label: '🌉' },
        { p: wLocal, c: '#a78bfa', label: '🏠' },
        { p: wRace,  c: '#f97316', label: '🏁' },
      ];
      for (const piece of pieces) {
        const segW = (piece.p / 100) * w;
        if (segW > 0.5) {
          segs.push(`<rect x="${x}" y="14" width="${segW}" height="22" fill="${piece.c}"/>`);
        }
        x += segW;
      }
      return segs.join('');
    })()}
    <g transform="translate(0 60)" class="mono" font-size="11" fill="${palette.dim}">
      <text x="0"   y="0"><tspan fill="#d4ff00">●</tspan> cache</text>
      <text x="120" y="0"><tspan fill="#2dd4bf">●</tspan> compression</text>
      <text x="270" y="0"><tspan fill="#60a5fa">●</tspan> subscription bridges</text>
      <text x="470" y="0"><tspan fill="#a78bfa">●</tspan> local routing</text>
      <text x="600" y="0"><tspan fill="#f97316">●</tspan> race mode</text>
    </g>
  </g>

  <!-- footer / buddy -->
  <g transform="translate(48 ${H - 70})">
    <text x="0" y="0" class="mono" font-size="11" fill="${palette.dim}">
      <tspan fill="${palette.accent}">${escSvg(buddy.species)}</tspan>
      <tspan dx="6">·</tspan>
      <tspan dx="6">Lv.${buddy.level}</tspan>
      <tspan dx="6">·</tspan>
      <tspan dx="6">${buddy.streakDays}d streak</tspan>
      <tspan dx="20" fill="${palette.dim}">— routing AI traffic since ${escSvg(new Date().toISOString().split('T')[0])}</tspan>
    </text>
  </g>
</svg>`;
}
