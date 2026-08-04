import { db } from '../database/json-database.js';
import { canProvisionWallet } from './wallet-eligibility.js';
import { getVerificationState } from '../kyc/service/verification-state.js';
import { isApprovedKycStatus } from '../kyc/types/verification.types.js';
import { DEFAULT_WALLET_CHAIN, type UserWalletRecord, type WalletChain } from '../database/types.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { createAuditLog } from '../audit/audit.service.js';
import { getWalletProvider } from './provider/provider-registry.js';
import { resolveActiveWalletProvider } from './wallet-controls.service.js';
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

/**
 * Who may be issued a wallet.
 *
 * REPLACES a gate that required a Bridge customer with kycStatus
 * 'kyc_approved' and a providerCustomerId. That was wrong for two reasons:
 *
 *   1. It cost $2. Bridge bills per KYC, so provisioning a wallet forced a
 *      Bridge onboarding even for a user who would only ever hold USDC and
 *      off-ramp to naira - a flow Bridge plays no part in.
 *
 *   2. It coupled the wallet to KYC. A wallet address is not a financial
 *      permission; it is somewhere to receive tokens. What a user may DO with
 *      what arrives is decided at the point of action by verification level
 *      and the ledger. Coupling the two is why every KYC-approved record in
 *      production carries a mock_cust_* id and Receive 404s for all of them.
 *
 * Sivan's own Level 1 decides instead: a payout bank account that resolved to
 * a real account name. Since the CBN directive effective 1 March 2024 a
 * Nigerian bank account cannot transact without BVN/NIN linkage, so an account
 * that resolves is one a licensed bank has already verified.
 *
 * The Bridge customer is still REQUIRED for Bridge's own custodial wallets,
 * because their API is customer-scoped - there is nowhere to put a wallet
 * without one. That requirement belongs to the provider, not to Sivan, so it
 * is checked per provider rather than for everybody.
 */
async function requireWalletEligibility(userId: string, providerName: string) {
  const data = await db.read();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw notFound('User');

  const state = await getVerificationState(userId);
  const eligibility = canProvisionWallet(state);
  if (!eligibility.eligible) throw badRequest(eligibility.reason);

  const customer = data.customers.find((item) => item.userId === userId);

  if (providerName === 'bridge') {
    if (!customer?.providerCustomerId) {
      throw badRequest('Bridge wallets require a Bridge customer. Complete verification first.');
    }
    if (!isApprovedKycStatus(customer.kycStatus)) {
      throw badRequest('Bridge requires approved verification before a wallet can be created.');
    }
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

  const provider = getWalletProvider(await resolveActiveWalletProvider());
  const { customer } = await requireWalletEligibility(userId, provider.name);

  if (!provider.supportedChains.includes(chain)) {
    throw badRequest(`${chain} wallets are not supported by the current provider`);
  }

  const providerWallet = await provider.createWallet({
    userId,
    providerCustomerId: customer?.providerCustomerId,
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
    customerId: customer?.id,
    provider: providerWallet.provider,
    providerWalletId: providerWallet.providerWalletId,
    chain: providerWallet.chain,
    address: providerWallet.address,
    status: providerWallet.status,
    custodial: providerWallet.custodyModel === 'custodial',
    // Recorded from what the provider actually returned. Immutable at Privy,
    // so this is a permanent property of the wallet, not of the provider.
    delegatedSigningEnabled: providerWallet.delegatedSigningEnabled ?? false,
    delegatedSignerId: providerWallet.delegatedSignerId,
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

  const provider = getWalletProvider(await resolveActiveWalletProvider());

  // undefined means "could not load", [] means "loaded, and it is genuinely
  // zero". Collapsing the two would show a confirmed $0.00 to a user whose
  // funds are fine and whose provider is merely unreachable.
  let balances: Array<{ asset: string; chain: string; amount: string }> | undefined;
  let balancesUnavailable = false;
  try {
    // address and chain are passed because Privy cannot answer without them -
    // it is a key manager, not an indexer, so the balance is read from an RPC
    // against this specific address on this specific network. Bridge and Mock
    // ignore the extra arguments.
    balances = await provider.getBalances(
      wallet.providerWalletId,
      wallet.customerId,
      wallet.address,
      wallet.chain
    );
  } catch (error) {
    // A provider outage must not blank the deposit address. The user can still
    // receive funds; only the balance figure is unavailable.
    //
    // Logged rather than swallowed silently: this branch is now reachable via a
    // rate-limited or misconfigured RPC, and an operator seeing "balance
    // unavailable" reports needs to know which endpoint failed and why.
    console.warn('[wallet.balances_unavailable]', {
      userId,
      chain: wallet.chain,
      provider: provider.name,
      reason: error instanceof Error ? error.message : String(error),
    });
    balances = undefined;
    balancesUnavailable = true;
  }

  return {
    ...wallet,
    balances,
    balancesUnavailable,
    acceptedAssets: assetsForChain(wallet.chain),
  };
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
