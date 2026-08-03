import { buildApp } from './app.js';
import { env } from './config/env.js';
import { captureError, flushMonitoring, initMonitoring } from './monitoring/sentry.js';
import { reconcileNgnSettlements } from './ngn/service/ngn-settlement-reconciler.js';

initMonitoring();

process.on('unhandledRejection', (error) => {
  captureError(error, { source: 'unhandledRejection' });
});

process.on('uncaughtException', async (error) => {
  captureError(error, { source: 'uncaughtException' });
  await flushMonitoring();
  process.exit(1);
});

let app;
try {
  app = await buildApp();
} catch (error) {
  // Startup misconfiguration (e.g. missing ADMIN_API_KEY in production).
  // Print it plainly so the failure is obvious in Render/CI logs instead of
  // exiting with a bare non-zero code.
  console.error('[startup] Failed to build app:', error instanceof Error ? error.message : error);
  captureError(error as Error, { source: 'build_app' });
  await flushMonitoring();
  process.exit(1);
}

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  captureError(error, { source: 'server_listen' });
  app.log.error(error);
  await flushMonitoring();
  process.exit(1);
}

/**
 * SETTLEMENT DOES NOT DEPEND ON A WEBHOOK ARRIVING.
 *
 * Started here rather than in buildApp() so that building the app in a test
 * does not start a timer that then talks to a live partner API.
 *
 * Every failure is swallowed and logged: this is a safety net, and a safety
 * net that can take the process down is worse than no safety net.
 */
if (env.NGN_SETTLEMENT_POLL_SECONDS > 0) {
  const intervalMs = env.NGN_SETTLEMENT_POLL_SECONDS * 1000;
  const tick = async () => {
    try {
      const outcome = await reconcileNgnSettlements();
      if (outcome.advanced.length > 0) {
        app.log.warn(
          { advanced: outcome.advanced },
          'ngn settlement reconciler advanced transfers the webhook did not'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'ngn settlement reconciler failed');
      captureError(error as Error, { source: 'ngn_settlement_reconciler' });
    }
  };
  // unref() so the timer never holds the process open during a shutdown.
  setInterval(tick, intervalMs).unref();
  // Run once at boot: a deploy is exactly when a webhook is most likely to
  // have been missed.
  void tick();
}
