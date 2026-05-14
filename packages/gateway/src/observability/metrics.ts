import {
  Counter,
  Histogram,
  Gauge,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const requestsTotal = new Counter({
  name: 'llm_gateway_requests_total',
  help: 'Total LLM requests processed',
  labelNames: ['caller', 'task_type', 'status'],
  registers: [registry],
});

export const latencySeconds = new Histogram({
  name: 'llm_gateway_latency_seconds',
  help: 'End-to-end request latency',
  labelNames: ['caller', 'task_type', 'model'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
  registers: [registry],
});

export const tokensTotal = new Counter({
  name: 'llm_gateway_tokens_total',
  help: 'Total tokens processed',
  labelNames: ['direction', 'model'],
  registers: [registry],
});

export const confidenceScore = new Histogram({
  name: 'llm_gateway_confidence_score',
  help: 'Confidence score distribution',
  labelNames: ['task_type', 'model'],
  buckets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  registers: [registry],
});

export const banlistHitsTotal = new Counter({
  name: 'llm_gateway_banlist_hits_total',
  help: 'Total ban list hits',
  labelNames: ['term', 'language', 'category'],
  registers: [registry],
});

export const validationFailuresTotal = new Counter({
  name: 'llm_gateway_validation_failures_total',
  help: 'Total validation failures per validator',
  labelNames: ['validator', 'task_type'],
  registers: [registry],
});

export const reviewQueueSize = new Gauge({
  name: 'llm_gateway_review_queue_size',
  help: 'Number of items in the review queue awaiting decision',
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: 'llm_gateway_circuit_breaker_state',
  help: 'Circuit breaker state: 0=closed, 0.5=half-open, 1=open',
  labelNames: ['model'],
  registers: [registry],
});

export const rateLimitRejectedTotal = new Counter({
  name: 'llm_gateway_rate_limit_rejected_total',
  help: 'Total rate-limited requests per caller',
  labelNames: ['caller'],
  registers: [registry],
});

export function recordCircuitBreakerState(
  model: string,
  state: 'closed' | 'open' | 'half-open',
): void {
  const value = state === 'closed' ? 0 : state === 'half-open' ? 0.5 : 1;
  circuitBreakerState.labels({ model }).set(value);
}

export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

export function getContentType(): string {
  return registry.contentType;
}
