import { buildApp } from './app.js';
import { env } from './config/env.js';
import { captureError, flushMonitoring, initMonitoring } from './monitoring/sentry.js';
import { reconcileNgnSettlements } from './ngn/service/ngn-settlement-reconciler.js';
import { confirmBalanceTransfers } from './balances/transfer-confirmation.service.js';

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

/**
 * A CRYPTO SEND HAD NO WAY TO FINISH.
 *
 * Reported with a screenshot: three sends stuck on "Processing", the oldest
 * two hours old. All three had actually settled - both Solana transfers are
 * finalised on chain with err:null and the recipient received every cent.
 * Nothing ever went back to look.
 *
 * `completed` was declared in BalanceTransferStatus and never once assigned to
 * a transfer. executeBalanceTransfer wrote 'processing' when the provider
 * accepted the broadcast and that was the final word. There was no poller and
 * no webhook on this path.
 *
 * Same shape and the same safety rules as the settlement reconciler above:
 * started here rather than in buildApp() so tests do not spawn a timer that
 * talks to a live chain, every failure swallowed and logged, unref'd.
 */
if (env.TRANSFER_CONFIRM_POLL_SECONDS > 0) {
  const intervalMs = env.TRANSFER_CONFIRM_POLL_SECONDS * 1000;
  const tick = async () => {
    try {
      const outcome = await confirmBalanceTransfers();
      if (outcome.confirmed.length > 0) {
        app.log.info({ confirmed: outcome.confirmed }, 'crypto sends confirmed on chain');
      }
      if (outcome.failed.length > 0) {
        app.log.error({ failed: outcome.failed }, 'crypto sends reverted on chain; holds released');
      }
      if (outcome.stale.length > 0) {
        app.log.warn(
          { stale: outcome.stale },
          'crypto sends submitted but still unconfirmed; a human must check the chain'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'transfer confirmer failed');
      captureError(error as Error, { source: 'transfer_confirmer' });
    }
  };
  setInterval(tick, intervalMs).unref();
  void tick();
}
