import { env } from '../config/env.js';
import type { NetworkMode, WalletChain } from '../database/types.js';

/**
 * Where mainnet-vs-testnet is decided.
 *
 * It is a property of the DEPLOYMENT, not of a user. Sivan runs two complete
 * stacks - a test frontend against the test API, and app.sivantech.online
 * against the live API - and they are already separated at the provider layer
 * (Bridge sandbox vs live, PAJ staging vs production). This makes the chain
 * layer match: the test deployment signs against testnet, the live one against
 * mainnet, and neither can be talked into the other.
 *
 * That is the point of pinning it here rather than offering a switch. There is
 * no request a client can send, and no row it can write, that moves a
 * production user onto testnet - the capability does not exist in that process.
 * An earlier version stored this per-user with a server-side ceiling; the
 * ceiling worked, but a control that is always refused in production is a
 * control worth deleting.
 */

export const DEFAULT_NETWORK_MODE: NetworkMode = 'mainnet';

/**
 * The network this deployment signs against.
 *
 * Deliberately NOT derived from APP_ENV. Keeping it a separate variable means a
 * future staging box can point at mainnet without having to claim it is
 * production, and - more practically - a reader of render.yaml sees the word
 * `testnet` next to the test service instead of having to infer it.
 *
 * Defaults to mainnet, so a deployment that forgets to set it gets real money
 * and the safety rails that go with it. The opposite default would sign a
 * user's genuine transfer onto a chain nobody is watching.
 */
export function resolveNetworkMode(): NetworkMode {
  return env.NETWORK_MODE === 'testnet' ? 'testnet' : DEFAULT_NETWORK_MODE;
}

/** True when this mode moves real money. Read as: refuse fiat if not. */
export function isMainnet(mode: NetworkMode): boolean {
  return mode === 'mainnet';
}

/**
 * What each chain calls its test network.
 *
 * Solana says devnet, Base and Ethereum say Sepolia. A single "Testnet" label
 * would be wrong on two of the three chains and would send someone hunting for
 * a Base devnet faucet that does not exist.
 *
 * Note the CAIP-2 map in privy-wallet.provider.ts keys Solana's entry as
 * `testnet` while its genesis hash is in fact DEVNET's. The label below follows
 * the chain the code actually signs against, not the key it is stored under.
 */
const TESTNET_LABELS: Record<WalletChain, string> = {
  solana: 'Devnet',
  base: 'Base Sepolia',
  ethereum: 'Sepolia',
  stellar: 'Testnet',
  celo: 'Alfajores',
};

export function networkLabel(mode: NetworkMode, chain: WalletChain): string {
  return mode === 'mainnet' ? 'Mainnet' : TESTNET_LABELS[chain] ?? 'Testnet';
}

/**
 * Guard for anything that touches real money: fiat payout, off-ramp, naira.
 *
 * Testnet tokens come from a faucet and have no value. Letting a testnet
 * balance reach an off-ramp would pay out real naira against nothing, so these
 * flows refuse rather than trying to convert.
 */
export function assertMainnetForFiat(mode: NetworkMode, operation: string): void {
  if (isMainnet(mode)) return;
  throw new Error(
    `${operation} is unavailable on testnet. Testnet tokens have no value and cannot be converted to fiat. ` +
    `Use the production app to move real funds.`
  );
}
