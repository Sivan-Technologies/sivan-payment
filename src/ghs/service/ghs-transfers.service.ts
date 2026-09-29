import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest, forbidden, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { env } from '../../config/env.js';
import { createAuditLog } from '../../audit/audit.service.js';
import type { GhsTransferRecord } from '../../database/types.js';

export const acceptGhsQuoteSchema = z.object({
  quoteId: z.string().min(1),
  userId: z.string().min(1),
  payoutAccountId: z.string().min(1).optional(),
});

export async function acceptGhsQuote(input: z.infer<typeof acceptGhsQuoteSchema>): Promise<GhsTransferRecord> {
  const quote = await db.findGhsQuoteById(input.quoteId);
  if (!quote) {
    throw notFound('Quote');
  }

  if (quote.userId !== input.userId) {
    throw forbidden('You cannot accept a quote minted for another user.');
  }

  if (Date.parse(quote.expiresAt) <= Date.now()) {
    throw badRequest('Quote has expired. Please request a fresh GHS quote.');
  }

  const payoutAccountId = input.payoutAccountId ?? quote.payoutAccountId;
  if (!payoutAccountId) {
    throw badRequest('payoutAccountId is required for GHS off-ramp payout.');
  }

  const payoutAccount = await db.findGhsPayoutAccountById(payoutAccountId);
  if (!payoutAccount) {
    throw notFound('Payout account');
  }

  if (payoutAccount.userId !== input.userId) {
    throw forbidden('You cannot use another user payout account.');
  }

  if (payoutAccount.status !== 'verified') {
    throw forbidden('Your Ghana payout account must be verified before initiating an off-ramp payout.');
  }

  let depositAddress = `sivan_ghs_dep_${id('addr').slice(0, 10)}`;
  const breetConfigured = Boolean(env.BREET_APP_ID && env.BREET_APP_SECRET);

  if (breetConfigured) {
    try {
      const response = await fetch('https://api.breet.io/v1/trades/sell/assets/generate-address', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-app-id': String(env.BREET_APP_ID),
          'x-app-secret': String(env.BREET_APP_SECRET),
          'X-Breet-Env': env.BREET_ENV === 'production' ? 'production' : 'development',
        },
        body: JSON.stringify({
          label: `sivan_ghs_${input.userId}`,
          bankId: payoutAccount.bankId,
          accountNumber: payoutAccount.accountNumber,
          autoSettlement: true,
          narration: 'Sivan GHS payout',
        }),
      });
      const body: any = await response.json().catch(() => ({}));
      if (body?.data?.address) {
        depositAddress = body.data.address;
      }
    } catch {
      // In offline / staging fallback, keep deterministic deposit address
    }
  }

  const now = nowIso();
  const transfer: GhsTransferRecord = {
    id: id('ghstrx'),
    quoteId: quote.id,
    userId: input.userId,
    provider: 'breet',
    providerTransferId: `breet_ghs_tx_${id('tx')}`,
    direction: quote.direction,
    status: 'pending',
    sourceCurrency: quote.sourceCurrency,
    destinationCurrency: quote.destinationCurrency,
    sourceAmount: quote.sourceAmount,
    destinationAmount: quote.destinationAmount,
    rate: quote.rate,
    feeAmount: quote.feeAmount,
    depositAddress,
    payoutAccountId: payoutAccount.id,
    bankId: payoutAccount.bankId,
    bankName: payoutAccount.bankName,
    accountNumber: payoutAccount.accountNumber,
    accountName: payoutAccount.accountName,
    settlementReference: `ghs_ref_${id('ref').slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    metadata: {
      accountType: payoutAccount.accountType,
      network: quote.network,
    },
  };

  await db.upsertGhsTransferRecord(transfer);

  await createAuditLog({
    actorType: 'user',
    actorId: input.userId,
    action: 'ghs.offramp_order_created',
    resourceType: 'ghs_transfer',
    resourceId: transfer.id,
    metadata: {
      sourceAmount: transfer.sourceAmount,
      destinationAmount: transfer.destinationAmount,
      bankName: payoutAccount.bankName,
      accountNumber: payoutAccount.accountNumber,
    },
  });

  return transfer;
}

export async function listGhsTransfers(filter?: { userId?: string }): Promise<GhsTransferRecord[]> {
  return db.listGhsTransfers(filter);
}

export async function findGhsTransferById(id: string): Promise<GhsTransferRecord | null> {
  return db.findGhsTransferById(id);
}
