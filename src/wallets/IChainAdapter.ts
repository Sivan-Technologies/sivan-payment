/**
 * SIVAN MULTI-CHAIN ADAPTER INTERFACE (IChainAdapter)
 *
 * Gold-standard adapter specification for blockchain network integrations.
 * Decouples high-level service agreement and payment orchestration from
 * network-specific RPC clients, transaction builders, and signing mechanisms.
 *
 * Every supported chain (Solana, Base, Stellar, Celo) implements this contract.
 */

export interface ChainTransferParams {
  fromUserId: string;
  toAddress: string;
  amountUsdc: number;
  idempotencyKey: string;
  asset?: 'usdc' | 'usdt' | 'cusd' | 'cngn';
  memo?: string;
  /**
   * Sivan protocol fee to collect atomically alongside the recipient payment.
   * Passed as a string (e.g. "0.10") matching the quote from quoteTransfer().
   * If omitted or zero, only the recipient transfer is executed.
   */
  feeAmount?: string;
}

export interface ChainTransferResult {
  txHash: string;
  explorerUrl?: string;
  network: string;
  feePaid?: string;
  blockHeight?: number;
  timestamp: string;
}

export interface ChainBalanceResult {
  asset: string;
  amount: number;
  rawAmount: string;
  contractAddress?: string;
  chain: string;
}

export interface IChainAdapter {
  /** Identifier of the chain (e.g., 'solana', 'base', 'stellar', 'celo') */
  readonly chain: string;

  /**
   * Return or derive the user's deposit address on this chain.
   */
  getDepositAddress(userId: string): Promise<string>;

  /**
   * Read the real on-chain spendable balance for a user.
   */
  getBalance(userId: string, asset?: string): Promise<number>;

  /**
   * Execute an on-chain transfer with strict idempotency and transaction hash return.
   */
  transfer(params: ChainTransferParams): Promise<ChainTransferResult>;

  /**
   * Validate whether a destination address format is syntactically valid for this chain.
   */
  validateAddress(address: string): boolean;

  /**
   * Health check to ensure the chain RPC endpoint is live and responsive.
   */
  isHealthy(): Promise<boolean>;
}
