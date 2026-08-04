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

export type ChainFamily = 'evm' | 'solana';

/** Sivan chain names that share one secp256k1 key and one 0x address. */
export const EVM_CHAINS = ['ethereum', 'base'] as const;

export function chainFamily(chain: string): ChainFamily {
  return String(chain).toLowerCase() === 'solana' ? 'solana' : 'evm';
}

/**
 * Every network a stored wallet row can actually sign for.
 *
 * REPLACES walletsToProvision().find(entry => entry.chain === wallet.chain)
 * in unified-balance.service.ts, which returned undefined for a row stored as
 * 'base' - walletsToProvision only lists 'ethereum' and 'solana'. The balance
 * reader therefore never looked at Ethereum for a Base-filed wallet, and never
 * looked at Base for an Ethereum-filed one. Which of those two blind spots you
 * hit was pure luck of provisioning order.
 */
export function networksServedByWallet(walletChain: string): string[] {
  return chainFamily(walletChain) === 'solana' ? ['solana'] : [...EVM_CHAINS];
}

/**
 * Can this stored wallet sign a transfer on this network?
 *
 * The question every send path should ask, instead of guessing a chain string
 * and hoping the row was filed under the same one.
 */
export function walletServesNetwork(walletChain: string, network: string): boolean {
  return chainFamily(walletChain) === chainFamily(network);
}
