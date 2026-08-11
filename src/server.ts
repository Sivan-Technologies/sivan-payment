import { buildApp } from './app.js';
import { env } from './config/env.js';
import { captureError, flushMonitoring, initMonitoring } from './monitoring/sentry.js';
import { reconcileNgnSettlements } from './ngn/service/ngn-settlement-reconciler.js';
import { confirmBalanceTransfers } from './balances/transfer-confirmation.service.js';
import { scanForDeposits } from './deposits/deposit-detection.service.js';
import { notifyPendingDeposits } from './deposits/deposit-notification.service.js';
import { confirmDeposits } from './deposits/deposit-confirmation.service.js';
import { isTransientPostgresError } from './database/postgres-database.js';

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

/**
 * SAY AT BOOT THAT WALLET CREATION IS BROKEN, INSTEAD OF LETTING USERS FIND OUT.
 *
 * Live spent an unknown number of hours issuing 503s from
 * POST /api/users/:id/wallets because PRIVY_AUTHORIZATION_KEY_QUORUM_ID named a
 * quorum belonging to a different Privy app. The information needed to catch it
 * was available the instant the process started - one authenticated GET - but
 * nothing asked until a user did, and by then the answer arrived as a Sentry
 * event rather than a deploy log.
 *
 * Deliberately NON-FATAL. Refusing to boot would take the whole API down -
 * NGN off-ramp, balances, support, everything - over a fault that breaks ONE
 * route, and on Render a crash-looping service is harder to diagnose than a
 * running one with a loud log line. It reports; /health/operational already
 * carries the same fact as a critical signal for anything that pages.
 *
 * Fire-and-forget so a slow Privy cannot delay listen().
 */
void (async () => {
  try {
    const { resolveActiveWalletProvider } = await import('./wallets/wallet-controls.service.js');
    if ((await resolveActiveWalletProvider()) !== 'privy') return;

    const { probePrivyCredentials } = await import('./wallets/provider/privy-wallet.provider.js');
    const probe = await probePrivyCredentials();
    if (probe.ok) {
      console.log('[startup.wallet_provider] privy reachable; wallet creation preflight passed.');
      return;
    }

    const detail = `[startup.wallet_provider] WALLET CREATION WILL FAIL: ${probe.message ?? `HTTP ${probe.status}`}`;
    console.error(detail);
    // Sentry, so it is visible without reading a deploy log that scrolls away.
    captureError(new Error(detail), { source: 'startup_wallet_preflight', status: probe.status });
  } catch (error) {
    // A preflight that crashes the process it is protecting is worse than none.
    console.error('[startup.wallet_provider] preflight itself failed:', error instanceof Error ? error.message : error);
  }
})();

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
      if (isTransientPostgresError(error)) {
        app.log.warn(
          { err: error },
          'ngn settlement reconciler skipped this tick because Postgres temporarily reset the connection'
        );
        return;
      }
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

/**
 * NOBODY WAS EVER TOLD THAT MONEY ARRIVED.
 *
 * A user sells on an exchange and withdraws USDC to their Sivan address - the
 * most common way money enters this product for the launch market. The system
 * did nothing about it: no record, no activity row, no notification. The
 * balance simply read higher on the next refresh, and if the RPC read happened
 * to fail it did not even do that, while the user held an exchange receipt
 * saying the money was sent.
 *
 * Two loops, deliberately separate. Detection writes records; notification
 * delivers them. A failing email provider must not stop deposits being
 * RECORDED, and a slow wallet sweep must not delay the alert for a deposit that
 * has already been found. They share only the database.
 *
 * Same rules as the two reconcilers above: started outside buildApp() so tests
 * do not spawn timers that talk to a live chain, every failure swallowed and
 * logged, unref'd, and one run at boot because a deploy is exactly when an
 * event is most likely to have been missed.
 */
if (env.DEPOSIT_POLL_SECONDS > 0) {
  const intervalMs = env.DEPOSIT_POLL_SECONDS * 1000;
  const tick = async () => {
    try {
      const outcome = await scanForDeposits();
      if (outcome.depositsRecorded > 0) {
        app.log.info({ recorded: outcome.recorded }, 'inbound deposits detected');
      }
      /**
       * Logged as a warning, not swallowed silently. An unreadable balance is
       * a deposit we cannot see, so a persistent count here means users are
       * receiving money the product is blind to - which looks identical to
       * "no deposits are happening" unless it is surfaced.
       */
      if (outcome.unreadable > 0) {
        app.log.warn(
          { unreadable: outcome.unreadable, scanned: outcome.walletsScanned },
          'wallet balances unreadable during deposit scan; deposits on those wallets are invisible'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'deposit scan failed');
      captureError(error as Error, { source: 'deposit_scan' });
    }
  };
  setInterval(tick, intervalMs).unref();
  void tick();
}

/**
 * THE LOOP THAT MOVES A DEPOSIT OFF "In progress".
 *
 * Reported with a screenshot showing the dashboard contradicting itself: the
 * balance card read "20 USDC / Available to send or sell / Ready" while the
 * activity row directly beneath it read "Deposit received ... In progress",
 * 28 minutes after the money had landed and been spendable.
 *
 * Nothing was broken in the sense of throwing. `recordDeposit` writes
 * 'pending', the status enum declares 'confirmed', both drivers implement
 * `updateWalletDepositStatus`, and migration 042 even indexes the pending set -
 * but there were ZERO callers of that writer. 'pending' was a permanent label
 * rather than a state, so the badge could never change.
 *
 * A THIRD timer rather than folding this into the scan, for the same reason
 * detection and notification are already separate: a slow chain read while
 * confirming an old deposit must not delay DETECTING a new one, which is the
 * job whose latency a user actually feels. They share only the database.
 *
 * 45s, matching the notifier rather than the 60s scan. A deposit only becomes
 * confirmable after it is recorded, so this interval is the tail of the delay a
 * user watches, and there is no chain read to save by waiting longer.
 */
if (env.DEPOSIT_CONFIRM_SECONDS > 0) {
  const intervalMs = env.DEPOSIT_CONFIRM_SECONDS * 1000;
  const tick = async () => {
    try {
      const outcome = await confirmDeposits();
      if (outcome.confirmed.length > 0) {
        app.log.info({ confirmed: outcome.confirmed.length }, 'inbound deposits confirmed');
      }
      /**
       * Escalated as an ERROR, not a warning. A stale pending deposit means a
       * user is looking at "In progress" against money that is already in
       * their balance - the exact contradiction this loop exists to remove -
       * and it will not clear itself.
       */
      if (outcome.stale.length > 0) {
        app.log.error(
          { stale: outcome.stale },
          'deposits unconfirmed far longer than any chain takes; the badge is wrong, the money may well be spendable'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'deposit confirmation failed');
      captureError(error as Error, { source: 'deposit_confirmation' });
    }
  };
  setInterval(tick, intervalMs).unref();
  void tick();
}

if (env.DEPOSIT_NOTIFY_SECONDS > 0) {
  const intervalMs = env.DEPOSIT_NOTIFY_SECONDS * 1000;
  const tick = async () => {
    try {
      const outcome = await notifyPendingDeposits();
      if (outcome.sent > 0) {
        app.log.info({ sent: outcome.sent }, 'deposit notifications delivered');
      }
      if (outcome.failed > 0) {
        app.log.error(
          { failed: outcome.failed },
          'deposit notifications failed to send; the deposits are recorded and visible in-app'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'deposit notifier failed');
      captureError(error as Error, { source: 'deposit_notifier' });
    }
  };
  setInterval(tick, intervalMs).unref();
  void tick();
}
