/**
 * Provider-agnostic wallet types.
 *
 * Sivan must be able to switch the wallet provider by configuration alone.
 * Two candidates today:
 *
 *   bridge — custodial. Bridge holds the keys and the funds. Simplest
 *            operationally (they handle gas and sweeping) but Sivan must
 *            confirm this is compatible with Bridge ToS 2.1(m) if Sivan also
 *            keeps balance records.
 *
 *   privy  — non-custodial embedded wallets. The user controls the key, so
 *            Sivan holds neither funds nor keys, which sits more cleanly
 *            inside Bridge ToS 2.1(m). Cost is per monthly-active wallet
 *            rather than per created wallet.
 *
 * Business logic must depend only on this file and `WalletProvider`, never on
 * a specific vendor SDK.
 */

import type { NetworkMode } from '../../database/types.js';

export type WalletProviderName = 'mock' | 'bridge' | 'privy';


/**
 * Chains Sivan may issue wallets on. Intersection of what Bridge Custodial
 * Wallets support and what Sivan enables in payment controls.
 * See CHAIN_ASSET_SUPPORT in src/controls/payment-controls.service.ts.
 */
export type WalletChain = 'solana' | 'base' | 'ethereum';

export type WalletAsset = 'usdc' | 'usdt';

export type WalletStatus =
  | 'provisioning'
  | 'active'
  | 'suspended'
  | 'closed'
  | 'failed';

/**
 * Custody model, surfaced so the UI and compliance reporting can state
 * plainly who holds the funds. This is a regulatory-relevant distinction,
 * not an implementation detail.
 */
export type WalletCustodyModel = 'custodial' | 'non_custodial';

export interface WalletBalance {
  asset: WalletAsset;
  chain: WalletChain;
  /**
   * Decimal string, NOT a number. Bridge expresses amounts in whole US cents
   * (2dp); other providers may differ. Keeping this a string avoids float
   * drift and lets the persistence layer choose its own precision.
   */
  amount: string;
  /** Token contract / mint address the balance was read from, when known. */
  contractAddress?: string;
}

/** A wallet as returned by a provider, before Sivan persists it. */
export interface ProviderWallet {
  provider: WalletProviderName;
  providerWalletId: string;
  chain: WalletChain;
  /** The on-chain address a user can be shown and can deposit to. */
  address: string;
  custodyModel: WalletCustodyModel;
  status: WalletStatus;
  /**
   * True when the provider requires an explicit user signature (or a
   * delegated session signer) before funds can move out. Non-custodial
   * providers set this; the UI must then prompt the user to sign rather
   * than promising an automatic transfer.
   */
  requiresUserSignature: boolean;
  /**
   * Whether Sivan can move funds from this wallet without the user present.
   *
   * NOT a property of the provider - a property of THIS wallet. Privy attaches
   * additional signers at creation and refuses to add one afterwards: a PATCH
   * must be signed by the wallet's OWNER, which is the user, and Sivan has no
   * way to produce that signature. Verified live - both an app-credentialled
   * PATCH and one signed by the key being added return 401.
   *
   * So two wallets from the same provider can differ permanently, and the
   * difference decides whether off-ramp is one tap or a manual send. It has to
   * be stored rather than inferred from the provider name.
   */
  delegatedSigningEnabled?: boolean;
  /** The key quorum acting as signer, when there is one. */
  delegatedSignerId?: string;
  balances?: WalletBalance[];
  rawProviderPayload?: unknown;
  createdAt?: string;
}

export interface CreateWalletInput {
  userId: string;
  /** Provider-side customer identifier, e.g. Bridge customer id. */
  providerCustomerId?: string;
  chain: WalletChain;
  /**
   * Caller-supplied idempotency key. Bridge requires an Idempotency-Key
   * header on wallet creation; providers that do not should ignore it.
   */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * Move funds out of a Sivan-issued wallet to an arbitrary address.
 *
 * The primary use is off-ramp: send to a Bridge liquidation address that
 * auto-converts to the user's verified bank account.
 */
export interface WalletTransferInput {
  providerWalletId: string;
  providerCustomerId?: string;
  asset: WalletAsset;
  chain: WalletChain;
  /** Decimal string. */
  amount: string;
  toAddress: string;
  idempotencyKey: string;
  reference?: string;
  /**
   * Sivan's fee on this transfer, collected in the SAME on-chain transaction.
   *
   * `amount` above is already the NET the recipient receives; this is the
   * portion Sivan keeps. Optional, and ignored by every provider except the
   * Solana path - EVM cannot batch two ERC-20 transfers as cheaply, so those
   * chains still leave the fee in the user's wallet.
   */
  feeAmount?: string;
  /**
   * Which network to sign against, already resolved by the server.
   *
   * Optional so existing callers keep their previous APP_ENV-derived behaviour
   * unchanged. Anything passing this must pass the OUTPUT of
   * resolveNetworkMode(), never a preference value read straight from the
   * database - the difference is whether the server has agreed to testnet or
   * merely been asked for it.
   */
  networkMode?: NetworkMode;
}


/**
 * A sponsored EVM transfer is an ERC-4337 user operation, so it has a user
 * operation hash BEFORE it has a transaction hash - the latter does not exist
 * until a bundler includes it on chain. Modelled separately because treating
 * them as one field is what produced empty transaction ids.
 */
export type WalletTransferStatus =
  | 'pending_user_signature'
  | 'submitted'
  | 'confirmed'
  | 'failed';

export interface WalletTransfer {
  provider: WalletProviderName;
  providerTransferId: string;
  status: WalletTransferStatus;
  /**
   * Present when the provider cannot complete the transfer server-side and
   * needs the user to sign in the client. Non-custodial providers use this.
   */
  userSignaturePayload?: unknown;
  /**
   * The on-chain transaction hash. ABSENT on a freshly sponsored transfer.
   *
   * A sponsored EVM transfer is an ERC-4337 user operation: it is accepted by
   * a bundler first and only gets a transaction hash once included on chain.
   * Privy returns `hash: ""` in the meantime, and an empty string here would
   * read as "we have a hash" to every caller.
   */
  txHash?: string;
  /**
   * The user operation hash, present instead of txHash while sponsored.
   *
   * This is the only identifier a sponsored transfer has at submit time, so it
   * is what reconciliation must key on until the transaction lands.
   */
  userOperationHash?: string;
  /** True when a paymaster covered gas rather than the wallet. */
  sponsored?: boolean;
  rawProviderPayload?: unknown;
}
