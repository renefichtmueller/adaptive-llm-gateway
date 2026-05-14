// eslint-disable-next-line @typescript-eslint/no-var-requires
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

export interface SchemaValidatorResult {
  passed: boolean;
  errors: string[];
  score_impact: number;
  retry: boolean;
}

const validatorCache = new Map<string, unknown>();

export function validateSchema(output: string, schema: Record<string, unknown> | undefined): SchemaValidatorResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { passed: true, errors: [], score_impact: 0, retry: false };
  }
  
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { passed: false, errors: ['Output is not valid JSON'], score_impact: -8, retry: true };
  }
  
  const schemaKey = JSON.stringify(schema);
  let validate = validatorCache.get(schemaKey) as ((data: unknown) => boolean) | undefined;
  if (!validate) {
    validate = ajv.compile(schema) as (data: unknown) => boolean;
    validatorCache.set(schemaKey, validate);
  }
  
  const valid = validate(parsed);
  if (!valid) {
    const errors = (ajv.errorsText((validate as unknown as { errors: unknown[] | null }).errors) || 'Schema validation failed').split(', ');
    return { passed: false, errors, score_impact: -5, retry: true };
  }
  
  return { passed: true, errors: [], score_impact: 0.5, retry: false };
}
