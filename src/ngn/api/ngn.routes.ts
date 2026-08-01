import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden } from '../../shared/errors.js';
import { parseBody } from '../../shared/validation.js';
import { createNgnQuote, createNgnQuoteSchema, listNgnQuotes } from '../service/ngn-quotes.service.js';
import { acceptNgnQuote, acceptNgnQuoteSchema, listNgnTransfers, retryNgnTransfer } from '../service/ngn-transfers.service.js';
import { getNgnControls, updateNgnControls, updateNgnControlsSchema } from '../service/ngn-controls.service.js';
import { listNgnBanks, resolveNgnBankAccount } from '../service/ngn-banks.service.js';
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
import {
  getVerificationLimitMatrix,
  setVerificationLimit,
  setVerificationLimitSchema,
  clearVerificationLimit,
  clearVerificationLimitSchema,
} from '../../kyc/service/verification-limits.service.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { PajNgnProvider } from '../provider/paj.provider.js';
import { getNgnReconciliationSummary } from '../service/ngn-reconciliation.service.js';
import { listNgnSettlementQueue } from '../service/ngn-settlement.service.js';
import { listNgnWebhooks, recordNgnWebhook } from '../service/ngn-webhooks.service.js';

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
  app.post('/api/webhooks/breet', async (request) => ({ data: await recordNgnWebhook('breet', request.body, request.headers) }));

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

    const describe = (networks: readonly any[]) =>
      networks.map((network) => ({
        network,
        asset,
        // Surfaced per network because it is per ASSET, not global, and the
        // user must see it before choosing where to send from.
        minimumDepositUsd: breetMinimumDepositUsd(network, asset, 'production'),
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
  app.post('/api/admin/ngn/transfers/:id/retry', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await retryNgnTransfer(id, (request as any).adminActor?.email || 'admin_api_key') };
  });
  app.post('/api/admin/ngn/webhooks/:provider', async (request) => {
    const { provider } = request.params as { provider: 'mock' | 'linkio' | 'eversend' | 'nomba' | 'paj' };
    return { data: await recordNgnWebhook(provider, request.body, request.headers) };
  });
}
