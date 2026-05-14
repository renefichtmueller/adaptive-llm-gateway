import { callOllama } from './llm-client.js';
import { logger } from '../observability/logger.js';

export interface ClassificationResult {
  task_type: string;
  content_type: string;
  language: 'de' | 'en' | 'other';
  complexity: 'low' | 'medium' | 'high';
  requires_facts: boolean;
  suggested_task_types: string[];
}

const CLASSIFIER_MODEL = 'qwen2.5:3b';

const SYSTEM_PROMPT = `You are a task classifier for an LLM routing gateway.
Analyze the input and return ONLY valid JSON with this exact structure:
{
  "task_type": "string (e.g. generic_summarize, code_review, generic_qa)",
  "content_type": "string (e.g. technical, marketing, analysis, conversation, structured_data)",
  "language": "de|en|other",
  "complexity": "low|medium|high",
  "requires_facts": true|false,
  "suggested_task_types": ["array", "of", "alternatives"]
}

Built-in task types:
generic_summarize, generic_extract, generic_classify, generic_rewrite, generic_qa,
content_translation_de_en, content_translation_en_de,
code_review, code_generate, data_enrichment

Custom task types come from your routing-rules.yaml — feel free to use any
identifier the user has registered there.

Return ONLY the JSON object, no other text.`;

export async function classifyInput(input: string): Promise<ClassificationResult> {
  const prompt = `Classify this input:\n\n${input.slice(0, 2000)}`;

  try {
    const response = await callOllama({
      model: CLASSIFIER_MODEL,
      prompt,
      system: SYSTEM_PROMPT,
      options: { temperature: 0.1, num_predict: 256 },
      format: 'json',
      stream: false,
    });

    const parsed = JSON.parse(response.response) as Partial<ClassificationResult>;

    return {
      task_type: parsed.task_type ?? 'generic_qa',
      content_type: parsed.content_type ?? 'general',
      language: (['de', 'en', 'other'].includes(parsed.language ?? '') ? parsed.language : 'en') as 'de' | 'en' | 'other',
      complexity: (['low', 'medium', 'high'].includes(parsed.complexity ?? '') ? parsed.complexity : 'medium') as 'low' | 'medium' | 'high',
      requires_facts: parsed.requires_facts ?? false,
      suggested_task_types: Array.isArray(parsed.suggested_task_types) ? parsed.suggested_task_types : [],
    };
  } catch (err) {
    logger.warn({ err }, 'Pre-classifier failed, using defaults');
    return {
      task_type: 'generic_qa',
      content_type: 'general',
      language: 'en',
      complexity: 'medium',
      requires_facts: false,
      suggested_task_types: [],
    };
  }
}
