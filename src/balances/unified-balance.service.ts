import { db } from '../database/json-database.js';
import { getUserBalance } from './balance.service.js';
import { getWalletProvider } from '../wallets/provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallets/wallet-controls.service.js';
import type { WalletChain } from '../wallets/types/wallet.types.js';

/**
 * ONE BALANCE, ASSEMBLED FROM THE CHAIN AND THE LEDGER.
 *
 * Reported: "I have balance in the receive wallet now, but not showing in the
 * dashboard or the transfer area." Both screens were right about different
 * things, which is the worst kind of disagreement:
 *
 *   Receive    reads /wallets?balances=true  - live, on-chain, via Privy
 *   Dashboard  reads /balance                - a journal of ledger entries
 *   Transfer   reads /balance                - same journal
 *
 * The ledger is credited from exactly two places, verified by grepping every
 * caller of createBalanceLedgerEntry: Bridge virtual-account settlements, and
 * admin adjustments. NOTHING credits it when crypto lands in a user's own
 * Privy wallet. So an on-chain deposit is real money that every spending path
 * in the product believes does not exist.
 *
 * THE MODEL, stated once so the whole codebase can share it:
 *
 *   chain      what the wallet provably holds right now. The truth.
 *   held       claims Sivan has placed against it - a transfer awaiting
 *              review, a supplier payout in flight. The chain cannot express
 *              this, which is why the ledger still exists.
 *   spendable  chain - held, floored at zero.
 *   credited   ledger-only value that is NOT yet on any chain we read:
 *              virtual-account deposits settled by Bridge into a pooled
 *              wallet. Counted, because it is genuinely spendable, and named
 *              separately because its custody story differs.
 *
 * Deliberately NOT done: replacing the ledger with the chain. Holds, review
 * queues and reconciliation all need a place to record intent, and a
 * blockchain has nowhere to write "30 of this is spoken for". The ledger stops
 * being a balance and becomes what it always should have been - a record of
 * claims.
 */

export interface UnifiedAssetBalance {
  asset: string;
  /** Live on-chain total for this asset across the user's wallets. */
  chain: string;
  /** Ledger credits with no on-chain counterpart we can read (virtual accounts). */
  credited: string;
  /** Claims against the balance: transfers under review, payouts in flight. */
  held: string;
  /** What the user may actually spend right now. */
  spendable: string;
  /** Deposits seen but not yet settled by the provider. */
  pending: string;
  /** Historical, for display continuity. */
  spent: string;
  /**
   * True when the chain figure could not be read.
   *
   * NOT the same as zero, and the distinction is the whole reason this field
   * exists: showing a confident 0.00 to someone whose funds are fine and whose
   * RPC is merely rate-limited is how you generate a support ticket that says
   * "your app lost my money".
   */
  chainUnavailable: boolean;
}

export interface UnifiedBalance {
  userId: string;
  balances: UnifiedAssetBalance[];
  /** Per-wallet detail, so Receive can keep showing addresses and networks. */
  wallets: Array<{
    chain: string;
    address: string;
    balances?: Array<{ asset: string; chain: string; amount: string }>;
    balancesUnavailable: boolean;
  }>;
  updatedAt: string;
}

const num = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
/** Six decimals: USDC and USDT both use six, and floats drift beyond that. */
const money = (value: number) => (Math.round(value * 1e6) / 1e6).toFixed(6);

/**
 * Read every wallet the user has, with live balances, tolerating failure.
 *
 * One provider call per wallet. Run in parallel because a user with an EVM and
 * a Solana wallet should not wait for two sequential RPC round trips on every
 * dashboard load.
 */
async function readChainBalances(userId: string) {
  const wallets = await db.listUserWallets(userId);
  const active = wallets.filter((wallet) => wallet.status !== 'closed');
  if (!active.length) return [];

  const provider = getWalletProvider(await resolveActiveWalletProvider());

  return Promise.all(
    active.map(async (wallet) => {
      try {
        const balances = await provider.getBalances(
          wallet.providerWalletId,
          wallet.customerId,
          wallet.address,
          wallet.chain as WalletChain
        );
        return { chain: wallet.chain, address: wallet.address, balances, balancesUnavailable: false };
      } catch (error) {
        // An RPC outage must not blank the dashboard or, worse, read as zero.
        console.warn('[unified_balance.chain_unavailable]', {
          userId,
          chain: wallet.chain,
          reason: error instanceof Error ? error.message : String(error),
        });
        return { chain: wallet.chain, address: wallet.address, balances: undefined, balancesUnavailable: true };
      }
    })
  );
}

export async function getUnifiedBalance(userId: string): Promise<UnifiedBalance> {
  // Independent: the ledger is our database, the chain is an RPC.
  const [ledger, wallets] = await Promise.all([getUserBalance(userId), readChainBalances(userId)]);

  const byAsset = new Map<string, UnifiedAssetBalance>();
  const ensure = (asset: string): UnifiedAssetBalance => {
    let row = byAsset.get(asset);
    if (!row) {
      row = {
        asset,
        chain: '0.000000',
        credited: '0.000000',
        held: '0.000000',
        spendable: '0.000000',
        pending: '0.000000',
        spent: '0.000000',
        chainUnavailable: false,
      };
      byAsset.set(asset, row);
    }
    return row;
  };

  /**
   * A FAILED READ IS A FACT ABOUT THE WHOLE BALANCE, NOT ABOUT ONE ASSET.
   *
   * The first version set chainUnavailable by looping `byAsset.values()`. When
   * the read failed BEFORE any asset row existed - which is the common case,
   * since the chain is what creates the rows - that loop ran over an empty map
   * and flagged nothing. getSpendable then saw no row at all and returned 0
   * instead of null, so an RPC outage read as "you have no money" and every
   * send was refused with a confident, wrong number.
   *
   * Caught by pointing this at the real Privy wallet while an upstream RPC was
   * returning HTTP 521.
   */
  const anyChainUnavailable = wallets.some((wallet) => wallet.balancesUnavailable);

  // Chain first: it is the truth, and it decides which assets exist at all.
  for (const wallet of wallets) {
    if (wallet.balancesUnavailable) continue;
    for (const entry of wallet.balances ?? []) {
      const row = ensure(String(entry.asset).toLowerCase());
      row.chain = money(num(row.chain) + num(entry.amount));
    }
  }

  /**
   * Ledger second, as CLAIMS rather than as a balance.
   *
   * `available` in the ledger is a credit with no chain counterpart we read -
   * a Bridge virtual-account deposit into pooled custody. Adding it to the
   * chain figure is correct: the user can spend both. Double counting is not a
   * risk here precisely because nothing credits the ledger from an on-chain
   * deposit, which is the bug that started this.
   */
  for (const entry of ledger.balances) {
    const row = ensure(String(entry.asset).toLowerCase());
    row.credited = money(num(entry.available));
    row.held = money(num(entry.held));
    row.pending = money(num(entry.pending));
    row.spent = money(num(entry.spent));
  }

  /**
   * When the chain could not be read at all, still surface the assets the
   * LEDGER knows about - flagged - rather than returning an empty list that
   * reads as a confirmed zero.
   */
  if (anyChainUnavailable && byAsset.size === 0) ensure('usdc');

  for (const row of byAsset.values()) {
    if (anyChainUnavailable) row.chainUnavailable = true;
    // Floored at zero: a hold larger than the readable balance is possible
    // mid-settlement, and a negative spendable figure is never useful to show.
    row.spendable = row.chainUnavailable
      ? money(Math.max(num(row.credited) - num(row.held), 0))
      : money(Math.max(num(row.chain) + num(row.credited) - num(row.held), 0));
  }

  return {
    userId,
    balances: [...byAsset.values()].sort((a, b) => a.asset.localeCompare(b.asset)),
    wallets,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * What may this user spend of this asset, right now?
 *
 * The single question every send path should ask. Returns null when the chain
 * could not be read AND the ledger holds nothing - the honest answer is "we do
 * not know", and a caller must refuse rather than assume zero or assume plenty.
 */
export async function getSpendable(userId: string, asset: string): Promise<number | null> {
  const unified = await getUnifiedBalance(userId);
  const row = unified.balances.find((item) => item.asset === asset.toLowerCase());
  if (!row) return 0;
  if (row.chainUnavailable && num(row.credited) === 0) return null;
  return num(row.spendable);
}
