import * as Sentry from '@sentry/node';
import type { Config } from '../config';

/**
 * Error tracking (Sentry), DSN-gated.
 *
 * If `SENTRY_DSN` is unset (dev / CI / any box without it configured), every
 * function here is a no-op — nothing initializes and no data leaves the process.
 * Set `SENTRY_DSN` in the environment to turn capture on. API-only for now.
 */

let enabled = false;

/** Initialize Sentry if a DSN is configured. Call once, as early as possible. */
export function initObservability(config: Config): void {
  if (!config.SENTRY_DSN) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
  });
  enabled = true;
  // eslint-disable-next-line no-console
  console.log(`[observability] Sentry enabled (env=${config.NODE_ENV})`);
}

export function isObservabilityEnabled(): boolean {
  return enabled;
}

/** Report an error to Sentry. No-op when Sentry is not initialized. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
