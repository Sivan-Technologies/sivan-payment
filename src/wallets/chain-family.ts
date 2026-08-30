/**
 * WHICH WALLET SERVES WHICH NETWORK.
 *
 * One line of code caused a user's 10 USDC send to sit "held" forever:
 *
 *   const walletChain = transfer.network === 'solana' ? 'solana' : 'ethereum';
 *   const wallet = await db.findUserWallet(userId, walletChain);
 *
 * findUserWallet matches `chain` EXACTLY. Every real wallet in this deployment
 * is stored as `chain: 'base'` - verified against the live audit log on
 * api-test, both `wallet.created` events read {"chain":"base"}. So a Base
 * transfer looked for an 'ethereum' row, found nothing, and took the "no
 * wallet - this is pooled custody, a human must pay it out" branch. The hold
 * stayed on the ledger, the money never moved, and the UI showed a transfer
 * that was neither sent nor refused.
 *
 * The underlying truth: Base and Ethereum are the SAME secp256k1 key at the
 * SAME 0x address. Privy issues one `ethereum` chain_type wallet for both
 * (CHAIN_TYPE in privy-wallet.provider.ts maps base -> ethereum). Which Sivan
 * chain string got written to the row depends on which code path provisioned
 * it, and that is an implementation detail that must never decide whether a
 * user can spend their money.
 *
 * So: never match a wallet by one literal chain name. Match by FAMILY.
 */

export type ChainFamily = 'evm' | 'solana' | 'stellar';

/** Sivan chain names that share one secp256k1 key and one 0x address. */
export const EVM_CHAINS = ['ethereum', 'base', 'celo', 'bsc', 'bnb'] as const;

export function chainFamily(chain: string): ChainFamily {
  const normalized = String(chain).toLowerCase().trim();
  if (normalized === 'solana') return 'solana';
  if (normalized === 'stellar') return 'stellar';
  return 'evm';
}

/**
 * Every network a stored wallet row can actually sign for.
 */
export function networksServedByWallet(walletChain: string): string[] {
  const family = chainFamily(walletChain);
  if (family === 'solana') return ['solana'];
  if (family === 'stellar') return ['stellar'];
  return [...EVM_CHAINS];
}

/**
 * Can this stored wallet sign a transfer on this network?
 */
export function walletServesNetwork(walletChain: string, network: string): boolean {
  return chainFamily(walletChain) === chainFamily(network);
}
