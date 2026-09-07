import { db } from '../database/json-database.js';
import { canProvisionWallet } from './wallet-eligibility.js';
import { getVerificationState } from '../kyc/service/verification-state.js';
import { isApprovedKycStatus } from '../kyc/types/verification.types.js';
import { DEFAULT_WALLET_CHAIN, type UserWalletRecord, type WalletChain, type UserRecord } from '../database/types.js';
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
  let user: UserRecord | undefined = data.users.find((item) => item.id === userId);
  if (!user) {
    const link = (data.customerIdentityLinks || []).find((l) => l.paymentUserId === userId);
    user = await db.insertUserRecord({
      id: userId,
      email: link?.email || `${userId}@sivan.user`,
      fullName: link?.email?.split('@')[0] || `${userId}`,
      telegramUserId: link?.telegramUserId,
      whatsappNumber: link?.whatsappNumber,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }).catch(async () => {
      return (await db.findUserById(userId)) || { id: userId, email: `${userId}@sivan.user`, fullName: `${userId}`, createdAt: nowIso(), updatedAt: nowIso() };
    });
  }

  const state = await getVerificationState(userId);
  const eligibility = canProvisionWallet(state);
  if (!eligibility.eligible) throw badRequest(eligibility.reason);

  const customer = data.customers.find((item) => item.userId === userId);

  /**
   * THE CONDITION WAS MISSING, AND THIS REFUSED EVERYONE.
   *
   * This read `if (providerName === 'bridge') {` with no eligibility test at
   * all, so EVERY Bridge wallet request threw - including for a customer
   * Bridge had fully approved. The `reason` string below computes a careful
   * distinction between "no Bridge customer" and "not approved (status: X)"
   * that nothing ever branched on: the log line always fired and the throw
   * always followed.
   *
   * Found while fixing virtual-account provisioning, which cannot work without
   * a Bridge wallet: the error said "Bridge has not approved this customer
   * (status: kyc_approved)" - a message that contradicts itself, and the
   * clearest possible sign the check had been lost rather than intended.
   *
   * The refusal itself is right and stays: a user with no Bridge customer, or
   * an unapproved one, genuinely cannot be issued a Bridge wallet, and
   * silently falling back to another custodian is not a request handler's
   * decision to make. It now only fires when one of those is actually true.
   */
  const bridgeCustomerUsable = Boolean(customer?.providerCustomerId) && isApprovedKycStatus(customer?.kycStatus);
  if (providerName === 'bridge' && !bridgeCustomerUsable) {
    /**
     * A PROVIDER LIMIT THAT NO NIGERIAN-BANK USER CAN EVER CLEAR.
     *
     * Reported from production, twice:
     *   POST /api/users/:id/wallets  400
     * for a user who verified with a Nigerian bank and is correctly Level 1.
     *
     * Traced by evaluating the gates directly. Sivan's own gate PASSES:
     *   canProvisionWallet(level=BANK, bankStatus=VERIFIED)
     *     -> { eligible: true, code: 'eligible' }
     * Then this block refuses, because the NGN path never creates a Bridge
     * customer - that is the entire point of the path. isApprovedKycStatus()
     * is false for undefined, kyc_not_started, kyc_incomplete and
     * kyc_under_review; only kyc_approved passes.
     *
     * So with WALLET_PROVIDER=bridge, EVERY Nigerian who verified by bank hits
     * a permanent dead end. Not a misconfigured user - a wallet provider that
     * structurally cannot serve the platform's main verification path.
     *
     * The old messages made this undiagnosable. They told a user who HAD
     * finished verification to go and finish verification, and named no
     * provider, so the obvious reading was "your KYC is broken" when the truth
     * is "this deployment points at the wrong wallet provider".
     *
     * Deliberately NOT auto-falling back to Privy here. Which provider
     * custodies user funds is not a decision a request handler should make
     * silently. It is an operator decision, so this states precisely what an
     * operator must change, and operational-health surfaces it BEFORE a user
     * ever meets it.
     */
    const reason = !customer?.providerCustomerId
      ? 'this account has no Bridge customer record'
      : `Bridge has not approved this customer (status: ${customer.kycStatus ?? 'none'})`;
    console.error('[wallet.provider_cannot_serve_user]', {
      userId,
      provider: 'bridge',
      reason,
      sivanEligible: true,
      fix: 'Set the active wallet provider to privy (PUT /api/admin/wallets/controls) or complete Bridge onboarding for this user.',
    });
    throw badRequest(
      'Deposit addresses are temporarily unavailable on this account. Our team has been notified - please try again shortly or contact support.'
    );
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

  // If chain is EVM-based, check if the user already holds an EVM wallet (Base/Ethereum/Celo/BSC)
  if (['base', 'celo', 'bsc', 'bnb', 'ethereum'].includes(chain)) {
    const evmWallet = await db.findUserWallet(userId, 'base')
      || await db.findUserWallet(userId, 'ethereum')
      || await db.findUserWallet(userId, 'celo')
      || await db.findUserWallet(userId, 'bsc');
    if (evmWallet) {
      const now = nowIso();
      const record: UserWalletRecord = {
        ...evmWallet,
        id: id('uw'),
        chain,
        createdAt: now,
        updatedAt: now,
      };
      return await db.insertUserWallet(record);
    }
  }

  if (chain === 'stellar') {
    const { generateStellarAddress } = await import('./stellar/stellar-keypair.js');
    const { ensureStellarAccountAndTrustline } = await import('./stellar/trustline.js');
    const address = generateStellarAddress('sivan_stellar_' + userId);
    const now = nowIso();
    const record: UserWalletRecord = {
      id: id('uw'),
      userId,
      customerId: customer?.id,
      provider: 'stellar_native',
      providerWalletId: `stellar_${address}`,
      chain: 'stellar',
      address,
      status: 'active',
      custodial: false,
      delegatedSigningEnabled: true,
      raw: { address, chain: 'stellar', trustlineActive: true },
      createdAt: now,
      updatedAt: now,
    };
    const saved = await db.insertUserWallet(record);
    ensureStellarAccountAndTrustline('sivan_stellar_' + userId, address).catch((err) => {
      console.warn('[user-wallet.stellar_trustline_bg_error]', err);
    });
    return saved;
  }

  const targetChain = chain === 'solana' ? 'solana' : 'ethereum';
  const providerWallet = await provider.createWallet({
    userId,
    providerCustomerId: customer?.providerCustomerId,
    chain: targetChain as WalletChain,
    idempotencyKey: `sivan-wallet-${userId}-${chain}`,
  });

  const now = nowIso();
  const record: UserWalletRecord = {
    id: id('uw'),
    userId,
    customerId: customer?.id,
    provider: providerWallet.provider,
    providerWalletId: providerWallet.providerWalletId,
    chain,
    address: providerWallet.address,
    status: providerWallet.status,
    custodial: providerWallet.custodyModel === 'custodial',
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

  if (wallet.chain === 'stellar') {
    const { ensureStellarAccountAndTrustline } = await import('./stellar/trustline.js');
    ensureStellarAccountAndTrustline('sivan_stellar_' + userId, wallet.address).catch(() => null);
  }

  const activeProviderName = await resolveActiveWalletProvider();
  const provider = getWalletProvider(wallet.provider ?? activeProviderName);

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
/**
 * THE WALLET A VIRTUAL ACCOUNT CAN ACTUALLY SETTLE INTO.
 *
 * This used to be `ensureUserWallet(...).providerWalletId`, which returns
 * whatever the ACTIVE provider issues. On a Privy deployment that is a Privy
 * wallet id - and Bridge's `bridge_wallet_id` field only accepts Bridge's own
 * ids. So every virtual-account provisioning attempt on a Privy deployment was
 * doomed: the request looked well-formed, Bridge rejected it, and
 * bridge-virtual-account.provider.ts had to grow a guard just to turn the
 * confusing provider error into a readable one.
 *
 * The guard was right and the caller was wrong. Refusing clearly is better
 * than failing obscurely, but neither issues the wallet that would work.
 *
 * A USER MAY HOLD BOTH WALLETS, and that is the agreed custody model:
 * deposits land in Privy, virtual-account settlement lands in Bridge, and the
 * user can spend from either. `findUserWallet` matches on CHAIN ALONE, so a
 * user with a Privy Solana wallet could never acquire a Bridge Solana one -
 * the row already existed, so provisioning was skipped and the Privy id was
 * handed to Bridge. This looks for a wallet from the RIGHT ISSUER and
 * provisions one when it is missing.
 *
 * NOT GATED ON THE ACTIVE PROVIDER, deliberately. The active provider decides
 * where NEW USER wallets come from; this is a settlement requirement of one
 * specific rail, and tying it to a global toggle is what coupled these two
 * unrelated decisions in the first place.
 */
export async function resolveSettlementWalletId(userId: string, chain: WalletChain = DEFAULT_CHAIN): Promise<string> {
  const wallet = await ensureSettlementWallet(userId, chain);
  return wallet.providerWalletId;
}

/**
 * Find or create this user's BRIDGE wallet on `chain`.
 *
 * Separate from ensureUserWallet() because the question is different: that one
 * asks "does this user have a wallet", this one asks "does this user have a
 * wallet BRIDGE WILL ACCEPT AS A SETTLEMENT DESTINATION".
 */
export async function ensureSettlementWallet(userId: string, chain: WalletChain = DEFAULT_CHAIN): Promise<UserWalletRecord> {
  const existing = (await db.listUserWallets(userId)).find(
    (w) => w.chain === chain
      && String(w.provider ?? '').toLowerCase() === 'bridge'
      && w.status !== 'closed'
  );
  if (existing) return existing;

  /**
   * FALL BACK TO WHATEVER EXISTS WHEN BRIDGE WALLETS ARE NOT AVAILABLE.
   *
   * On a mock or Privy-only deployment there is no Bridge wallet to issue, and
   * throwing here would break the local test path and every mock journey. The
   * downstream guard in bridge-virtual-account.provider.ts still refuses a
   * non-Bridge wallet against the REAL provider, so this cannot leak a wrong
   * id into a live Bridge request - it only avoids failing before we get
   * there.
   */
  /**
   * RESPECT MOCK MODE.
   *
   * getWalletProvider('bridge') builds a REAL Bridge client regardless of
   * BRIDGE_MOCK_MODE, so asking for one by name inside a mock harness produced
   * a genuine Bridge wallet id attached to a mock customer - and the next call
   * that used it got a live 404 "Customer not found with id mock_cust_...".
   * Caught by test:supplier-payments immediately after this function started
   * naming the provider explicitly.
   *
   * When the deployment is mocked there is no meaningful Bridge/Privy
   * distinction to preserve, so the ordinary wallet is the right answer.
   */
  if (String(process.env.BRIDGE_MOCK_MODE ?? '').toLowerCase() === 'true') {
    return ensureUserWallet(userId, chain);
  }

  let provider;
  let customer;
  try {
    provider = getWalletProvider('bridge');
    // ELIGIBILITY IS PART OF AVAILABILITY.
    //
    // Bridge refuses to issue a wallet for a customer it has not approved for
    // wallets - a real provider precondition, distinct from KYC approval. That
    // is not an error in this path; it just means a Bridge settlement wallet
    // cannot be had right now, which is exactly what the fallback below is
    // for. Caught rather than propagated so a legitimate "not yet" does not
    // surface to an operator as "Deposit addresses are temporarily
    // unavailable".
    ({ customer } = await requireWalletEligibility(userId, provider.name));
    if (!provider.supportedChains.includes(chain)) {
      throw badRequest(`${chain} settlement wallets are not supported by Bridge.`);
    }
  } catch {
    /**
     * FALL BACK TO THE USER'S ORDINARY WALLET.
     *
     * Three reasons this cannot leak a wrong id into a live Bridge request:
     * the guard in bridge-virtual-account.provider.ts still refuses any
     * non-Bridge wallet before the API call; a mock deployment never reaches
     * Bridge at all; and on a real deployment where Bridge HAS approved the
     * customer, this branch is not taken.
     *
     * The alternative - throwing - would make every mock and Privy-only
     * environment unable to provision a virtual account, which is how the
     * original bug went unnoticed for so long.
     */
    return ensureUserWallet(userId, chain);
  }

  const providerWallet = await provider.createWallet({
    userId,
    providerCustomerId: customer?.providerCustomerId,
    chain,
    // Deterministic and DISTINCT from the ensureUserWallet key, so a user who
    // already has a Privy wallet on this chain does not have the retry
    // collapse onto it. Same reason that key is deterministic: a retry must
    // return the existing wallet rather than provision (and bill for) a
    // second one.
    idempotencyKey: `sivan-settlement-wallet-${userId}-${chain}`,
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
    delegatedSigningEnabled: providerWallet.delegatedSigningEnabled ?? false,
    delegatedSignerId: providerWallet.delegatedSignerId,
    raw: providerWallet.rawProviderPayload,
    createdAt: now,
    updatedAt: now,
  };
  return db.insertUserWallet(record);
}
