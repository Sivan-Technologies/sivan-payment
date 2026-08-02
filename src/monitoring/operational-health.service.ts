/**
 * Is the money moving?
 *
 * WHY THIS EXISTS SEPARATELY FROM /health AND FROM SENTRY
 *
 * /health answers "is the process up". Sentry answers "did something throw".
 * Neither can see the failure mode that actually costs users money, which is
 * silent: nothing crashes, no exception is raised, and a transfer simply sits
 * in a non-terminal state forever.
 *
 * Every incident this product has had so far was that shape:
 *
 *   - `trade.flagged` was unhandled, so a below-minimum deposit sat at
 *     awaiting_crypto_deposit indefinitely (8a935a7)
 *   - `trade.completed` was stored and discarded, so a SETTLED payout also sat
 *     at awaiting_crypto_deposit indefinitely (593fbbf)
 *   - migration 036 failed on every redeploy, so the API served stale code for
 *     six commits with a 200 on /health throughout (f14a514)
 *
 * A process-liveness check reported healthy through all three. These are the
 * numbers that would not have.
 *
 * Deliberately CHEAP and read-only: it is polled by an uptime monitor, so it
 * must not be the thing that falls over under load.
 */

import { db } from '../database/json-database.js';
import { getNgnControls } from '../ngn/service/ngn-controls.service.js';
import { env } from '../config/env.js';

export type AlertSeverity = 'ok' | 'warn' | 'critical';

export interface OperationalSignal {
  name: string;
  severity: AlertSeverity;
  value: number;
  /** What an operator should actually do. A number with no action is noise. */
  detail: string;
}

export interface OperationalHealth {
  status: AlertSeverity;
  checkedAt: string;
  environment: string;
  signals: OperationalSignal[];
}

/**
 * Thresholds.
 *
 * Chosen against real behaviour rather than round numbers:
 *
 *   A Breet deposit confirms in minutes. A transfer still awaiting crypto
 *   after 2 hours is either a user who abandoned it (harmless) or a webhook
 *   that never applied (not harmless), and the second is indistinguishable
 *   from the first without looking - which is exactly why it needs a human.
 *
 *   A name review blocks a paying customer from withdrawing. 24 hours is
 *   already a bad experience; 48 is a churned user.
 */
const STUCK_TRANSFER_HOURS = 2;
const STALE_REVIEW_HOURS = 24;
const CRITICAL_REVIEW_HOURS = 48;

/** Non-terminal states. A transfer sitting in one of these is unfinished. */
const IN_FLIGHT = new Set([
  'created', 'quote_created', 'quote_accepted', 'awaiting_deposit',
  'awaiting_crypto_deposit', 'deposit_received', 'blockchain_confirmed',
  'processing', 'settlement_processing', 'bank_processing', 'crypto_sent',
]);

function hoursSince(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? ms / 3_600_000 : 0;
}

function worst(signals: OperationalSignal[]): AlertSeverity {
  if (signals.some((s) => s.severity === 'critical')) return 'critical';
  if (signals.some((s) => s.severity === 'warn')) return 'warn';
  return 'ok';
}

export async function getOperationalHealth(): Promise<OperationalHealth> {
  const signals: OperationalSignal[] = [];

  const transfers = await db.listNgnTransfers().catch(() => []);
  const payoutAccounts = await db.listNgnPayoutAccounts().catch(() => []);

  // 1. STUCK TRANSFERS. The signal that would have caught both webhook bugs.
  {
    const stuck = transfers.filter(
      (t: any) => IN_FLIGHT.has(String(t.status)) && hoursSince(t.updatedAt ?? t.createdAt) >= STUCK_TRANSFER_HOURS
    );
    signals.push({
      name: 'transfers_stuck_in_flight',
      // Critical, not warn: money has left a user's wallet and no naira has
      // arrived. Every minute of this is a support ticket forming.
      severity: stuck.length > 0 ? 'critical' : 'ok',
      value: stuck.length,
      detail: stuck.length
        ? `${stuck.length} transfer(s) unfinished for over ${STUCK_TRANSFER_HOURS}h. Check the Breet webhook log - a delivery may have failed or gone unapplied.`
        : `No transfer has been in flight longer than ${STUCK_TRANSFER_HOURS}h.`,
    });
  }

  // 2. TRANSFERS HELD FOR REVIEW. Funds Breet is holding, uncredited.
  {
    const held = transfers.filter((t: any) => t.status === 'requires_review');
    signals.push({
      name: 'transfers_requiring_review',
      severity: held.length > 0 ? 'warn' : 'ok',
      value: held.length,
      detail: held.length
        ? `${held.length} deposit(s) flagged below the asset minimum. Breet is holding the funds; recovering each costs the flag fee.`
        : 'No flagged deposits.',
    });
  }

  // 3. THE NAME REVIEW QUEUE. Each row is a user who cannot withdraw.
  {
    const pending = payoutAccounts.filter((a) => a.status === 'pending_review');
    const oldest = Math.max(0, ...pending.map((a) => hoursSince(a.createdAt)));
    const severity: AlertSeverity =
      oldest >= CRITICAL_REVIEW_HOURS ? 'critical' : oldest >= STALE_REVIEW_HOURS ? 'warn' : 'ok';
    signals.push({
      name: 'kyc_name_reviews_pending',
      severity,
      value: pending.length,
      detail: pending.length
        ? `${pending.length} bank name review(s) waiting, oldest ${oldest.toFixed(1)}h. These users cannot withdraw until someone decides.`
        : 'Review queue empty.',
    });
  }

  // 4. WEBHOOKS ARRIVING AT ALL. Silence is ambiguous, so it is only a warn -
  //    a quiet night and a broken endpoint look identical from here.
  {
    const webhooks = await db.listNgnWebhooks().catch(() => []);
    const recent = webhooks.filter((w: any) => hoursSince(w.createdAt) <= 24).length;
    const inFlightRecently = transfers.some(
      (t: any) => IN_FLIGHT.has(String(t.status)) && hoursSince(t.createdAt) <= 24
    );
    signals.push({
      name: 'provider_webhooks_24h',
      severity: recent === 0 && inFlightRecently ? 'warn' : 'ok',
      value: recent,
      detail: recent === 0 && inFlightRecently
        ? 'Transfers were started in the last 24h but NO provider webhook arrived. Check the webhook URL and secret at the provider.'
        : `${recent} provider webhook(s) in the last 24h.`,
    });
  }

  // 5. DELEGATED SIGNING. Without it the backend cannot move funds out of a
  //    user wallet at all - every withdrawal returns pending_user_signature.
  {
    const configured = Boolean(env.PRIVY_AUTHORIZATION_PRIVATE_KEY && env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID);
    signals.push({
      name: 'delegated_signing_configured',
      severity: configured ? 'ok' : 'critical',
      value: configured ? 1 : 0,
      detail: configured
        ? 'Delegated signing credentials are present.'
        : 'PRIVY_AUTHORIZATION_* is missing. The backend cannot sign withdrawals - every one will require the user to sign.',
    });
  }

  // 6. THE RAILS. An operator pausing deliberately is fine; an accidental
  //    pause that nobody notices is an outage that looks like low volume.
  {
    const controls = await getNgnControls().catch(() => null);
    const offrampOn = controls?.offrampEnabled === true;
    signals.push({
      name: 'ngn_offramp_enabled',
      severity: offrampOn ? 'ok' : 'warn',
      value: offrampOn ? 1 : 0,
      detail: offrampOn
        ? 'NGN off-ramp is enabled.'
        : 'NGN off-ramp is DISABLED. If this was not deliberate, users cannot withdraw to naira.',
    });
  }

  // 7. THE PROVIDER SANDBOX FLAG. The one that would silently make every
  //    verification worthless in production.
  {
    const production = (env.BREET_ENV ?? 'development') === 'production';
    const isLive = env.APP_ENV === 'production';
    signals.push({
      name: 'breet_environment',
      // Only critical when the APP is live. In staging, development is right.
      severity: isLive && !production ? 'critical' : 'ok',
      value: production ? 1 : 0,
      detail: isLive && !production
        ? 'APP_ENV is production but BREET_ENV is development. Bank name resolution returns a stub for EVERY account number - verification proves nothing.'
        : `Breet environment: ${env.BREET_ENV ?? 'development'}.`,
    });
  }

  // 8. THE ACTIVE NGN PROVIDER. A provider whose resolver cannot authenticate
  //    breaks the bank picker completely - and it fails as a 500 on a user
  //    action, which is invisible from any liveness check.
  //
  //    This is not hypothetical: test ran with NGN_PROVIDER=paj, whose staging
  //    key was never provisioned, and every bank resolution returned 500.
  {
    // Read process.env FIRST. config/env.ts parses once at import, so a value
    // changed afterwards - by an operator restarting with new config, or by a
    // test - would otherwise be invisible here. Same reasoning as
    // wallet-health's credential check.
    const provider = process.env.NGN_PROVIDER || env.NGN_PROVIDER || 'mock';
    // CREDENTIALS, NOT JUST THE NAME.
    //
    // Setting NGN_PROVIDER=breet without BREET_APP_ID/SECRET is worse than
    // leaving it wrong: every bank call 403s with "Breet credentials are not
    // configured", so the picker is empty and a user cannot verify at all.
    // Caught in the browser - the provider signal read ok while /api/ngn/banks
    // returned 403.
    // `process.env.X || env.X` is WRONG here: env is a parsed snapshot, so a
    // credential DELETED from process.env would fall through to the stale
    // snapshot value and still read as configured. Prefer process.env when
    // the key is present at all, including when it is empty.
    const breetAppId = 'BREET_APP_ID' in process.env ? process.env.BREET_APP_ID : env.BREET_APP_ID;
    const breetSecret = 'BREET_APP_SECRET' in process.env ? process.env.BREET_APP_SECRET : env.BREET_APP_SECRET;
    const breetConfigured = Boolean(breetAppId && breetSecret);
    const usable = provider === 'breet' && breetConfigured;
    // 'mock' is correct in a test run and in local development, so it is only
    // a problem on a DEPLOYED environment. 'paj' is a problem anywhere it
    // serves users, because its resolver cannot authenticate at all.
    const deployed = env.APP_ENV === 'production' || env.APP_ENV === 'staging';
    signals.push({
      name: 'ngn_provider',
      // Deliberately choosing breet and then not configuring it is broken
      // EVERYWHERE, not only on a deployed host - the picker is empty and
      // nobody can verify. A merely-unset provider (mock) is only a problem
      // once deployed.
      severity: usable
        ? 'ok'
        : provider === 'breet' || deployed ? 'critical' : 'ok',
      value: usable ? 1 : 0,
      detail: usable
        ? 'NGN provider is breet, with credentials.'
        : provider === 'breet' && !breetConfigured
          ? 'NGN_PROVIDER is breet but BREET_APP_ID/BREET_APP_SECRET are missing. Every bank lookup returns 403 and no user can verify.'
          : deployed
            ? `NGN_PROVIDER is "${provider}" on a deployed environment. Bank resolution will fail for users — set it to breet.`
            : `NGN provider is "${provider}" (local/test — fine here).`,
    });
  }

  return {
    status: worst(signals),
    checkedAt: new Date().toISOString(),
    environment: env.APP_ENV,
    signals,
  };
}
