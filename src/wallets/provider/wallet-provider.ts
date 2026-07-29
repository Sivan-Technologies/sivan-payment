import type {
  CreateWalletInput,
  ProviderWallet,
  WalletBalance,
  WalletCustodyModel,
  WalletProviderName,
  WalletTransfer,
  WalletTransferInput,
} from '../types/wallet.types.js';

/**
 * Contract every wallet provider adapter must satisfy.
 *
 * Services and routes must depend on this interface only. Swapping Bridge for
 * Privy (or adding another vendor) should require changing the registry and
 * one env var, nothing else.
 */
export interface WalletProvider {
  readonly name: WalletProviderName;

  /**
   * Whether this provider holds user funds and keys. Exposed because the
   * answer changes Sivan's regulatory posture and what the UI is allowed to
   * claim, so it must not be hidden inside the adapter.
   */
  readonly custodyModel: WalletCustodyModel;

  /** Chains this adapter can currently issue wallets on. */
  readonly supportedChains: readonly string[];

  createWallet(input: CreateWalletInput): Promise<ProviderWallet>;

  getWallet(providerWalletId: string, providerCustomerId?: string): Promise<ProviderWallet>;

  listWallets(providerCustomerId: string): Promise<ProviderWallet[]>;

  getBalances(providerWalletId: string, providerCustomerId?: string): Promise<WalletBalance[]>;

  /**
   * Move funds out of the wallet.
   *
   * Custodial providers execute server-side and return `submitted`.
   * Non-custodial providers may return `pending_user_signature` with a
   * payload the client must sign — callers must handle both.
   */
  createTransfer(input: WalletTransferInput): Promise<WalletTransfer>;

  getTransfer(providerTransferId: string): Promise<WalletTransfer>;
}
