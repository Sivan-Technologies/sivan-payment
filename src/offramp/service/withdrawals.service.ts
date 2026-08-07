import { z } from 'zod';
import { db } from '../../database/json-database.js';
import type { Chain, Currency } from '../../database/types.js';
import { getExternalAccount } from './external-accounts.service.js';
import { getLiquidationAddressFeePercent } from './fees.service.js';
import { getOfframpProvider, routeOfframpProvider } from '../../providers/provider-registry.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { requireCurrencyEnabled, requireSourceAssetEnabled, requireSourceNetworkEnabled, requireAssetSupportedOnChain } from '../../controls/payment-controls.service.js';
import { syncPaymentTransactionReferencesForResource } from '../../references/transaction-references.service.js';
import { attachWithdrawalTimeline } from '../../timeline/transaction-timeline.service.js';

export const createWithdrawalSchema = z.object({
  userId: z.string().min(1),
  externalAccountId: z.string().min(1),
  sourceCurrency: z.enum(['usdc', 'usdt']).default('usdc'),
  sourceChain: z.enum(['ethereum', 'polygon', 'base', 'solana', 'arbitrum', 'optimism', 'avalanche_c_chain']).default('ethereum'),
  destinationCurrency: z.enum(['usd', 'gbp', 'eur']),
  destinationPaymentRail: z.string().optional(),
  destinationReference: z.string().optional(),
  returnAddress: z.string().optional(),
  returnInstructions: z.unknown().optional(),
  /**
   * HOW MUCH. This endpoint had NO amount field at all.
   *
   * That is not a cosmetic omission - it is why the foreign rail could never
   * do what the naira rail does. Without an amount the server cannot know how
   * much to move, cannot check the user can afford it, and cannot measure the
   * transaction against a limit. So it did none of those things: it minted a
   * Bridge liquidation address and told the user to go send crypto to it by
   * hand, while an identical NGN withdrawal was swept automatically from the
   * same Privy wallet.
   *
   * OPTIONAL, deliberately. Omitting it preserves the original behaviour
   * exactly - an open-ended deposit address the user funds themselves, which
   * is a legitimate way to use a liquidation address and which existing
   * integrations rely on. Supplying it opts into the balance-funded path.
   */
  sourceAmount: z.coerce.number().positive().optional(),
  /**
   * Where the crypto comes from.
   *
   * 'balance'  - Sivan sends it from the user's Privy wallet (needs sourceAmount)
   * 'external' - the user sends it themselves, as before
   *
   * Defaults to 'external' when no amount is given and 'balance' when one is,
   * so neither existing callers nor the new UI has to state the obvious.
   */
  fundingSource: z.enum(['balance', 'external']).optional()
});

export async function createWithdrawal(input: z.infer<typeof createWithdrawalSchema>) {
  await requireCurrencyEnabled(input.destinationCurrency);
  await requireSourceAssetEnabled(input.sourceCurrency);
  await requireSourceNetworkEnabled(input.sourceChain as Chain);
  // Asset and network are enabled independently, so also confirm the token
  // actually exists on that chain (e.g. USDT is not available on Base).
  await requireAssetSupportedOnChain(input.sourceCurrency, input.sourceChain as Chain);
  const externalAccount = await getExternalAccount(input.externalAccountId);
  if (externalAccount.userId !== input.userId) throw notFound('External account');
  if (!['active', 'verified'].includes(externalAccount.status)) {
    throw badRequest('External account must be active or verified before withdrawal');
  }
  if (externalAccount.currency !== input.destinationCurrency) {
    throw badRequest(`External account currency ${externalAccount.currency} does not match withdrawal currency ${input.destinationCurrency}`);
  }

  const data = await db.read();
  const customer = data.customers.find((c) => c.id === externalAccount.customerId);
  if (!customer) throw notFound('Customer');
  if (customer.kycStatus !== 'kyc_approved') throw badRequest('KYC must be approved before withdrawals');

  /**
   * Which of the two things the user is asking for, decided ONCE.
   *
   * Derived rather than defaulted in the schema so the two fields cannot
   * disagree: asking to fund from balance without saying how much is a
   * contradiction, and it is refused here rather than silently downgraded to
   * a manual-send the user was not expecting.
   */
  const fundingSource = input.fundingSource ?? (input.sourceAmount ? 'balance' : 'external');
  if (fundingSource === 'balance' && !input.sourceAmount) {
    throw badRequest('Enter the amount you want to withdraw from your Sivan balance.');
  }

  /**
   * THE FOREIGN RAIL WAS NOT MEASURED AGAINST ANY LIMIT.
   *
   * `offramp/foreign` is a real allowance - it appears in every
   * verification-summary response with its own ceiling - and nothing on this
   * path ever consulted it. A Level 1 user capped at NGN 100,000 could
   * withdraw unlimited USD through Bridge, because the only limit check in the
   * codebase lived in the NGN quote/accept path.
   *
   * Only enforced when we know the amount. A manual-send withdrawal genuinely
   * has no amount to measure at creation time - the user decides it later by
   * how much they send - so there is nothing to check and pretending otherwise
   * would mean inventing a number.
   */
  if (input.sourceAmount) {
    await assertForeignWithdrawalWithinLimit(input.userId, input.sourceAmount);
  }

  const destinationPaymentRail = input.destinationPaymentRail ?? defaultRail(input.destinationCurrency);
  const routingDecision = routeOfframpProvider({
    preferredProvider: externalAccount.provider || customer.provider,
    sourceCurrency: input.sourceCurrency,
    sourceChain: input.sourceChain as Chain,
    destinationCurrency: input.destinationCurrency as Currency,
    destinationPaymentRail,
    complianceModel: 'first_party_withdrawal'
  });
  const provider = getOfframpProvider(routingDecision.providerName);
  const customDeveloperFeePercent = await getLiquidationAddressFeePercent({
    destinationCurrency: input.destinationCurrency as Currency,
    destinationPaymentRail
  });

  const providerAddress = await provider.createLiquidationAddress({ 
    customerId: customer.providerCustomerId,
    sourceCurrency: input.sourceCurrency,
    sourceChain: input.sourceChain as Chain,
    externalAccountId: externalAccount.providerExternalAccountId,
    destinationCurrency: input.destinationCurrency as Currency,
    destinationPaymentRail,
    destinationReference: input.destinationReference,
    returnAddress: input.returnAddress,
    returnInstructions: input.returnInstructions,
    customDeveloperFeePercent,
    idempotencyKey: idempotencyKey('la')
  });

  const now = nowIso();
  const la = {
    id: id('la'),
    userId: input.userId,
    customerId: customer.id,
    externalAccountId: externalAccount.id,
    provider: provider.name,
    providerLiquidationAddressId: providerAddress.id,
    address: providerAddress.address,
    memolessAddress: providerAddress.memolessAddress,
    chain: providerAddress.chain,
    sourceCurrency: providerAddress.currency,
    destinationCurrency: providerAddress.destinationCurrency,
    destinationPaymentRail: providerAddress.destinationPaymentRail,
    returnAddress: input.returnAddress,
    returnInstructions: input.returnInstructions,
    customDeveloperFeePercent,
    status: providerAddress.state === 'active' ? 'active' as const : 'created' as const,
    raw: providerAddress.raw,
    createdAt: now,
    updatedAt: now
  };

  const withdrawal = {
    id: id('wd'),
    userId: input.userId,
    customerId: customer.id,
    externalAccountId: externalAccount.id,
    liquidationAddressId: la.id,
    provider: provider.name,
    sourceCurrency: input.sourceCurrency,
    destinationCurrency: input.destinationCurrency,
    sourceAmount: input.sourceAmount === undefined ? undefined : String(input.sourceAmount),
    feePercent: customDeveloperFeePercent,
    status: 'pending_deposit' as const,
    destinationReference: input.destinationReference,
    createdAt: now,
    updatedAt: now
  };

  await db.createWithdrawalRecords(la, withdrawal);
  await syncPaymentTransactionReferencesForResource('withdrawal', withdrawal);
  const timelineData = await db.read();
  const result = {
    withdrawal: attachWithdrawalTimeline(withdrawal, timelineData),
    deposit: {
      address: la.address,
      memolessAddress: la.memolessAddress,
      chain: la.chain,
      currency: la.sourceCurrency
    }
  };

  await createAuditLog({
    actorType: 'user',
    actorId: input.userId,
    action: 'withdrawal.created',
    resourceType: 'payments_withdrawal',
    resourceId: result.withdrawal.id,
    metadata: {
      provider: provider.name,
      destinationCurrency: input.destinationCurrency,
      sourceChain: input.sourceChain,
      feePercent: customDeveloperFeePercent,
      fundingSource,
      sourceAmount: input.sourceAmount
    }
  });

  /**
   * SEND THE CRYPTO, INSTEAD OF ASKING THE USER TO.
   *
   * Identical in shape to the NGN rail's scheduleSweep, and deliberately so -
   * the naira path already proved this design in production and the two should
   * not diverge. See sweepWithdrawalToLiquidationAddress for why it is
   * detached from the response.
   */
  if (fundingSource === 'balance' && input.sourceAmount) {
    scheduleWithdrawalSweep(withdrawal.id, {
      userId: input.userId,
      network: input.sourceChain,
      asset: input.sourceCurrency,
      amount: input.sourceAmount,
      toAddress: la.address
    });
  }

  return { ...result, fundingSource };
}

/**
 * Re-check the foreign-rail ceiling for a Bridge withdrawal.
 *
 * The policy engine speaks NGN for every rail - that is what makes one ceiling
 * comparable across naira and dollars - so the USD amount is converted before
 * it is measured. The rate comes from the NGN quote engine rather than a
 * constant here, so the limit and the price a user is quoted cannot drift
 * apart.
 */
async function assertForeignWithdrawalWithinLimit(userId: string, amountUsd: number): Promise<void> {
  const [{ getVerificationState }, { decide }, { listVerificationLimitOverrides }, { userLimitOverrideFor }, { effectiveUsedNgn }, { usdToNgn }] =
    await Promise.all([
      import('../../kyc/service/verification-state.js'),
      import('../../kyc/service/verification-policy.js'),
      import('../../kyc/service/verification-limits.service.js'),
      import('../../kyc/service/user-limits.service.js'),
      import('../../kyc/service/user-limit-usage.js'),
      import('../../kyc/service/foreign-rail-fx.js'),
    ]);

  const amountNgn = usdToNgn(amountUsd);
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) return;

  const [state, tierOverrides, userOverride, priorVolumeNgn] = await Promise.all([
    getVerificationState(userId),
    listVerificationLimitOverrides(),
    userLimitOverrideFor(userId, 'offramp', 'foreign'),
    effectiveUsedNgn(userId, 'offramp', 'foreign'),
  ]);

  const decision = decide(
    state,
    { flow: 'offramp', rail: 'foreign', amountNgn, priorVolumeNgn },
    tierOverrides,
    userOverride
  );

  if (!decision.allowed) {
    const { forbidden } = await import('../../shared/errors.js');
    throw forbidden(decision.reason);
  }
}

/**
 * Run the sweep after the response has been sent.
 *
 * Detached for exactly the reason the NGN sweep is: awaiting an on-chain
 * transfer inside an HTTP request put a blockchain on the critical path and
 * blew the Cloudflare worker's 12s UPSTREAM_TIMEOUT_MS, showing users a 503
 * for a withdrawal that had in fact been created. The withdrawal and its
 * deposit address are already durable by the time this runs; if the sweep is
 * lost to a restart the address is still valid and the funds can still be sent
 * manually.
 */
function scheduleWithdrawalSweep(
  withdrawalId: string,
  params: { userId: string; network: string; asset: string; amount: number; toAddress: string }
): void {
  setImmediate(() => {
    void (async () => {
      try {
        await sweepWithdrawalToLiquidationAddress(withdrawalId, params);
      } catch (error) {
        await createAuditLog({
          actorType: 'system', actorId: 'withdrawal_sweep', action: 'withdrawal.sweep_failed',
          resourceType: 'payments_withdrawal', resourceId: withdrawalId, severity: 'error',
          metadata: { toAddress: params.toAddress, reason: error instanceof Error ? error.message : String(error) },
        }).catch(() => { /* never rethrow from a detached task - an unhandled rejection kills the process */ });
      }
    })();
  });
}

async function sweepWithdrawalToLiquidationAddress(
  withdrawalId: string,
  params: { userId: string; network: string; asset: string; amount: number; toAddress: string }
): Promise<void> {
  const { getSpendable } = await import('../../balances/unified-balance.service.js');
  const { getWalletProvider } = await import('../../wallets/provider/provider-registry.js');
  const { resolveActiveWalletProvider } = await import('../../wallets/wallet-controls.service.js');

  const skip = async (reason: string, detail: Record<string, unknown> = {}) => {
    await createAuditLog({
      actorType: 'system', actorId: 'withdrawal_sweep', action: 'withdrawal.sweep_skipped',
      resourceType: 'payments_withdrawal', resourceId: withdrawalId, severity: 'info',
      metadata: { reason, toAddress: params.toAddress, ...detail },
    });
  };

  // Same wallet-selection rule as the NGN sweep: BY FAMILY, not by exact chain
  // string. Every wallet in this deployment is filed as chain:'base', so an
  // exact match on 'ethereum' finds nothing and the sweep silently does not
  // happen - the precise bug that caused the orders_awaiting_deposit pile-up.
  const wallet = await db.findUserWalletForNetwork(params.userId, params.network);
  if (!wallet) return skip('no_wallet_for_network', { network: params.network });

  // Never sign a transfer larger than the wallet holds: it reverts on chain
  // AFTER the user has been told their withdrawal is under way. A null
  // spendable means the balance could not be READ, which is not zero.
  const spendable = await getSpendable(params.userId, params.asset);
  if (spendable === null || spendable < params.amount) {
    return skip('insufficient_spendable', {
      asset: params.asset,
      network: params.network,
      requiredAmount: params.amount,
      spendable,
      shortfall: spendable === null ? null : Math.max(0, params.amount - spendable),
      balanceUnreadable: spendable === null,
    });
  }

  const provider = getWalletProvider(await resolveActiveWalletProvider());
  const result = await provider.createTransfer({
    providerWalletId: wallet.providerWalletId,
    providerCustomerId: wallet.customerId,
    asset: params.asset as any,
    chain: params.network as any,
    amount: String(params.amount),
    toAddress: params.toAddress,
    // Keyed on the withdrawal, so a retry cannot sweep twice.
    idempotencyKey: `wdsweep_${withdrawalId}`,
    reference: withdrawalId,
  });

  const current = (await db.read()).withdrawals.find((w) => w.id === withdrawalId);
  if (current) {
    await db.updateWithdrawalRecord({
      ...current,
      status: 'deposit_received',
      depositTxHash: result.txHash ?? current.depositTxHash,
      updatedAt: nowIso(),
    });
  }

  await createAuditLog({
    actorType: 'system', actorId: 'withdrawal_sweep', action: 'withdrawal.sweep_submitted',
    resourceType: 'payments_withdrawal', resourceId: withdrawalId, severity: 'info',
    metadata: {
      toAddress: params.toAddress, amount: params.amount, asset: params.asset, network: params.network,
      providerTransferId: result.providerTransferId, txHash: result.txHash, sponsored: result.sponsored,
    },
  });
}

export async function listWithdrawals(userId: string) {
  const data = await db.read();
  return data.withdrawals
    .filter((w) => w.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((withdrawal) => attachWithdrawalTimeline(withdrawal, data));
}

export async function getWithdrawal(id: string) {
  const data = await db.read();
  const record = data.withdrawals.find((w) => w.id === id);
  if (!record) throw notFound('Withdrawal');
  return attachWithdrawalTimeline(record, data);
}

export async function getWithdrawalDeposit(id: string) {
  const data = await db.read();
  const withdrawal = data.withdrawals.find((w) => w.id === id);
  if (!withdrawal) throw notFound('Withdrawal');
  const la = data.liquidationAddresses.find((item) => item.id === withdrawal.liquidationAddressId);
  if (!la) throw notFound('Deposit address');
  return { address: la.address, memolessAddress: la.memolessAddress, chain: la.chain, currency: la.sourceCurrency, status: la.status };
}

export async function syncWithdrawalDrains(withdrawalId: string) {
  const data = await db.read();
  const withdrawal = data.withdrawals.find((w) => w.id === withdrawalId);
  if (!withdrawal) throw notFound('Withdrawal');
  const la = data.liquidationAddresses.find((item) => item.id === withdrawal.liquidationAddressId);
  const customer = data.customers.find((c) => c.id === withdrawal.customerId);
  if (!la || !customer) throw notFound('Liquidation address or customer');
  const provider = getOfframpProvider(withdrawal.provider);
  const drains = await provider.getLiquidationAddressDrains(customer.providerCustomerId, la.providerLiquidationAddressId);
  return { withdrawal, drains };
}

function defaultRail(currency: Currency): string {
  if (currency === 'gbp') return 'faster_payments';
  if (currency === 'eur') return 'sepa';
  return 'ach';
}
