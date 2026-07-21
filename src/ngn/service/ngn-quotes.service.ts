import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { getCustomerByUserId } from '../../customers/customers.service.js';
import { badRequest, forbidden, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { getNgnControls } from './ngn-controls.service.js';
import type { NgnQuoteInput, NgnQuoteRecord } from '../types/ngn.types.js';

export const createNgnQuoteSchema = z.object({
  userId: z.string().min(1),
  direction: z.enum(['onramp', 'offramp']),
  sourceCurrency: z.enum(['ngn', 'usdc', 'usdt']),
  destinationCurrency: z.enum(['ngn', 'usdc', 'usdt']),
  sourceAmount: z.string().min(1)
});

function validateCurrencyPair(input: NgnQuoteInput) {
  if (input.direction === 'onramp' && (input.sourceCurrency !== 'ngn' || !['usdc', 'usdt'].includes(input.destinationCurrency))) throw badRequest('NGN on-ramp must quote NGN to USDC/USDT.');
  if (input.direction === 'offramp' && (!['usdc', 'usdt'].includes(input.sourceCurrency) || input.destinationCurrency !== 'ngn')) throw badRequest('NGN off-ramp must quote USDC/USDT to NGN.');
  const amount = Number(input.sourceAmount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Invalid source amount.');
}

export async function createNgnQuote(input: z.infer<typeof createNgnQuoteSchema>) {
  validateCurrencyPair(input);
  const controls = await getNgnControls();
  if (input.direction === 'onramp' && !controls.onrampEnabled) throw forbidden('NGN on-ramp is currently disabled.');
  if (input.direction === 'offramp' && !controls.offrampEnabled) throw forbidden('NGN off-ramp is currently disabled.');
  if (Number(input.sourceAmount) > Number(controls.maxTransactionNgn) && input.sourceCurrency === 'ngn') throw forbidden('NGN amount exceeds current transaction limit.');
  const customer = await getCustomerByUserId(input.userId);
  if (customer.kycStatus !== 'kyc_approved') throw forbidden('KYC must be approved before NGN transactions.');
  const provider = getNgnProvider(controls.activeProvider);
  const quote = await provider.createQuote({ ...input, customerId: customer.id });
  const now = nowIso();
  const record: NgnQuoteRecord = { id: id('ngnq'), userId: input.userId, customerId: customer.id, direction: input.direction, provider: quote.provider, sourceCurrency: input.sourceCurrency, destinationCurrency: input.destinationCurrency, sourceAmount: quote.sourceAmount, destinationAmount: quote.destinationAmount, rate: quote.rate, feeAmount: quote.feeAmount, status: 'quote_created', providerQuoteId: quote.providerQuoteId, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), metadata: quote.metadata, createdAt: now, updatedAt: now };
  await db.upsertNgnQuoteRecord(record);
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'ngn.quote_created', resourceType: 'payments_ngn_quote', resourceId: record.id, metadata: { direction: record.direction, provider: record.provider } });
  return record;
}

export async function getNgnQuote(quoteId: string) {
  const quote = (await db.listNgnQuotes()).find((item) => item.id === quoteId);
  if (!quote) throw notFound('NGN quote');
  return quote;
}

export async function listNgnQuotes(options: { userId?: string } = {}) {
  return (await db.listNgnQuotes()).filter((item) => !options.userId || item.userId === options.userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function markQuoteAccepted(quote: NgnQuoteRecord) {
  const now = nowIso();
  const accepted: NgnQuoteRecord = { ...quote, status: 'quote_accepted', updatedAt: now };
  await db.upsertNgnQuoteRecord(accepted);
  return accepted;
}
