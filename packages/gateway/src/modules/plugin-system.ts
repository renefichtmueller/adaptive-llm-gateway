/**
 * Plugin System
 *
 * Lightweight pre/post hooks for custom request mangling. Plugins live in
 * `plugins/*.js` (or `.mjs`) directories listed in PLUGINS_DIR env var
 * (comma-separated). Each plugin exports a default object with optional
 * `preComplete` and `postComplete` async hooks.
 *
 * Example plugin (`plugins/redact-acme.mjs`):
 *
 *   export default {
 *     name: 'redact-acme',
 *     async preComplete({ request }) {
 *       request.input = request.input.replace(/acme-secret-\w+/g, '<REDACTED>');
 *       return request;
 *     },
 *     async postComplete({ response }) {
 *       response.metadata = { ...response.metadata, audited: true };
 *       return response;
 *     },
 *   };
 *
 * Hooks run in load order. A hook returning `null` aborts the request
 * with an HTTP 422.
 */
import { readdirSync, existsSync } from 'fs';
import { join, resolve, extname } from 'path';
import { pathToFileURL } from 'url';
import { logger } from '../observability/logger.js';

export interface PluginContext {
  caller: string;
  callId: string;
  request: Record<string, unknown>;
}

export interface PluginPostContext extends PluginContext {
  response: Record<string, unknown>;
}

export interface Plugin {
  name: string;
  /** Called before the gateway dispatches the request. Return `null` to abort. */
  preComplete?: (ctx: PluginContext) => Promise<Record<string, unknown> | null>;
  /** Called after a successful response. Return a modified response or the original. */
  postComplete?: (ctx: PluginPostContext) => Promise<Record<string, unknown>>;
}

const loaded: Plugin[] = [];

/**
 * Scan PLUGINS_DIR(s) for plugin modules and import them.
 * Idempotent: call once at boot.
 */
export async function loadPlugins(): Promise<{ loaded: string[] }> {
  const raw = process.env['PLUGINS_DIR'];
  if (!raw) return { loaded: [] };
  const dirs = raw.split(',').map((d) => resolve(d.trim())).filter(Boolean);
  const names: string[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      logger.warn({ dir }, 'Plugin directory not found, skipping');
      continue;
    }
    const files = readdirSync(dir).filter((f) => ['.js', '.mjs'].includes(extname(f)));
    for (const file of files) {
      try {
        const url = pathToFileURL(join(dir, file)).href;
        const mod = await import(url) as { default?: Plugin };
        const plugin = mod.default;
        if (!plugin || typeof plugin.name !== 'string') {
          logger.warn({ file }, 'Plugin missing default export with `name`');
          continue;
        }
        loaded.push(plugin);
        names.push(plugin.name);
      } catch (err) {
        logger.error({ err, file }, 'Failed to load plugin');
      }
    }
  }
  logger.info({ count: loaded.length, names }, 'Plugins loaded');
  return { loaded: names };
}

/**
 * Run all pre-complete hooks. Returns the (possibly mutated) request
 * object, or null if any plugin aborted the call.
 */
export async function runPreComplete(ctx: PluginContext): Promise<Record<string, unknown> | null> {
  let req = ctx.request;
  for (const p of loaded) {
    if (!p.preComplete) continue;
    try {
      const next = await p.preComplete({ ...ctx, request: req });
      if (next === null) {
        logger.info({ plugin: p.name, caller: ctx.caller }, 'Plugin aborted request');
        return null;
      }
      req = next;
    } catch (err) {
      logger.warn({ err, plugin: p.name }, 'preComplete hook threw; continuing');
    }
  }
  return req;
}

export async function runPostComplete(ctx: PluginPostContext): Promise<Record<string, unknown>> {
  let resp = ctx.response;
  for (const p of loaded) {
    if (!p.postComplete) continue;
    try {
      resp = await p.postComplete({ ...ctx, response: resp });
    } catch (err) {
      logger.warn({ err, plugin: p.name }, 'postComplete hook threw; continuing');
    }
  }
  return resp;
}

export function getLoadedPlugins(): readonly string[] {
  return loaded.map((p) => p.name);
}
