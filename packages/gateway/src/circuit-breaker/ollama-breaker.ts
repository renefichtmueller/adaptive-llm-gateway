import CircuitBreaker from 'opossum';
import { logger } from '../observability/logger.js';
import { recordCircuitBreakerState } from '../observability/metrics.js';

export type ModelTier = 'fast' | 'medium' | 'large';

interface TierOptions {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
}

const TIER_OPTIONS: Record<ModelTier, TierOptions> = {
  fast: {
    timeout: 10_000,
    errorThresholdPercentage: 50,
    resetTimeout: 15_000,
  },
  medium: {
    timeout: 30_000,
    errorThresholdPercentage: 50,
    resetTimeout: 20_000,
  },
  large: {
    timeout: 120_000,
    errorThresholdPercentage: 30,
    resetTimeout: 45_000,
  },
};

 
const breakerRegistry = new Map<string, CircuitBreaker<any[], any>>();

type AsyncFn<A extends unknown[], R> = (...args: A) => Promise<R>;

export function getBreaker<A extends unknown[], R>(
  model: string,
  tier: ModelTier,
  fn: AsyncFn<A, R>,
): CircuitBreaker<A, R> {
  const existing = breakerRegistry.get(model) as CircuitBreaker<A, R> | undefined;
  if (existing) return existing;

  const opts = TIER_OPTIONS[tier] ?? TIER_OPTIONS['medium'];
  const breaker = new CircuitBreaker(fn, {
    timeout: opts.timeout,
    errorThresholdPercentage: opts.errorThresholdPercentage,
    resetTimeout: opts.resetTimeout,
    volumeThreshold: 3,
    name: `ollama-${model}`,
  });

  breaker.on('open', () => {
    logger.warn({ model, tier }, 'Circuit breaker opened');
    recordCircuitBreakerState(model, 'open');
  });

  breaker.on('halfOpen', () => {
    logger.info({ model, tier }, 'Circuit breaker half-open');
    recordCircuitBreakerState(model, 'half-open');
  });

  breaker.on('close', () => {
    logger.info({ model, tier }, 'Circuit breaker closed');
    recordCircuitBreakerState(model, 'closed');
  });

  breaker.on('fallback', (result) => {
    logger.warn({ model, result }, 'Circuit breaker fallback triggered');
  });

  breakerRegistry.set(model, breaker as CircuitBreaker<unknown[], unknown>);
  return breaker;
}

export function getBreakerState(model: string): 'closed' | 'open' | 'half-open' {
  const breaker = breakerRegistry.get(model);
  if (!breaker) return 'closed';
  if (breaker.opened) return 'open';
  if (breaker.halfOpen) return 'half-open';
  return 'closed';
}

export function getAllBreakerStates(): Record<string, 'closed' | 'open' | 'half-open'> {
  const states: Record<string, 'closed' | 'open' | 'half-open'> = {};
  for (const [model] of breakerRegistry) {
    states[model] = getBreakerState(model);
  }
  return states;
}
