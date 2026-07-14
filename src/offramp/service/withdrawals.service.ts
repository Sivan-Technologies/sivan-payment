import { z } from 'zod';
import { db } from '../../database/json-database.js';
import type { Chain, Currency } from '../../database/types.js';
import { getExternalAccount } from './external-accounts.service.js';
import { getLiquidationAddressFeePercent } from './fees.service.js';
import { getOfframpProvider, routeOfframpProvider } from '../../providers/provider-registry.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { requireCurrencyEnabled, requireSourceAssetEnabled, requireSourceNetworkEnabled } from '../../controls/payment-controls.service.js';

export const createWithdrawalSchema = z.object({
  userId: z.string().min(1),
  externalAccountId: z.string().min(1),
  sourceCurrency: z.enum(['usdc', 'usdt']).default('usdc'),
  sourceChain: z.enum(['ethereum', 'polygon', 'base', 'solana', 'arbitrum', 'optimism', 'avalanche_c_chain']).default('ethereum'),
  destinationCurrency: z.enum(['usd', 'gbp', 'eur']),
  destinationPaymentRail: z.string().optional(),
  destinationReference: z.string().optional(),
  returnAddress: z.string().optional(),
  returnInstructions: z.unknown().optional()
});

export async function createWithdrawal(input: z.infer<typeof createWithdrawalSchema>) {
  await requireCurrencyEnabled(input.destinationCurrency);
  await requireSourceAssetEnabled(input.sourceCurrency);
  await requireSourceNetworkEnabled(input.sourceChain as Chain);
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
  const customDeveloperFeePercent = getLiquidationAddressFeePercent({
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
  const result = await db.mutate((mutable) => {
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
    mutable.liquidationAddresses.push(la);

    const withdrawal = {
      id: id('wd'),
      userId: input.userId,
      customerId: customer.id,
      externalAccountId: externalAccount.id,
      liquidationAddressId: la.id,
      provider: provider.name,
      sourceCurrency: input.sourceCurrency,
      destinationCurrency: input.destinationCurrency,
      feePercent: customDeveloperFeePercent,
      status: 'pending_deposit' as const,
      destinationReference: input.destinationReference,
      createdAt: now,
      updatedAt: now
    };
    mutable.withdrawals.push(withdrawal);

    return {
      withdrawal,
      deposit: {
        address: la.address,
        memolessAddress: la.memolessAddress,
        chain: la.chain,
        currency: la.sourceCurrency
      }
    };
  });

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
      feePercent: customDeveloperFeePercent
    }
  });

  return result;
}

export async function listWithdrawals(userId: string) {
  const data = await db.read();
  return data.withdrawals.filter((w) => w.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getWithdrawal(id: string) {
  const data = await db.read();
  const record = data.withdrawals.find((w) => w.id === id);
  if (!record) throw notFound('Withdrawal');
  return record;
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
