import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { getCustomerByUserId } from '../../customers/customers.service.js';
import { badRequest, forbidden, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { env } from '../../config/env.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { getNgnControls } from './ngn-controls.service.js';
import { decide, requiresBridgeCustomer } from '../../kyc/service/verification-policy.js';
import { getVerificationState, getCumulativeNgnVolume } from '../../kyc/service/verification-state.js';
import { VOLUME_WINDOW_DAYS } from '../../kyc/types/verification.types.js';
import type { NgnProviderName, NgnQuoteInput, NgnQuoteRecord } from '../types/ngn.types.js';

export const createNgnQuoteSchema = z.object({
  userId: z.string().min(1),
  direction: z.enum(['onramp', 'offramp']),
  sourceCurrency: z.enum(['ngn', 'usdc', 'usdt']),
  destinationCurrency: z.enum(['ngn', 'usdc', 'usdt']),
  sourceAmount: z.string().min(1)
});


/**
 * Sivan's verification decides. Providers inherit.
 *
 * This replaced a gate that required a Bridge customer with kycStatus
 * 'kyc_approved' before ANY naira transfer - including NGN 1,000 between two
 * Nigerian bank accounts that Bridge plays no part in. Bridge charges $2 per
 * KYC, so that gate spent $2 of real money to authorise transactions Bridge
 * never saw, and blocked every user who had not paid it.
 *
 * Naira never reaches Bridge, so Bridge must not gate naira. What gates it is
 * Sivan's own verification level against a cumulative volume ceiling.
 */
async function requireSivanVerified(userId: string, input: NgnQuoteInput, providerName: NgnProviderName) {
  const state = await getVerificationState(userId);
  const priorVolumeNgn = await getCumulativeNgnVolume(userId, VOLUME_WINDOW_DAYS);

  // The naira leg is what an NGN threshold measures, and which leg that is
  // depends on direction: on-ramp sends NGN, off-ramp receives it.
  //
  // Getting this wrong is not cosmetic. An off-ramp quotes USDC as its source,
  // so reading sourceAmount here would put a stablecoin figure - or worse, a
  // placeholder - against a naira ceiling, and the off-ramp limit would never
  // bind. Caught by test: a NGN 80,000 off-ramp passed a NGN 50,000 ceiling.
  //
  // The naira side of an off-ramp is not known until the provider quotes, so
  // it is estimated from the live rate first and re-checked afterwards.
  let amountNgn = 0;
  if (input.sourceCurrency === 'ngn') {
    amountNgn = Number(input.sourceAmount);
  } else {
    const preview = await getNgnProvider(providerName).createQuote({ ...input, customerId: undefined });
    amountNgn = Number(preview.destinationAmount);
  }

  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    throw forbidden('We could not price that amount. Please try again.');
  }

  const decision = decide(state, {
    flow: input.direction === 'onramp' ? 'onramp' : 'offramp',
    rail: 'ngn',
    amountNgn,
    priorVolumeNgn,
  });

  if (!decision.allowed) throw forbidden(decision.reason);
  return decision;
}

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
  await requireSivanVerified(input.userId, input, controls.activeProvider);

  // A Bridge customer is looked up only when the flow actually needs one. NGN
  // rails do not, so a user with no Bridge customer - which under this model is
  // most users - is no longer blocked, and no $2 is spent to let naira move.
  const customer = requiresBridgeCustomer('ngn')
    ? await getCustomerByUserId(input.userId)
    : await getCustomerByUserId(input.userId).catch(() => undefined);

  const provider = getNgnProvider(controls.activeProvider);
  const quote = await provider.createQuote({ ...input, customerId: customer?.id });
  const now = nowIso();
  const record: NgnQuoteRecord = { id: id('ngnq'), userId: input.userId, customerId: customer?.id, direction: input.direction, provider: quote.provider, sourceCurrency: input.sourceCurrency, destinationCurrency: input.destinationCurrency, sourceAmount: quote.sourceAmount, destinationAmount: quote.destinationAmount, rate: quote.rate, feeAmount: quote.feeAmount, status: 'quote_created', providerQuoteId: quote.providerQuoteId, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), metadata: quote.metadata, createdAt: now, updatedAt: now };
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
