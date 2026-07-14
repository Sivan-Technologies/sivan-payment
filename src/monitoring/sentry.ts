import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';

let initialized = false;

export function initMonitoring() {
  if (!env.SENTRY_DSN || initialized) return;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.APP_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    release: process.env.RENDER_GIT_COMMIT || process.env.npm_package_version
  });

  initialized = true;
}

export function captureError(error: unknown, context?: Record<string, unknown>) {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
    }
    Sentry.captureException(error);
  });
}

export async function flushMonitoring(timeoutMs = 2000) {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}
