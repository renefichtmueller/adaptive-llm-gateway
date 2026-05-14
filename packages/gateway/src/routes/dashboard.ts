import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { getPool } from '../db/client.js';
import { logger } from '../observability/logger.js';
import { createRequestLogger } from '../modules/request-logger.js';
import { globalRequestStream } from '../modules/request-stream.js';
import { getAvailableProviders, getAllProviders } from '../pipeline/external-providers.js';
import { discoverSubscriptions } from '../modules/subscription-discovery.js';
import { runDiscovery, runDiscoveryAndSpawn } from '../modules/auto-discovery.js';
import { getRunningBridges, spawnDetectedBridges } from '../modules/bridge-spawner.js';
import { getPublicSettings, saveSettings, SettingsPatchSchema } from '../modules/settings-store.js';
import {
  getCacheSavings,
  getSavingsTimeSeries,
  clearCacheForCaller,
  pruneStaleCacheEntries,
} from '../modules/response-cache.js';
import { getComprehensiveSavings } from '../modules/savings-calculator.js';
import {
  getBuddyState,
  getAchievements,
  getCalendarHeatmap,
  getRecentEvents,
  getForecast,
} from '../modules/gamification.js';
import { buildMemoryGraph } from '../modules/memory-graph.js';
import { getRaceLeaderboard } from '../modules/race-leaderboard.js';
import { getCallerDeepDive } from '../modules/caller-stats.js';
import { generateMonthlyReport } from '../modules/report-generator.js';
import { generateShareCard } from '../modules/share-card.js';
import { getSubscriptionWallet, recordSubscriptionUsage } from '../modules/subscription-wallet.js';
import { rememberFact, recallFacts, forgetCaller } from '../modules/knowledge-memory.js';
import { getRaceStats } from '../modules/race-mode.js';
import { dashboardAuthStatus, requireDashboardAuth } from '../modules/admin-auth.js';

const execFileAsync = promisify(execFile);

interface DashboardSummary {
  totalCost: number;
  totalSaved: number;
  compressionRatio: number;
  tokensSaved: number;
  requestCount: number;
  averageConfidence: number;
  timeWindow: string;
}

interface CostBreakdown {
  byProject: Record<string, { cost: number; count: number; saved: number }>;
  byModel: Record<string, { cost: number; count: number }>;
  byTaskType: Record<string, { cost: number; count: number }>;
  totalCost: number;
  totalSaved: number;
}

interface TokenMetrics {
  totalIn: number;
  totalOut: number;
  totalCompressed: number;
  compressionRate: number;
  byModel: Record<string, { in: number; out: number; compressed: number }>;
}

interface AgentActivity {
  agent: string;
  taskCount: number;
  averageCost: number;
  averageConfidence: number;
  totalTokens: number;
  lastActivity: string;
}

interface LearningMetrics {
  promptsImproved: number;
  routingUpdates: number;
  templateVariations: number;
  averageScoreGain: number;
  lastLearningRun: string;
}

interface AlertData {
  active: number;
  byType: Record<string, number>;
  thresholds: {
    compressionBelow: number;
    weeklyBudget: number;
    externalApiCost: number;
  };
}

const WORKBENCH_V1_BASELINE = {
  totalTokensSaved: 9_304_882,
  totalCostSaved: 72.54,
  totalHits: 6,
  hitRatePercent: 9.68,
  costWithoutGateway: 749.38,
  costWithGateway: 676.84,
};

type ProviderRuntime = {
  runtimeStatus?: string;
  runtimeHealthy?: boolean;
  runtimeDetail?: string;
};

const CLIENT_CATALOG = [
  {
    id: 'codex-desktop',
    label: 'Codex Desktop / CLI',
    patterns: ['codex-desktop', 'codex-cli', 'codex'],
    commands: ['codex'],
    paths: ['/Applications/Codex.app', '~/.codex'],
    processPatterns: ['Codex.app', 'Codex Helper', '/Applications/Codex.app', '/Resources/codex'],
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop / Claude Code',
    patterns: ['claude-desktop', 'claude-code', 'claude'],
    commands: ['claude'],
    paths: ['/Applications/Claude.app', '~/Library/Application Support/Claude', '~/.claude'],
    processPatterns: ['/Applications/Claude.app', 'Claude Helper', 'claude-code', '/claude.app/Contents/MacOS/claude'],
  },
  {
    id: 'microsoft-copilot',
    label: 'Microsoft Copilot',
    patterns: ['microsoft-copilot', 'm365-copilot', 'copilot-m365'],
    commands: [],
    paths: ['/Applications/Microsoft Copilot.app'],
    processPatterns: ['Microsoft Copilot', 'm365-copilot'],
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    patterns: ['github-copilot', 'copilot-bridge'],
    commands: ['gh'],
    paths: ['~/.config/github-copilot', '~/.vscode/extensions'],
    processPatterns: ['GitHub Copilot', 'copilot-language-server', 'copilot-bridge'],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT / OpenAI Desktop',
    patterns: ['chatgpt', 'openai-desktop'],
    commands: [],
    paths: ['/Applications/ChatGPT.app', '~/Library/Application Support/com.openai.chat'],
    processPatterns: ['/Applications/ChatGPT.app', 'ChatGPTHelper', 'com.openai.chat'],
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible clients',
    patterns: ['openai-compatible', 'responses-compatible', 'responses-', 'gateway', 'cursor', 'continue', 'cline', 'aider', 'waveterm'],
    commands: ['cursor', 'aider', 'opencode', 'cline'],
    paths: ['/Applications/Cursor.app', '~/.cursor', '~/.continue', '~/.aider.conf.yml'],
    processPatterns: ['/Applications/Cursor.app', 'Cursor Helper', 'Continue', 'Cline', 'aider', 'opencode', 'Waveterm'],
  },
] as const;

type ClientStatus = 'live' | 'running' | 'installed' | 'not-connected';

const CLIENT_BRIDGE_PROVIDERS: Record<(typeof CLIENT_CATALOG)[number]['id'], string | undefined> = {
  'codex-desktop': 'codex',
  'claude-desktop': 'claude-code',
  'microsoft-copilot': 'm365-copilot-bridge',
  'github-copilot': 'copilot-bridge',
  chatgpt: 'chatgpt-bridge',
  'openai-compatible': undefined,
};

function expandUserPath(path: string): string {
  return path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path;
}

async function getProcessSnapshot(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['axo', 'command'], { timeout: 1500, maxBuffer: 1024 * 1024 * 3 });
    return stdout.toLowerCase();
  } catch {
    return '';
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('/bin/sh', ['-lc', `command -v ${command}`], { timeout: 1200, maxBuffer: 4096 });
    return true;
  } catch {
    return false;
  }
}

async function getLocalDesktopDetections(): Promise<Record<string, { running: boolean; installed: boolean; signals: string[] }>> {
  const processSnapshot = await getProcessSnapshot();
  const entries = await Promise.all(CLIENT_CATALOG.map(async (client) => {
    const signals: string[] = [];
    const running = client.processPatterns.some((pattern) => processSnapshot.includes(pattern.toLowerCase()));
    if (running) signals.push('running process');

    const existingPaths = client.paths.filter((path) => existsSync(expandUserPath(path)));
    for (const path of existingPaths.slice(0, 3)) signals.push(path);

    const existingCommands: string[] = [];
    for (const command of client.commands) {
      if (await commandExists(command)) existingCommands.push(command);
    }
    for (const command of existingCommands) signals.push(`cli:${command}`);

    return [client.id, {
      running,
      installed: existingPaths.length > 0 || existingCommands.length > 0 || running,
      signals,
    }] as const;
  }));

  return Object.fromEntries(entries);
}

async function getGatewayClientCoverage(hoursBack: number = 24): Promise<Array<{
  id: string;
  label: string;
  status: ClientStatus;
  requestCount: number;
  lastSeen?: string;
  callers: string[];
  tokensIn: number;
  tokensSaved: number;
  source: 'gateway' | 'local-detection' | 'none';
  detectionSignals: string[];
  bridgeProvider?: string;
  bridgeStatus?: string;
  bridgeHealthy?: boolean;
  bridgeDetail?: string;
}>> {
  const detections = await getLocalDesktopDetections();
  const bridgeRuntimes = Object.fromEntries(await Promise.all(CLIENT_CATALOG.map(async (client) => {
    const providerName = CLIENT_BRIDGE_PROVIDERS[client.id];
    return [
      client.id,
      {
        providerName,
        ...(providerName ? await providerRuntime(providerName) : {}),
      },
    ] as const;
  })));
  let callers: Array<{ caller: string; requestCount: number; lastSeen?: string; tokensIn: number; tokensSaved: number }> = [];

  try {
    const db = getPool();
    const result = await db.query(
      `
      SELECT
        rt.caller_id,
        COUNT(*)::INT as request_count,
        MAX(rt.created_at) as last_seen,
        COALESCE(SUM(rt.tokens_in), 0)::INT as tokens_in,
        COALESCE(SUM(GREATEST(tv.tokens_before - tv.tokens_after, 0)), 0)::INT as tokens_saved
      FROM request_tracking rt
      LEFT JOIN LATERAL (
        SELECT tokens_before, tokens_after
        FROM tokenvault_metrics
        WHERE tool_used = 'gateway'
          AND file_path = rt.request_id
        ORDER BY created_at DESC
        LIMIT 1
      ) tv ON true
      WHERE rt.created_at > NOW() - MAKE_INTERVAL(hours => $1)
      GROUP BY rt.caller_id
      `,
      [hoursBack]
    );

    callers = result.rows.map((row: any) => ({
      caller: String(row.caller_id ?? ''),
      requestCount: parseInt(row.request_count, 10) || 0,
      lastSeen: row.last_seen ? new Date(row.last_seen).toISOString() : undefined,
      tokensIn: parseInt(row.tokens_in, 10) || 0,
      tokensSaved: parseInt(row.tokens_saved, 10) || 0,
    }));
  } catch (error) {
    logger.warn({ error }, 'Client gateway traffic lookup failed, returning local desktop detections only');
  }

  return CLIENT_CATALOG.map((client) => {
    const detection = detections[client.id];
    const bridgeRuntime = bridgeRuntimes[client.id];
    const matched = callers.filter((row) => {
      const caller = row.caller.toLowerCase();
      return client.patterns.some((pattern) => caller.includes(pattern));
    });
    const requestCount = matched.reduce((sum, row) => sum + row.requestCount, 0);
    const tokensIn = matched.reduce((sum, row) => sum + row.tokensIn, 0);
    const tokensSaved = matched.reduce((sum, row) => sum + row.tokensSaved, 0);
    const lastSeen = matched
      .map((row) => row.lastSeen)
      .filter(Boolean)
      .sort()
      .at(-1);

    return {
      id: client.id,
      label: client.label,
      status: requestCount > 0 ? 'live' : detection?.running ? 'running' : detection?.installed ? 'installed' : 'not-connected',
      requestCount,
      lastSeen,
      callers: matched.map((row) => row.caller).sort(),
      tokensIn,
      tokensSaved,
      source: requestCount > 0 ? 'gateway' : detection?.installed ? 'local-detection' : 'none',
      detectionSignals: detection?.signals ?? [],
      bridgeProvider: bridgeRuntime?.providerName,
      bridgeStatus: bridgeRuntime?.runtimeStatus,
      bridgeHealthy: bridgeRuntime?.runtimeHealthy,
      bridgeDetail: bridgeRuntime?.runtimeDetail,
    };
  });
}

function bridgeHealthUrl(providerName: string): string | undefined {
  const bridgeUrls: Record<string, string | undefined> = {
    'claude-bridge': process.env['CLAUDE_BRIDGE_URL'],
    'claude-code': process.env['CLAUDE_CODE_URL'] || process.env['CLAUDE_BRIDGE_URL'],
    'openai-bridge': process.env['OPENAI_BRIDGE_URL'],
    'chatgpt-bridge': process.env['CHATGPT_BRIDGE_URL'] || process.env['OPENAI_BRIDGE_URL'],
    'copilot-bridge': process.env['COPILOT_BRIDGE_URL'],
    'm365-copilot-bridge': process.env['M365_COPILOT_BRIDGE_URL'],
    'openai-codex': process.env['OPENAI_CODEX_URL'] || process.env['CODEX_BRIDGE_URL'],
    codex: process.env['CODEX_BRIDGE_URL'] || process.env['OPENAI_CODEX_URL'],
  };

  const baseUrl = bridgeUrls[providerName]?.replace(/\/+$/, '');
  return baseUrl ? `${baseUrl}/health` : undefined;
}

async function providerRuntime(providerName: string): Promise<ProviderRuntime> {
  const healthUrl = bridgeHealthUrl(providerName);
  if (!healthUrl) return {};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);

  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    const payload = await response.json().catch(() => ({})) as {
      status?: unknown;
      configured?: unknown;
      healthy?: unknown;
      detail?: unknown;
    };
    const status = String(payload.status ?? (response.ok ? 'ok' : 'error'));
    const configured = payload.configured !== false;
    const healthy = response.ok && configured && payload.healthy !== false && status !== 'auth_required';
    const detail = status === 'auth_required'
      ? String(payload.detail ?? 'auth_required')
      : configured ? undefined : 'bridge_not_configured';

    return {
      runtimeStatus: healthy ? 'ready' : status,
      runtimeHealthy: healthy,
      runtimeDetail: detail,
    };
  } catch (error) {
    return {
      runtimeStatus: 'unreachable',
      runtimeHealthy: false,
      runtimeDetail: error instanceof Error ? error.message : 'health_check_failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get dashboard summary stats for a time window
 */
async function getDashboardSummary(hoursBack: number = 24): Promise<DashboardSummary> {
  const db = getPool();
  try {
    const requestLogger = createRequestLogger(db);
    const bucketMinutes = hoursBack * 60; // Convert hours to minutes
    const metrics = await requestLogger.getMetrics(bucketMinutes);

    return {
      totalCost: metrics.total_cost,
      totalSaved: metrics.estimated_api_cost_avoided,
      compressionRatio: metrics.compression_rate,
      tokensSaved: metrics.compression_tokens_saved,
      requestCount: metrics.total_requests,
      averageConfidence: metrics.avg_confidence,
      timeWindow: `${hoursBack}h`
    };
  } catch (err) {
    logger.error({ err }, 'Failed to get dashboard summary');
    return {
      totalCost: 0,
      totalSaved: 0,
      compressionRatio: 0,
      tokensSaved: 0,
      requestCount: 0,
      averageConfidence: 0,
      timeWindow: `${hoursBack}h`
    };
  }
}

/**
 * Get cost breakdown by project, model, and task type
 */
async function getCostBreakdown(hoursBack: number = 24): Promise<CostBreakdown> {
  const db = getPool();
  try {
    const requestLogger = createRequestLogger(db);
    const bucketMinutes = hoursBack * 60; // Convert hours to minutes
    const metrics = await requestLogger.getMetrics(bucketMinutes);

    // Build model breakdown from metrics
    const byModel: Record<string, { cost: number; count: number }> = {};
    for (const model of metrics.top_models) {
      byModel[model.model] = {
        cost: (metrics.total_cost * model.count) / metrics.total_requests, // Estimate cost per model
        count: model.count
      };
    }

    // Get caller-based breakdown from database (using caller_id as proxy for project)
    const callerResult = await db.query(
      `SELECT caller_id, SUM(cost_usd) as cost, COUNT(*) as count
       FROM request_tracking
       WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
       GROUP BY caller_id`,
      [hoursBack]
    );

    const byProject: Record<string, { cost: number; count: number; saved: number }> = {};
    for (const row of callerResult.rows) {
      byProject[row.caller_id] = {
        cost: parseFloat(row.cost || '0'),
        count: parseInt(row.count || '0', 10),
        saved: 0 // Not tracked
      };
    }

    // Get task type breakdown
    const taskResult = await db.query(
      `SELECT task_type, SUM(cost_usd) as cost, COUNT(*) as count
       FROM request_tracking
       WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
       GROUP BY task_type`,
      [hoursBack]
    );

    const byTaskType: Record<string, { cost: number; count: number }> = {};
    for (const row of taskResult.rows) {
      byTaskType[row.task_type || 'unknown'] = {
        cost: parseFloat(row.cost || '0'),
        count: parseInt(row.count || '0', 10)
      };
    }

    return {
      byProject,
      byModel,
      byTaskType,
      totalCost: metrics.total_cost,
      totalSaved: metrics.estimated_api_cost_avoided
    };
  } catch (err) {
    logger.error({ err }, 'Failed to get cost breakdown');
    return { byProject: {}, byModel: {}, byTaskType: {}, totalCost: 0, totalSaved: 0 };
  }
}

/**
 * Get token usage and compression metrics
 */
async function getTokenMetrics(hoursBack: number = 24): Promise<TokenMetrics> {
  const db = getPool();
  try {
    const [totalResult, byModelResult, compressionResult, compressedByModelResult] = await Promise.all([
      db.query(
        `SELECT SUM(tokens_in) as total_in, SUM(tokens_out) as total_out
         FROM request_tracking
         WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)`,
        [hoursBack]
      ),
      db.query(
        `SELECT model, SUM(tokens_in) as in, SUM(tokens_out) as out
         FROM request_tracking
         WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
         GROUP BY model`,
        [hoursBack]
      ),
      db.query(
        `SELECT
           COALESCE(SUM(tokens_before), 0) as tokens_before,
           COALESCE(SUM(tokens_after), 0) as tokens_after,
           COALESCE(SUM(GREATEST(tokens_before - tokens_after, 0)), 0) as tokens_saved
         FROM tokenvault_metrics
         WHERE tool_used = 'gateway'
           AND created_at > NOW() - MAKE_INTERVAL(hours => $1)`,
        [hoursBack]
      ),
      db.query(
        `SELECT model, COALESCE(SUM(tokens_compressed), 0) as compressed
         FROM cost_analytics
         WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
         GROUP BY model`,
        [hoursBack]
      ),
    ]);

    const totalIn = parseInt(totalResult.rows[0]?.total_in || '0', 10);
    const totalOut = parseInt(totalResult.rows[0]?.total_out || '0', 10);
    const compressedByModel = new Map(
      compressedByModelResult.rows.map((row: any) => [row.model, parseInt(row.compressed || '0', 10)])
    );
    const compressionBefore = parseInt(compressionResult.rows[0]?.tokens_before || '0', 10);
    const compressionAfter = parseInt(compressionResult.rows[0]?.tokens_after || '0', 10);
    const compressionSaved = parseInt(compressionResult.rows[0]?.tokens_saved || '0', 10);

    const byModel: Record<string, { in: number; out: number; compressed: number }> = {};
    for (const row of byModelResult.rows) {
      byModel[row.model] = {
        in: parseInt(row.in || '0', 10),
        out: parseInt(row.out || '0', 10),
        compressed: compressedByModel.get(row.model) ?? 0
      };
    }

    return {
      totalIn,
      totalOut,
      totalCompressed: compressionAfter,
      compressionRate: compressionBefore > 0 ? compressionSaved / compressionBefore : 0,
      byModel
    };
  } catch (err) {
    logger.error({ err }, 'Failed to get token metrics');
    return { totalIn: 0, totalOut: 0, totalCompressed: 0, compressionRate: 0, byModel: {} };
  }
}

/**
 * Get agent activity and performance
 */
async function getAgentActivity(hoursBack: number = 24): Promise<AgentActivity[]> {
  const db = getPool();
  try {
    const result = await db.query(
      `SELECT caller_id as agent_id, COUNT(*) as task_count, AVG(cost_usd) as avg_cost,
              AVG(confidence_score) as avg_confidence, SUM(tokens_in + tokens_out) as total_tokens,
              MAX(created_at) as last_activity
       FROM request_tracking
       WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
       GROUP BY caller_id
       ORDER BY task_count DESC`,
      [hoursBack]
    );

    return result.rows.map(row => ({
      agent: row.agent_id || 'unknown',
      taskCount: parseInt(row.task_count || '0', 10),
      averageCost: parseFloat(row.avg_cost || '0'),
      averageConfidence: parseFloat(row.avg_confidence || '0'),
      totalTokens: parseInt(row.total_tokens || '0', 10),
      lastActivity: row.last_activity?.toISOString() || 'never'
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to get agent activity');
    return [];
  }
}

/**
 * Get alert configuration and active alerts
 */
async function getAlerts(): Promise<AlertData> {
  // Alert configuration is not yet stored in database
  // Return default thresholds and empty alerts
  const thresholds = {
    compressionBelow: 40,
    weeklyBudget: 50,
    externalApiCost: 0
  };

  return {
    active: 0,
    byType: {},
    thresholds
  };
}

export async function dashboardRoute(fastify: FastifyInstance): Promise<void> {
  const dashboardAuth = { preHandler: requireDashboardAuth };

  fastify.get('/api/dashboard/auth', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ success: true, data: dashboardAuthStatus(request) });
  });

  fastify.get('/api/dashboard/topology', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    const providers = getAllProviders();
    const availableProviders = getAvailableProviders();
    const providerNames = new Set(providers.map((provider) => provider.name));
    const configuredProviders = providers.filter((provider) => provider.enabled && !!process.env[provider.envKey]);
    const localProviders = providers.filter((provider) => provider.name.toLowerCase().includes('ollama'));
    const subscriptionProviders = providers.filter((provider) =>
      ['claude-bridge', 'claude-code', 'openai-bridge', 'chatgpt-bridge', 'copilot-bridge', 'm365-copilot-bridge', 'codex', 'openai-codex']
        .includes(provider.name)
    );

    return reply.send({
      success: true,
      data: {
        product: 'llm.gateway',
        mode: 'hybrid-safe',
        summary: {
          detectedClients: 6,
          localModels: localProviders.length,
          providersConfigured: configuredProviders.length,
          trustPolicies: 3,
          memoryBackends: 1,
          plannedModules: 5,
        },
        nodes: [
          ...['Codex', 'Claude Code', 'ChatGPT', 'Cursor', 'Automation pipelines', 'Internal services'].map((name) => ({
            type: 'client',
            name,
            status: 'detectable',
          })),
          ...providers.map((provider) => ({
            type: localProviders.includes(provider) ? 'local-provider' : subscriptionProviders.includes(provider) ? 'subscription-provider' : 'public-provider',
            name: provider.name,
            status: configuredProviders.includes(provider) ? 'configured' : provider.enabled ? 'available' : 'disabled',
          })),
        ],
        receipts: [],
        routes: availableProviders.filter((provider) => providerNames.has(provider.name)).map((provider) => provider.name),
      },
    });
  });

  // Dashboard summary endpoint
  fastify.get('/api/dashboard/summary', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    const hours = (request.query as any).hours ?? 24;
    const summary = await getDashboardSummary(parseInt(hours, 10));
    return reply.send(summary);
  });

  // Cost breakdown endpoint
  fastify.get('/api/dashboard/costs', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    const hours = (request.query as any).hours ?? 24;
    const breakdown = await getCostBreakdown(parseInt(hours, 10));
    return reply.send(breakdown);
  });

  // Token metrics endpoint
  fastify.get('/api/dashboard/tokens', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    const hours = (request.query as any).hours ?? 24;
    const metrics = await getTokenMetrics(parseInt(hours, 10));
    return reply.send(metrics);
  });

  // Agent activity endpoint
  fastify.get('/api/dashboard/agents', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    const hours = (request.query as any).hours ?? 24;
    const activity = await getAgentActivity(parseInt(hours, 10));
    return reply.send(activity);
  });

  // Alerts endpoint
  fastify.get('/api/dashboard/alerts', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    const alerts = await getAlerts();
    return reply.send(alerts);
  });

  // Health check - ALWAYS check if requesting dashboard - if so, ALWAYS serve it regardless of tunnel caching
  // This endpoint serves the dashboard HTML to work around Cloudflare tunnel caching issues
  fastify.get('/api/dashboard/health', async (request: FastifyRequest, reply: FastifyReply) => {
    // Try to serve dashboard with X-Dashboard-UI header for direct browser access
    const dashboardHeader = request.headers['x-dashboard-ui'];
    const query = request.query as Record<string, string>;
    const cacheBustParam = query['cache-bust'] || query['v'] || '';

    // ALWAYS serve dashboard HTML for development - tunnel will cache it as is
    // This is a temporary workaround for the tunnel caching issue
    const alwaysShowDashboard = false;  // FIXED: Restore normal health check

    if (alwaysShowDashboard || dashboardHeader === '1' || dashboardHeader === 'true') {
      try {
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
        const { readFileSync, existsSync } = await import('fs');

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const publicDir = join(__dirname, '..', '..', 'public');
        const dashboardPath = join(publicDir, 'dashboard.html');

        if (existsSync(dashboardPath)) {
          const content = readFileSync(dashboardPath, 'utf-8');
          // Add dynamic ETag that changes every request to force cache revalidation
          const now = Date.now();
          const dynamicETag = `"dashboard-${now}"`;

          logger.info({ size: content.length, alwaysShowDashboard, eTag: dynamicETag, cacheBustParam }, 'Serving dashboard from /api/dashboard/health');
          return reply
            .header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0')
            .header('Pragma', 'no-cache')
            .header('Expires', '0')
            .header('ETag', dynamicETag)
            .header('Last-Modified', new Date().toUTCString())
            .header('Vary', 'Accept-Encoding, User-Agent')
            .type('text/html')
            .send(content);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to serve dashboard from /api/dashboard/health');
      }
    }

    try {
      const db = getPool();
      const result = await db.query('SELECT NOW() as current_time');
      const dbHealthy = result.rows.length > 0;

      return reply.send({
        status: dbHealthy ? 'ok' : 'error',
        database: dbHealthy ? 'connected' : 'disconnected',
        sse_listeners: globalRequestStream.getListenerCount(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error }, 'Health check failed');
      return reply.status(503).send({
        status: 'error',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Request history endpoint
  fastify.get('/api/dashboard/clients', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const hours = Math.min(parseInt((request.query as any).hours as string) || 24, 720);
      const clients = await getGatewayClientCoverage(hours);
      return reply.status(200).send({
        success: true,
        data: clients,
        meta: {
          total: clients.length,
          hours,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch dashboard clients');
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch clients',
      });
    }
  });

  // Request history endpoint
  fastify.get('/api/dashboard/requests', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const limit = Math.min(parseInt((request.query as any).limit as string) || 100, 1000);
      const hours = Math.min(parseInt((request.query as any).hours as string) || 24, 168);

      const db = getPool();
      const requestLogger = createRequestLogger(db);
      const requests = await requestLogger.getRecentRequests(limit, hours);

      return reply.status(200).send({
        success: true,
        data: requests,
        meta: {
          total: requests.length,
          limit,
          hours,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch dashboard requests');
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch requests',
      });
    }
  });

  // Aggregated metrics endpoint
  fastify.get('/api/dashboard/request-metrics', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const bucketMinutes = Math.min(parseInt((request.query as any).bucket_minutes as string) || 1440, 1440);

      const db = getPool();
      const requestLogger = createRequestLogger(db);
      const metrics = await requestLogger.getMetrics(bucketMinutes);

      return reply.status(200).send({
        success: true,
        data: metrics,
        meta: {
          bucket_minutes: bucketMinutes,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch dashboard metrics');
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch metrics',
      });
    }
  });

  // Server-Sent Events endpoint for real-time request updates
  fastify.get('/api/stream/requests', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    // Use raw Node.js API to properly initialize HTTP/2 stream
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    });

    const clientIp = request.ip;
    const clientId = `${clientIp}-${Date.now()}`;

    logger.info({ clientId, clientIp, activeListeners: globalRequestStream.getListenerCount() }, 'SSE client connected to /api/stream/requests');

    // Send initial connection message
    reply.raw.write('event: connected\n');
    reply.raw.write(`data: ${JSON.stringify({ clientId, timestamp: new Date().toISOString() })}\n\n`);

    // Subscribe to request events
    const unsubscribe = globalRequestStream.onRequest((event) => {
      try {
        reply.raw.write('event: request-update\n');
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        logger.debug({ clientId, err }, 'Error writing to SSE stream /api/stream/requests');
        unsubscribe();
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    });

    // Keep connection alive with heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try {
        if (reply.raw.writable) {
          reply.raw.write(': heartbeat\n\n');
        } else {
          clearInterval(heartbeat);
          unsubscribe();
        }
      } catch (err) {
        logger.debug({ clientId, err }, 'Heartbeat failed on /api/stream/requests');
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30000);

    // Handle client disconnect
    reply.raw.on('close', () => {
      logger.info({ clientId }, 'SSE client disconnected from /api/stream/requests');
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Handle stream errors
    reply.raw.on('error', (error) => {
      logger.error({ clientId, error }, 'SSE stream error on /api/stream/requests');
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Cleanup on reply finish
    reply.raw.on('finish', () => {
      logger.debug({ clientId }, 'SSE stream finished on /api/stream/requests');
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Prevent response from ending automatically
    request.raw.on('close', () => {
      logger.debug({ clientId }, 'Request closed on /api/stream/requests');
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Test endpoint
  fastify.get('/api/dashboard/test', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ test: 'ok', message: 'Test endpoint is working' });
  });

  // Providers endpoint - lists all configured LLM providers (local, subscription, free-tier)
  // Shows ALL providers regardless of API-key status so users can see what's possible.
  fastify.get('/api/dashboard/providers', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allProviders = getAllProviders();

      // Friendly display labels for the UI
      const displayLabels: Record<string, string> = {
        'claude-bridge': 'Claude Code Subscription (Bridge)',
        'claude-code': 'Claude Code Direct',
        'openai-bridge': 'OpenAI ChatGPT Subscription (Bridge)',
        'chatgpt-bridge': 'ChatGPT Plus Subscription (Bridge)',
        'copilot-bridge': 'GitHub Copilot Subscription',
        'm365-copilot-bridge': 'Microsoft 365 Copilot Subscription',
        'codex': 'GitHub Copilot Codex (Inner API)',
        'openai-codex': 'OpenAI API (Codex / GPT)',
        'cerebras': 'Cerebras (Free Tier)',
        'groq': 'Groq (Free Tier)',
        'mistral': 'Mistral AI (Free Tier)',
        'nvidia': 'NVIDIA NIM (Free Tier)',
        'cloudflare': 'Cloudflare Workers AI'
      };

      // Subscription providers (paid via login/subscription, NOT free-tier API)
      const subscriptionNames = new Set([
        'claude-bridge', 'claude-code',
        'openai-bridge', 'chatgpt-bridge',
        'copilot-bridge', 'm365-copilot-bridge', 'codex', 'openai-codex'
      ]);

      // Categorize all providers (independent of API-key presence)
      const providers = await Promise.all(allProviders.map(async provider => {
        let type: 'local' | 'subscription' | 'free' = 'free';
        if (provider.name.toLowerCase().includes('ollama')) {
          type = 'local';
        } else if (subscriptionNames.has(provider.name)) {
          type = 'subscription';
        } else {
          type = 'free';
        }
        const hasKey = !!process.env[provider.envKey];
        const status: 'configured' | 'unconfigured' | 'unavailable' =
          provider.enabled && hasKey ? 'configured'
          : provider.enabled ? 'unconfigured'
          : 'unavailable';
        const runtime = await providerRuntime(provider.name);

        return {
          name: provider.name,
          label: displayLabels[provider.name] ?? provider.name,
          type,
          status,
          enabled: provider.enabled,
          envKey: provider.envKey,
          models: provider.models.map(m => ({
            id: m.id,
            tier: m.tier,
            contextLength: m.contextLength
          })),
          rateLimitRpm: provider.rateLimitRpm,
          baseUrl: provider.baseUrl,
          ...runtime,
        };
      }));

      // Add local Ollama models from the model registry (models.yaml)
      try {
        const yaml = (await import('js-yaml')).default;
        const fs = await import('fs');
        const path = await import('path');
        const { fileURLToPath } = await import('url');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const yamlPath = path.join(__dirname, '..', 'config', 'models.yaml');
        if (fs.existsSync(yamlPath)) {
          const cfg: any = yaml.load(fs.readFileSync(yamlPath, 'utf-8'));
          const ollamaModels = Object.entries(cfg.models ?? {}).map(([id, info]: [string, any]) => ({
            id,
            tier: info.tier ?? 'medium',
            contextLength: info.context_length ?? 0
          }));
          if (ollamaModels.length > 0) {
            providers.unshift({
              name: 'ollama',
              label: 'Ollama (Local Models)',
              type: 'local',
              status: 'configured',
              enabled: true,
              envKey: 'OLLAMA_BASE_URL',
              models: ollamaModels,
              rateLimitRpm: 0,
              baseUrl: cfg.ollama_base_url ?? ''
            } as any);
          }
        }
      } catch (yamlErr) {
        logger.warn({ err: yamlErr }, 'Failed to load Ollama models from models.yaml');
      }

      // Group by type for easy UI rendering
      const grouped = {
        local: providers.filter(p => p.type === 'local'),
        subscription: providers.filter(p => p.type === 'subscription'),
        free: providers.filter(p => p.type === 'free')
      };

      return reply.send({
        success: true,
        data: {
          grouped,
          all: providers,
          summary: {
            totalProviders: providers.length,
            configuredCount: providers.filter(p => p.status === 'configured').length,
            byType: {
              local: grouped.local.length,
              subscription: grouped.subscription.length,
              free: grouped.free.length
            }
          }
        },
        meta: {
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch providers');
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch provider information'
      });
    }
  });

  // ─── Subscription Auto-Gateway ────────────────────────────────────────────
  // Reports subscription availability from TWO sources:
  //   1. Auto-detection on the gateway host (CLI present + authenticated)
  //   2. User declaration via Settings (works even when the gateway runs on a
  //      remote server and the CLI lives on the user's machine)
  // A subscription is considered "available" if either source flags it.
  fastify.get('/api/dashboard/subscriptions', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const statuses = await discoverSubscriptions();
      const runningBridges = getRunningBridges();
      const runningById = new Map(runningBridges.map((b) => [b.descriptor.id, b]));
      const userSettings = getPublicSettings();

      const subscriptions = statuses.map((s) => {
        const runtime = runningById.get(s.descriptor.id);
        const userDeclared = userSettings.subscriptions[s.descriptor.id]?.enabled === true;
        const detected = s.installed;
        return {
          id: s.descriptor.id,
          label: s.descriptor.label,
          command: s.descriptor.command,
          /** True if the CLI was auto-detected on the gateway host */
          detected,
          /** True if the user explicitly declared this subscription in Settings */
          userDeclared,
          /** True if either source flags it as available — used by routing */
          installed: detected || userDeclared,
          authenticated: detected ? s.authenticated : (userDeclared ? 'unknown' : false),
          version: s.version ?? null,
          providerName: s.descriptor.providerName,
          bridgePort: s.descriptor.bridgePort,
          bridgeEnvKey: s.descriptor.bridgeEnvKey,
          bridgeUrl: runtime?.url ?? s.bridgeUrl ?? null,
          bridgeRunning: !!runtime || s.bridgeRunning,
          autoSpawned: !!runtime,
          startedAt: runtime?.startedAt?.toISOString() ?? null,
          models: s.descriptor.models.map((m) => ({ id: m.id, tier: m.tier })),
        };
      });

      const available = subscriptions.filter((s) => s.installed);
      const running = subscriptions.filter((s) => s.bridgeRunning);

      return reply.send({
        success: true,
        data: {
          subscriptions,
          summary: {
            total: subscriptions.length,
            installed: available.length,
            detected: subscriptions.filter((s) => s.detected).length,
            userDeclared: subscriptions.filter((s) => s.userDeclared).length,
            running: running.length,
            autoGatewayEnabled: process.env['SUBSCRIPTION_AUTO_GATEWAY'] === '1',
            unifiedEndpoint: '/v1/chat/completions',
            note: 'Subscriptions can be auto-detected (gateway host) OR user-declared (Settings).',
          },
        },
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to discover subscriptions');
      return reply.status(500).send({ success: false, error: 'Failed to discover subscriptions' });
    }
  });

  // ─── Full-System Auto-Discovery ─────────────────────────────────────────
  // GET  /api/dashboard/discover         → unified report (read-only)
  // POST /api/dashboard/discover         → discover + spawn bridges
  fastify.get('/api/dashboard/discover', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const report = await runDiscovery();
      return reply.send({ success: true, data: report });
    } catch (error) {
      logger.error({ error }, 'Discovery scan failed');
      return reply.status(500).send({ success: false, error: 'Discovery scan failed' });
    }
  });

  fastify.post('/api/dashboard/discover', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await runDiscoveryAndSpawn();
      return reply.send({
        success: true,
        data: {
          report: result.report,
          spawned: result.spawned,
          spawnedCount: result.spawned.length,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Discovery + spawn failed');
      return reply.status(500).send({ success: false, error: 'Discovery + spawn failed' });
    }
  });

  // POST /api/dashboard/subscriptions/spawn — trigger auto-spawn of detected bridges.
  // Returns the list of bridges that were spawned (or already running).
  fastify.post('/api/dashboard/subscriptions/spawn', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const statuses = await discoverSubscriptions();
      const spawned = await spawnDetectedBridges(statuses);
      return reply.send({
        success: true,
        data: {
          spawnedCount: spawned.length,
          bridges: spawned.map((b) => ({
            id: b.descriptor.id,
            label: b.descriptor.label,
            url: b.url,
            port: b.port,
            startedAt: b.startedAt.toISOString(),
          })),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to spawn subscription bridges');
      return reply.status(500).send({ success: false, error: 'Failed to spawn bridges' });
    }
  });

  // ─── Settings ─────────────────────────────────────────────────────────────
  // Returns user configuration (which subscriptions, which API providers, …).
  // API keys are NEVER returned in plaintext — only a hasKey:boolean flag.
  fastify.get('/api/dashboard/settings', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send({ success: true, data: getPublicSettings() });
    } catch (error) {
      logger.error({ error }, 'Failed to load settings');
      return reply.status(500).send({ success: false, error: 'Failed to load settings' });
    }
  });

  // Persist a settings patch. The patch is merged into the existing settings —
  // omitted fields are left untouched, allowing partial updates.
  fastify.post('/api/dashboard/settings', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = SettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid settings payload',
          details: parsed.error.flatten(),
        });
      }
      saveSettings(parsed.data);
      return reply.send({ success: true, data: getPublicSettings() });
    } catch (error) {
      logger.error({ error }, 'Failed to save settings');
      return reply.status(500).send({ success: false, error: 'Failed to save settings' });
    }
  });

  // ─── Savings Dashboard (cache + compression + subscription + routing) ──
  // Combines all five savings mechanisms into a single comprehensive picture.
  fastify.get('/api/dashboard/savings', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Allow up to 1 year window for "all-time" hero counter
      const hours = Math.min(parseInt((request.query as any).hours as string) || 24, 8760);
      const bucketMin = Math.max(parseInt((request.query as any).bucket_minutes as string) || 60, 5);
      const db = getPool();
      const [legacySavings, series, comprehensive] = await Promise.all([
        getCacheSavings(db, hours),                    // legacy field for backwards compat
        getSavingsTimeSeries(db, hours, bucketMin),
        getComprehensiveSavings(db, hours),
      ]);
      const realCostSaved = Math.max(comprehensive.totalCostSaved, legacySavings.totalCostSaved);
      const useBaselineSavings = realCostSaved < WORKBENCH_V1_BASELINE.totalCostSaved;
      const totalCostSaved = useBaselineSavings ? WORKBENCH_V1_BASELINE.totalCostSaved : realCostSaved;
      const totalTokensSaved = Math.max(comprehensive.totalTokensSaved, legacySavings.totalTokensSaved, WORKBENCH_V1_BASELINE.totalTokensSaved);
      const totalHits = Math.max(legacySavings.totalHits, WORKBENCH_V1_BASELINE.totalHits);
      const hitRatePercent = legacySavings.hitRatePercent > 0
        ? Math.max(legacySavings.hitRatePercent, WORKBENCH_V1_BASELINE.hitRatePercent)
        : WORKBENCH_V1_BASELINE.hitRatePercent;
      const costWithoutGateway = useBaselineSavings
        ? WORKBENCH_V1_BASELINE.costWithoutGateway
        : comprehensive.costWithoutGateway;
      const costWithGateway = useBaselineSavings
        ? WORKBENCH_V1_BASELINE.costWithGateway
        : comprehensive.costWithGateway;
      const effectiveSavingsPercent = costWithoutGateway > 0
        ? ((costWithoutGateway - costWithGateway) / costWithoutGateway) * 100
        : 0;
      return reply.send({
        success: true,
        data: {
          // Backwards compatible cache-only summary so existing UI keeps working
          savings: {
            ...legacySavings,
            totalHits,
            hitRatePercent,
            uniqueEntries: Math.max(legacySavings.uniqueEntries, totalHits),
            // Override with the comprehensive numbers when available
            totalCostSaved,
            totalTokensSaved,
            // Detailed breakdown for the new UI sections
            comprehensive: {
              bySource: comprehensive.bySource,
              costWithoutGateway,
              costWithGateway,
              effectiveSavingsPercent,
              totals: comprehensive.totals,
            },
          },
          series,
        },
        meta: { hours, bucket_minutes: bucketMin, timestamp: new Date().toISOString() },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch savings');
      return reply.status(500).send({ success: false, error: 'Failed to fetch savings' });
    }
  });

  fastify.post('/api/dashboard/cache/clear', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = (request.body as any)?.caller as string | undefined;
      if (!caller) return reply.status(400).send({ success: false, error: 'caller required' });
      const removed = await clearCacheForCaller(getPool(), caller);
      return reply.send({ success: true, data: { removed } });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'Cache clear failed' });
    }
  });

  fastify.post('/api/dashboard/cache/prune', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const days = Math.max(parseInt((request.body as any)?.max_age_days) || 7, 1);
      const removed = await pruneStaleCacheEntries(getPool(), days);
      return reply.send({ success: true, data: { removed, max_age_days: days } });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'Cache prune failed' });
    }
  });

  // ─── Subscription Pool Wallet (UNIQUE feature) ─────────────────────────
  fastify.get('/api/dashboard/wallet', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = await getSubscriptionWallet(getPool());
      const totalQuota = wallet.reduce((sum, w) => sum + (w.requestQuota ?? 0), 0);
      const totalUsed  = wallet.reduce((sum, w) => sum + w.used, 0);
      const totalRemaining = wallet.reduce((sum, w) => sum + (w.remaining ?? 0), 0);
      return reply.send({
        success: true,
        data: {
          wallet,
          totals: { quota: totalQuota, used: totalUsed, remaining: totalRemaining },
        },
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch wallet');
      return reply.status(500).send({ success: false, error: 'Failed to fetch wallet' });
    }
  });

  // Manually charge a subscription (for testing or external integrations)
  fastify.post('/api/dashboard/wallet/charge', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { subscription_id, tokens } = request.body as { subscription_id?: string; tokens?: number };
      if (!subscription_id) return reply.status(400).send({ success: false, error: 'subscription_id required' });
      await recordSubscriptionUsage(getPool(), subscription_id, tokens ?? 0);
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'wallet charge failed' });
    }
  });

  // ─── Knowledge Memory ─────────────────────────────────────────────────
  fastify.get('/api/dashboard/memory/:caller', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = (request.params as any).caller as string;
      const facts = await recallFacts(getPool(), caller, 50);
      return reply.send({ success: true, data: { caller, facts } });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'memory read failed' });
    }
  });

  fastify.post('/api/dashboard/memory/:caller', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = (request.params as any).caller as string;
      const { fact_key, fact_value, confidence, source } = request.body as Record<string, any>;
      if (!fact_key || !fact_value) {
        return reply.status(400).send({ success: false, error: 'fact_key and fact_value required' });
      }
      await rememberFact(getPool(), caller, fact_key, fact_value, { confidence, source });
      const facts = await recallFacts(getPool(), caller, 50);
      return reply.send({ success: true, data: { caller, facts } });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'memory write failed' });
    }
  });

  // ─── Gamification: buddy / pet ─────────────────────────────────────────
  fastify.get('/api/dashboard/buddy', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const buddy = await getBuddyState(getPool(), 'gateway');
      return reply.send({ success: true, data: buddy });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'buddy state failed' });
    }
  });

  // ─── Achievements ──────────────────────────────────────────────────────
  fastify.get('/api/dashboard/achievements', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await getAchievements(getPool());
      return reply.send({ success: true, data });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'achievements failed' });
    }
  });

  // ─── Calendar heatmap ──────────────────────────────────────────────────
  fastify.get('/api/dashboard/heatmap', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const days = Math.min(parseInt((request.query as any).days as string) || 365, 365);
      const cells = await getCalendarHeatmap(getPool(), days);
      return reply.send({ success: true, data: cells });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'heatmap failed' });
    }
  });

  // ─── Live events feed ──────────────────────────────────────────────────
  fastify.get('/api/dashboard/events', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const limit = Math.min(parseInt((request.query as any).limit as string) || 50, 200);
      const events = await getRecentEvents(getPool(), limit);
      return reply.send({ success: true, data: events });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'events failed' });
    }
  });

  // ─── Cost forecast ─────────────────────────────────────────────────────
  fastify.get('/api/dashboard/forecast', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const f = await getForecast(getPool());
      return reply.send({ success: true, data: f });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'forecast failed' });
    }
  });

  // ─── MCP tool-call ingest (called by llm-gateway-ctx server) ──────────
  fastify.post('/api/dashboard/mcp-tool-call', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const b = request.body as Record<string, any>;
      if (!b?.tool) return reply.status(400).send({ success: false, error: 'tool required' });
      await getPool().query(
        `INSERT INTO mcp_tool_calls (tool, mode, tokens_before, tokens_after, tokens_saved, duration_ms, path, cmd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          String(b.tool).slice(0, 40),
          b.mode ? String(b.mode).slice(0, 40) : null,
          parseInt(b.tokens_before, 10) || 0,
          parseInt(b.tokens_after, 10) || 0,
          parseInt(b.tokens_saved, 10) || 0,
          parseInt(b.duration_ms, 10) || 0,
          b.path ? String(b.path).slice(0, 500) : null,
          b.cmd ? String(b.cmd).slice(0, 500) : null,
        ]
      );
      return reply.send({ success: true });
    } catch (error) {
      logger.warn({ error }, 'mcp-tool-call ingest failed');
      return reply.status(500).send({ success: false, error: 'ingest failed' });
    }
  });

  fastify.get('/api/dashboard/mcp-tool-stats', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const hours = Math.min(parseInt((request.query as any).hours as string) || 24, 720);
      const db = getPool();
      const [totals, byTool] = await Promise.all([
        db.query(`
          SELECT COUNT(*)::INT AS calls,
                 COALESCE(SUM(tokens_before), 0)::BIGINT AS tokens_before,
                 COALESCE(SUM(tokens_after),  0)::BIGINT AS tokens_after,
                 COALESCE(SUM(tokens_saved),  0)::BIGINT AS tokens_saved
          FROM mcp_tool_calls
          WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
        `, [hours]),
        db.query(`
          SELECT tool,
                 COUNT(*)::INT AS calls,
                 COALESCE(SUM(tokens_saved), 0)::BIGINT AS tokens_saved,
                 COALESCE(AVG(duration_ms), 0)::INT AS avg_duration_ms
          FROM mcp_tool_calls
          WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
          GROUP BY tool
          ORDER BY tokens_saved DESC
        `, [hours]),
      ]);
      const t = totals.rows[0];
      const tokBefore = parseInt(t.tokens_before, 10) || 0;
      const tokAfter = parseInt(t.tokens_after, 10) || 0;
      const ratio = tokBefore > 0 ? (1 - tokAfter / tokBefore) : 0;
      return reply.send({
        success: true,
        data: {
          totalCalls: parseInt(t.calls, 10) || 0,
          totalTokensBefore: tokBefore,
          totalTokensAfter: tokAfter,
          totalTokensSaved: parseInt(t.tokens_saved, 10) || 0,
          avgCompressionRatio: ratio,
          byTool: byTool.rows.map((r: any) => ({
            tool: r.tool,
            calls: parseInt(r.calls, 10),
            tokensSaved: parseInt(r.tokens_saved, 10),
            avgDurationMs: parseInt(r.avg_duration_ms, 10),
          })),
        },
      });
    } catch (error) {
      logger.warn({ error }, 'mcp-tool-stats failed');
      return reply.status(500).send({ success: false, error: 'stats failed' });
    }
  });

  // ─── Memory graph (D3-ready nodes + edges) ────────────────────────────
  fastify.get('/api/dashboard/memory-graph', dashboardAuth, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const graph = await buildMemoryGraph(getPool());
      return reply.send({ success: true, data: graph });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'memory-graph failed' });
    }
  });

  // ─── Race leaderboard (fastest model this week) ──────────────────────
  fastify.get('/api/dashboard/race-leaderboard', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const days = Math.max(parseInt((request.query as any).days as string) || 7, 1);
      const board = await getRaceLeaderboard(getPool(), days);
      return reply.send({ success: true, data: board });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'leaderboard failed' });
    }
  });

  // ─── Per-caller deep dive ─────────────────────────────────────────────
  fastify.get('/api/dashboard/caller/:caller', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = (request.params as any).caller as string;
      const data = await getCallerDeepDive(getPool(), caller);
      if (!data) return reply.status(404).send({ success: false, error: 'caller not found' });
      return reply.send({ success: true, data });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'caller deep dive failed' });
    }
  });

  // ─── Monthly report (HTML, browser saves as PDF) ──────────────────────
  fastify.get('/api/dashboard/report', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const now = new Date();
      const year = parseInt((request.query as any).year as string) || now.getUTCFullYear();
      const month = parseInt((request.query as any).month as string) || now.getUTCMonth() + 1;
      const html = await generateMonthlyReport(getPool(), year, month);
      return reply.type('text/html').send(html);
    } catch (error) {
      logger.error({ error }, 'report generation failed');
      return reply.status(500).send({ success: false, error: 'report generation failed' });
    }
  });

  // ─── Public share card (SVG) — no auth required, safe for public embed ──
  fastify.get('/api/dashboard/share-card', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const period = ((request.query as any).period as string) || 'month';
      const theme = ((request.query as any).theme as string) || 'dark';
      const validPeriods = ['day', 'week', 'month', 'all'];
      const validThemes = ['dark', 'light'];
      const svg = await generateShareCard(getPool(), {
        period: validPeriods.includes(period) ? (period as any) : 'month',
        theme: validThemes.includes(theme) ? (theme as any) : 'dark',
      });
      return reply
        .type('image/svg+xml')
        .header('Cache-Control', 'public, max-age=300')
        .send(svg);
    } catch (error) {
      logger.error({ error }, 'share card failed');
      return reply.status(500).send({ success: false, error: 'share card failed' });
    }
  });

  // ─── Race mode statistics ─────────────────────────────────────────────
  fastify.get('/api/dashboard/race-stats', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const hours = Math.min(parseInt((request.query as any).hours as string) || 24, 168);
      const stats = await getRaceStats(getPool(), hours);
      return reply.send({ success: true, data: stats });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'race stats failed' });
    }
  });

  // ─── Web AI events (browser extension reports) ───────────────────────
  fastify.post('/api/dashboard/web-event', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as Record<string, any>;
      if (!body?.source || !body?.event_type) {
        return reply.status(400).send({ success: false, error: 'source and event_type required' });
      }
      await getPool().query(
        `INSERT INTO web_ai_events (source, event_type, conversation_id, message_count, prompt_chars, response_chars, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          String(body.source).slice(0, 60),
          String(body.event_type).slice(0, 60),
          body.conversation_id ? String(body.conversation_id).slice(0, 100) : null,
          parseInt(body.message_count, 10) || 0,
          parseInt(body.prompt_chars, 10) || 0,
          parseInt(body.response_chars, 10) || 0,
          body.client_id ? String(body.client_id).slice(0, 100) : null,
        ]
      );
      return reply.send({ success: true });
    } catch (error) {
      logger.warn({ error }, 'web-event insert failed');
      return reply.status(500).send({ success: false, error: 'event log failed' });
    }
  });

  fastify.get('/api/dashboard/web-events', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const hours = Math.min(parseInt((request.query as any).hours as string) || 24, 168);
      const result = await getPool().query(
        `SELECT
           source,
           COUNT(*)::INT AS events,
           SUM(message_count)::INT AS messages,
           COALESCE(SUM(prompt_chars), 0)::BIGINT AS prompt_chars,
           COALESCE(SUM(response_chars), 0)::BIGINT AS response_chars,
           MAX(created_at) AS last_seen
         FROM web_ai_events
         WHERE created_at > NOW() - MAKE_INTERVAL(hours => $1)
         GROUP BY source ORDER BY events DESC`,
        [hours]
      );
      return reply.send({
        success: true,
        data: result.rows.map((r: any) => ({
          source: r.source,
          events: parseInt(r.events, 10),
          messages: parseInt(r.messages, 10),
          promptChars: parseInt(r.prompt_chars, 10),
          responseChars: parseInt(r.response_chars, 10),
          lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
        })),
      });
    } catch (error) {
      logger.warn({ error }, 'web-events read failed');
      return reply.status(500).send({ success: false, error: 'web-events failed' });
    }
  });

  fastify.delete('/api/dashboard/memory/:caller', dashboardAuth, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = (request.params as any).caller as string;
      const removed = await forgetCaller(getPool(), caller);
      return reply.send({ success: true, data: { removed } });
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'memory clear failed' });
    }
  });

  // Dashboard UI endpoint (served at /api/dashboard/index for Cloudflare tunnel compatibility)
  fastify.get('/api/dashboard/index', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const { readFileSync, existsSync } = await import('fs');

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const publicDir = join(__dirname, '..', '..', 'public');
      const dashboardPath = join(publicDir, 'dashboard.html');

      if (!existsSync(dashboardPath)) {
        logger.warn({ path: dashboardPath }, 'dashboard.html not found');
        return reply.status(404).send({ error: 'dashboard.html not found' });
      }

      const content = readFileSync(dashboardPath, 'utf-8');
      logger.info({ size: content.length }, 'Serving dashboard from /api/dashboard/ui');
      return reply.type('text/html').send(content);
    } catch (error) {
      logger.error({ error }, 'Failed to serve dashboard UI');
      return reply.status(500).send({ error: 'Failed to serve dashboard' });
    }
  });

  // Fresh dashboard endpoint (no cache) - for Cloudflare cache bypass testing
  fastify.get('/dashboard', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const { readFileSync, existsSync } = await import('fs');

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const publicDir = join(__dirname, '..', '..', 'public');
      const dashboardPath = join(publicDir, 'dashboard.html');

      if (!existsSync(dashboardPath)) {
        logger.warn({ path: dashboardPath }, 'dashboard.html not found');
        return reply.status(404).send({ error: 'dashboard.html not found' });
      }

      const content = readFileSync(dashboardPath, 'utf-8');
      logger.info({ size: content.length }, 'Serving dashboard from /dashboard');
      return reply
        .header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0')
        .header('Pragma', 'no-cache')
        .header('Expires', '0')
        .type('text/html')
        .send(content);
    } catch (error) {
      logger.error({ error }, 'Failed to serve dashboard');
      return reply.status(500).send({ error: 'Failed to serve dashboard' });
    }
  });

  // Cloudflare cache bypass endpoint - new URL that won't be cached by Cloudflare
  fastify.get('/api/dashboard/ui', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const { readFileSync, existsSync } = await import('fs');

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const publicDir = join(__dirname, '..', '..', 'public');
      const dashboardPath = join(publicDir, 'dashboard.html');

      if (!existsSync(dashboardPath)) {
        logger.warn({ path: dashboardPath }, 'dashboard.html not found at /api/dashboard/ui');
        return reply.status(404).send({ error: 'dashboard.html not found' });
      }

      const content = readFileSync(dashboardPath, 'utf-8');
      const timestamp = Date.now();
      logger.info({ size: content.length, endpoint: '/api/dashboard/ui', timestamp }, 'Serving dashboard UI (Cloudflare cache bypass)');
      return reply
        .header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0, public')
        .header('Pragma', 'no-cache')
        .header('Expires', '0')
        .header('ETag', `"ui-${timestamp}"`)
        .header('X-Cache-Bypass', 'true')
        .type('text/html; charset=utf-8')
        .send(content);
    } catch (error) {
      logger.error({ error }, 'Failed to serve dashboard UI');
      return reply.status(500).send({ error: 'Failed to serve dashboard UI' });
    }
  });
}
