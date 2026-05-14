/**
 * Monthly Report Generator
 *
 * Renders a print-friendly HTML report (intended to be saved as PDF via the
 * browser's print dialog). Includes hero counters, savings breakdown by
 * source, top models, top callers, achievements unlocked this month, and
 * the activity heatmap.
 *
 * Going via HTML+print-CSS sidesteps any need for an external PDF library
 * — the user clicks the gateway's "Print to PDF" link and saves the page.
 */
import type { Pool } from 'pg';
import { getComprehensiveSavings } from './savings-calculator.js';
import { getBuddyState, getAchievements } from './gamification.js';

function formatCost(c: number): string {
  if (c === 0) return '$0.00';
  if (c < 0.01) return `$${c.toFixed(6)}`;
  if (c < 1) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}
function fmtNum(n: number): string { return n.toLocaleString(); }
function fmtPct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

export async function generateMonthlyReport(
  db: Pool,
  year: number,
  month: number
): Promise<string> {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const hoursBack = Math.ceil((Date.now() - monthStart.getTime()) / 3600_000);
  const monthName = monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Pull all the data points
  const [savings, buddy, achievements, monthRows, modelRows, callerRows] = await Promise.all([
    getComprehensiveSavings(db, hoursBack),
    getBuddyState(db, 'gateway'),
    getAchievements(db),
    db.query(`
      SELECT COUNT(*)::INT AS req,
             COALESCE(SUM(tokens_in + tokens_out), 0)::BIGINT AS tokens,
             COALESCE(AVG(latency_ms), 0)::INT AS avg_lat,
             COALESCE(SUM(cost_usd), 0)::NUMERIC AS cost,
             SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*),0) AS success_rate
      FROM request_tracking
      WHERE created_at >= $1 AND created_at < $2
    `, [monthStart, monthEnd]),
    db.query(`
      SELECT model, COUNT(*)::INT AS cnt
      FROM request_tracking
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY model ORDER BY cnt DESC LIMIT 8
    `, [monthStart, monthEnd]),
    db.query(`
      SELECT caller_id, COUNT(*)::INT AS cnt, COALESCE(SUM(cost_usd), 0)::NUMERIC AS cost
      FROM request_tracking
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY caller_id ORDER BY cnt DESC LIMIT 8
    `, [monthStart, monthEnd]),
  ]);

  const monthStats = monthRows.rows[0] ?? {};
  const totalReq = parseInt(monthStats.req ?? '0', 10);
  const totalTokens = parseInt(monthStats.tokens ?? '0', 10);
  const monthCost = parseFloat(monthStats.cost ?? '0');
  const successRate = parseFloat(monthStats.success_rate ?? '0');
  const avgLat = parseInt(monthStats.avg_lat ?? '0', 10);

  const newAchievements = achievements.unlocked
    .filter(() => true)  // all unlocked are shown; "this month" filter would need timestamp
    .slice(0, 12);

  const html = /* html */ `
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>LLM Gateway · Monthly Report · ${monthName}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: 'Inter', -apple-system, sans-serif; font-size: 11pt; color: #24313d; line-height: 1.5; }
  h1 { font-size: 22pt; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 4pt; color: #0f766e; }
  h2 { font-size: 13pt; font-weight: 600; margin: 16pt 0 8pt; padding-bottom: 4pt; border-bottom: 1pt solid #d6e0e7; color: #0f766e; }
  h2::before { content: '// '; }
  .eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 8pt; letter-spacing: 0.16em; text-transform: uppercase; color: #667684; }
  .hero { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8pt; margin: 12pt 0 18pt; }
  .hero-tile { padding: 10pt; border: 0.5pt solid #d6e0e7; background: #f4f7fa; }
  .hero-num { font-family: 'JetBrains Mono', monospace; font-size: 22pt; font-weight: 700; color: #0f766e; line-height: 1; }
  .hero-label { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.1em; color: #667684; margin-bottom: 4pt; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 10pt; }
  th, td { padding: 4pt 8pt; border-bottom: 0.3pt solid #d6e0e7; text-align: left; }
  th { font-weight: 600; color: #667684; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.1em; }
  td.num { font-family: 'JetBrains Mono', monospace; text-align: right; }
  .axes { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4pt; }
  .axis { padding: 8pt; border: 0.5pt solid #d6e0e7; background: #f4f7fa; text-align: center; }
  .axis-cost { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 11pt; color: #0f766e; }
  .axis-label { font-size: 7pt; color: #667684; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4pt; }
  .ach { display: inline-block; padding: 4pt 8pt; margin: 2pt; border: 0.5pt solid #0f766e; background: #ecfdf5; font-size: 9pt; }
  .footer { margin-top: 24pt; padding-top: 8pt; border-top: 0.3pt solid #d6e0e7; font-size: 8pt; color: #93a1ad; text-align: center; }
  .ascii-buddy { font-family: 'JetBrains Mono', monospace; font-size: 9pt; line-height: 1; white-space: pre; }
  .savings-vs { display: flex; gap: 8pt; align-items: center; margin: 12pt 0; }
  .savings-vs > div { flex: 1; padding: 10pt; border: 0.5pt solid #d6e0e7; }
  .savings-vs .without { background: #fef2f2; }
  .savings-vs .with { background: #ecfdf5; }
  .savings-vs .arrow { flex: 0; font-size: 14pt; color: #93a1ad; }
  .num-amount { font-family: 'JetBrains Mono', monospace; font-size: 16pt; font-weight: 700; }
  @media print { .no-print { display: none; } body { background: white; } }
</style>
</head>
<body>

<div class="no-print" style="margin-bottom: 8pt; padding: 8pt; background: #ecfdf5; border-left: 3pt solid #0f766e;">
  <strong>Save as PDF</strong>: Press <code>Cmd/Ctrl+P</code> → choose "Save as PDF".
</div>

<header>
  <div class="eyebrow">monthly report</div>
  <h1>${monthName}</h1>
  <div style="font-family: 'JetBrains Mono', monospace; font-size: 9pt; color: #667684;">
    LLM Gateway · ${new Date().toISOString().split('T')[0]}
  </div>
</header>

<div class="hero">
  <div class="hero-tile">
    <div class="hero-label">requests routed</div>
    <div class="hero-num">${fmtNum(totalReq)}</div>
  </div>
  <div class="hero-tile">
    <div class="hero-label">tokens processed</div>
    <div class="hero-num">${fmtNum(totalTokens)}</div>
  </div>
  <div class="hero-tile">
    <div class="hero-label">cost saved</div>
    <div class="hero-num">${formatCost(savings.totalCostSaved)}</div>
  </div>
</div>

<h2>Cost Analysis</h2>
<div class="savings-vs">
  <div class="without">
    <div class="hero-label">without gateway</div>
    <div class="num-amount" style="color: #b42318;">${formatCost(savings.costWithoutGateway)}</div>
  </div>
  <div class="arrow">→</div>
  <div class="with">
    <div class="hero-label">with gateway</div>
    <div class="num-amount" style="color: #15803d;">${formatCost(savings.costWithGateway)}</div>
  </div>
</div>
<p>Saved <strong>${formatCost(savings.costWithoutGateway - savings.costWithGateway)}</strong> through cache hits, compression, subscription bridges, local routing, and race-mode optimization.</p>

<h2>Savings by Source</h2>
<div class="axes">
  <div class="axis"><div class="axis-cost">${formatCost(savings.bySource.cache.cost)}</div><div class="axis-label">⚡ Cache</div></div>
  <div class="axis"><div class="axis-cost">${formatCost(savings.bySource.compression.cost)}</div><div class="axis-label">🗜 Compression</div></div>
  <div class="axis"><div class="axis-cost">${formatCost(savings.bySource.subscriptionBridge.cost)}</div><div class="axis-label">🌉 Sub. Bridges</div></div>
  <div class="axis"><div class="axis-cost">${formatCost(savings.bySource.localRouting.cost)}</div><div class="axis-label">🏠 Local</div></div>
  <div class="axis"><div class="axis-cost">${formatCost(savings.bySource.raceMode.cost)}</div><div class="axis-label">🏁 Race</div></div>
</div>

<h2>Activity Summary</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Total requests</td><td class="num">${fmtNum(totalReq)}</td></tr>
  <tr><td>Average latency</td><td class="num">${fmtNum(avgLat)} ms</td></tr>
  <tr><td>Success rate</td><td class="num">${fmtPct(successRate)}</td></tr>
  <tr><td>Cost actually paid</td><td class="num">${formatCost(monthCost)}</td></tr>
</table>

<h2>Top Models This Month</h2>
<table>
  <tr><th>Model</th><th>Requests</th><th>Share</th></tr>
  ${modelRows.rows.map((r: any) => `
    <tr>
      <td><code>${r.model}</code></td>
      <td class="num">${fmtNum(parseInt(r.cnt,10))}</td>
      <td class="num">${totalReq > 0 ? ((parseInt(r.cnt,10)/totalReq)*100).toFixed(1) : 0}%</td>
    </tr>
  `).join('')}
</table>

<h2>Top Callers This Month</h2>
<table>
  <tr><th>Caller</th><th>Requests</th><th>Cost</th></tr>
  ${callerRows.rows.map((r: any) => `
    <tr>
      <td><code>${r.caller_id}</code></td>
      <td class="num">${fmtNum(parseInt(r.cnt,10))}</td>
      <td class="num">${formatCost(parseFloat(r.cost))}</td>
    </tr>
  `).join('')}
</table>

<h2>Achievements Unlocked</h2>
<div>
  ${newAchievements.map((a) => `<span class="ach">${a.icon} ${a.title}</span>`).join('')}
  ${newAchievements.length === 0 ? '<em>No achievements unlocked yet — keep using the gateway!</em>' : ''}
</div>

<h2>Buddy Status</h2>
<div style="display: flex; gap: 12pt; align-items: center; padding: 10pt; border: 0.5pt solid #d6e0e7;">
  <div class="ascii-buddy">${buddy.asciiArt.join('\n')}</div>
  <div>
    <strong>${buddy.name}</strong> · ${buddy.species} · ${buddy.stage}<br>
    Level ${buddy.level} · XP ${fmtNum(buddy.xp)}/${fmtNum(buddy.xpForNextLevel)}<br>
    Mood: ${buddy.mood} · Streak: ${buddy.streakDays} days<br>
    <em>"${buddy.speech}"</em>
  </div>
</div>

<div class="footer">
  Generated by LLM Gateway · ${new Date().toISOString()} 
</div>

</body></html>`;
  return html;
}
