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
import { getNgnProvider } from '../ngn/provider/ngn-provider-registry.js';
import { env } from '../config/env.js';
import { resolveActiveWalletProvider } from '../wallets/wallet-controls.service.js';
import { probePrivyCredentials } from '../wallets/provider/privy-wallet.provider.js';

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

/**
 * States where SIVAN OR A PROVIDER HOLDS THE USER'S MONEY.
 *
 * This is the whole point of the signal: crypto has left the user's control
 * and no naira has arrived. Every minute is a support ticket forming, so it
 * pages someone.
 *
 * `awaiting_crypto_deposit` and the pre-deposit states are DELIBERATELY NOT
 * here. They mean the opposite: an order exists and the user has not sent
 * anything. Nobody's money is at risk and there is nothing for an operator to
 * do.
 *
 * Measured on api-test: 9 transfers counted as CRITICAL, all
 * `awaiting_crypto_deposit`, all with no destinationTxHash - nobody had ever
 * sent crypto. That is 9 pages for abandoned test orders, and a monitor that
 * cries wolf is a monitor nobody reads. Those are now reported separately as
 * an informational count.
 */
const IN_FLIGHT = new Set([
  'deposit_received', 'blockchain_confirmed',
  'processing', 'settlement_processing', 'bank_processing', 'crypto_sent',
]);

/**
 * Orders created but never funded. Informational, never critical.
 *
 * Worth counting - a sudden spike means people are trying to sell and failing
 * at the send step - but it is a product signal, not an incident.
 */
const AWAITING_DEPOSIT = new Set([
  'created', 'quote_created', 'quote_accepted', 'awaiting_deposit',
  'awaiting_crypto_deposit',
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
    const unfunded = transfers.filter(
      (t: any) => AWAITING_DEPOSIT.has(String(t.status)) && hoursSince(t.updatedAt ?? t.createdAt) >= STUCK_TRANSFER_HOURS
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

    /**
     * Counted, never paged. An abandoned order is a product observation.
     */
    signals.push({
      name: 'orders_awaiting_deposit',
      severity: 'ok',
      value: unfunded.length,
      detail: unfunded.length
        ? `${unfunded.length} order(s) created but never funded. No money is at risk - the user has not sent crypto.`
        : 'No unfunded orders older than the threshold.',
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

  /**
   * 4b. IS THE WEBHOOK SECRET EVEN SET?
   *
   * verifyWebhook() fails CLOSED when BREET_WEBHOOK_SECRET is empty - which is
   * the right call, an unauthenticated webhook that credits balances is worse
   * than a broken one. But nothing SAID so. Every Breet delivery returned 403,
   * Breet retried on its published backoff (1m, 5m, 1h, 4h, 8h, 12h, 24h) and
   * then marked the event permanently failed, and the only symptom anywhere
   * was settlements arriving late via the 5-minute reconciler.
   *
   * Measured: BREET_WEBHOOK_SECRET is an empty string on this deployment. This
   * was described to me as a "secret mismatch"; it is not a mismatch, it is
   * ABSENT. The value comes from the Breet dashboard under
   * Settings -> For Developer -> Webhook Verification Secret Key, and Breet
   * sends it verbatim in the `x-webhook-secret` header.
   *
   * Critical rather than warn: with it unset, no webhook can ever be accepted,
   * so every settlement depends on the reconciler catching it within 5 minutes.
   * That is a fallback, not a design.
   */
  {
    const configured = Boolean(env.BREET_WEBHOOK_SECRET);
    signals.push({
      name: 'ngn_webhook_secret_configured',
      severity: configured ? 'ok' : 'critical',
      value: configured ? 1 : 0,
      detail: configured
        ? 'NGN webhook secret is configured, so provider deliveries can be verified.'
        : 'BREET_WEBHOOK_SECRET is EMPTY, so every provider webhook is rejected with 403 and '
          + 'settlement falls back to the reconciler. Copy the Webhook Verification Secret Key '
          + 'from the provider dashboard into BREET_WEBHOOK_SECRET.',
    });
  }

  /**
   * 4c. CAN THE ACTIVE WALLET PROVIDER ACTUALLY SERVE OUR USERS?
   *
   * Reported twice from production: POST /wallets returned 400 for a user who
   * had verified with a Nigerian bank and was correctly Level 1.
   *
   * Sivan's own eligibility passed. The Bridge adapter then refused, because
   * Bridge's API is customer-scoped and the NGN verification path never
   * creates a Bridge customer - by design, since Bridge plays no part in a
   * naira off-ramp and charges $2 per KYC.
   *
   * So `bridge` cannot issue a wallet to ANY Nigerian-bank user, ever. That is
   * not a per-user fault to be discovered one support ticket at a time; it is
   * a deployment-wide misconfiguration, and it belongs here where an operator
   * sees it before a customer does.
   *
   * Privy is the provider that serves this path: it is customer-agnostic, so
   * Level 1 is sufficient.
   */
  {
    const provider = await resolveActiveWalletProvider().catch(() => 'unknown');
    // Only 'bridge' has the customer-scoped limitation. mock is refused
    // outside development by the registry itself, and privy needs no customer.
    const blocked = provider === 'bridge';
    signals.push({
      name: 'wallet_provider_serves_ngn_users',
      severity: blocked ? 'critical' : 'ok',
      value: blocked ? 0 : 1,
      detail: blocked
        ? 'Active wallet provider is "bridge", which requires a Bridge customer with approved KYC. '
          + 'Users who verified by Nigerian bank have no Bridge customer, so wallet creation returns 400 '
          + 'for all of them. Switch to privy: PUT /api/admin/wallets/controls {"activeProvider":"privy"}.'
        : `Active wallet provider is "${provider}", which can issue wallets to bank-verified users.`,
    });

    /**
     * 4d. AND WILL IT ANSWER?
     *
     * The signal above reports which provider is SELECTED. It says nothing
     * about whether that provider will respond, and the difference is not
     * academic: live reported wallet_provider_serves_ngn_users: ok while
     * POST /wallets returned 500 and the dashboard footer read "All systems
     * operational". A user was told to check details they could not fix, and
     * every health indicator agreed with the product that nothing was wrong.
     *
     * Only probed when privy is the active provider - it is the only one this
     * check knows how to reach, and probing an inactive provider would raise
     * alarms about a code path nobody is using.
     */
    /**
     * NOT IN TESTS, and not merely as an optimisation.
     *
     * This makes a real network call to Privy. Left unguarded it fired during
     * the operational-health suite, where PRIVY_AUTHORIZATION_KEY_QUORUM_ID is
     * the literal string "stub" - Privy correctly answered 404, the signal went
     * critical, and a green system reported an outage. A health probe that
     * turns a fixture into a false alarm trains people to ignore the fixture.
     *
     * Guarded on APP_ENV rather than on a bespoke flag so it cannot be switched
     * off in production by accident: staging and production probe, everything
     * else does not.
     */
    const probeEnabled = env.APP_ENV === 'production' || env.APP_ENV === 'staging';
    if (provider === 'privy' && probeEnabled) {
      const probe = await probePrivyCredentials();
      const rejected = probe.status === 401 || probe.status === 403;
      signals.push({
        name: 'wallet_provider_reachable',
        // A rejected credential is an outage: it will not heal, and every
        // wallet creation fails until someone changes a key. An unreachable
        // provider may just be a blip.
        // A 404 is the quorum being wrong, which is permanent until someone
        // changes an env var - critical, like a rejected credential. Only a
        // genuine transport failure is a mere warning.
        severity: probe.ok ? 'ok' : rejected || probe.status === 404 ? 'critical' : 'warn',
        value: probe.ok ? 1 : 0,
        detail: probe.ok
          ? 'Privy answered an authenticated request; wallet creation should work.'
          : rejected
            ? `Privy REJECTED our credentials (${probe.status}): ${probe.message}. `
              + 'PRIVY_APP_ID / PRIVY_APP_SECRET are set but dead - likely rotated, revoked, or pointed at '
              + 'the wrong app. EVERY wallet creation returns an error until this is fixed.'
            /**
             * A 404 here is the key quorum, not the credentials. Worth its own
             * wording because the fix is completely different: the app id and
             * secret are fine and nothing needs rotating - a quorum id from
             * another Privy app was copied into this environment, which
             * authenticates and then fails only on wallet CREATION.
             */
            : probe.status === 404
              ? `Wallet creation is broken: ${probe.message}`
              : `Privy did not answer: ${probe.message}. Wallet creation will fail while this lasts.`,
      });
    }
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

    // CONFIGURED IS NOT THE SAME AS WORKING, AND THAT GAP HID A REAL OUTAGE.
    //
    // This used to stop at "are the vars non-empty". A REVOKED key is
    // non-empty, so when the Breet sandbox key was rotated the signal kept
    // reporting "NGN provider is breet, with credentials" while
    // GET /api/ngn/banks returned 500 to every user on the deployed test API.
    // The bank picker was empty, nobody could verify, and the health endpoint
    // said ok.
    //
    // So actually call Breet. provider.health() already does exactly this -
    // it probes /trades/assets, which is authenticated and real - it simply
    // was not wired in here.
    //
    // Failure to REACH Breet is reported as a warning rather than critical:
    // a transient network blip should not page someone at 3am. A rejected
    // credential is critical, because nothing works until a human fixes it.
    let breetReachable: boolean | undefined;
    let breetMessage = '';
    if (provider === 'breet' && breetConfigured) {
      try {
        const health = await getNgnProvider('breet').health();
        breetReachable = health.available;
        breetMessage = health.message ?? '';
      } catch (error: any) {
        breetReachable = false;
        breetMessage = String(error?.message ?? 'Breet health check threw.');
      }
    }

    const credentialsRejected = breetReachable === false && /401|unauthor|invalid|wrong app/i.test(breetMessage);
    const usable = provider === 'breet' && breetConfigured && breetReachable !== false;
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
        // Unreachable-but-not-rejected is a blip; a dead key is an outage.
        : provider === 'breet' && breetReachable === false && !credentialsRejected
          ? 'warn'
          : provider === 'breet' || deployed ? 'critical' : 'ok',
      value: usable ? 1 : 0,
      detail: usable
        ? `NGN provider is breet, credentials verified against Breet${breetMessage ? ` (${breetMessage})` : ''}.`
        : provider === 'breet' && !breetConfigured
          ? 'NGN_PROVIDER is breet but BREET_APP_ID/BREET_APP_SECRET are missing. Every bank lookup returns 403 and no user can verify.'
          : provider === 'breet' && credentialsRejected
            ? `Breet REJECTED our credentials: ${breetMessage}. The key is set but dead - likely rotated or revoked. Every bank lookup 500s and no user can verify.`
            : provider === 'breet' && breetReachable === false
              ? `Breet is not reachable: ${breetMessage}. Bank lookups will fail while this lasts.`
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
