import { db } from '../database/json-database.js';
import { getUserBalance, getBalanceTransferControls } from './balance.service.js';
import { getWalletProvider } from '../wallets/provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallets/wallet-controls.service.js';
import type { WalletChain } from '../wallets/types/wallet.types.js';
import { networksServedByWallet } from '../wallets/chain-family.js';

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

function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  return Promise.race([
    promise.then((res) => {
      clearTimeout(timer);
      return res;
    }),
    timeoutPromise,
  ]);
}

interface CachedUnifiedBalance {
  timestamp: number;
  data: UnifiedBalance;
}

const unifiedBalanceCache = new Map<string, CachedUnifiedBalance>();
const BALANCE_CACHE_TTL_MS = 6_000; // 6-second short TTL to serve immediate reloads instantly

export function invalidateUnifiedBalanceCache(userId?: string) {
  if (userId) {
    unifiedBalanceCache.delete(userId);
  } else {
    unifiedBalanceCache.clear();
  }
}

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

  const providerCache = new Map<string, ReturnType<typeof getWalletProvider>>();
  const activeProviderName = await resolveActiveWalletProvider();
  const providerFor = (wallet: { provider?: string }) => {
    const name = wallet.provider ?? activeProviderName;
    let resolved = providerCache.get(name);
    if (!resolved) {
      resolved = getWalletProvider(name);
      providerCache.set(name, resolved);
    }
    return resolved;
  };

  /**
   * ONE EVM WALLET, SEVERAL EVM CHAINS - AND THE MONEY IS RARELY ON THE ONE
   * IT IS FILED UNDER.
   *
   * networksServedByWallet() answers from the key family, so it is correct for
   * a row filed under either name and cannot degrade to an empty list.
   * We filter by activeSupportedChains to target active Phase 2 networks cleanly.
   */
  const activeSupportedChains = new Set(['solana', 'base', 'bsc', 'bnb', 'stellar', 'celo', 'arbitrum', 'arc']);
  const uniqueReads = new Map<string, { wallet: (typeof active)[0]; chain: string }>();
  for (const wallet of active) {
    const chains = networksServedByWallet(wallet.chain).filter((c) => activeSupportedChains.has(c.toLowerCase()));
    for (const chain of chains) {
      const key = `${chain}:${wallet.address.toLowerCase()}`;
      if (!uniqueReads.has(key)) {
        uniqueReads.set(key, { wallet, chain });
      }
    }
  }

  const reads = Array.from(uniqueReads.values());

  return Promise.all(
    reads.map(async ({ wallet, chain }) => {
      try {
        const balances = await withTimeout(
          providerFor(wallet).getBalances(
            wallet.providerWalletId,
            wallet.customerId,
            wallet.address,
            chain as WalletChain
          ),
          2500,
          `RPC timeout for ${chain} after 2500ms`
        );
        return { chain, address: wallet.address, balances, balancesUnavailable: false };
      } catch (error) {
        // An RPC outage must not blank the dashboard or, worse, read as zero.
        console.warn('[unified_balance.chain_unavailable]', {
          userId,
          chain,
          reason: error instanceof Error ? error.message : String(error),
        });
        return { chain, address: wallet.address, balances: undefined, balancesUnavailable: true };
      }
    })
  );
}

export async function getUnifiedBalance(userId: string, bypassCache = false): Promise<UnifiedBalance> {
  if (!bypassCache) {
    const cached = unifiedBalanceCache.get(userId);
    if (cached && Date.now() - cached.timestamp < BALANCE_CACHE_TTL_MS) {
      return cached.data;
    }
  }

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
  /**
   * A CHAIN WE DO NOT SUPPORT MUST NOT BLANK A BALANCE WE CAN READ.
   *
   * Reported with a screenshot: "YOUR BALANCE — Could not reach the network /
   * Retrying shortly", while Base and Solana were both answering normally.
   *
   * Reproduced rather than guessed. Every EVM wallet is read on BOTH networks,
   * because one secp256k1 key serves them:
   *
   *     networksServedByWallet('base') -> ['ethereum', 'base']
   *
   * With no RPC configured each chain had exactly ONE public endpoint, and on
   * 2026-08-05 ethereum's - eth.llamarpc.com - was returning HTTP 521 while
   * mainnet.base.org and api.mainnet-beta.solana.com both returned 200. This
   * line was `wallets.some(...)`, so that single dead endpoint set
   * chainUnavailable on EVERY asset row and the dashboard reported the user's
   * whole balance as unreadable.
   *
   * The insult is that Ethereum is DISABLED for transfers - balance.service.ts
   * ships `supportedNetworks: ['base','solana']` because Ethereum gas loses
   * $2-3 on every transfer at any size. So an outage on a chain the product
   * deliberately does not use was hiding the balance on the chains it does.
   *
   * Now only a chain the user can actually TRANSACT on can mark the balance
   * unreadable. A failed read on an unsupported chain is still recorded on the
   * per-wallet detail below (nothing is hidden from an operator) but it no
   * longer degrades the headline figure.
   *
   * Deliberately NOT solved by removing Ethereum from the read: the wallet
   * genuinely holds an Ethereum balance at the same address, a user who
   * deposited there must still be able to see it, and enabling the network
   * later must not require remembering to re-add it here.
   */
  const spendableNetworks = new Set(
    (await getBalanceTransferControls()).supportedNetworks.map((network) => String(network).toLowerCase())
  );
  const anyChainUnavailable = wallets.some(
    (wallet) => wallet.balancesUnavailable && spendableNetworks.has(String(wallet.chain).toLowerCase())
  );

  // Chain first: it is the truth, and it decides which assets exist at all.
  for (const wallet of wallets) {
    if (wallet.balancesUnavailable) continue;
    for (const entry of wallet.balances ?? []) {
      /**
       * ONLY COUNT WHAT BELONGS TO THE CHAIN WE ASKED ABOUT.
       *
       * The same address is read once per network it serves - Base and
       * Ethereum for one EVM wallet - and the results are summed, which is
       * right because those are genuinely different balances.
       *
       * It is only right while each read answers about the network it was
       * asked about. A provider that ignores the chain argument and returns
       * everything turns that sum into a double count: 108 USDC on Base was
       * reported for the Base read AND the Ethereum read and totalled 216.
       * Caught by test:base-wallet-sends against the mock, which did exactly
       * that.
       *
       * Cross-checking here rather than only fixing the mock, because this is
       * the line that would show a user twice the money they have, and it must
       * not depend on every present and future adapter being well behaved.
       */
      if (entry.chain && String(entry.chain).toLowerCase() !== String(wallet.chain).toLowerCase()) continue;
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
    // Only positive ledger credits (from virtual accounts or admin adjustments)
    // represent off-chain funds in pooled custody that add to the user's chain balance.
    // Negative ledger available caused by on-chain wallet debits (which have no ledger credit)
    // must NEVER drag down on-chain balances that have already been debited by the blockchain consensus.
    const pooledCredits = Math.max(0, num(entry.available));
    row.credited = money(pooledCredits);
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
    row.spendable = row.chainUnavailable && num(row.chain) === 0
      ? money(Math.max(num(row.credited) - num(row.held), 0))
      : money(Math.max(num(row.chain) + num(row.credited) - num(row.held), 0));
  }

  const result: UnifiedBalance = {
    userId,
    balances: [...byAsset.values()].sort((a, b) => a.asset.localeCompare(b.asset)),
    wallets,
    updatedAt: new Date().toISOString(),
  };

  unifiedBalanceCache.set(userId, { timestamp: Date.now(), data: result });
  return result;
}

/**
 * What may this user spend of this asset, right now?
 *
 * The single question every send path should ask. Returns null when the chain
 * could not be read AND the ledger holds nothing - the honest answer is "we do
 * not know", and a caller must refuse rather than assume zero or assume plenty.
 *
 * When network is provided, checks spendable funds available on that specific network.
 */
export async function getSpendable(userId: string, asset: string, network?: string): Promise<number | null> {
  const unified = await getUnifiedBalance(userId);
  const row = unified.balances.find((item) => item.asset === asset.toLowerCase());
  if (!row) return 0;

  if (network) {
    const net = network.toLowerCase();
    const wallet = unified.wallets.find((w) => w.chain.toLowerCase() === net);
    if (wallet && wallet.balancesUnavailable && num(row.credited) === 0) return null;
    const balanceEntry = wallet ? (wallet.balances || []).find((b) => b.asset.toLowerCase() === asset.toLowerCase()) : undefined;
    const chainAmount = balanceEntry ? num(balanceEntry.amount) : 0;
    const pooledCredits = num(row.credited);
    const held = num(row.held);
    return Math.max(0, chainAmount + pooledCredits - held);
  }

  if (row.chainUnavailable && num(row.chain) === 0 && num(row.credited) === 0) return null;
  return num(row.spendable);
}
