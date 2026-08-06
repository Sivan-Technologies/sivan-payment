import type { NetworkMode } from '../../database/types.js';
import type {
  CreateWalletInput,
  ProviderWallet,
  WalletBalance,
  WalletChain,
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

  /**
   * Live balances for a wallet.
   *
   * `address` and `chain` are optional for backward compatibility with Bridge
   * and Mock, which read balances through their own APIs. Privy needs them to
   * make RPC calls, since Privy is a key manager and does not index balances.
   */
  getBalances(
    providerWalletId: string,
    providerCustomerId?: string,
    address?: string,
    chain?: WalletChain,
    /**
     * WHICH NETWORK TO READ. Passed, not inferred.
     *
     * createTransfer already takes a per-request networkMode and picks its
     * CAIP-2 chain id from it, while this read fell back to a process-wide
     * resolveNetworkMode(). The two could therefore disagree about the same
     * wallet: a transfer signed on Base Sepolia, a balance queried on Base
     * mainnet. Observed - a user held 20 USDC on Base Sepolia and every read
     * returned 0, because the mainnet USDC contract was queried instead.
     *
     * That is not only a wrong number on a dashboard. getSpendable() feeds the
     * off-ramp sweep, so a testnet balance reading as zero makes the sweep skip
     * with insufficient_spendable and silently leaves the user to send the
     * crypto by hand.
     *
     * Optional so Bridge and Mock, which index balances themselves, are
     * unaffected.
     */
    networkMode?: NetworkMode
  ): Promise<WalletBalance[]>;

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
