import { readFileSync, watch, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { logger } from '../observability/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../../prompts/templates');

export interface PromptTemplate {
  id: string;
  version: string;
  task_type: string;
  system_prompt: string;
  user_template: string;
  system_prompt_de?: string;
  user_template_de?: string;
  few_shot_examples?: Array<{ user: string; assistant: string }>;
  few_shot_examples_de?: Array<{ user: string; assistant: string }>;
  output_schema?: Record<string, unknown>;
  variables?: string[];
}

export interface AssembledPrompt {
  system: string;
  prompt: string;
  prompt_id: string;
  prompt_version: string;
  schema?: Record<string, unknown>;
}

export interface PromptVariables {
  input: string;
  current_date?: string;
  user_context?: Record<string, unknown>;
  source_data?: string;
  output_schema?: string;
  banned_terms_de?: string;
  banned_terms_en?: string;
  sff8024_codes?: string;
  known_vendors?: string;
  few_shot_examples?: string;
  [key: string]: unknown;
}

const templateCache = new Map<string, PromptTemplate>();

function loadTemplate(filename: string): PromptTemplate | null {
  const path = join(TEMPLATES_DIR, filename);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = yaml.load(raw) as PromptTemplate;
    if (!parsed.id) {
      parsed.id = filename.replace('.yaml', '');
    }
    return parsed;
  } catch (err) {
    logger.warn({ err, filename }, 'Failed to load prompt template');
    return null;
  }
}

function initTemplates(): void {
  try {
    const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.yaml'));
    for (const file of files) {
      const tmpl = loadTemplate(file);
      if (tmpl) {
        templateCache.set(tmpl.id, tmpl);
      }
    }
    logger.info({ count: templateCache.size }, 'Prompt templates loaded');
  } catch {
    logger.warn('Prompt templates directory not found — using fallback templates only');
  }
}

function startWatcher(): void {
  try {
    watch(TEMPLATES_DIR, { recursive: false }, (_event, filename) => {
      if (!filename?.endsWith('.yaml')) return;
      const tmpl = loadTemplate(filename);
      if (tmpl) {
        templateCache.set(tmpl.id, tmpl);
        logger.info({ id: tmpl.id }, 'Prompt template reloaded');
      }
    });
  } catch {
    // Templates dir not accessible — skip file watching
  }
}

initTemplates();
startWatcher();

function replaceVariables(template: string, vars: PromptVariables): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    const placeholder = `{{${key}}}`;
    if (value === undefined || value === null) {
      result = result.replaceAll(placeholder, '');
    } else if (typeof value === 'object') {
      result = result.replaceAll(placeholder, JSON.stringify(value, null, 2));
    } else {
      result = result.replaceAll(placeholder, String(value));
    }
  }
  // Remove unreplaced placeholders
  result = result.replace(/\{\{[^}]+\}\}/g, '');
  return result;
}

function buildFewShotExamples(
  examples: Array<{ user: string; assistant: string }>,
): string {
  if (!examples.length) return '';
  const parts = examples.map(
    (ex, i) => `Example ${i + 1}:\nInput: ${ex.user}\nOutput: ${ex.assistant}`,
  );
  return `\n\n--- Examples ---\n${parts.join('\n\n')}\n--- End Examples ---\n`;
}

function getFallbackTemplate(taskType: string): PromptTemplate {
  return {
    id: taskType,
    version: '1.0.0',
    task_type: taskType,
    system_prompt: `You are a helpful AI assistant. Complete the following task accurately and concisely. Task: ${taskType}. Return only the requested output without preamble or explanation.`,
    user_template: '{{input}}',
    few_shot_examples: [],
  };
}

export function resolvePrompt(
  taskType: string,
  vars: PromptVariables,
  language: 'de' | 'en' = 'en',
): AssembledPrompt {
  const template = templateCache.get(taskType) ?? getFallbackTemplate(taskType);

  const useGerman = language === 'de' && Boolean(template.system_prompt_de);
  const systemRaw = useGerman
    ? (template.system_prompt_de ?? template.system_prompt)
    : template.system_prompt;
  const userRaw = useGerman
    ? (template.user_template_de ?? template.user_template)
    : template.user_template;

  const examples = (useGerman
    ? (template.few_shot_examples_de ?? template.few_shot_examples ?? [])
    : (template.few_shot_examples ?? []));

  const enrichedVars: PromptVariables = {
    ...vars,
    current_date: new Date().toISOString().split('T')[0] ?? '',
    few_shot_examples: buildFewShotExamples(examples),
    output_schema: template.output_schema
      ? JSON.stringify(template.output_schema, null, 2)
      : '',
  };

  const systemPrompt = replaceVariables(systemRaw, enrichedVars);
  const userPrompt = replaceVariables(userRaw, enrichedVars);

  return {
    system: systemPrompt,
    prompt: userPrompt,
    prompt_id: template.id,
    prompt_version: template.version ?? '1.0.0',
    schema: template.output_schema,
  };
}

export function getTemplate(taskType: string): PromptTemplate | undefined {
  return templateCache.get(taskType);
}

export function listTemplates(): string[] {
  return [...templateCache.keys()];
}
