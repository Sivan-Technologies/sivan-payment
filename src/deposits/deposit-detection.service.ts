import { db } from '../database/json-database.js';
import { env } from '../config/env.js';
import { getWalletProvider } from '../wallets/provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallets/wallet-controls.service.js';
import { networksServedByWallet } from '../wallets/chain-family.js';
import { recordDeposit, depositIdempotencyKey } from './deposit.service.js';
import type { WalletChain } from '../wallets/types/wallet.types.js';

/**
 * DETECTOR: BALANCE POLLING WITH A DIFF.
 *
 * The first of several. Everything vendor-aware about deposit detection lives
 * above the `recordDeposit` seam, and this file is that layer for the polling
 * strategy. Replacing it with an Alchemy/Helius webhook changes this file and
 * nothing below it.
 *
 * WHY POLLING FIRST, GIVEN IT IS THE CRUDEST OPTION
 *
 * An exchange withdrawal takes minutes to arrive on chain. A 60-second poll is
 * therefore not the weak link in that experience, and polling needs no vendor
 * account, no contract and no new inbound surface to secure. It gets deposit
 * records, feed rows and notifications shipped before launch. The upgrade path
 * is real work but it is confined to one file.
 *
 * WHAT THIS DETECTOR CANNOT DO, STATED PLAINLY
 *
 *   - No transaction hash. A balance delta is not a transaction, so the record
 *     has no txHash and the UI can offer no block-explorer link. blockExplorer
 *     .ts already handles a missing hash by rendering no link.
 *   - No sender. We know money arrived, not who sent it.
 *   - Two deposits inside one tick merge into one record with the combined
 *     amount. See depositIdempotencyKey for why that is the safe direction.
 *   - A deposit and a withdrawal inside one tick can cancel out and be missed
 *     entirely. Mitigated below by only ever acting on an INCREASE, and by the
 *     fact that outbound sends are recorded separately as balance transfers.
 *
 * All four disappear when detection moves to webhooks. None of them is worse
 * than the current behaviour, which is to say nothing at all.
 */

/**
 * WHICH ASSETS ARE WATCHED.
 *
 * USDC and USDT. USDT is at least as common as USDC on Nigerian exchanges, so
 * watching only USDC would miss a large share of real deposits - and a missed
 * deposit is the exact support ticket this feature exists to prevent.
 *
 * Not "every asset the wallet holds": that multiplies RPC calls per wallet and
 * invites dust and airdropped spam tokens to generate notification rows, which
 * trains users to ignore deposit alerts. A deliberate allow-list.
 */
const WATCHED_ASSETS = new Set(['USDC', 'USDT']);

/**
 * Six decimals. Both USDC and USDT use six on every chain we support, and the
 * rest of the codebase already settled on this precision.
 */
const money = (value: number) => (Math.round(value * 1e6) / 1e6).toFixed(6);

const num = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The smallest delta worth calling a deposit.
 *
 * Floating point across two reads of the same unchanged balance can differ in
 * the last decimal place, and an RPC that rounds differently between calls
 * would otherwise manufacture a stream of 0.000001 "deposits". One cent of a
 * six-decimal stablecoin is below any real transfer and safely above noise.
 */
const MIN_DEPOSIT = 0.01;

export interface DepositScanOutcome {
  walletsScanned: number;
  depositsRecorded: number;
  /** Wallets whose balance could not be read. NOT treated as zero. */
  unreadable: number;
  recorded: Array<{ userId: string; asset: string; amount: string; chain: string }>;
}

/**
 * In-memory record of the last balance seen per (wallet, chain, asset).
 *
 * NOT PERSISTED, AND THAT IS A DELIBERATE CHOICE WITH A REAL CONSEQUENCE.
 *
 * On restart this map is empty, so the first tick after a deploy establishes a
 * baseline and records NOTHING. Any deposit that arrived while the process was
 * down is therefore never announced.
 *
 * The alternative - persisting the baseline and diffing across restarts - is
 * worse in the failure mode that matters. A stale persisted baseline combined
 * with a legitimate outbound send produces a phantom deposit for the difference,
 * and telling a user they received money they did not receive is a far more
 * damaging error than staying quiet about one they did.
 *
 * The real fix is webhooks, which have no baseline at all. Until then this is
 * a known gap, and it is bounded: Render restarts are infrequent and the
 * balance itself is never wrong, only the notification is missed.
 */
const lastSeen = new Map<string, number>();

const seenKey = (walletId: string, chain: string, asset: string) => `${walletId}:${chain}:${asset}`;

/** Test seam: a fresh process is the only other way to clear the baseline. */
export function resetDepositBaseline() {
  lastSeen.clear();
}

/**
 * One pass over every open wallet.
 *
 * Reads balances chain by chain, exactly as unified-balance.service.ts does -
 * one EVM key serves both Base and Ethereum at the same address, and the money
 * is routinely on the chain the row is NOT filed under. Asking only for the
 * row's own chain is the bug that reported a wallet holding 180 USDC on Base
 * as zero.
 */
export async function scanForDeposits(): Promise<DepositScanOutcome> {
  const outcome: DepositScanOutcome = { walletsScanned: 0, depositsRecorded: 0, unreadable: 0, recorded: [] };

  const wallets = await db.listAllOpenWallets();
  if (!wallets.length) return outcome;

  const activeProviderName = await resolveActiveWalletProvider();
  const providerCache = new Map<string, ReturnType<typeof getWalletProvider>>();
  const providerFor = (w: { provider?: string }) => {
    const name = w.provider ?? activeProviderName;
    let resolved = providerCache.get(name);
    if (!resolved) {
      resolved = getWalletProvider(name);
      providerCache.set(name, resolved);
    }
    return resolved;
  };

  const windowStart = new Date().toISOString();

  for (const wallet of wallets) {
    const provider = providerFor(wallet);
    // Every network this one key can receive on, not just the filed chain.
    const networks = networksServedByWallet(wallet.chain);

    for (const network of networks) {
      outcome.walletsScanned += 1;

      let balances;
      try {
        balances = await provider.getBalances(
          wallet.providerWalletId,
          wallet.customerId,
          wallet.address,
          network as WalletChain
        );
      } catch {
        /**
         * AN UNREADABLE BALANCE IS NOT A ZERO BALANCE.
         *
         * Treating a failed RPC read as 0 would, on the next successful read,
         * look like the user's entire balance had just been deposited - and we
         * would email them to say so. Skip the pair entirely and leave the
         * baseline untouched, so the next tick diffs against the last figure we
         * actually believed.
         */
        outcome.unreadable += 1;
        continue;
      }

      for (const balance of balances) {
        const asset = String(balance.asset ?? '').toUpperCase();
        if (!WATCHED_ASSETS.has(asset)) continue;
        // getBalances is chain-filtered, but a provider that ignores the
        // argument would otherwise cross-credit chains - the exact bug that
        // double-counted 108 USDC as 216.
        if (balance.chain && String(balance.chain) !== network) continue;

        const key = seenKey(wallet.id, network, asset);
        const current = num(balance.amount);
        const previous = lastSeen.get(key);

        // Always update the baseline, whatever we decide below.
        lastSeen.set(key, current);

        // First sighting establishes a baseline. If there is an existing on-chain balance
        // that has not yet been recorded as a deposit, record the unrecorded delta safely.
        if (previous === undefined) {
          if (current >= MIN_DEPOSIT) {
            const existing = await db.listWalletDeposits(wallet.userId);
            const recordedTotal = existing
              .filter((d) => d.chain.toLowerCase() === network.toLowerCase() && d.asset.toUpperCase() === asset.toUpperCase())
              .reduce((sum, d) => sum + num(d.amount), 0);

            const unrecorded = current - recordedTotal;
            if (unrecorded >= MIN_DEPOSIT) {
              const result = await recordDeposit({
                userId: wallet.userId,
                walletId: wallet.id,
                address: wallet.address,
                chain: network,
                asset,
                amount: money(unrecorded),
                detectionSource: 'balance_poll',
                idempotencyKeyOverride: `${network}:${wallet.address.toLowerCase()}:${asset}:baseline_sync`,
                rawPayload: { current: money(current), recordedTotal: money(recordedTotal), detector: 'baseline_sync' }
              });

              if (result.created) {
                outcome.depositsRecorded += 1;
                outcome.recorded.push({ userId: wallet.userId, asset, amount: money(unrecorded), chain: network });
              }
            }
          }
          continue;
        }

        const delta = current - previous;
        // Only increases. A decrease is a withdrawal, already recorded as a
        // balance transfer by the send path.
        if (delta < MIN_DEPOSIT) continue;

        const result = await recordDeposit({
          userId: wallet.userId,
          walletId: wallet.id,
          address: wallet.address,
          chain: network,
          asset,
          amount: money(delta),
          detectionSource: 'balance_poll',
          idempotencyKeyOverride: depositIdempotencyKey({
            chain: network,
            address: wallet.address,
            asset,
            windowStart
          }),
          rawPayload: { previous: money(previous), current: money(current), detector: 'balance_poll' }
        });

        if (result.created) {
          outcome.depositsRecorded += 1;
          outcome.recorded.push({ userId: wallet.userId, asset, amount: money(delta), chain: network });
        }
      }
    }
  }

  return outcome;
}

/** Poll interval, seconds. 0 disables the detector entirely. */
export const DEPOSIT_POLL_SECONDS = env.DEPOSIT_POLL_SECONDS;
