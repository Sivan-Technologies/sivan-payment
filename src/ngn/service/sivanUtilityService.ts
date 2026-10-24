/**
 * SIVAN UTILITY SERVICE (MULTI-PROVIDER ORCHESTRATOR)
 *
 * Coordinates daily digital service fulfillment across pluggable providers:
 * - Telco Airtime Top-Up (MTN, Airtel, Glo, 9mobile)
 * - Mobile Data Bundles
 * - Electricity DisCo Inquiry & Token Generation (IKEDC, EKEDC, AEDC, etc.)
 * - Atomic Debit & Human-Readable Receipt Formatting for WhatsApp & Telegram
 *
 * Pluggable transport: not hardcoded to any single aggregator.
 * Routes dynamically through UtilityProviderRegistry.
 */

import crypto from 'node:crypto';
import { db } from '../../database/json-database.js';
import { badRequest } from '../../shared/errors.js';
import { getUnifiedBalance } from '../../balances/unified-balance.service.js';
import { createBalanceLedgerEntry } from '../../balances/balance.service.js';
import {
  type TelcoOperator,
  type DiscoCode,
  type MeterType,
  type AirtimePurchaseRequest,
  type DataBundlePurchaseRequest,
  type ElectricityInquiryRequest,
  type ElectricityInquiryResponse,
  type ElectricityPaymentRequest,
  type UtilityReceipt,
  type DataPlanOption,
  detectTelcoOperator,
  normalizeDomesticPhone,
  DISCO_DISPLAY_NAMES,
} from '../types/paystackUtilityTypes.js';
import {
  getUtilityProvider,
  registerUtilityProvider,
  listUtilityProviders,
  getActiveUtilityProviderName,
  executeUtilityWithFailover,
  getUtilityProviderChain,
  executeForService,
  getProviderChainForService,
} from '../provider/utility-registry.js';
import type { IUtilityProvider } from '../provider/utility-provider.interface.js';
import { ensureUtilityRoutingLoaded } from './utility-routing.service.js';

/**
 * One key per purchase, reused for every attempt in a failover chain.
 *
 * Without it a provider that vended successfully but answered too slowly gets
 * retried on the next provider and the customer receives the value twice
 * while being debited once.
 */
function newIdempotencyKey(service: string, userId: string): string {
  return `sivan_${service}_${crypto.randomUUID()}_${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 8)}`;
}
import type { VirtualAccountTransactionRecord } from '../../virtual-accounts/types/virtual-account.types.js';
import { getUtilityDataPlanBySize, resolveProviderPlanCode } from './utility-data-plans.service.js';

export {
  getUtilityProvider,
  registerUtilityProvider,
  listUtilityProviders,
  getActiveUtilityProviderName,
  executeUtilityWithFailover,
  getUtilityProviderChain,
  IUtilityProvider,
};

const MIN_AIRTIME_NGN = 100;
const MAX_AIRTIME_NGN = 50_000;
const MIN_ELECTRICITY_NGN = 1_000;
const MAX_ELECTRICITY_NGN = 100_000;

function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
}

async function resolvePaymentUserId(target: string): Promise<string> {
  if (!target) return target;
  const rawClean = target.trim().replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
  const withPlus = `+${rawClean}`;
  const withWhatsapp = `whatsapp:+${rawClean}`;

  const directUser = await db.findUserById(target).catch(() => null);
  if (directUser) return directUser.id;

  const phoneVariants: string[] = [withPlus, withWhatsapp, rawClean];
  if (rawClean.startsWith('234') && rawClean.length === 13) {
    const local0 = `0${rawClean.slice(3)}`;
    phoneVariants.push(local0, `whatsapp:${local0}`);
  } else if (rawClean.startsWith('0') && rawClean.length === 11) {
    const intl = `234${rawClean.slice(1)}`;
    phoneVariants.push(`+${intl}`, intl, `whatsapp:+${intl}`);
  }

  for (const variant of phoneVariants) {
    const user = await db.findUserByWhatsappNumber(variant).catch(() => null);
    if (user) return user.id;
  }

  if (target.includes('@')) {
    const userByEmail = await db.findUserByEmail(target.trim().toLowerCase()).catch(() => null);
    if (userByEmail) return userByEmail.id;
  }

  if (rawClean) {
    const userByTg = await db.findUserByTelegramUserId(rawClean).catch(() => null);
    if (userByTg) return userByTg.id;
  }

  const userByTarget = await db.findUserByTarget(target).catch(() => null);
  if (userByTarget) return userByTarget.id;

  const identityLinks = await db.listCustomerIdentityLinks().catch(() => []);
  const link = identityLinks.find(
    (l) => l.status === 'linked' && (
      phoneVariants.includes(l.whatsappNumber || '') ||
      phoneVariants.includes(l.telegramUserId || '') ||
      l.telegramUserId === rawClean ||
      l.email?.toLowerCase() === target.trim().toLowerCase()
    )
  );
  if (link?.paymentUserId) return link.paymentUserId;

  return target;
}

/**
 * Calculates current spendable NGN balance for a user from their virtual account ledger.
 */
export async function getUserNgnBalance(userId: string): Promise<number> {
  const resolvedUserId = await resolvePaymentUserId(userId).catch(() => userId);
  try {
    const unified = await getUnifiedBalance(resolvedUserId);
    const ngnBal = (unified.balances as any[]).find((b) => String(b.asset).toLowerCase() === 'ngn');
    const available = Number(ngnBal?.availableBalance ?? ngnBal?.spendable ?? 0);
    if (available > 0) return available;
  } catch (_err) {
    // Fall back to virtual account transaction tally
  }

  const allTx = await db.listVirtualAccountTransactions();
  const userTxs = allTx.filter((tx) => (tx.userId === resolvedUserId || tx.userId === userId) && tx.status === 'completed');

  let balance = 0;
  for (const tx of userTxs) {
    const amount = Number(tx.destinationAmount || 0);
    balance += amount;
  }
  return Math.max(0, Math.round(balance * 100) / 100);
}

/**
 * Lists available data plans for a given telco operator through the active or preferred utility provider.
 */
export async function fetchDataPlans(
  operator: TelcoOperator,
  preferredProviderName?: string
): Promise<DataPlanOption[]> {
  await ensureUtilityRoutingLoaded();
  if (preferredProviderName) {
    const provider = getUtilityProvider(preferredProviderName);
    if (!provider.listDataPlans) {
      throw badRequest(`Provider "${preferredProviderName}" does not publish a data plan catalogue.`);
    }
    return provider.listDataPlans(operator);
  }
  const { result } = await executeForService('data', 'listDataPlans', (provider) =>
    provider.listDataPlans(operator)
  );
  return result;
}

/**
 * Records an atomic debit transaction on the user's ledger and updates balance ledger.
 */
async function recordUtilityDebit(input: {
  userId: string;
  providerName: string;
  serviceType: string;
  reference: string;
  amountNgn: number;
  rawPayload: unknown;
}): Promise<void> {
  const resolvedUserId = await resolvePaymentUserId(input.userId).catch(() => input.userId);
  const user = await db.findUserById(resolvedUserId).catch(() => null);
  const isPostgres = (process.env.DATABASE_PROVIDER || '').toLowerCase() === 'postgres';
  // In PostgreSQL, user_id must be a valid user ID (or undefined) to satisfy foreign key constraint
  const validUserId = user ? user.id : (isPostgres ? (resolvedUserId.startsWith('usr_') ? resolvedUserId : undefined) : resolvedUserId);

  let virtualAccountId: string | undefined = undefined;
  if (validUserId) {
    const vas = await db.listVirtualAccounts().catch(() => []);
    const userVa = vas.find((va) => va.userId === validUserId && va.status === 'active');
    if (userVa) {
      virtualAccountId = userVa.id;
    }
  }

  const now = new Date().toISOString();
  const txRecord: VirtualAccountTransactionRecord = {
    id: `vatx_debit_${crypto.createHash('sha256').update(input.reference).digest('hex').slice(0, 24)}`,
    provider: 'paystack',
    virtualAccountId,
    depositId: input.reference,
    userId: validUserId,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: input.amountNgn.toFixed(2),
    destinationAmount: (-input.amountNgn).toFixed(2), // Debit is recorded as negative
    paymentRail: `utility_${input.providerName}_${input.serviceType}`,
    status: 'completed',
    depositReference: input.reference,
    rawPayload: input.rawPayload,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };

  try {
    await db.upsertVirtualAccountTransactionRecord(txRecord);
  } catch (err) {
    console.warn('[sivanUtilityService] Failed to upsert virtual account transaction record:', err);
    // If it failed due to foreign key or constraint, retry with null userId/virtualAccountId so the transaction audit record is preserved
    if (txRecord.userId || txRecord.virtualAccountId) {
      txRecord.userId = undefined;
      txRecord.virtualAccountId = undefined;
      await db.upsertVirtualAccountTransactionRecord(txRecord).catch((retryErr) => {
        console.error('[sivanUtilityService] Critical: failed fallback virtual account transaction upsert:', retryErr);
      });
    }
  }

  // Record in unified balance ledger
  if (validUserId) {
    await createBalanceLedgerEntry(
      {
        userId: validUserId,
        asset: 'ngn',
        amount: input.amountNgn.toFixed(2),
        kind: 'debit_transfer',
        status: 'completed',
        sourceType: `utility_${input.serviceType}`,
        sourceId: input.reference,
        description: `Utility purchase (${input.serviceType}) via ${input.providerName.toUpperCase()}: ${input.amountNgn} NGN`,
        transferId: input.reference,
      },
      { actorType: 'user', actorId: validUserId }
    ).catch((err) => {
      console.warn('[sivanUtilityService] Failed to record ledger entry for utility purchase:', err);
    });
  }
}

/**
 * Executes airtime purchase through active utility provider with phone normalization and telco detection.
 */
export async function executeAirtimePurchase(
  req: AirtimePurchaseRequest
): Promise<UtilityReceipt> {
  const normalizedPhone = normalizeDomesticPhone(req.phone);
  const operator: TelcoOperator | undefined = req.operator || detectTelcoOperator(normalizedPhone);

  if (!operator) {
    throw badRequest(
      `Could not automatically detect the telco network for ${req.phone}. Please specify your network: MTN, Airtel, Glo, or 9mobile.`
    );
  }

  if (req.amountNgn < MIN_AIRTIME_NGN || req.amountNgn > MAX_AIRTIME_NGN) {
    throw badRequest(
      `Airtime amount must be between ${MIN_AIRTIME_NGN.toLocaleString()} NGN and ${MAX_AIRTIME_NGN.toLocaleString()} NGN.`
    );
  }

  // 1. Balance verification
  const resolvedUserId = await resolvePaymentUserId(req.userId).catch(() => req.userId);
  const balance = await getUserNgnBalance(resolvedUserId);
  if (balance < req.amountNgn) {
    throw badRequest(
      `Insufficient balance (${balance.toLocaleString()} NGN). You need ${req.amountNgn.toLocaleString()} NGN for this purchase. Please deposit NGN into your Sivan account.`
    );
  }

  // 2 & 3. Upstream fulfilment through the chain configured for airtime
  await ensureUtilityRoutingLoaded();
  const airtimeKey = newIdempotencyKey('airtime', resolvedUserId);
  const { result, providerName } = await executeForService(
    'airtime',
    'purchaseAirtime',
    (provider) => provider.purchaseAirtime(normalizedPhone, req.amountNgn, operator, airtimeKey),
    // Airtime costs us close to face value, so the amount is a fair proxy for
    // what it draws from the float.
    { costNgn: req.amountNgn }
  );

  // 4. Atomic ledger debit
  await recordUtilityDebit({
    userId: resolvedUserId,
    providerName,
    serviceType: 'airtime',
    reference: result.reference,
    amountNgn: req.amountNgn,
    rawPayload: result.rawPayload,
  });

  const now = new Date().toISOString();
  const remaining = balance - req.amountNgn;

  const formattedText = [
    'Sivan Payment Ai: Airtime Receipt',
    '----------------------------------------',
    `Operator: ${operator.toUpperCase()}`,
    `Recipient: ${normalizedPhone}`,
    `Amount: ${req.amountNgn.toLocaleString()} NGN`,
    'Platform Fee: 0 NGN (Free)',
    `Total Debited: ${req.amountNgn.toLocaleString()} NGN`,
    `Remaining Balance: ${remaining.toLocaleString()} NGN`,
    `Fulfillment Rail: ${providerName.toUpperCase()}`,
    `Status: Delivered Successfully`,
    `Reference: ${result.reference}`,
    `Date: ${formatTimestamp(now)}`,
    '----------------------------------------',
  ].join('\n');

  return {
    success: true,
    serviceType: 'airtime',
    providerName,
    operatorOrDisco: operator.toUpperCase(),
    recipientOrMeter: normalizedPhone,
    amountNgn: req.amountNgn,
    feeNgn: 0,
    totalDebitedNgn: req.amountNgn,
    reference: result.reference,
    timestamp: now,
    formattedText,
  };
}

/**
 * Executes data bundle purchase through active utility provider.
 */
export async function executeDataPurchase(
  req: DataBundlePurchaseRequest
): Promise<UtilityReceipt> {
  const normalizedPhone = normalizeDomesticPhone(req.phone);
  const operator = req.operator || detectTelcoOperator(normalizedPhone);

  if (!operator) {
    throw badRequest(`Please specify a valid telco operator: MTN, Airtel, Glo, or 9mobile.`);
  }

  // The catalogue is authoritative for price. Previously an unknown planCode
  // fell through to the client-supplied amountNgn, so a caller could pay 500
  // for a 430 bundle, or name a plan that does not exist and set its own price.
  const bundlePlan = await getUtilityDataPlanBySize(req.planCode, operator);
  if (!bundlePlan) {
    throw badRequest(
      `No data plan "${req.planCode}" is configured for ${operator.toUpperCase()}. ` +
        `An admin must add it in the admin hub before it can be sold.`
    );
  }
  const amountNgn = bundlePlan.amountNgn;

  if (amountNgn <= 0) {
    throw badRequest('Invalid data bundle amount.');
  }

  const resolvedUserId = await resolvePaymentUserId(req.userId).catch(() => req.userId);
  const balance = await getUserNgnBalance(resolvedUserId);
  if (balance < amountNgn) {
    throw badRequest(
      `Insufficient balance (${balance.toLocaleString()} NGN). You need ${amountNgn.toLocaleString()} NGN.`
    );
  }

  await ensureUtilityRoutingLoaded();
  const dataKey = newIdempotencyKey('data', resolvedUserId);
  let dispatchedPlanCode = '';
  const { result, providerName } = await executeForService('data', 'purchaseDataBundle', (provider) => {
    // Each provider has its own plan namespace, so translate before dispatch.
    // Refusing here is deliberate: sending Sivan's own code upstream is what
    // made SME API data purchases fail.
    const providerPlanCode = resolveProviderPlanCode(bundlePlan, provider.name);
    if (!providerPlanCode) {
      throw badRequest(
        `Data plan "${bundlePlan.bundleSize}" (${bundlePlan.network}) has no plan code mapped for ` +
          `provider "${provider.name}". Map it in the admin hub, or route data to a provider that has one.`
      );
    }
    dispatchedPlanCode = providerPlanCode;
    return provider.purchaseDataBundle(normalizedPhone, providerPlanCode, amountNgn, operator, dataKey);
  },
  /**
   * The float is drawn down by the WHOLESALE cost, not the retail price, so
   * the markup must not count toward affordability. When the cost has never
   * been synced it is left undefined rather than substituted: skipping a
   * provider over a number we invented is exactly what this is meant to
   * prevent.
   */
  typeof bundlePlan.costPriceNgn === 'number' ? { costNgn: bundlePlan.costPriceNgn } : {});

  await recordUtilityDebit({
    userId: resolvedUserId,
    providerName,
    serviceType: 'data',
    reference: result.reference,
    amountNgn,
    rawPayload: result.rawPayload,
  });

  const now = new Date().toISOString();
  const remaining = balance - amountNgn;

  const formattedText = [
    'Sivan Payment Ai: Mobile Data Receipt',
    '----------------------------------------',
    `Operator: ${operator.toUpperCase()}`,
    `Plan: ${bundlePlan.bundleSize} (${bundlePlan.network.toUpperCase()})`,
    `Provider Plan: ${dispatchedPlanCode}`,
    `Recipient: ${normalizedPhone}`,
    // The catalogue price, which is what the ledger is actually debited by.
    // These previously disagreed: the ledger took the catalogue price while
    // the receipt quoted whatever the caller had asked for.
    `Amount: ${amountNgn.toLocaleString()} NGN`,
    'Platform Fee: 0 NGN (Free)',
    `Total Debited: ${amountNgn.toLocaleString()} NGN`,
    `Remaining Balance: ${remaining.toLocaleString()} NGN`,
    `Fulfillment Rail: ${providerName.toUpperCase()}`,
    `Status: Activated Successfully`,
    `Reference: ${result.reference}`,
    `Date: ${formatTimestamp(now)}`,
    '----------------------------------------',
  ].join('\n');

  return {
    success: true,
    serviceType: 'data',
    providerName,
    operatorOrDisco: operator.toUpperCase(),
    recipientOrMeter: normalizedPhone,
    amountNgn,
    feeNgn: 0,
    totalDebitedNgn: amountNgn,
    reference: result.reference,
    timestamp: now,
    formattedText,
  };
}

/**
 * Pre-flight electricity meter inquiry (fetches registered customer name).
 */
export async function executeElectricityInquiry(
  req: ElectricityInquiryRequest
): Promise<ElectricityInquiryResponse> {
  if (!req.meterNumber || req.meterNumber.trim().length < 6) {
    throw badRequest('Please provide a valid electricity meter number.');
  }

  const discoName = DISCO_DISPLAY_NAMES[req.disco];
  if (!discoName) {
    throw badRequest(`Unknown electricity distribution company: ${req.disco}`);
  }

  await ensureUtilityRoutingLoaded();
  const { result: inquiry, providerName } = await executeForService(
    'electricity',
    'inquireElectricityMeter',
    (provider) => provider.inquireElectricityMeter(req.meterNumber.trim(), req.disco, req.meterType)
  );
  return {
    ...inquiry,
    discoName,
    providerName,
  };
}

/**
 * Executes electricity bill payment and returns 20-digit token for prepaid meters.
 */
export async function executeElectricityPayment(
  req: ElectricityPaymentRequest
): Promise<UtilityReceipt> {
  if (req.amountNgn < MIN_ELECTRICITY_NGN || req.amountNgn > MAX_ELECTRICITY_NGN) {
    throw badRequest(
      `Electricity payment amount must be between ${MIN_ELECTRICITY_NGN.toLocaleString()} NGN and ${MAX_ELECTRICITY_NGN.toLocaleString()} NGN.`
    );
  }

  const discoName = DISCO_DISPLAY_NAMES[req.disco] || req.disco.toUpperCase();

  const resolvedUserId = await resolvePaymentUserId(req.userId).catch(() => req.userId);
  const balance = await getUserNgnBalance(resolvedUserId);
  if (balance < req.amountNgn) {
    throw badRequest(
      `Insufficient balance (${balance.toLocaleString()} NGN). You need ${req.amountNgn.toLocaleString()} NGN.`
    );
  }

  await ensureUtilityRoutingLoaded();
  const electricityKey = newIdempotencyKey('electricity', resolvedUserId);
  const { result, providerName } = await executeForService('electricity', 'payElectricityBill', (provider) =>
    provider.payElectricityBill(
      req.meterNumber.trim(),
      req.disco,
      req.meterType,
      req.amountNgn,
      req.customerName,
      electricityKey
    )
  );

  await recordUtilityDebit({
    userId: resolvedUserId,
    providerName,
    serviceType: 'electricity',
    reference: result.reference,
    amountNgn: req.amountNgn,
    rawPayload: result.rawPayload,
  });

  const now = new Date().toISOString();
  const remaining = balance - req.amountNgn;

  const lines = [
    'Sivan Payment Ai: Electricity Receipt',
    '----------------------------------------',
    `DisCo: ${discoName}`,
    `Meter Number: ${req.meterNumber}`,
    `Meter Type: ${req.meterType === 'prepaid' ? 'Prepaid' : 'Postpaid'}`,
    `Customer Name: ${result.customerName}`,
  ];

  if (result.token) {
    lines.push(`Token: ${result.token}`);
  }
  if (result.units) {
    lines.push(`Units: ${result.units}`);
  }

  lines.push(
    `Amount Paid: ${req.amountNgn.toLocaleString()} NGN`,
    'Platform Fee: 0 NGN (Free)',
    `Total Debited: ${req.amountNgn.toLocaleString()} NGN`,
    `Remaining Balance: ${remaining.toLocaleString()} NGN`,
    `Fulfillment Rail: ${providerName.toUpperCase()}`,
    'Status: Payment Confirmed',
    `Reference: ${result.reference}`,
    `Date: ${formatTimestamp(now)}`,
    '----------------------------------------'
  );

  return {
    success: true,
    serviceType: 'electricity',
    providerName,
    operatorOrDisco: discoName,
    recipientOrMeter: req.meterNumber,
    customerName: result.customerName,
    token: result.token,
    units: result.units,
    amountNgn: req.amountNgn,
    feeNgn: 0,
    totalDebitedNgn: req.amountNgn,
    reference: result.reference,
    timestamp: now,
    formattedText: lines.join('\n'),
  };
}
