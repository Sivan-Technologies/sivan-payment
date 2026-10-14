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
  detectTelcoOperator,
  normalizeDomesticPhone,
  DISCO_DISPLAY_NAMES,
} from '../types/paystackUtilityTypes.js';
import {
  getUtilityProvider,
  registerUtilityProvider,
  listUtilityProviders,
  getActiveUtilityProviderName,
} from '../provider/utility-registry.js';
import type { IUtilityProvider } from '../provider/utility-provider.interface.js';
import type { VirtualAccountTransactionRecord } from '../../virtual-accounts/types/virtual-account.types.js';

export {
  getUtilityProvider,
  registerUtilityProvider,
  listUtilityProviders,
  getActiveUtilityProviderName,
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

/**
 * Calculates current spendable NGN balance for a user from their virtual account ledger.
 */
export async function getUserNgnBalance(userId: string): Promise<number> {
  const allTx = await db.listVirtualAccountTransactions();
  const userTxs = allTx.filter((tx) => tx.userId === userId && tx.status === 'completed');

  let balance = 0;
  for (const tx of userTxs) {
    const amount = Number(tx.destinationAmount || 0);
    // Inflows are positive, debits (utility purchases) are recorded as negative destinationAmount
    balance += amount;
  }
  return Math.max(0, Math.round(balance * 100) / 100);
}

/**
 * Records an atomic debit transaction on the user's ledger.
 */
async function recordUtilityDebit(input: {
  userId: string;
  providerName: string;
  serviceType: string;
  reference: string;
  amountNgn: number;
  rawPayload: unknown;
}): Promise<void> {
  const now = new Date().toISOString();
  const txRecord: VirtualAccountTransactionRecord = {
    id: `vatx_debit_${crypto.createHash('sha256').update(input.reference).digest('hex').slice(0, 24)}`,
    provider: 'paystack',
    depositId: input.reference,
    userId: input.userId,
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
  await db.upsertVirtualAccountTransactionRecord(txRecord);
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
  const balance = await getUserNgnBalance(req.userId);
  if (balance < req.amountNgn) {
    throw badRequest(
      `Insufficient balance (${balance.toLocaleString()} NGN). You need ${req.amountNgn.toLocaleString()} NGN for this purchase. Please deposit NGN into your Sivan account.`
    );
  }

  // 2. Resolve active utility provider via registry
  const provider = getUtilityProvider(req.providerName);

  // 3. Upstream provider execution
  const result = await provider.purchaseAirtime(normalizedPhone, req.amountNgn, operator);

  // 4. Atomic ledger debit
  await recordUtilityDebit({
    userId: req.userId,
    providerName: provider.name,
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
    `Fulfillment Rail: ${provider.name.toUpperCase()}`,
    `Status: Delivered Successfully`,
    `Reference: ${result.reference}`,
    `Date: ${formatTimestamp(now)}`,
    '----------------------------------------',
  ].join('\n');

  return {
    success: true,
    serviceType: 'airtime',
    providerName: provider.name,
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

  if (req.amountNgn <= 0) {
    throw badRequest('Invalid data bundle amount.');
  }

  const balance = await getUserNgnBalance(req.userId);
  if (balance < req.amountNgn) {
    throw badRequest(
      `Insufficient balance (${balance.toLocaleString()} NGN). You need ${req.amountNgn.toLocaleString()} NGN.`
    );
  }

  const provider = getUtilityProvider(req.providerName);
  const result = await provider.purchaseDataBundle(normalizedPhone, req.planCode, req.amountNgn, operator);

  await recordUtilityDebit({
    userId: req.userId,
    providerName: provider.name,
    serviceType: 'data',
    reference: result.reference,
    amountNgn: req.amountNgn,
    rawPayload: result.rawPayload,
  });

  const now = new Date().toISOString();
  const remaining = balance - req.amountNgn;

  const formattedText = [
    'Sivan Payment Ai: Mobile Data Receipt',
    '----------------------------------------',
    `Operator: ${operator.toUpperCase()}`,
    `Plan: ${req.planCode}`,
    `Recipient: ${normalizedPhone}`,
    `Amount: ${req.amountNgn.toLocaleString()} NGN`,
    'Platform Fee: 0 NGN (Free)',
    `Total Debited: ${req.amountNgn.toLocaleString()} NGN`,
    `Remaining Balance: ${remaining.toLocaleString()} NGN`,
    `Fulfillment Rail: ${provider.name.toUpperCase()}`,
    `Status: Activated Successfully`,
    `Reference: ${result.reference}`,
    `Date: ${formatTimestamp(now)}`,
    '----------------------------------------',
  ].join('\n');

  return {
    success: true,
    serviceType: 'data',
    providerName: provider.name,
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

  const provider = getUtilityProvider(req.providerName);
  const inquiry = await provider.inquireElectricityMeter(req.meterNumber.trim(), req.disco, req.meterType);
  return {
    ...inquiry,
    discoName,
    providerName: provider.name,
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

  const balance = await getUserNgnBalance(req.userId);
  if (balance < req.amountNgn) {
    throw badRequest(
      `Insufficient balance (${balance.toLocaleString()} NGN). You need ${req.amountNgn.toLocaleString()} NGN.`
    );
  }

  const provider = getUtilityProvider(req.providerName);
  const result = await provider.payElectricityBill(
    req.meterNumber.trim(),
    req.disco,
    req.meterType,
    req.amountNgn,
    req.customerName
  );

  await recordUtilityDebit({
    userId: req.userId,
    providerName: provider.name,
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
    `Fulfillment Rail: ${provider.name.toUpperCase()}`,
    'Status: Payment Confirmed',
    `Reference: ${result.reference}`,
    `Date: ${formatTimestamp(now)}`,
    '----------------------------------------'
  );

  return {
    success: true,
    serviceType: 'electricity',
    providerName: provider.name,
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
