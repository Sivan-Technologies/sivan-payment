import { db } from '../database/json-database.js';
import { DEFAULT_WALLET_CHAIN, type UserWalletRecord, type WalletChain } from '../database/types.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { createAuditLog } from '../audit/audit.service.js';
import { getWalletProvider } from './provider/provider-registry.js';
import { isAssetSupportedOnChain } from '../controls/payment-controls.service.js';

/**
 * Per-customer wallet management.
 *
 * Every user gets their own Bridge wallet. Their virtual account settles into
 * it, and their deposits arrive in it. Sivan never pools user funds into a
 * shared wallet, so Bridge remains custodian and source of truth for balances.
 */

/**
 * Solana is the default chain: it is the only supported chain carrying BOTH
 * USDC and USDT, and it has by far the lowest fees. Base cannot hold USDT.
 */
export const DEFAULT_CHAIN: WalletChain = DEFAULT_WALLET_CHAIN;

export function assetsForChain(chain: WalletChain): Array<'usdc' | 'usdt'> {
  return (['usdc', 'usdt'] as const).filter((asset) => isAssetSupportedOnChain(asset, chain as any));
}

async function requireApprovedCustomer(userId: string) {
  const data = await db.read();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw notFound('User');

  const customer = data.customers.find((item) => item.userId === userId);
  if (!customer) throw badRequest('Complete verification before creating a wallet');
  // A wallet is a place to receive money. Issuing one before KYC would let an
  // unverified user receive funds, which our providers do not permit.
  if (customer.kycStatus !== 'kyc_approved') {
    throw badRequest('Verification must be approved before a wallet can be created');
  }
  if (!customer.providerCustomerId) {
    throw badRequest('Customer is not yet registered with the payment provider');
  }
  return { user, customer };
}

/**
 * Get the user's wallet for a chain, creating it if absent.
 *
 * Idempotent by design: concurrent calls, retries, and repeated page loads all
 * converge on one wallet per (user, chain). The DB enforces this too, so a
 * race cannot produce a second address.
 */
export async function ensureUserWallet(userId: string, chain: WalletChain = DEFAULT_CHAIN): Promise<UserWalletRecord> {
  const existing = await db.findUserWallet(userId, chain);
  if (existing) return existing;

  const { customer } = await requireApprovedCustomer(userId);
  const provider = getWalletProvider();

  if (!provider.supportedChains.includes(chain)) {
    throw badRequest(`${chain} wallets are not supported by the current provider`);
  }

  const providerWallet = await provider.createWallet({
    userId,
    providerCustomerId: customer.providerCustomerId,
    chain,
    // Deliberately deterministic, NOT shared/id.ts idempotencyKey() which
    // appends a random UUID. A retry must reuse the same key so the provider
    // returns the existing wallet instead of provisioning (and billing for)
    // a second one.
    idempotencyKey: `sivan-wallet-${userId}-${chain}`,
  });

  const now = nowIso();
  const record: UserWalletRecord = {
    id: id('uw'),
    userId,
    customerId: customer.id,
    provider: providerWallet.provider,
    providerWalletId: providerWallet.providerWalletId,
    chain: providerWallet.chain,
    address: providerWallet.address,
    status: providerWallet.status,
    custodial: providerWallet.custodyModel === 'custodial',
    raw: providerWallet.rawProviderPayload,
    createdAt: now,
    updatedAt: now,
  };

  const saved = await db.insertUserWallet(record);

  await createAuditLog({
    actorType: 'system',
    actorId: userId,
    action: 'wallet.created',
    resourceType: 'user_wallet',
    resourceId: saved.id,
    severity: 'info',
    metadata: {
      userId,
      chain: saved.chain,
      provider: saved.provider,
      providerWalletId: saved.providerWalletId,
      custodial: saved.custodial,
    },
  });

  return saved;
}

export async function listUserWallets(userId: string): Promise<UserWalletRecord[]> {
  return db.listUserWallets(userId);
}

/**
 * Wallet plus live balances read from the provider.
 *
 * Balances are deliberately NOT computed from a Sivan ledger. Bridge holds the
 * funds, so Bridge is the source of truth. Reading through avoids the class of
 * bug where our books and the provider's disagree.
 */
export async function getUserWalletWithBalances(userId: string, chain: WalletChain = DEFAULT_CHAIN) {
  const wallet = await db.findUserWallet(userId, chain);
  if (!wallet) return null;

  const provider = getWalletProvider();
  let balances: Array<{ asset: string; chain: string; amount: string }> = [];
  try {
    balances = await provider.getBalances(wallet.providerWalletId, wallet.customerId);
  } catch {
    // A provider outage must not blank the deposit address. The user can still
    // receive funds; only the balance figure is unavailable.
    balances = [];
  }

  return { ...wallet, balances, acceptedAssets: assetsForChain(wallet.chain) };
}

/**
 * The destination a virtual account should settle into for this user.
 *
 * Called when provisioning a virtual account so the fiat a user wires converts
 * into THEIR wallet, not a pooled Sivan wallet.
 */
export async function resolveSettlementWalletId(userId: string, chain: WalletChain = DEFAULT_CHAIN): Promise<string> {
  const wallet = await ensureUserWallet(userId, chain);
  return wallet.providerWalletId;
}
