import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden } from '../../shared/errors.js';
import { parseBody } from '../../shared/validation.js';
import { createNgnQuote, createNgnQuoteSchema, listNgnQuotes } from '../service/ngn-quotes.service.js';
import { acceptNgnQuote, acceptNgnQuoteSchema, cancelNgnTransfer, listNgnTransfers, retryNgnTransfer } from '../service/ngn-transfers.service.js';
import { getNgnControls, updateNgnControls, updateNgnControlsSchema } from '../service/ngn-controls.service.js';
import { listNgnBanks, resolveNgnBankAccount } from '../service/ngn-banks.service.js';
import { db } from '../../database/json-database.js';
import { getGasUsage, getGasControls } from '../../balances/gas-usage.service.js';
import { solanaTransactionCostUsd, ataRentCostUsd } from '../../balances/gas-policy.js';
import { fetchPrivyGasSpendUsd } from '../../wallets/provider/privy-wallet.provider.js';
import type { UserWalletRecord } from '../../database/types.js';
import {
  saveNgnPayoutAccount,
  saveNgnPayoutAccountSchema,
  listNgnPayoutAccounts,
  listNgnPayoutAccountReviews,
  getNgnPayoutReviewSummary,
  reviewNgnPayoutAccount,
  reviewNgnPayoutAccountSchema,
} from '../service/ngn-payout-accounts.service.js';
import { getWalletProviderHealth, getAllWalletProviderHealth } from '../../wallets/wallet-health.service.js';
import {
  getWalletControlsView,
  updateWalletControls,
  updateWalletControlsSchema,
} from '../../wallets/wallet-controls.service.js';
import { listPaymentControls } from '../../controls/payment-controls.service.js';
import {
  usableForOnramp,
  usableForOfframp,
  breetMinimumDepositUsd,
  type StableAsset,
} from '../provider/breet-networks.js';
import { breetEnvironment } from '../provider/breet.provider.js';
import { gasEstimateUsd, networkDisplayLabel } from '../network-costs.js';

import {
  getVerificationLimitMatrix,
  setVerificationLimit,
  setVerificationLimitSchema,
  clearVerificationLimit,
  clearVerificationLimitSchema,
} from '../../kyc/service/verification-limits.service.js';
import {
  getUserLimitDetail,
  setUserLimit,
  setUserLimitSchema,
  clearUserLimit,
  clearUserLimitSchema,
  resetUserWindow,
  resetUserWindowSchema,
} from '../../kyc/service/user-limits.service.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { PajNgnProvider } from '../provider/paj.provider.js';
import { getNgnReconciliationSummary } from '../service/ngn-reconciliation.service.js';
import { listNgnSettlementQueue } from '../service/ngn-settlement.service.js';
import { listNgnWebhooks, recordNgnWebhook } from '../service/ngn-webhooks.service.js';
import { reconcileNgnSettlements } from '../service/ngn-settlement-reconciler.js';

function ensureOwnUser(request: any, userId: string) {
  const authUserId = request.authUser?.sub;
  if (authUserId && authUserId !== userId) {
    throw forbidden('You cannot access another user account');
  }
}

export async function ngnRoutes(app: FastifyInstance) {
  app.get('/api/ngn/quote', async (request) => {
    const query = createNgnQuoteSchema.parse(request.query ?? {});
    ensureOwnUser(request, query.userId);
    return { data: await createNgnQuote(query) };
  });

  app.post('/api/ngn/onramp/orders', async (request) => {
    const body = parseBody(acceptNgnQuoteSchema, request.body);
    ensureOwnUser(request, body.userId);
    return { data: await acceptNgnQuote(body) };
  });

  app.post('/api/ngn/offramp/orders', async (request) => {
    const body = parseBody(acceptNgnQuoteSchema, request.body);
    ensureOwnUser(request, body.userId);
    return { data: await acceptNgnQuote(body) };
  });

  app.get('/api/users/:userId/ngn-transfers', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listNgnTransfers({ userId }) };
  });

  /**
   * Let a user close an off-ramp they have decided not to fund.
   *
   * There was no way to do this at all - an unfunded sell sat there until the
   * 24h reconciler swept it, showing a live deposit address for an order the
   * user had already abandoned. Reported as "seems like a stale sell".
   *
   * ensureOwnUser as well as the service-level ownership check: cancelling is
   * a state change on someone's money, and one guard is not enough.
   */
  app.post('/api/users/:userId/ngn-transfers/:id/cancel', async (request) => {
    const { userId, id } = request.params as { userId: string; id: string };
    ensureOwnUser(request, userId);
    const body = (request.body ?? {}) as { reason?: string };
    return { data: await cancelNgnTransfer(id, { userId, actorId: userId, reason: body.reason }) };
  });


  /**
   * Banks and account resolution, on whichever provider is ACTIVE.
   *
   * These were '/api/ngn/paj/*' and constructed `new PajNgnProvider()`
   * directly, ignoring NGN_PROVIDER entirely. With Breet as the default that
   * meant the only bank endpoints in the product talked to the wrong provider:
   * a user would pick from PajRamp's bank list and hand a PajRamp bank id to
   * Breet, which does not recognise it.
   *
   * The provider-specific paths are kept as aliases so nothing already
   * pointing at them breaks, but they now resolve through the registry too.
   */
  app.get('/api/ngn/banks', async (request) => {
    const query = request.query as { userId?: string; currency?: 'ngn' | 'ghs' };
    if (query.userId) ensureOwnUser(request, query.userId);
    return { data: await listNgnBanks(query.currency ?? 'ngn') };
  });

  /**
   * Resolve an account number to the name the bank holds for it.
   *
   * This is Sivan's Level 1 identity evidence: since the CBN directive of
   * 1 March 2024 a Nigerian account cannot transact without BVN/NIN linkage,
   * so an account that resolves has already been verified by a licensed bank.
   */
  app.get('/api/ngn/bank-account/resolve', async (request) => {
    const query = request.query as { userId?: string; bankId?: string; accountNumber?: string; currency?: 'ngn' | 'ghs' };
    if (query.userId) ensureOwnUser(request, query.userId);
    if (!query.bankId || !query.accountNumber) throw badRequest('bankId and accountNumber are required');
    return { data: await resolveNgnBankAccount(query.bankId, query.accountNumber, query.currency ?? 'ngn') };
  });

  /**
   * Save a payout account, matched against the name on file.
   *
   * The resolve endpoint above is READ-ONLY and proves nothing about who is
   * asking. This is the one that creates evidence: it re-resolves the account
   * server side and matches the bank's name against the user's.
   *
   * Deliberately does NOT accept an accountName from the client. A client that
   * could supply the name could submit a stranger's account number alongside
   * its own name and inherit that stranger's bank-verified identity.
   */
  app.post('/api/ngn/payout-accounts', async (request, reply) => {
    const body = parseBody(saveNgnPayoutAccountSchema, request.body);
    ensureOwnUser(request, body.userId);
    return reply.code(201).send({ data: await saveNgnPayoutAccount(body) });
  });

  app.get('/api/ngn/payout-accounts', async (request) => {
    const query = request.query as { userId?: string };
    if (!query.userId) throw badRequest('userId is required');
    ensureOwnUser(request, query.userId);
    return { data: await listNgnPayoutAccounts(query.userId) };
  });

  /**
   * The review queue: accounts whose name match was partial.
   *
   * These are users who are probably legitimate - a middle name the bank does
   * not hold, a married name, a transliteration - and who are BLOCKED until
   * someone looks. An unattended queue is a silent outage for real customers,
   * which is why the list is oldest-first.
   */
  app.get('/api/admin/ngn/payout-accounts/reviews', async () => ({
    data: await listNgnPayoutAccountReviews(),
  }));

  /**
   * Where manual review is actually needed, as counts.
   *
   * Separate from the queue itself because the queue length alone cannot tell
   * an operator whether anyone is waiting on THEM: on a sandbox every account
   * lands in it, perfect matches included.
   */
  app.get('/api/admin/ngn/payout-accounts/review-summary', async () => ({
    data: await getNgnPayoutReviewSummary(),
  }));

  app.put('/api/admin/ngn/payout-accounts/:accountId/review', async (request) => {
    const { accountId } = request.params as { accountId: string };
    const body = parseBody(reviewNgnPayoutAccountSchema.omit({ reviewedBy: true }), request.body);
    // Taken from the authenticated admin, never from the body: an operator
    // must not be able to file a decision under someone else's name.
    const reviewedBy = (request as any).adminActor?.email || 'admin_api_key';
    return { data: await reviewNgnPayoutAccount(accountId, { ...body, reviewedBy }) };
  });

  // Legacy aliases. Same registry-backed implementation, not PajRamp.
  app.get('/api/ngn/paj/banks', async (request) => {
    const query = request.query as { userId?: string };
    if (query.userId) ensureOwnUser(request, query.userId);
    return { data: await listNgnBanks('ngn') };
  });

  app.get('/api/ngn/paj/bank-account/resolve', async (request) => {
    const query = request.query as { userId?: string; bankId?: string; accountNumber?: string };
    if (query.userId) ensureOwnUser(request, query.userId);
    if (!query.bankId || !query.accountNumber) throw badRequest('bankId and accountNumber are required');
    return { data: await resolveNgnBankAccount(query.bankId, query.accountNumber, 'ngn') };
  });

  app.get('/api/admin/ngn/paj/banks', async () => ({ data: await new PajNgnProvider().getBanks() }));
  app.get('/api/admin/ngn/paj/bank-account/resolve', async (request) => {
    const query = request.query as { bankId?: string; accountNumber?: string };
    if (!query.bankId || !query.accountNumber) throw badRequest('bankId and accountNumber are required');
    return { data: await new PajNgnProvider().resolveBankAccount(query.bankId, query.accountNumber) };
  });

  app.post('/api/webhooks/paj', async (request) => ({ data: await recordNgnWebhook('paj', request.body, request.headers) }));
  // Breet delivers to its own path so the two providers' secrets and payload
  // shapes never reach the wrong verifier. Breet's verifyWebhook checks the
  // x-webhook-secret header and then re-fetches the transaction from Breet, so
  // a forged amount in the body cannot be credited.
  /**
   * Breet webhooks, plus the dashboard's URL-verification ping.
   *
   * SAVING A WEBHOOK URL IN BREET'S DASHBOARD POSTS TO IT AND DEMANDS A 200.
   *
   * That ping carries no `x-webhook-secret` - the secret does not exist yet at
   * the point you are configuring the URL - and it carries no event body. So
   * verifyWebhook() correctly rejected it with 403 and the dashboard refused
   * to save, reporting "Webhook URL must acknowledge the verification request
   * with a 200 response".
   *
   * A verification ping is recognised by having NO event and NO id. It is
   * acknowledged and nothing else: nothing is stored, no transfer is touched,
   * no balance moves. A payload that carries an event still goes through the
   * full secret check and the fetch-by-id confirmation, so this does not
   * weaken the path that actually credits money - which is the only thing
   * that matters here.
   *
   * Deliberately NOT keyed on "the secret is missing". That would let anyone
   * who omits the header get a 200, which is exactly the shape of the bug
   * being avoided.
   */
  app.post('/api/webhooks/breet', {
    /**
     * ACCEPT ANY CONTENT TYPE, AND AN EMPTY BODY.
     *
     * Fastify rejected the dashboard's ping before our handler ever ran:
     *
     *   Content-Type: application/json + zero-length body -> 400 "Body cannot be empty"
     *   no Content-Type header at all                     -> 415 Unsupported Media Type
     *   Content-Type: application/x-www-form-urlencoded   -> 415 Unsupported Media Type
     *
     * All three are 4xx, so Breet reports "Webhook URL must acknowledge the
     * verification request with a 200 response" and refuses to save - and no
     * amount of handler logic helps, because the handler is never reached.
     *
     * A wildcard parser that tolerates an empty payload fixes all three. It
     * parses JSON when it can and hands back an empty object when it cannot,
     * so a real webhook still arrives as a normal object and every secret
     * check below is unchanged.
     */
    bodyLimit: 1_048_576,
  }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    /**
     * A VERIFICATION PING, NOT A WEBHOOK.
     *
     * Recognised by carrying no transaction identity - no id, and no event
     * that names a real Breet event. Breet's live events are `trade.*` and
     * `withdrawal.*`; the dashboard probe sends either nothing at all or a
     * placeholder such as {"event":"verification"}, which named an event and
     * was therefore being treated as a forged webhook and refused with 403.
     *
     * Matching on the event NAMESPACE rather than on "is the event field
     * present" is what makes this safe: a payload claiming `trade.completed`
     * can never be waved through, whatever else it contains.
     */
    const eventName = typeof body.event === 'string' ? body.event : '';
    const isRealEventName = /^(trade|withdrawal)\./i.test(eventName);
    const isVerificationPing = !isRealEventName && !body.id;
    if (isVerificationPing) {
      return { data: { acknowledged: true, verification: true } };
    }
    return { data: await recordNgnWebhook('breet', request.body, request.headers) };
  });

  /**
   * Which networks a user may actually pick, per direction.
   *
   * Deliberately TWO lists, because the answer genuinely differs:
   *
   *   solana   usdc/usdt   off-ramp YES   on-ramp YES
   *   base     usdc        off-ramp YES   on-ramp NO   (Breet has no Base withdrawal)
   *   base     usdt        neither        (Breet publishes no Base USDT asset at all)
   *   ethereum usdc/usdt   off-ramp YES   on-ramp YES
   *
   * Serving one shared list would let a user select Base for an on-ramp and
   * only discover after committing that naira cannot settle there. The
   * capability map already refuses it server-side; this stops the UI offering
   * it in the first place.
   *
   * Intersected with the admin's enabled networks, so turning Ethereum off in
   * Admin Controls removes it here without a deploy.
   */
  app.get('/api/ngn/networks', async (request) => {
    const query = request.query as { asset?: string };
    const asset = (String(query.asset ?? 'usdc').toLowerCase()) as StableAsset;
    if (asset !== 'usdc' && asset !== 'usdt') {
      throw badRequest('asset must be usdc or usdt.');
    }

    const controls = await listPaymentControls();
    const enabled = (controls.sourceNetworks ?? [])
      .filter((n: any) => n.enabled)
      .map((n: any) => n.network as any);

    /**
     * A network is only offered if we can price BOTH ends of it.
     *
     * createNgnQuote() now refuses a chain with no fee estimate rather than
     * guessing $0.50 (see network-costs.ts). Listing such a chain here would
     * advertise an option that fails the moment it is picked, so the filter and
     * the refusal are deliberately driven by the same table.
     *
     * The practical effect: an admin enabling a network Sivan has no fee data
     * for sees it simply not appear, instead of users hitting a dead end after
     * choosing it.
     */
    const describe = (networks: readonly any[]) =>
      networks
        .filter((network) => gasEstimateUsd(String(network)) !== undefined)
        .map((network) => ({
        network,
        asset,
        /**
         * Sent so the client stops keeping its own copy of this table.
         *
         * The frontend had a duplicate TYPICAL_GAS_USD with its own silent
         * $0.50 fallback, which could disagree with the server's floor - the UI
         * would promise one fee while the quote was computed from another.
         * One source, one number, no drift.
         */
        gasEstimateUsd: gasEstimateUsd(String(network)),
        /** So the UI never has to render a raw slug like 'avalanche_c_chain'. */
        label: networkDisplayLabel(String(network)),

        // Surfaced per network because it is per ASSET, not global, and the
        // user must see it before choosing where to send from.
        //
        // THE ENVIRONMENT MUST BE THE REAL ONE, NOT 'production'.
        //
        // Hardcoding it meant this endpoint advertised Breet's MAINNET
        // minimum ($15) on the sandbox, where the enforced figure is $50. The
        // UI showed "minimum $15", the user sent $20, and only on accepting
        // the quote did they learn the true floor. A limit the product states
        // and then does not honour is worse than no limit shown.
        minimumDepositUsd: breetMinimumDepositUsd(network, asset, breetEnvironment()),
      }));

    return {
      data: {
        asset,
        offramp: describe(usableForOfframp(enabled, asset)),
        onramp: describe(usableForOnramp(enabled, asset)),
      },
    };
  });

  /**
   * Wallet provider, admin-controlled.
   *
   * WALLET_PROVIDER lived only in the environment, so changing custody
   * provider meant a redeploy. Safe to change at runtime because every wallet
   * row records the provider that issued it - switching decides who issues the
   * NEXT wallet and never orphans an existing one.
   *
   * GET returns the environment default alongside the override, since an
   * operator cannot judge a switch without seeing what it switches FROM.
   */
  app.get('/api/admin/wallets/controls', async () => ({ data: await getWalletControlsView() }));

  /**
   * Can this deployment actually reach its wallet provider?
   *
   * Exists because credential problems were only observable by creating a
   * wallet - which sits behind the KYC gate, so a misconfigured deployment
   * looked identical to a working one when tested without a verified bank
   * account. This asks the provider directly: no user, no KYC, nothing
   * created.
   */
  /**
   * EVERY WALLET ON THE PLATFORM, for support.
   *
   * There was no admin view of who holds a wallet, on which chain, at what
   * address. Answering "does this user have a Solana address?" meant a
   * database query, which support cannot run - so the question arrived here
   * instead, one ticket at a time.
   *
   * Deliberately does NOT read balances. That is one RPC round trip per wallet
   * per chain, so a list of 250 wallets would take minutes and time out behind
   * the 12s gateway. The list answers "does it exist and where"; a balance is
   * a per-wallet question asked from the existing detail endpoint.
   */
  app.get('/api/admin/wallets', async (request) => {
    const { query, chain, limit } = request.query as { query?: string; chain?: string; limit?: string };
    const wallets = await db.listAllOpenWallets();
    const needle = String(query ?? '').trim().toLowerCase();

    const filtered = wallets
      .filter((wallet) => (chain ? wallet.chain === chain : true))
      .filter((wallet) => !needle
        || wallet.address?.toLowerCase().includes(needle)
        || wallet.userId?.toLowerCase().includes(needle)
        || wallet.providerWalletId?.toLowerCase().includes(needle))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const capped = Math.min(Number(limit) || 200, 500);
    return {
      data: {
        total: filtered.length,
        // Counts come from the FULL set, not the page, so an operator filtering
        // to one chain still sees the platform totals rather than their filter.
        byChain: wallets.reduce((acc: Record<string, number>, wallet: UserWalletRecord) => {
          acc[wallet.chain] = (acc[wallet.chain] ?? 0) + 1;
          return acc;
        }, {}),
        delegated: wallets.filter((wallet: UserWalletRecord) => wallet.delegatedSigningEnabled).length,
        wallets: filtered.slice(0, capped).map((wallet) => ({
          id: wallet.id,
          userId: wallet.userId,
          chain: wallet.chain,
          address: wallet.address,
          provider: wallet.provider,
          providerWalletId: wallet.providerWalletId,
          status: wallet.status,
          custodial: wallet.custodial,
          delegatedSigningEnabled: Boolean(wallet.delegatedSigningEnabled),
          createdAt: wallet.createdAt,
        })),
      },
    };
  });

  /**
   * Gas sponsorship: what has been spent, and what the limits are.
   *
   * Reports BOTH our own estimate and Privy's billed figure. They answer
   * different questions - the estimate drives the circuit breaker in real
   * time, Privy's is the invoice - and showing only one would hide a drift
   * between them that is itself worth seeing.
   */
  app.get('/api/admin/wallets/gas', async () => {
    const [usage, controls] = await Promise.all([getGasUsage(), getGasControls()]);

    // Solana wallets only: EVM gas is paid in ETH and is not part of this
    // budget, so including those ids would inflate Privy's figure against a
    // budget that never counted them.
    const wallets = (await db.listAllOpenWallets())
      .filter((wallet: UserWalletRecord) => wallet.chain === 'solana')
      .map((wallet: UserWalletRecord) => wallet.providerWalletId)
      .filter(Boolean);

    const billed = await fetchPrivyGasSpendUsd({
      walletIds: wallets,
      startMs: Date.now() - 24 * 3600_000,
      endMs: Date.now(),
    });

    return {
      data: {
        ...usage,
        controls,
        costs: {
          perTransferUsd: solanaTransactionCostUsd(controls.solPriceUsd),
          perNewRecipientUsd: ataRentCostUsd(controls.solPriceUsd),
        },
        // `ok:false` is surfaced rather than swallowed. An unknown billed
        // figure is honest; a silent 0 would read as "we have spent nothing".
        privy: billed,
        walletsTracked: wallets.length,
      },
    };
  });

  app.get('/api/admin/wallets/health', async (request) => {
    const query = request.query as { all?: string };
    return {
      data: query.all === 'true'
        ? await getAllWalletProviderHealth()
        : await getWalletProviderHealth(),
    };
  });

  app.put('/api/admin/wallets/controls', async (request) => ({
    data: await updateWalletControls(parseBody(updateWalletControlsSchema, request.body)),
  }));

  app.get('/api/admin/ngn/controls', async () => ({ data: await getNgnControls() }));
  app.put('/api/admin/ngn/controls', async (request) => ({ data: await updateNgnControls(parseBody(updateNgnControlsSchema, request.body)) }));

  /**
   * Verification ceilings, admin-controlled.
   *
   * These were compiled into FLOW_LIMITS and could only be changed by editing
   * code and redeploying, which is the wrong shape for a compliance number.
   *
   * Breet's documented MAINNET minimum is $15 (~NGN 24,075), so a Level 1 user
   * on the NGN 50,000 ceiling gets about two withdrawals a month - tight, not
   * impossible. The sandbox reports $50 for the same assets, which is a
   * testing artifact rather than the production floor.
   *
   * GET returns default, override and effective side by side, because an
   * operator cannot judge a limit without seeing what it was changed from.
   */
  app.get('/api/admin/verification-limits', async () => ({ data: await getVerificationLimitMatrix() }));

  app.put('/api/admin/verification-limits', async (request) => ({
    data: await setVerificationLimit(parseBody(setVerificationLimitSchema, request.body)),
  }));

  /** Remove an override and fall back to the shipped default. */
  app.delete('/api/admin/verification-limits', async (request) => ({
    data: await clearVerificationLimit(parseBody(clearVerificationLimitSchema, request.body)),
  }));

  /**
   * PER-USER LIMITS.
   *
   * The routes above move a whole TIER. These move ONE PERSON, which is what
   * support actually needs: "this verified merchant needs a higher cap this
   * month" previously had no answer that did not also raise the cap for every
   * stranger at the same level.
   *
   * GET returns tier default, override and effective figure side by side, for
   * the same reason the tier matrix does - a ceiling cannot be judged without
   * seeing what it was changed from.
   */
  app.get('/api/admin/users/:userId/limits', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUserLimitDetail(userId) };
  });

  app.put('/api/admin/users/:userId/limits', async (request) => {
    const { userId } = request.params as { userId: string };
    // The path is authoritative for WHO. Trusting a userId in the body would
    // let a mistyped payload silently edit a different customer's ceiling
    // than the one the admin has open on screen.
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role;
    const body = parseBody(setUserLimitSchema, {
      ...(request.body as object),
      userId,
      ...(actor ? { updatedBy: actor } : {}),
    });
    return { data: await setUserLimit(body) };
  });

  app.delete('/api/admin/users/:userId/limits', async (request) => {
    const { userId } = request.params as { userId: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role;
    const body = parseBody(clearUserLimitSchema, {
      ...(request.body as object),
      userId,
      ...(actor ? { clearedBy: actor } : {}),
    });
    return { data: await clearUserLimit(body) };
  });

  /**
   * Forgive the volume already counted in this user's rolling window.
   *
   * A SEPARATE ROUTE from the ceiling above, not a field on it. Raising a cap
   * and forgiving spend are different acts with different risk, and folding
   * them together would make them indistinguishable in the audit log.
   */
  app.post('/api/admin/users/:userId/limits/reset', async (request) => {
    const { userId } = request.params as { userId: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role;
    const body = parseBody(resetUserWindowSchema, {
      ...(request.body as object),
      userId,
      ...(actor ? { createdBy: actor } : {}),
    });
    return { data: await resetUserWindow(body) };
  });
  app.get('/api/admin/ngn/quotes', async (request) => {
    const query = request.query as { userId?: string };
    return { data: await listNgnQuotes({ userId: query.userId }) };
  });
  app.get('/api/admin/ngn/transfers', async (request) => {
    const query = request.query as { userId?: string; status?: string };
    return { data: await listNgnTransfers(query) };
  });
  app.get('/api/admin/ngn/settlement-queue', async () => ({ data: await listNgnSettlementQueue() }));
  app.get('/api/admin/ngn/webhooks', async () => ({ data: await listNgnWebhooks() }));
  app.get('/api/admin/ngn/reconciliation', async () => ({ data: await getNgnReconciliationSummary() }));
  app.get('/api/admin/ngn/provider-health', async () => {
    const controls = await getNgnControls();
    const active = getNgnProvider(controls.activeProvider);
    const backup = controls.backupProvider ? getNgnProvider(controls.backupProvider) : null;
    return { data: { active: await active.health(), backup: backup ? await backup.health() : null, controls } };
  });
  /**
   * Reconcile against the provider's own record, on demand.
   *
   * The timer does this every few minutes; this is the button for when
   * somebody is standing over a stuck payout and does not want to wait.
   */
  app.post('/api/admin/ngn/reconcile-settlements', async (request) => ({
    data: await reconcileNgnSettlements({
      actorId: (request as any).adminActor?.email || 'admin_api_key',
    }),
  }));
  app.post('/api/admin/ngn/transfers/:id/retry', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await retryNgnTransfer(id, (request as any).adminActor?.email || 'admin_api_key') };
  });
  app.post('/api/admin/ngn/webhooks/:provider', async (request) => {
    const { provider } = request.params as { provider: 'mock' | 'linkio' | 'eversend' | 'nomba' | 'paj' };
    return { data: await recordNgnWebhook(provider, request.body, request.headers) };
  });
}
