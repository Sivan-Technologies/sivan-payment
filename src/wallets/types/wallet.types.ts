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
}

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
  txHash?: string;
  rawProviderPayload?: unknown;
}
