import { buildApp } from './app.js';
import { env } from './config/env.js';
import { captureError, flushMonitoring, initMonitoring } from './monitoring/sentry.js';
import { reconcileNgnSettlements } from './ngn/service/ngn-settlement-reconciler.js';
import { confirmBalanceTransfers } from './balances/transfer-confirmation.service.js';
import { scanForDeposits } from './deposits/deposit-detection.service.js';
import { notifyPendingDeposits } from './deposits/deposit-notification.service.js';
import { confirmDeposits } from './deposits/deposit-confirmation.service.js';
import { isTransientPostgresError } from './database/postgres-database.js';
import { sweepDeadlineAlerts } from './agreements/deadline-sweeper.service.js';
import { reconcileUnsettledUtilityPurchases } from './ngn/service/sivanUtilityService.js';
import { archiveExpiredAuditLogs } from './audit/audit.service.js';
import { evaluateProviderFloats } from './monitoring/provider-float/provider-float-monitor.service.js';
import { runUniversalDailyReconciliation } from './reconciliation/universal-reconciliation.service.js';

initMonitoring();

process.on('unhandledRejection', (error) => {
  captureError(error, { source: 'unhandledRejection' });
});

process.on('uncaughtException', async (error) => {
  captureError(error, { source: 'uncaughtException' });
  await flushMonitoring();
  process.exit(1);
});

let app: Awaited<ReturnType<typeof buildApp>>;
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
 * Register a background worker with staggered boot delay, unref'd intervals,
 * and in-flight execution guard (overlap protection).
 *
 * Prevents CPU, event-loop, and database connection pool exhaustion at boot.
 */
function registerBackgroundWorker(options: {
  name: string;
  intervalSeconds: number;
  bootDelaySeconds: number;
  task: () => Promise<void>;
}): void {
  if (options.intervalSeconds <= 0) return;
  const intervalMs = options.intervalSeconds * 1000;
  const bootDelayMs = options.bootDelaySeconds * 1000;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) {
      app.log.warn(
        { worker: options.name },
        'background worker tick skipped: previous run still in flight'
      );
      return;
    }
    inFlight = true;
    try {
      await options.task();
    } finally {
      inFlight = false;
    }
  };

  // Staggered startup delay: do not hammer database and CPU at t=0
  const timer = setTimeout(() => {
    void tick();
    setInterval(tick, intervalMs).unref();
  }, bootDelayMs);
  timer.unref();

  app.log.info(
    { worker: options.name, bootDelaySeconds: options.bootDelaySeconds, intervalSeconds: options.intervalSeconds },
    'background worker registered with staggered startup delay'
  );
}

/**
 * 1. TRANSFER CONFIRMER (High-Priority Safety)
 * Boot delay: 10s | Cadence: 60s
 * Re-checks crypto sends that are still 'processing' to confirm on-chain finality.
 */
registerBackgroundWorker({
  name: 'transfer_confirmer',
  intervalSeconds: env.TRANSFER_CONFIRM_POLL_SECONDS,
  bootDelaySeconds: 10,
  task: async () => {
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
  },
});

/**
 * 2. DEPOSIT CONFIRMATION WORKER (High-Priority Safety)
 * Boot delay: 15s | Cadence: 60s
 * Moves deposits off 'pending' once finality is confirmed.
 */
registerBackgroundWorker({
  name: 'deposit_confirmation',
  intervalSeconds: env.DEPOSIT_CONFIRM_SECONDS,
  bootDelaySeconds: 15,
  task: async () => {
    try {
      const outcome = await confirmDeposits();
      if (outcome.confirmed.length > 0) {
        app.log.info({ confirmed: outcome.confirmed.length }, 'inbound deposits confirmed');
      }
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
  },
});

/**
 * 3. DEPOSIT NOTIFIER (High-Priority Safety)
 * Boot delay: 20s | Cadence: 60s
 * Delivers notifications for newly detected and recorded deposits.
 */
registerBackgroundWorker({
  name: 'deposit_notifier',
  intervalSeconds: env.DEPOSIT_NOTIFY_SECONDS,
  bootDelaySeconds: 20,
  task: async () => {
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
  },
});

/**
 * 4. NGN SETTLEMENT RECONCILER (Medium-Priority Sweep)
 * Boot delay: 30s | Cadence: 300s (5m)
 * Safety net for bank transfer settlements that may have missed a webhook.
 */
registerBackgroundWorker({
  name: 'ngn_settlement_reconciler',
  intervalSeconds: env.NGN_SETTLEMENT_POLL_SECONDS,
  bootDelaySeconds: 30,
  task: async () => {
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
  },
});

/**
 * 5. UTILITY RECONCILER (Medium-Priority Sweep)
 * Boot delay: 45s | Cadence: 300s (5m)
 * Reconciles unsettled and pending utility purchases with upstream aggregators.
 */
registerBackgroundWorker({
  name: 'utility_reconciler',
  intervalSeconds: env.UTILITY_RECONCILE_POLL_SECONDS,
  bootDelaySeconds: 45,
  task: async () => {
    try {
      const outcome = await reconcileUnsettledUtilityPurchases();
      if (outcome.settled.length > 0) {
        app.log.info({ settled: outcome.settled }, 'unsettled utility purchases reconciled and settled');
      }
      if (outcome.failed.length > 0) {
        app.log.error({ failed: outcome.failed }, 'unsettled utility purchases failed during reconciliation');
      }
      if (outcome.pendingReconciliation.length > 0) {
        app.log.warn({ pending: outcome.pendingReconciliation }, 'utility purchases pending reconciliation');
      }
    } catch (error) {
      app.log.error({ err: error }, 'utility reconciler failed');
      captureError(error as Error, { source: 'utility_reconciler' });
    }
  },
});

/**
 * 6. DEPOSIT SCANNER (Medium-Priority Sweep)
 * Boot delay: 60s | Cadence: 120s (2m)
 * Sweeps registered wallets for incoming crypto deposits across supported chains.
 */
registerBackgroundWorker({
  name: 'deposit_scanner',
  intervalSeconds: env.DEPOSIT_POLL_SECONDS,
  bootDelaySeconds: 60,
  task: async () => {
    try {
      const outcome = await scanForDeposits();
      if (outcome.depositsRecorded > 0) {
        app.log.info({ recorded: outcome.recorded }, 'inbound deposits detected');
      }
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
  },
});

/**
 * 7. DEADLINE SWEEPER (Medium-Priority Sweep)
 * Boot delay: 75s | Cadence: 300s (5m)
 * Proactively notifies buyers and sellers of approaching or overdue Service Agreement deadlines.
 */
registerBackgroundWorker({
  name: 'deadline_sweeper',
  intervalSeconds: env.DEADLINE_SWEEP_SECONDS,
  bootDelaySeconds: 75,
  task: async () => {
    try {
      const outcome = await sweepDeadlineAlerts();
      if (outcome.sent6h > 0) {
        app.log.info({ sent: outcome.sent6h }, 'deadline 6-hour warnings dispatched');
      }
      if (outcome.sentOverdue > 0) {
        app.log.info({ sent: outcome.sentOverdue }, 'agreement overdue notices dispatched');
      }
      if (outcome.failed > 0) {
        app.log.error(
          { failed: outcome.failed },
          'deadline alert notifications failed; sentinel flags already set, alerts will not retry'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'deadline sweeper failed');
      captureError(error as Error, { source: 'deadline_sweeper' });
    }
  },
});

/**
 * 8. PROVIDER FLOAT MONITOR (Low-Priority Maintenance)
 * Boot delay: 180s (3m) | Cadence: 1800s (30m)
 * Monitors Paystack payout pools and gas wallet float balances, alerting ops when thresholds drop.
 */
registerBackgroundWorker({
  name: 'provider_float_monitor',
  intervalSeconds: env.FLOAT_MONITOR_POLL_SECONDS,
  bootDelaySeconds: 180,
  task: async () => {
    try {
      const outcome = await evaluateProviderFloats();
      if (outcome.alertsTriggered > 0) {
        app.log.warn(
          { alertsTriggered: outcome.alertsTriggered, summary: outcome.summary },
          'provider float buffer warnings or critical alerts dispatched to ops'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'provider float monitor failed');
      captureError(error as Error, { source: 'provider_float_monitor' });
    }
  },
});

/**
 * 9. UNIVERSAL RECONCILIATION WORKER (Low-Priority Maintenance)
 * Boot delay: 300s (5m) | Cadence: 1800s (30m)
 * Automatically syncs terminal states and cross-provider settlements.
 */
registerBackgroundWorker({
  name: 'universal_reconciliation_worker',
  intervalSeconds: env.RECONCILIATION_SWEEP_POLL_SECONDS,
  bootDelaySeconds: 300,
  task: async () => {
    try {
      const outcome = await runUniversalDailyReconciliation();
      if (outcome.autoResolvedCount > 0) {
        app.log.info(
          { autoResolvedCount: outcome.autoResolvedCount, scannedCount: outcome.scannedCount },
          'universal reconciliation worker auto-resolved pending settlements'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'universal reconciliation worker failed');
      captureError(error as Error, { source: 'universal_reconciliation_worker' });
    }
  },
});

/**
 * 10. AUDIT LOG ARCHIVAL WORKER (Background Housekeeping)
 * Boot delay: 900s (15m) | Cadence: 86400s (24h)
 * Moves expired audit logs (older than 90 days) to cold compliance storage.
 */
registerBackgroundWorker({
  name: 'audit_log_archival',
  intervalSeconds: env.AUDIT_LOG_ARCHIVE_POLL_SECONDS,
  bootDelaySeconds: 900,
  task: async () => {
    try {
      const outcome = await archiveExpiredAuditLogs(env.AUDIT_LOG_RETENTION_DAYS);
      if (outcome.archivedCount > 0) {
        app.log.info(
          { archivedCount: outcome.archivedCount, oldestRemainingDate: outcome.oldestRemainingDate },
          'expired audit logs successfully archived to compliance storage'
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'audit log archival worker failed');
      captureError(error as Error, { source: 'audit_log_archival' });
    }
  },
});
