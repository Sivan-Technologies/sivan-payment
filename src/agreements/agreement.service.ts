/**
 * SERVICE AGREEMENT LIFECYCLE MANAGER
 *
 * Owns creation, state transitions, and the live countdown label computation
 * for service agreements. The sweeper (deadline-sweeper.service.ts) calls
 * listActiveAgreementsForDeadlineSweep() and claims sentinel flags through
 * markReminder6hSent() / markOverdueNoticeSent().
 *
 * STATE MACHINE:
 *   createAgreement()   → pending_payment
 *   fundAgreement()     → funded        (computes delivery_due_at)
 *   startDelivery()     → in_delivery   (optional; seller signals work started)
 *   markDelivered()     → delivered
 *   releaseAgreement()  → released
 *   cancelAgreement()   → cancelled
 */

import { db } from '../database/json-database.js';
import { id as generateId, nowIso } from '../shared/id.js';
import { parseDeliveryDeadline } from './deadline-parser.js';
import { badRequest, notFound } from '../shared/errors.js';
import { createBalanceLedgerEntry, getUserBalance } from '../balances/balance.service.js';
import { getWalletProvider } from '../wallets/provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallets/wallet-controls.service.js';
import { ensureUserWallet } from '../wallets/user-wallet.service.js';
import { quoteServiceAgreementFee, type FeePayer } from './agreement-fee-policy.js';
import { dispatchCeloSettlementTransfer } from '../wallets/celo/celo-settlement-relayer.js';
import { getIdentityStatus } from '../identity/identity.service.js';
import type { ServiceAgreementRecord, ServiceAgreementStatus, WalletChain, UserRecord, UserWalletRecord } from '../database/types.js';

// --- god-service split: public API barrel re-exports (callers unchanged) ---
export * from './agreement-escrow-sync.service.js';
import { syncEscrowAgentAcceptance, syncEscrowAgentFunding } from './agreement-escrow-sync.service.js';
export * from './agreement-notifications.service.js';
import { notifyAgreementAccepted, notifyAgreementCancellation } from './agreement-notifications.service.js';
export * from './agreement-finance.service.js';
import { getSivanServiceAgreementFeeWallet } from './agreement-finance.service.js';
export * from './agreement-identity.service.js';
import { resolveBuyerUUID, resolveTelegramIdForAgreement, resolveWhatsAppPhoneForAgreement } from './agreement-identity.service.js';

// ─── Input shapes ────────────────────────────────────────────────────────────

export interface CreateAgreementInput {
  id?: string;
  buyerUserId: string;
  sellerUserId: string;
  buyerWalletAddress?: string;
  sellerWalletAddress?: string;
  title: string;
  description: string;
  amountUsdc: number;
  currency?: string;
  network: WalletChain;
  /** Optional override: bypass NL extraction and set deadline_days directly. */
  deadlineDays?: number;
  feePayer?: FeePayer;
  channel?: string;
  fundingTxHash?: string;
  attributionTag?: string;
  feeAmountUsdc?: number;
  sellerNetAmountUsdc?: number;
}

// ─── Countdown label ─────────────────────────────────────────────────────────

/**
 * Create a new agreement record. Extracts deadline_days from the description
 * via natural language parsing unless the caller provides an explicit override.
 * Dynamically prices and attaches the Sivan Service Agreement Fee.
 */
export async function createAgreement(
  input: CreateAgreementInput
): Promise<ServiceAgreementRecord> {
  if (!input.buyerUserId) throw badRequest('buyerUserId is required');
  if (!input.sellerUserId) throw badRequest('sellerUserId is required');
  if (!input.title) throw badRequest('title is required');
  if (!input.amountUsdc || input.amountUsdc <= 0) throw badRequest('amountUsdc must be positive');
  if (!input.network) throw badRequest('network is required');

  // Enforce Sivan Identity & Integrity Protocol: No generic/placeholder buyer or seller IDs
  const DISALLOWED_IDENTIFIERS = [
    'minipay_buyer',
    'test_user',
    'anonymous',
    'buyer',
    'seller',
    'user',
    'undefined',
    'null',
  ];
  const cleanBuyer = String(input.buyerUserId || '').trim().toLowerCase();
  const cleanSeller = String(input.sellerUserId || '').trim().toLowerCase();

  if (DISALLOWED_IDENTIFIERS.includes(cleanBuyer)) {
    throw badRequest(`Invalid buyerUserId: generic placeholder identifiers ('${input.buyerUserId}') are prohibited.`);
  }
  if (DISALLOWED_IDENTIFIERS.includes(cleanSeller)) {
    throw badRequest(`Invalid sellerUserId: generic placeholder identifiers ('${input.sellerUserId}') are prohibited.`);
  }
  if (cleanBuyer === cleanSeller) {
    throw badRequest('Invalid agreement: buyer and seller cannot be the same user identity.');
  }
  if (
    input.buyerWalletAddress &&
    input.sellerWalletAddress &&
    input.buyerWalletAddress.trim().toLowerCase() === input.sellerWalletAddress.trim().toLowerCase()
  ) {
    throw badRequest('Invalid agreement: buyer wallet address cannot equal seller wallet address.');
  }

  // Pre-resolve buyer identity to actual DB user ID when available
  const resolvedBuyerUUID = await resolveBuyerUUID(input.buyerUserId);
  const effectiveBuyerUserId = resolvedBuyerUUID || input.buyerUserId;

  const parseResult = parseDeliveryDeadline(input.description || '');
  const deadlineDays = input.deadlineDays ?? parseResult.deadlineDays;

  const feePayer: FeePayer = input.feePayer || (input.channel === 'minipay' ? 'seller' : 'buyer');
  const feeQuote = quoteServiceAgreementFee(input.amountUsdc, input.network, feePayer);

  const feeAmount = typeof input.feeAmountUsdc === 'number' && input.feeAmountUsdc >= 0
    ? input.feeAmountUsdc
    : feeQuote.feeAmount;

  const sellerNetAmount = typeof input.sellerNetAmountUsdc === 'number' && input.sellerNetAmountUsdc > 0
    ? input.sellerNetAmountUsdc
    : (feePayer === 'seller' ? Math.max(0, parseFloat((input.amountUsdc - feeAmount).toFixed(6))) : feeQuote.sellerNetAmount);

  const buyerTotalPayable = feePayer === 'seller' ? input.amountUsdc : feeQuote.buyerTotalPayable;

  const now = nowIso();
  const isPreFunded = Boolean(input.fundingTxHash);
  const dueAt = isPreFunded && deadlineDays
    ? new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  if (input.id) {
    const existing = await db.findServiceAgreementById(input.id);
    if (existing) {
      let shouldSave = false;
      if (input.fundingTxHash && (existing.status === 'pending_payment' || (existing.status as any) === 'pending_funding')) {
        existing.status = 'funded';
        existing.fundingTxHash = input.fundingTxHash;
        existing.fundedAt = now;
        existing.deliveryDueAt = dueAt || new Date(Date.now() + (existing.deadlineDays || 1) * 24 * 60 * 60 * 1000).toISOString();
        existing.updatedAt = now;
        shouldSave = true;
      }
      if (typeof input.feeAmountUsdc === 'number' && existing.feeAmountUsdc !== input.feeAmountUsdc) {
        existing.feeAmountUsdc = input.feeAmountUsdc;
        shouldSave = true;
      }
      if (typeof input.sellerNetAmountUsdc === 'number' && existing.sellerNetAmountUsdc !== input.sellerNetAmountUsdc) {
        existing.sellerNetAmountUsdc = input.sellerNetAmountUsdc;
        shouldSave = true;
      }
      if (input.feePayer && existing.feePayer !== input.feePayer) {
        existing.feePayer = input.feePayer;
        shouldSave = true;
      }
      if (shouldSave) {
        await db.updateServiceAgreement(existing);
      }
      return existing;
    }
  }

  const agreement: ServiceAgreementRecord = {
    id: input.id || generateId('agr'),
    buyerUserId: effectiveBuyerUserId,
    sellerUserId: input.sellerUserId,
    title: input.title,
    description: input.description || '',
    amountUsdc: input.amountUsdc,
    currency: input.currency || 'usdc',
    network: input.network,
    status: isPreFunded ? 'funded' : 'pending_seller_acceptance',
    deadlineDays,
    deliveryDueAt: dueAt,
    reminder6hSent: false,
    overdueNoticeSent: false,
    fundedAt: isPreFunded ? now : null,
    deliveredAt: null,
    releasedAt: null,
    sellerAcceptedAt: isPreFunded ? now : null,
    sellerDeclinedAt: null,
    sellerDeclineReason: null,
    acceptanceExpiresAt: isPreFunded ? null : new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    fundingTxHash: input.fundingTxHash || null,
    releaseTxHash: null,
    vaultAddress: null,
    channel: input.channel || 'web',
    feeAmountUsdc: feeAmount,
    feePercent: feeQuote.feePercent,
    feePayer,
    buyerTotalPayableUsdc: buyerTotalPayable,
    sellerNetAmountUsdc: sellerNetAmount,
    feeTxHash: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insertServiceAgreement(agreement);
  return agreement;
}

/**
 * Verifies whether a caller (by user ID, email, handle, telegram username, or phone)
 * is authorized to act as the seller/contractor on an agreement.
 * Supports cross-channel identity aliases (with or without @ prefix, email local part, etc.).
 */
async function checkSellerAuthorization(existingSellerId?: string, callerSellerId?: string): Promise<boolean> {
  if (!callerSellerId) return true;
  const cleanCaller = String(callerSellerId || '').trim().toLowerCase();
  const existingSeller = String(existingSellerId || '').trim().toLowerCase();
  if (!existingSeller || cleanCaller === existingSeller) return true;

  const cleanExisting = existingSeller.replace(/^@/, '');
  const cleanCallerNoAt = cleanCaller.replace(/^@/, '');
  if (cleanCallerNoAt === cleanExisting) return true;

  // Try finding user by caller ID or email or username
  const user = (await db.findUserById(cleanCaller)) || (await db.findUserByEmail(cleanCaller));
  if (!user) return false;

  const userEmail = (user.email || '').toLowerCase().trim();
  const emailHandle = userEmail ? userEmail.split('@')[0] : '';
  const userTg = (user.telegramUsername || '').toLowerCase().trim().replace(/^@/, '');
  const userWa = (user.whatsappNumber || '').replace(/\D/g, '');
  const existingDigits = existingSeller.replace(/\D/g, '');

  if (cleanExisting === user.id.toLowerCase()) return true;
  if (cleanExisting === userEmail) return true;
  if (cleanExisting === emailHandle) return true;
  if (userTg && cleanExisting === userTg) return true;
  if (user.username && cleanExisting === user.username.toLowerCase().replace(/^@/, '')) return true;
  if ((user as any).walletAddress && cleanExisting === (user as any).walletAddress.toLowerCase()) return true;
  if (existingDigits && userWa && (existingDigits === userWa || userWa.endsWith(existingDigits) || existingDigits.endsWith(userWa))) return true;

  // Check identity link status if available
  try {
    const status = await getIdentityStatus(user.id);
    const linkedTg = status?.channels?.telegram?.link?.telegramUsername?.toLowerCase().replace(/^@/, '');
    const linkedWa = (status?.link?.whatsappNumber || status?.channels?.whatsapp?.link?.whatsappNumber || '').replace(/\D/g, '');
    if (linkedTg && cleanExisting === linkedTg) return true;
    if (linkedWa && existingDigits && (existingDigits === linkedWa || linkedWa.endsWith(existingDigits))) return true;
  } catch {}

  return false;
}

/**
 * Seller accepts the service agreement.
 * Transitions status from pending_seller_acceptance to pending_payment.
 * Buyer can now fund the agreement.
 */
export async function acceptAgreement(
  agreementId: string,
  sellerUserId?: string
): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);

  if (existing.status !== 'pending_seller_acceptance') {
    throw badRequest(`Agreement ${agreementId} cannot be accepted from status ${existing.status}`);
  }

  if (sellerUserId) {
    const authorized = await checkSellerAuthorization(existing.sellerUserId, sellerUserId);
    if (!authorized) {
      throw badRequest(`User ${sellerUserId} is not authorized to accept this agreement`);
    }
  }

  const now = nowIso();
  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'pending_payment',
    sellerAcceptedAt: now,
    updatedAt: now,
  };

  await db.updateServiceAgreement(updated);

  // Fire real-time notification to buyer on Telegram / WhatsApp that deal is accepted and ready to fund
  void notifyAgreementAccepted(updated);

  // Sync acceptance to external escrow agent so external channels stay in sync
  void syncEscrowAgentAcceptance(updated, sellerUserId);

  return updated;
}

/**
 * Seller declines the service agreement.
 * Transitions status from pending_seller_acceptance to declined.
 * An optional reason can be provided.
 */
export async function declineAgreement(
  agreementId: string,
  options?: { sellerUserId?: string; reason?: string }
): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);

  if (existing.status !== 'pending_seller_acceptance') {
    throw badRequest(`Agreement ${agreementId} cannot be declined from status ${existing.status}`);
  }

  if (options?.sellerUserId) {
    const authorized = await checkSellerAuthorization(existing.sellerUserId, options.sellerUserId);
    if (!authorized) {
      throw badRequest(`User ${options.sellerUserId} is not authorized to decline this agreement`);
    }
  }

  const now = nowIso();
  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'declined',
    sellerDeclinedAt: now,
    sellerDeclineReason: options?.reason?.trim() || null,
    updatedAt: now,
  };

  await db.updateServiceAgreement(updated);

  // Fire real-time cancellation push to buyer (counterparty) and seller (actor)
  void notifyAgreementCancellation(
    updated,
    'seller',
    'declined',
    options?.reason
  );

  return updated;
}

/**
 * Mark an agreement as funded and compute the delivery due timestamp.
 * Executes on-chain transfer to vault including the Sivan service agreement fee.
 * delivery_due_at = now + deadlineDays calendar days.
 */
export async function fundAgreement(agreementId: string, externalTxHash?: string): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);

  if (existing.status === 'funded') {
    if (externalTxHash && !existing.fundingTxHash) {
      existing.fundingTxHash = externalTxHash;
      await db.updateServiceAgreement(existing);
    }
    return existing;
  }

  if (existing.status === 'pending_seller_acceptance') {
    throw badRequest(`Agreement ${agreementId} is awaiting seller acceptance before funding`);
  }

  if (existing.status !== 'pending_payment' && (existing.status as any) !== 'pending_funding') {
    throw badRequest(`Agreement ${agreementId} is already ${existing.status}; cannot fund`);
  }

  const now = new Date();
  const dueAt = new Date(now.getTime() + existing.deadlineDays * 24 * 60 * 60 * 1000);

  const feeQuote = quoteServiceAgreementFee(
    existing.amountUsdc,
    existing.network,
    existing.feePayer || 'buyer'
  );
  const payableAmount = existing.buyerTotalPayableUsdc ?? feeQuote.buyerTotalPayable;

  let fundingTxHash: string | null = externalTxHash || null;
  let vaultAddress: string | null = null;

  if (!fundingTxHash) {
    try {
      const resolvedBuyerUUID = await resolveBuyerUUID(existing.buyerUserId);
      const buyerWallet = await db.findUserWalletForNetwork(resolvedBuyerUUID, existing.network || 'solana');
      if (buyerWallet) {
        const activeProviderName = await resolveActiveWalletProvider();
        const network = (existing.network || 'solana').toLowerCase();
        if (network === 'stellar' || buyerWallet.chain === 'stellar') {
          vaultAddress = process.env.STELLAR_VAULT_ADDRESS || process.env.STELLAR_DISTRIBUTION_PUBLIC_KEY || buyerWallet.address;
        } else if (['base', 'celo', 'bsc', 'bnb', 'ethereum'].includes(network) || buyerWallet.address.startsWith('0x')) {
          vaultAddress = process.env.EVM_VAULT_ADDRESS || process.env.EVM_SETTLEMENT_ROUTER_ADDRESS || buyerWallet.address;
        } else {
          vaultAddress = process.env.SOLANA_VAULT_ADDRESS || process.env.SAP_AGENT_PUBLIC_KEY || buyerWallet.address;
        }

        const provider = getWalletProvider(buyerWallet.provider ?? activeProviderName);
        const transferResult = await provider.createTransfer({
          providerWalletId: buyerWallet.providerWalletId,
          providerCustomerId: buyerWallet.customerId,
          asset: ((existing.currency || 'usdc').toLowerCase() as any),
          chain: (existing.network || 'solana') as any,
          amount: String(payableAmount),
          toAddress: vaultAddress || buyerWallet.address,
          idempotencyKey: `fund_agr_${existing.id}`,
          reference: existing.id,
        });

        fundingTxHash = (transferResult as any).transactionHash || (transferResult as any).txHash || (transferResult as any).providerTransferId || null;
      }
    } catch (onChainErr) {
      console.warn('[agreement.fund] On-chain fund note:', onChainErr);
    }
  }

  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'funded',
    fundedAt: now.toISOString(),
    deliveryDueAt: dueAt.toISOString(),
    fundingTxHash: fundingTxHash || existing.fundingTxHash || null,
    vaultAddress: vaultAddress || existing.vaultAddress || null,
    feeAmountUsdc: existing.feeAmountUsdc ?? feeQuote.feeAmount,
    feePercent: existing.feePercent ?? feeQuote.feePercent,
    feePayer: existing.feePayer ?? feeQuote.feePayer,
    buyerTotalPayableUsdc: payableAmount,
    sellerNetAmountUsdc: existing.sellerNetAmountUsdc ?? feeQuote.sellerNetAmount,
    updatedAt: now.toISOString(),
  };

  await db.updateServiceAgreement(updated);

  // Sync funding to external escrow agent so external channels stay in sync
  void syncEscrowAgentFunding(updated);

  try {
    await createBalanceLedgerEntry(
      {
        userId: existing.buyerUserId,
        asset: ((existing.currency || 'usdc').toLowerCase() as any),
        amount: String(payableAmount),
        kind: 'hold',
        status: 'held',
        sourceType: 'service_agreement',
        sourceId: existing.id,
        description: `Hold ${payableAmount} ${(existing.currency || 'USDC').toUpperCase()} locked into Service Agreement (${existing.title})`
      },
      { actorType: 'user', actorId: existing.buyerUserId }
    );
  } catch (err) {
    console.warn('[agreement.fund] Ledger hold note:', err);
  }

  return updated;
}

/**
 * Seller signals they have started work. Optional intermediate state.
 */
export async function startDelivery(agreementId: string): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);
  if (existing.status !== 'funded') {
    throw badRequest(`Agreement ${agreementId} must be funded to start delivery; current: ${existing.status}`);
  }

  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'in_delivery',
    updatedAt: nowIso(),
  };
  await db.updateServiceAgreement(updated);
  return updated;
}

/**
 * Seller marks delivery submitted.
 */
export async function markDelivered(agreementId: string): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);
  if (existing.status !== 'funded' && existing.status !== 'in_delivery') {
    throw badRequest(`Agreement ${agreementId} cannot be marked delivered from ${existing.status}`);
  }

  // Tiered verification protocol:
  // Naira Service Agreements require a phone/WhatsApp anchor for local banking compliance.
  // USDC / crypto agreements proceed frictionlessly via wallet or user ID.
  const curr = String(existing.currency || '').toUpperCase();
  if (curr === 'NAIRA' || curr === 'NGN') {
    let seller = await db.findUserById(existing.sellerUserId);
    if (!seller && existing.sellerUserId) {
      seller = await db.findUserByTarget(existing.sellerUserId);
    }
    const hasPhone = Boolean(
      seller?.whatsappNumber ||
      (seller as any)?.phone ||
      existing.sellerUserId?.startsWith('+') ||
      /^\+?[0-9]{10,15}$/.test(existing.sellerUserId || '')
    );
    if (!hasPhone) {
      throw badRequest(
        'Naira Service Agreements require a verified WhatsApp phone number for compliance and local banking rail settlement.'
      );
    }
  }

  const now = nowIso();
  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'delivered',
    deliveredAt: now,
    updatedAt: now,
  };
  await db.updateServiceAgreement(updated);
  return updated;
}

/**
 * Resolves or auto-provisions a contractor user record and their wallet.
 * Ensures the contractor always has a valid UserRecord and UserWalletRecord in DB.
 */
async function resolveContractorUser(sellerTarget: string, network: string = 'celo'): Promise<{ user: UserRecord; walletAddress?: string }> {
  const clean = String(sellerTarget || '').trim();
  if (!clean) {
    throw badRequest('sellerUserId is required');
  }

  // 1. Look up existing user across user_id, target, email, username, customer_identity_links
  let user = await db.findUserById(clean);
  if (!user) user = await db.findUserByTarget(clean);
  if (!user && clean.includes('@') && clean.includes('.')) {
    user = await db.findUserByEmail(clean);
  }
  if (!user) {
    const finder = (db as any).findUserByUsername;
    if (typeof finder === 'function') {
      user = await finder.call(db, clean.replace(/^@/, ''));
    }
  }

  // 1b. Identity link lookup (explicit fallback)
  if (!user) {
    try {
      const links = await db.listCustomerIdentityLinks();
      const rawUser = clean.replace(/^@/, '').toLowerCase();
      const digitsOnly = clean.replace(/\D/g, '');
      const matched = links.find((l) =>
        (l.telegramUsername && l.telegramUsername.toLowerCase() === rawUser) ||
        (l.telegramUserId && l.telegramUserId === clean) ||
        (l.whatsappNumber && (l.whatsappNumber === clean || l.whatsappNumber === `+${digitsOnly}`))
      );
      if (matched?.paymentUserId) {
        user = await db.findUserById(matched.paymentUserId);
      }
    } catch (linkErr) {
      console.warn('[agreement.resolveContractorUser] identity link lookup note:', linkErr);
    }
  }

  const isAddress = clean.startsWith('0x') || clean.length >= 32;
  const isEmail = clean.includes('@') && clean.includes('.');
  const username = clean.replace(/^@/, '');
  const shadowUserId = `usr_${clean.replace(/[^a-zA-Z0-9_]/g, '')}`;
  const userId = user ? user.id : (clean.startsWith('usr_') ? clean : (isAddress ? clean : shadowUserId));

  // 2. Auto-create user record if not present
  if (!user) {
    const email = isEmail ? clean : `${username || clean}@sivan.user`;
    const fullName = isAddress ? `${clean.slice(0, 6)}...${clean.slice(-4)}` : username || clean;
    const now = nowIso();
    try {
      user = await db.insertUserRecord({
        id: userId,
        email,
        fullName,
        username: !isAddress ? username : undefined,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      user = (await db.findUserById(userId)) || (await db.findUserByTarget(clean)) || {
        id: userId,
        email,
        fullName,
        createdAt: now,
        updatedAt: now,
      };
    }
  } else if (user.id !== shadowUserId) {
    // If real user was found but a shadow user record was previously credited under shadowUserId,
    // reconcile shadow user available balance into the real user's ledger!
    try {
      const shadowLedger = await getUserBalance(shadowUserId).catch(() => null);
      if (shadowLedger && shadowLedger.balances?.length) {
        for (const bal of shadowLedger.balances) {
          const avail = Number(bal.available || 0);
          if (avail > 0) {
            await createBalanceLedgerEntry(
              {
                userId: shadowUserId,
                asset: bal.asset as any,
                amount: String(avail),
                kind: 'debit_transfer',
                status: 'completed',
                sourceType: 'user_reconciliation',
                sourceId: `recon_${user.id}`,
                description: `Reconcile balance to real user account (${user.email || user.username || user.id})`,
              },
              { actorType: 'system', actorId: 'balance_reconciliation' }
            );
            await createBalanceLedgerEntry(
              {
                userId: user.id,
                asset: bal.asset as any,
                amount: String(avail),
                kind: 'credit_available',
                status: 'available',
                sourceType: 'user_reconciliation',
                sourceId: `recon_${shadowUserId}`,
                description: `Reconciled balance from Telegram contractor handle (${clean})`,
              },
              { actorType: 'system', actorId: 'balance_reconciliation' }
            );
          }
        }
      }
    } catch (reconErr) {
      console.warn('[agreement.resolveContractorUser] shadow balance reconciliation note:', reconErr);
    }
  }

  // 3. Ensure contractor wallet exists in DB for this network
  let walletAddress: string | undefined;
  try {
    const existingWallet = await db.findUserWalletForNetwork(user.id, network);
    if (existingWallet?.address) {
      walletAddress = existingWallet.address;
    } else if (isAddress) {
      walletAddress = clean;
      const now = nowIso();
      const rawRecord: UserWalletRecord = {
        id: generateId('uw'),
        userId: user.id,
        provider: 'evm_native',
        providerWalletId: `evm_${clean}`,
        chain: (network || 'celo') as any,
        address: clean,
        status: 'active',
        custodial: false,
        delegatedSigningEnabled: true,
        raw: { address: clean, chain: network },
        createdAt: now,
        updatedAt: now,
      };
      await db.insertUserWallet(rawRecord).catch(() => null);
    } else {
      const provisioned = await ensureUserWallet(user.id, network as any).catch(() => null);
      if (provisioned?.address) {
        walletAddress = provisioned.address;
      }
    }
  } catch (err) {
    console.warn('[agreement.resolveContractorUser] wallet note:', err);
  }

  return { user, walletAddress: walletAddress || (isAddress ? clean : undefined) };
}

/**
 * Buyer approves delivery and releases funds.
 * Executes on-chain transfer directly to seller wallet, debits buyer hold, and credits contractor available balance.
 */
export async function releaseAgreement(
  agreementId: string,
  toAddressOverride?: string
): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);
  
  if (existing.status === 'released') {
    return existing;
  }

  const releasableStatuses: string[] = ['delivered', 'funded', 'in_delivery', 'in_progress', 'pending_payment'];
  if (!releasableStatuses.includes(existing.status)) {
    throw badRequest(`Agreement ${agreementId} must be active or delivered before release; current: ${existing.status}`);
  }

  const now = nowIso();
  const feePayer: FeePayer = existing.feePayer || (existing.channel === 'minipay' ? 'seller' : 'buyer');
  const feeQuote = quoteServiceAgreementFee(
    existing.amountUsdc,
    existing.network,
    feePayer
  );
  const feeAmount = typeof existing.feeAmountUsdc === 'number' && existing.feeAmountUsdc >= 0
    ? existing.feeAmountUsdc
    : feeQuote.feeAmount;
  const sellerNetAmount = typeof existing.sellerNetAmountUsdc === 'number' && existing.sellerNetAmountUsdc > 0
    ? existing.sellerNetAmountUsdc
    : (feePayer === 'seller' ? Math.max(0, parseFloat((existing.amountUsdc - feeAmount).toFixed(6))) : feeQuote.sellerNetAmount);
  const payableAmount = existing.buyerTotalPayableUsdc ?? (feePayer === 'seller' ? existing.amountUsdc : feeQuote.buyerTotalPayable);
  const feeWallet = getSivanServiceAgreementFeeWallet(existing.network || 'solana');

  let releaseTxHash: string | null = null;
  let feeTxHash: string | null = null;

  // 1. Resolve or auto-provision the contractor / seller account and their wallet
  const { user: contractorUser, walletAddress: contractorAddress } = await resolveContractorUser(
    existing.sellerUserId,
    existing.network || 'celo'
  );

  // 2. On-chain settlement transfer (if on-chain wallet / vault is active)
  //
  // GUARD: For Celo agreements we require the agent vault key upfront.
  // If it is missing we throw immediately — before any DB write — so the
  // buyer's UI sees an error instead of a false "Released" receipt while
  // the contractor receives nothing.
  const isCeloAgreement = (existing.network || '').toLowerCase() === 'celo';
  if (isCeloAgreement) {
    const { getCeloAgentPrivateKey } = await import('../wallets/celo/celo-settlement-relayer.js');
    if (!getCeloAgentPrivateKey()) {
      throw new Error(
        'Celo settlement is not operational: CELO_AGENT_PRIVATE_KEY is not configured on this server. ' +
        'Contact Sivan support — funds have NOT been released and no debit has occurred.'
      );
    }
  }

  try {
    const activeProviderName = await resolveActiveWalletProvider();
    const resolvedBuyerUUID = await resolveBuyerUUID(existing.buyerUserId);
    const buyerWallet = await db.findUserWalletForNetwork(resolvedBuyerUUID, existing.network || 'solana');
    const sellerWallet = await db.findUserWalletForNetwork(contractorUser.id, existing.network || 'solana');
    const targetToAddress = toAddressOverride || contractorAddress || sellerWallet?.address;

    // CIRCULAR TRANSFER GUARD
    // If the resolved sender wallet address equals the recipient address the
    // transfer is a no-op at best and silently misleading at worst. Throw
    // immediately so the release fails visibly rather than recording a fake
    // tx hash that moved nothing.
    if (buyerWallet?.address && targetToAddress && buyerWallet.address.toLowerCase() === targetToAddress.toLowerCase()) {
      throw new Error(
        `Circular transfer detected for agreement ${existing.id}: ` +
        `sender wallet (${buyerWallet.address}) equals recipient address. ` +
        'Release rejected — check buyer/seller identity mapping.'
      );
    }

    if (targetToAddress) {
      // Recipient address format check
      if (existing.network === 'solana') {
        if (!/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(targetToAddress)) {
          throw new Error(`Invalid Solana recipient wallet address format: '${targetToAddress}'`);
        }
      } else if (existing.network === 'celo' || targetToAddress.startsWith('0x')) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(targetToAddress)) {
          throw new Error(`Invalid EVM/Celo recipient wallet address format: '${targetToAddress}'`);
        }
      } else if (existing.network === 'stellar') {
        if (!/^G[A-Z0-9]{55}$/.test(targetToAddress)) {
          throw new Error(`Invalid Stellar recipient wallet address format: '${targetToAddress}'`);
        }
      }

      // Priority 1: Automated Celo on-chain relayer transfer from Sivan Agent Vault
      if ((existing.network === 'celo' || targetToAddress.startsWith('0x')) && targetToAddress.length === 42) {
        const relayerRes = await dispatchCeloSettlementTransfer({
          toAddress: targetToAddress,
          amount: sellerNetAmount,
          currency: existing.currency,
          agreementId: existing.id,
        });
        if (relayerRes.success && relayerRes.txHash) {
          releaseTxHash = relayerRes.txHash;

          // Priority 1b: Automated Celo on-chain protocol fee transfer from Sivan Agent Vault directly to Sivan Fee Wallet
          if (feeAmount > 0 && feeWallet && feeWallet.toLowerCase() !== targetToAddress.toLowerCase()) {
            try {
              const feeRelayerRes = await dispatchCeloSettlementTransfer({
                toAddress: feeWallet,
                amount: feeAmount,
                currency: existing.currency,
                agreementId: `fee_${existing.id}`,
              });
              if (feeRelayerRes.success && feeRelayerRes.txHash) {
                feeTxHash = feeRelayerRes.txHash;
              } else {
                console.warn('[agreement.release] Celo fee relayer transfer note:', feeRelayerRes.error);
              }
            } catch (feeErr) {
              console.warn('[agreement.release] Celo fee relayer dispatch exception:', feeErr);
            }
          }
        } else if (isCeloAgreement) {
          // For Celo agreements, a failed relayer dispatch is a hard error.
          // Do NOT fall through to Priority 2 or mark the DB released.
          const errorMsg = `Celo settlement transfer failed for agreement ${existing.id}: ${relayerRes.error || 'unknown relayer error'}. No funds were transferred.`;
          await db.updateServiceAgreement({
            ...existing,
            lastError: errorMsg,
            updatedAt: nowIso(),
          });
          throw new Error(`${errorMsg} Agreement status has NOT been updated.`);
        }
      }

      if (!isCeloAgreement) {
        // Pre-flight check: Verify source wallet balance before attempting broadcast
        if (buyerWallet?.providerWalletId) {
          try {
            const provider = getWalletProvider(buyerWallet?.provider ?? activeProviderName);
            const balances = await provider.getBalances(
              buyerWallet.providerWalletId,
              buyerWallet.customerId,
              buyerWallet.address,
              (existing.network || 'solana') as any
            );
            const tokenMatch = balances.find(
              (b) =>
                b.asset.toLowerCase() === (existing.currency || 'usdc').toLowerCase() &&
                b.chain.toLowerCase() === (existing.network || 'solana').toLowerCase()
            );
            const availableAmount = tokenMatch ? Number(tokenMatch.amount) : 0;
            if (availableAmount < sellerNetAmount) {
              const errorMsg = `Insufficient balance in buyer wallet (${buyerWallet.address}) for ${existing.network}: available ${availableAmount} ${existing.currency || 'USDC'}, required ${sellerNetAmount} ${existing.currency || 'USDC'}. Please top up the wallet before release.`;
              await db.updateServiceAgreement({
                ...existing,
                lastError: errorMsg,
                updatedAt: nowIso(),
              });
              throw new Error(errorMsg);
            }
          } catch (balErr: any) {
            if (balErr.message?.includes('Insufficient balance')) {
              throw balErr;
            }
            console.warn('[agreement.release] Pre-flight balance check warning:', balErr?.message || balErr);
          }
        }

        // Priority 2: Provider transfer fallback for non-Celo networks only.
        try {
          const provider = getWalletProvider(buyerWallet?.provider ?? sellerWallet?.provider ?? activeProviderName);
          if (!releaseTxHash) {
            const netTransferResult = await provider.createTransfer({
              providerWalletId: buyerWallet?.providerWalletId || sellerWallet?.providerWalletId || `evm_${targetToAddress}`,
              providerCustomerId: buyerWallet?.customerId || sellerWallet?.customerId,
              asset: ((existing.currency || 'usdc').toLowerCase() as any),
              chain: (existing.network || 'solana') as any,
              amount: String(sellerNetAmount),
              toAddress: targetToAddress,
              idempotencyKey: `rel_agr_${existing.id}_seller`,
              reference: existing.id,
            });
            releaseTxHash = (netTransferResult as any).transactionHash || (netTransferResult as any).txHash || (netTransferResult as any).providerTransferId || null;
            if (!releaseTxHash) {
              throw new Error(`Wallet provider did not return a confirmed transaction hash for agreement ${existing.id}.`);
            }
          }

          // Transfer Sivan Platform Fee for non-Celo networks
          if (feeAmount > 0 && feeWallet && feeWallet.toLowerCase() !== targetToAddress.toLowerCase()) {
            try {
              const provider2 = getWalletProvider(buyerWallet?.provider ?? sellerWallet?.provider ?? activeProviderName);
              const feeTransferResult = await provider2.createTransfer({
                providerWalletId: buyerWallet?.providerWalletId || sellerWallet?.providerWalletId || `evm_${targetToAddress}`,
                providerCustomerId: buyerWallet?.customerId || sellerWallet?.customerId,
                asset: ((existing.currency || 'usdc').toLowerCase() as any),
                chain: (existing.network || 'solana') as any,
                amount: String(feeAmount),
                toAddress: feeWallet,
                idempotencyKey: `rel_agr_${existing.id}_fee`,
                reference: `fee_${existing.id}`,
              });
              feeTxHash = (feeTransferResult as any).transactionHash || (feeTransferResult as any).txHash || (feeTransferResult as any).providerTransferId || null;
            } catch (feeErr) {
              console.warn('[agreement.release] Non-Celo fee transfer note:', feeErr);
            }
          }
        } catch (netTransferErr: any) {
          const errorMsg = `Settlement transfer broadcast failed on ${existing.network || 'solana'}: ${netTransferErr?.message || netTransferErr}`;
          await db.updateServiceAgreement({
            ...existing,
            lastError: errorMsg,
            updatedAt: nowIso(),
          });
          throw new Error(
            `${errorMsg}. Agreement status has NOT been updated to prevent phantom releases.`
          );
        }
      }
    }
  } catch (onChainErr: any) {
    // Both Celo and non-Celo on-chain errors must NOT fall through to a fake release!
    throw onChainErr;
  }

  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'released',
    releasedAt: now,
    releaseTxHash: releaseTxHash || existing.releaseTxHash || null,
    feeTxHash: feeTxHash || existing.feeTxHash || null,
    sellerNetAmountUsdc: sellerNetAmount,
    buyerTotalPayableUsdc: payableAmount,
    feeAmountUsdc: feeAmount,
    lastError: null,
    updatedAt: now,
  };

  await db.updateServiceAgreement(updated);

  // 3. Ledger settlement entries: Debit buyer held balance AND credit contractor available balance
  try {
    // Debit hold from buyer - records full settlement breakdown of held funds
    await createBalanceLedgerEntry(
      {
        userId: existing.buyerUserId,
        asset: ((existing.currency || 'usdc').toLowerCase() as any),
        amount: String(payableAmount),
        kind: 'debit_transfer',
        status: 'completed',
        sourceType: 'service_agreement',
        sourceId: existing.id,
        description: `Debit ${payableAmount} ${(existing.currency || 'USDC').toUpperCase()} released for Service Agreement (${existing.title}) [Contractor: ${sellerNetAmount}, Platform Fee: ${feeAmount}]`
      },
      { actorType: 'system', actorId: 'agreement_release' }
    );

    // Credit contractor available balance
    await createBalanceLedgerEntry(
      {
        userId: contractorUser.id,
        asset: ((existing.currency || 'usdc').toLowerCase() as any),
        amount: String(sellerNetAmount),
        kind: 'credit_available',
        status: 'available',
        sourceType: 'service_agreement',
        sourceId: existing.id,
        description: `Credit ${sellerNetAmount} ${(existing.currency || 'USDC').toUpperCase()} from released Service Agreement (${existing.title})`
      },
      { actorType: 'system', actorId: 'agreement_release' }
    );
  } catch (err) {
    console.warn('[agreement.release] Ledger release note:', err);
  }

  return updated;
}

export interface CancelAgreementOptions {
  refundSignature?: string;
  buyerAddress?: string;
  reason?: string;
}

/**
 * Cancel an agreement. Allowed from any pre-release active status.
 * Automatically refunds locked funds back to buyer on-chain when funded.
 */
export async function cancelAgreement(
  agreementId: string,
  options?: CancelAgreementOptions
): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);

  const terminalStatuses: ServiceAgreementStatus[] = ['released', 'cancelled'];
  if (terminalStatuses.includes(existing.status)) {
    throw badRequest(`Agreement ${agreementId} is already ${existing.status}; cannot cancel`);
  }

  const now = nowIso();
  const refundAmount = existing.buyerTotalPayableUsdc ?? existing.amountUsdc;
  const buyerTargetAddress =
    options?.buyerAddress ||
    (existing.buyerUserId?.startsWith('0x') ? existing.buyerUserId : null);

  let refundTxHash: string | null = null;

  // If the agreement was funded on-chain, trigger refund transfer back to buyer wallet
  if (
    existing.status === 'funded' ||
    existing.status === 'in_delivery' ||
    existing.status === 'delivered' ||
    existing.status === 'disputed' ||
    existing.fundingTxHash
  ) {
    try {
      const activeProviderName = await resolveActiveWalletProvider();
      const resolvedBuyerUUID = await resolveBuyerUUID(existing.buyerUserId);
      const buyerWallet = await db.findUserWalletForNetwork(resolvedBuyerUUID, existing.network || 'solana');
      const targetAddress = buyerTargetAddress || buyerWallet?.address;

      if (targetAddress) {
        // Priority 1: Automated Celo on-chain relayer refund from Sivan Agent Vault
        if ((existing.network === 'celo' || targetAddress.startsWith('0x')) && targetAddress.length === 42) {
          try {
            const relayerRes = await dispatchCeloSettlementTransfer({
              toAddress: targetAddress,
              amount: refundAmount,
              currency: existing.currency,
              agreementId: existing.id,
              isRefund: true,
            });
            if (relayerRes.success && relayerRes.txHash) {
              refundTxHash = relayerRes.txHash;
            }
          } catch (relayerErr) {
            console.warn('[agreement.cancel] Celo refund relayer note:', relayerErr);
          }
        }

        // Priority 2: Provider transfer fallback (if not already dispatched)
        if (!refundTxHash) {
          const provider = getWalletProvider(buyerWallet?.provider ?? activeProviderName);
          const refundTransferResult = await provider.createTransfer({
            providerWalletId: buyerWallet?.providerWalletId || '',
            providerCustomerId: buyerWallet?.customerId,
            asset: ((existing.currency || 'usdc').toLowerCase() as any),
            chain: (existing.network || 'celo') as any,
            amount: String(refundAmount),
            toAddress: targetAddress,
            idempotencyKey: `ref_agr_${existing.id}_buyer`,
            reference: `refund_${existing.id}`,
          });

          refundTxHash =
            (refundTransferResult as any).transactionHash ||
            (refundTransferResult as any).txHash ||
            (refundTransferResult as any).providerTransferId ||
            null;
        }
      }
    } catch (onChainErr) {
      console.warn('[agreement.cancel] On-chain refund transfer note:', onChainErr);
    }
  }

  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'cancelled',
    refundTxHash: refundTxHash || options?.refundSignature || existing.refundTxHash || null,
    refundSignature: options?.refundSignature || existing.refundSignature || null,
    updatedAt: now,
  };
  await db.updateServiceAgreement(updated);

  if (
    existing.status === 'funded' ||
    existing.status === 'in_delivery' ||
    existing.status === 'delivered' ||
    existing.status === 'disputed'
  ) {
    try {
      await createBalanceLedgerEntry(
        {
          userId: existing.buyerUserId,
          asset: ((existing.currency || 'usdc').toLowerCase() as any),
          amount: String(refundAmount),
          kind: 'hold_release',
          status: 'available',
          sourceType: 'service_agreement',
          sourceId: existing.id,
          description: `Release hold for cancelled Service Agreement (${existing.title})`
        },
        { actorType: 'system', actorId: existing.buyerUserId }
      );
    } catch (err) {
      console.warn('[agreement.cancel] Ledger hold release note:', err);
    }
  }

  // Fire real-time cancellation push to seller (counterparty) and buyer (actor)
  void notifyAgreementCancellation(
    updated,
    'buyer',
    'cancelled',
    options?.reason
  );

  return updated;
}

/**
 * Extend an agreement's delivery deadline by additional hours.
 */
export async function extendAgreementDeadline(
  agreementId: string,
  additionalHours: number
): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);

  const terminalStatuses: ServiceAgreementStatus[] = ['released', 'cancelled'];
  if (terminalStatuses.includes(existing.status)) {
    throw badRequest(`Agreement ${agreementId} is ${existing.status}; cannot extend deadline`);
  }

  const currentDueMs = existing.deliveryDueAt ? new Date(existing.deliveryDueAt).getTime() : Date.now();
  const baseMs = Math.max(Date.now(), currentDueMs);
  const newDueMs = baseMs + Math.max(1, additionalHours) * 60 * 60 * 1000;
  const newDueIso = new Date(newDueMs).toISOString();

  const additionalDays = Math.max(0.5, Math.round((additionalHours / 24) * 10) / 10);
  const updatedDeadlineDays = Math.max(1, Math.round(existing.deadlineDays + additionalDays));

  const updated: ServiceAgreementRecord = {
    ...existing,
    deadlineDays: updatedDeadlineDays,
    deliveryDueAt: newDueIso,
    overdueNoticeSent: false,
    reminder6hSent: false,
    updatedAt: nowIso(),
  };

  await db.updateServiceAgreement(updated);
  return updated;
}

/**
 * Get a single agreement by id. Returns null if not found.
 */
export async function getAgreement(agreementId: string): Promise<ServiceAgreementRecord | null> {
  const record = await db.findServiceAgreementById(agreementId);
  if (record && record.fundingTxHash && (record.status === 'pending_payment' || (record.status as any) === 'pending_funding')) {
    record.status = 'funded';
    record.fundedAt = record.fundedAt || record.createdAt || nowIso();
    if (!record.deliveryDueAt && record.deadlineDays) {
      record.deliveryDueAt = new Date(new Date(record.fundedAt).getTime() + record.deadlineDays * 24 * 60 * 60 * 1000).toISOString();
    }
    record.updatedAt = nowIso();
    await db.updateServiceAgreement(record);
  }
  return record;
}

// ─── Admin Agreement Operations ──────────────────────────────────────────────

export interface AdminReleaseAgreementInput {
  agreementId: string;
  toAddressOverride?: string;
  releaseTxHashOverride?: string;
  adminNote?: string;
  callerAdmin?: string;
}

/**
 * Administrative action to force-release or retry release on a service agreement.
 * Supports toAddressOverride (if original seller ATA/address was misconfigured)
 * and releaseTxHashOverride (if manual on-chain broadcast was executed).
 */
export async function adminReleaseAgreement(
  input: AdminReleaseAgreementInput
): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(input.agreementId);
  if (!existing) throw notFound(`Service agreement ${input.agreementId}`);

  // Option A: Admin manual on-chain transaction hash binding
  if (input.releaseTxHashOverride?.trim()) {
    const txHash = input.releaseTxHashOverride.trim();
    const now = nowIso();
    const updated: ServiceAgreementRecord = {
      ...existing,
      status: 'released',
      releasedAt: existing.releasedAt || now,
      releaseTxHash: txHash,
      lastError: null,
      adminReleaseNote: input.adminNote || 'Admin manual on-chain transaction hash binding',
      adminReleasedBy: input.callerAdmin || 'admin',
      updatedAt: now,
    };
    await db.updateServiceAgreement(updated);

    // Ledger settlement entries: Debit buyer held balance AND credit contractor available balance
    try {
      const payableAmount = existing.buyerTotalPayableUsdc ?? existing.amountUsdc;
      const sellerNetAmount = existing.sellerNetAmountUsdc ?? existing.amountUsdc;
      await createBalanceLedgerEntry({
        userId: existing.buyerUserId,
        asset: ((existing.currency || 'usdc').toLowerCase() as any),
        amount: String(payableAmount),
        kind: 'debit_transfer',
        status: 'completed',
        sourceType: 'service_agreement',
        sourceId: existing.id,
        description: `Admin manual release: Debit ${payableAmount} ${(existing.currency || 'USDC').toUpperCase()} for Agreement (${existing.title}) [Admin: ${input.callerAdmin || 'admin'}]`,
      });
      await createBalanceLedgerEntry({
        userId: existing.sellerUserId,
        asset: ((existing.currency || 'usdc').toLowerCase() as any),
        amount: String(sellerNetAmount),
        kind: 'credit_available',
        status: 'completed',
        sourceType: 'service_agreement',
        sourceId: existing.id,
        description: `Admin manual release: Credit ${sellerNetAmount} ${(existing.currency || 'USDC').toUpperCase()} for Agreement (${existing.title}) [Admin: ${input.callerAdmin || 'admin'}]`,
      });
    } catch (ledgerErr) {
      console.warn('[adminReleaseAgreement] Ledger recording note:', ledgerErr);
    }
    return updated;
  }

  // Option B: Trigger standard or overridden release
  const released = await releaseAgreement(existing.id, input.toAddressOverride);
  if (input.adminNote || input.callerAdmin) {
    const now = nowIso();
    const withAudit: ServiceAgreementRecord = {
      ...released,
      adminReleaseNote: input.adminNote || null,
      adminReleasedBy: input.callerAdmin || 'admin',
      updatedAt: now,
    };
    await db.updateServiceAgreement(withAudit);
    return withAudit;
  }
  return released;
}

/**
 * List all service agreements for admin console with filtering and health summary.
 */
export async function listAdminAgreements(filters?: {
  status?: string;
  network?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  agreements: ServiceAgreementRecord[];
  total: number;
  summary: {
    total: number;
    funded: number;
    delivered: number;
    released: number;
    attentionRequired: number;
  };
}> {
  const all: ServiceAgreementRecord[] = await (db as any).listServiceAgreements();
  let filtered: ServiceAgreementRecord[] = [...all];

  if (filters?.status && filters.status !== 'all') {
    filtered = filtered.filter((a: ServiceAgreementRecord) => a.status === filters.status);
  }
  if (filters?.network && filters.network !== 'all') {
    filtered = filtered.filter((a: ServiceAgreementRecord) => (a.network || '').toLowerCase() === filters.network?.toLowerCase());
  }
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter(
      (a: ServiceAgreementRecord) =>
        a.id.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.buyerUserId.toLowerCase().includes(q) ||
        a.sellerUserId.toLowerCase().includes(q) ||
        (a.releaseTxHash || '').toLowerCase().includes(q)
    );
  }

  // Sort newest first
  filtered.sort((a: ServiceAgreementRecord, b: ServiceAgreementRecord) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const summary = {
    total: all.length,
    funded: all.filter((a: ServiceAgreementRecord) => a.status === 'funded').length,
    delivered: all.filter((a: ServiceAgreementRecord) => a.status === 'delivered').length,
    released: all.filter((a: ServiceAgreementRecord) => a.status === 'released').length,
    attentionRequired: all.filter(
      (a: ServiceAgreementRecord) =>
        Boolean(a.lastError) ||
        (a.status === 'delivered' && !a.releasedAt) ||
        (a.status === 'released' && !a.releaseTxHash)
    ).length,
  };

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  const paged = filtered.slice(offset, offset + limit);

  return {
    agreements: paged,
    total: filtered.length,
    summary,
  };
}

