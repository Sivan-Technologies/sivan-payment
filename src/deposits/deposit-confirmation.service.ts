import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { solanaRpc } from '../wallets/solana/solana-rpc.js';
import { evmRpc, usesNativeStablecoin } from '../wallets/evm/evm-rpc.js';
import { resolveNetworkMode } from '../wallets/network-mode.js';
import { solanaMintFor } from '../wallets/solana/spl-transfer.js';
import { erc20TokenAddress, decimalsForChainAsset } from '../wallets/provider/privy-wallet.provider.js';
import { nowIso } from '../shared/id.js';
import type { WalletDepositRecord } from '../database/types.js';
import type { WalletChain } from '../wallets/types/wallet.types.js';

/**
 * LAYER 4: NOTHING EVER MARKED A DEPOSIT AS CONFIRMED.
 *
 * Reported with a screenshot: the dashboard read
 *
 *     YOUR BALANCE   20 USDC   Available to send or sell   Ready
 *     Deposit received   Solana · 28m ago   +20.000000 USDC   [In progress]
 *
 * Two statements about the same 20 USDC, on the same screen, contradicting
 * each other. The balance card - which reads the CHAIN - says the money is
 * spendable. The activity row - which reads the DEPOSIT RECORD - says it is
 * still moving. The user is left to guess which one is lying.
 *
 * Confirmed against the live Neon database:
 *
 *     dep_fc5c402f-2324-47ed-a92d-ddd9561373ce
 *     chain solana  asset USDC  amount 20.000000
 *     status pending            detection_source balance_poll
 *     created 09:37:31Z         notified_at 09:38:08Z
 *
 * Still `pending` an hour later, for money that was final on Solana within
 * seconds of being observed.
 *
 *
 * WHY IT WAS STUCK, WHICH IS NOT A BUG IN ANY EXISTING LINE OF CODE.
 *
 * `recordDeposit` writes `status: 'pending'` - correct, an observation is not
 * finality. `WalletDepositStatus` declares `'confirmed'`. Both database drivers
 * implement `updateWalletDepositStatus`. The migration even carves out a
 * partial index for the confirmer's hot query:
 *
 *     create index ... payments_wallet_deposits_pending_idx
 *       on payments_wallet_deposits (created_at) where status = 'pending';
 *
 * And then:
 *
 *     $ grep -rn "updateWalletDepositStatus" src scripts e2e frontend
 *     src/database/json-database.ts:750:  async updateWalletDepositStatus(...)
 *     src/database/postgres-database.ts:1499:  async updateWalletDepositStatus(...)
 *
 * Two definitions, ZERO call sites. The writer, the status enum and the index
 * were all built for a confirmer that was never written. `'pending'` was
 * therefore not a state, it was a permanent label. Exactly the shape of the
 * crypto-send bug in transfer-confirmation.service.ts - "submitted, and never
 * checked again" - repeated one layer down on the inbound path.
 *
 *
 * THE HARD PART: THE BALANCE POLLER LEAVES NO TRANSACTION TO CHECK.
 *
 * transfer-confirmation.service.ts has it easy - it broadcast the transaction,
 * so it holds the signature and can ask the chain about that exact thing. This
 * detector cannot. It saw a NUMBER GO UP. `tx_hash` is null on the reported row
 * and null on every balance_poll row by construction, so there is nothing to
 * pass to getSignatureStatuses.
 *
 * So the question has to be reframed. Not "did transaction X land", which is
 * unanswerable here, but:
 *
 *     is the increase we observed still present on chain,
 *     at a block/slot the chain itself calls final?
 *
 * That is answerable, it is the question the user actually cares about, and it
 * is strictly stronger evidence than a transaction receipt: a receipt says one
 * transfer landed, whereas re-reading the finalised balance says the money is
 * THERE, having survived any reorg, and would still be there if the deposit had
 * been immediately swept out from under us.
 *
 *   Solana  - re-read the token balance at commitment 'finalized'. Solana's
 *             finalized commitment means supermajority-rooted; it does not roll
 *             back. The poller reads at the node default ('confirmed'), which
 *             is precisely the gap that makes 'pending' meaningful in the first
 *             place, so this is a genuinely different question and not the same
 *             read twice.
 *
 *   EVM     - re-read balanceOf at a block CONFIRMATIONS behind the head,
 *             rather than at 'latest' as the poller does. Base does not reorg
 *             deeply, but reading a balance at 'latest' and calling the result
 *             final is the assumption that eventually costs somebody money.
 *
 * A tx_hash IS used when one exists, because a webhook detector supplies one
 * and a receipt is cheaper than a balance read. The balance path is the
 * fallback, not the preference - and that ordering is what lets this module
 * survive the poll -> webhook migration unchanged.
 *
 *
 * WHAT IT WILL NOT DO.
 *
 * It never marks a deposit FAILED on the strength of a balance that has since
 * gone DOWN. That is the single most dangerous inference available here: a user
 * who deposits 20 USDC and immediately sends it out has a wallet holding zero,
 * which is indistinguishable from a reorged deposit by balance alone. Telling
 * them their deposit failed - after we already emailed to say it arrived, and
 * after they spent it - would be a false statement about their money. Only an
 * explicit on-chain failure, which requires a tx_hash, produces 'failed'.
 * Everything else stays pending and is escalated by age.
 *
 * It also credits nobody. Same boundary the whole deposits module holds:
 * spendable balance is read from the chain in unified-balance.service.ts. This
 * changes a label from "In progress" to "Confirmed" and nothing else.
 */

/** Only pending rows are worth a chain read. Anything else is already final. */
const OPEN_STATUS = 'pending';

/**
 * Blocks behind the head at which an EVM balance is treated as final.
 *
 * Base is an OP-stack L2 whose sequencer does not reorg in normal operation,
 * so this is protection against the abnormal case rather than routine
 * behaviour. Twelve blocks is ~24 seconds at Base's 2-second block time -
 * short enough that a user does not notice the wait, deep enough that a
 * single-block reorg cannot flip a "Confirmed" badge back.
 */
export const EVM_CONFIRMATIONS = 12;

/**
 * How long a pending deposit may sit before it is escalated.
 *
 * Solana finalises in seconds and Base in under a minute. Anything still
 * unconfirmed after fifteen minutes is not slow, it is wrong - an RPC that
 * cannot be reached, a chain we are reading on the wrong network mode, or a
 * balance that vanished. Escalated to the audit log, NOT marked failed.
 */
const STALE_AFTER_MINUTES = 15;

export interface DepositConfirmationOutcome {
  checked: number;
  confirmed: string[];
  failed: string[];
  stillPending: string[];
  /** Pending far longer than any chain takes. Someone should look. */
  stale: string[];
  /** Chain unreadable. NOT evidence of anything - see the header. */
  unreadable: number;
}

function minutesSince(iso?: string): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return (Date.now() - then) / 60000;
}

const num = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Tolerance when comparing a re-read balance against the recorded deposit.
 *
 * The comparison is ">= amount", not "== amount", because by the time this
 * runs the balance has usually moved again - another deposit landed, or the
 * user spent some. Equality would confirm almost nothing.
 *
 * The epsilon absorbs the last-decimal drift between two reads of a
 * six-decimal token that MIN_DEPOSIT in the detector exists to absorb on the
 * way in. Same reasoning, same magnitude, opposite direction.
 */
const EPSILON = 0.000001;

/**
 * Is the deposited amount still present, at a finalised block/slot?
 *
 * Returns 'unknown' rather than throwing on any RPC problem. An unreachable
 * node is not evidence that money vanished, and the deposit must survive the
 * outage unchanged - the same rule scanForDeposits applies to an unreadable
 * balance on the way in.
 */
async function balanceStillPresent(
  deposit: WalletDepositRecord,
  production: boolean
): Promise<'confirmed' | 'unknown'> {
  const expected = num(deposit.amount);
  // A zero or unparseable amount is not something to confirm. It should not
  // exist - MIN_DEPOSIT gates it - but confirming it would be asserting
  // finality about nothing.
  if (expected <= 0) return 'unknown';

  try {
    if (deposit.chain === 'solana') {
      /**
       * COMMITMENT IS THE ENTIRE POINT OF THIS CALL.
       *
       * privy-wallet.provider.ts issues the same getTokenAccountsByOwner with
       * no commitment, so the node answers at its default - 'confirmed', which
       * is supermajority-VOTED but not yet rooted and can, in principle, be
       * dropped. Passing 'finalized' asks a strictly stronger question, and
       * that difference is the only thing separating a pending deposit from a
       * confirmed one on this chain. Drop this parameter and the confirmer
       * becomes a re-run of the detector.
       */
      const mint = solanaMintFor(deposit.asset, production);
      if (!mint) return 'unknown';

      const { result } = await solanaRpc<any>(
        'getTokenAccountsByOwner',
        [deposit.address, { mint }, { encoding: 'jsonParsed', commitment: 'finalized' }],
        { production }
      );

      const accounts: any[] = result?.value ?? [];
      // Summed, matching solanaBalances: one owner can hold several accounts
      // for a mint, and reading only the first under-reports the holding and
      // would leave a real deposit stuck pending forever.
      const total = accounts.reduce((sum, account) => {
        const raw = account?.account?.data?.parsed?.info?.tokenAmount?.amount;
        return sum + (raw ? BigInt(raw) : 0n);
      }, 0n);

      const held = Number(total) / 1e6;
      return held + EPSILON >= expected ? 'confirmed' : 'unknown';
    }

    if (deposit.chain === 'stellar') {
      const { readStellarUsdcBalance, readStellarUsdtBalance } = await import('../wallets/stellar/stellar-rpc.js');
      const isUsdt = deposit.asset.toLowerCase() === 'usdt';
      const held = isUsdt
        ? await readStellarUsdtBalance(deposit.address, { production })
        : await readStellarUsdcBalance(deposit.address, { production });
      return held + EPSILON >= expected ? 'confirmed' : 'unknown';
    }

    /**
     * EVM: read at a block behind the head, not at 'latest'.
     *
     * erc20BalanceOf hardcodes 'latest' so it cannot be reused here - and
     * reusing it would mean this function asks the identical question the
     * detector already asked, and confirms every deposit unconditionally. The
     * block tag is the evidence.
     */
    const head = await evmRpc<string>(deposit.chain as WalletChain, 'eth_blockNumber', [], { production });
    const headNumber = BigInt(head);
    // Early in a fresh testnet's life the head can be below the confirmation
    // depth. Clamp at 0 rather than underflowing a bigint into a huge number.
    const target = headNumber > BigInt(EVM_CONFIRMATIONS) ? headNumber - BigInt(EVM_CONFIRMATIONS) : 0n;

    const holder = deposit.address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(holder)) return 'unknown';

    if (usesNativeStablecoin(deposit.chain as WalletChain)) {
      const raw = await evmRpc<string>(
        deposit.chain as WalletChain,
        'eth_getBalance',
        [holder, `0x${target.toString(16)}`],
        { production }
      );
      if (!raw || raw === '0x') return 'unknown';
      const decimals = decimalsForChainAsset(deposit.chain as WalletChain, deposit.asset);
      const held = Number(BigInt(raw)) / 10 ** decimals;
      return held + EPSILON >= expected ? 'confirmed' : 'unknown';
    }

    const token = erc20TokenAddress(deposit.chain as WalletChain, deposit.asset, production);
    if (!token) return 'unknown';

    const data = '0x70a08231' + holder.slice(2).padStart(64, '0');
    const raw = await evmRpc<string>(
      deposit.chain as WalletChain,
      'eth_call',
      [{ to: token, data }, `0x${target.toString(16)}`],
      { production }
    );

    // Not a zero balance - a node that could not answer, or a token not
    // deployed at that address on this network. erc20BalanceOf throws on the
    // same condition for the same reason.
    if (!raw || raw === '0x') return 'unknown';

    const decimals = decimalsForChainAsset(deposit.chain as WalletChain, deposit.asset);
    const held = Number(BigInt(raw)) / 10 ** decimals;
    return held + EPSILON >= expected ? 'confirmed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Ask the chain about a deposit that DOES have a transaction hash.
 *
 * Only a webhook detector supplies one today, so this path is dormant until
 * that migration - but it is written now because it is the only way a deposit
 * can ever legitimately be marked FAILED, and because writing it later would
 * mean touching this module during the migration rather than only above the
 * seam.
 */
async function txOutcome(
  deposit: WalletDepositRecord,
  production: boolean
): Promise<'confirmed' | 'failed' | 'unknown'> {
  const hash = deposit.txHash;
  if (!hash) return 'unknown';

  try {
    if (deposit.chain === 'solana') {
      const { result } = await solanaRpc<{ value: Array<null | { err: unknown; confirmationStatus?: string }> }>(
        'getSignatureStatuses',
        [[hash], { searchTransactionHistory: true }],
        { production }
      );
      const status = result?.value?.[0];
      if (!status) return 'unknown';
      if (status.err) return 'failed';
      // 'processed' is not enough - it can still be dropped. Matching
      // transfer-confirmation.service.ts exactly.
      return status.confirmationStatus === 'finalized' ? 'confirmed' : 'unknown';
    }

    if (deposit.chain === 'stellar') {
      const { horizonEndpoints } = await import('../wallets/stellar/stellar-rpc.js');
      const endpoints = horizonEndpoints({ production });
      for (const base of endpoints) {
        try {
          const res = await fetch(`${base}/transactions/${hash}`);
          if (res.status === 404) return 'unknown';
          if (!res.ok) continue;
          const data: any = await res.json();
          return data.successful ? 'confirmed' : 'failed';
        } catch {
          continue;
        }
      }
      return 'unknown';
    }

    const receipt = await evmRpc<any>(
      deposit.chain as WalletChain,
      'eth_getTransactionReceipt',
      [hash],
      { production }
    );
    // null means not yet mined OR pruned from this node. Neither is failure.
    if (!receipt) return 'unknown';
    if (receipt.status === '0x0') return 'failed';

    // Mined is not final. Require the same depth the balance path requires,
    // so the two paths cannot disagree about what "confirmed" means.
    const head = await evmRpc<string>(deposit.chain as WalletChain, 'eth_blockNumber', [], { production });
    const depth = BigInt(head) - BigInt(receipt.blockNumber ?? head);
    return depth >= BigInt(EVM_CONFIRMATIONS) ? 'confirmed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * One pass over every deposit still saying "pending".
 *
 * Safe to run concurrently with the detector and the notifier: it only ever
 * transitions pending -> confirmed, `updateWalletDepositStatus` is a single
 * statement, and a second writer setting the same value is harmless.
 */
export async function confirmDeposits(limit = 100): Promise<DepositConfirmationOutcome> {
  const outcome: DepositConfirmationOutcome = {
    checked: 0,
    confirmed: [],
    failed: [],
    stillPending: [],
    stale: [],
    unreadable: 0,
  };

  const pending = (await db.listPendingWalletDeposits(limit)) ?? [];
  if (!pending.length) return outcome;

  const production = resolveNetworkMode() === 'mainnet';

  /**
   * Which deposits have already been escalated, read from the audit log rather
   * than held in memory. This process restarts on every deploy, and an
   * in-memory set would re-alert the entire backlog each time - the mistake
   * that produced 66 alert events for 3 stale transfers.
   */
  const escalations = await db
    .listAuditLogsByActions?.(['deposit.stale'])
    .catch(() => [] as any[]);
  const alreadyEscalated = new Set<string>(
    (escalations ?? []).map((log: any) => String(log?.resourceId ?? '')).filter(Boolean)
  );

  for (const deposit of pending) {
    if (String(deposit.status) !== OPEN_STATUS) continue;
    outcome.checked += 1;

    // A hash is stronger and cheaper evidence, so it is asked first. Falls
    // through to the balance question when there is no hash, which is every
    // balance_poll row.
    let verdict = await txOutcome(deposit, production);
    if (verdict === 'unknown') {
      verdict = await balanceStillPresent(deposit, production);
    }

    if (verdict === 'confirmed') {
      const updated = await db.updateWalletDepositStatus(deposit.id, 'confirmed', nowIso());
      if (updated) {
        outcome.confirmed.push(deposit.id);
        await createAuditLog({
          action: 'deposit.confirmed',
          resourceType: 'wallet_deposit',
          resourceId: deposit.id,
          actorType: 'system',
          metadata: {
            userId: deposit.userId,
            chain: deposit.chain,
            asset: deposit.asset,
            amount: deposit.amount,
            evidence: deposit.txHash ? `tx:${deposit.txHash}` : 'finalized_balance',
          },
        }).catch(() => undefined);
      }
      continue;
    }

    if (verdict === 'failed') {
      const updated = await db.updateWalletDepositStatus(deposit.id, 'failed', nowIso());
      if (updated) outcome.failed.push(deposit.id);
      continue;
    }

    outcome.unreadable += 1;
    outcome.stillPending.push(deposit.id);

    /**
     * ESCALATE BY AGE, NEVER MARK FAILED BY AGE.
     *
     * An old pending deposit is a deposit we cannot read, not a deposit that
     * did not happen - the reported row sat pending for an hour holding real,
     * spendable money. Age is evidence about our monitoring, not about the
     * chain.
     */
    const age = minutesSince(deposit.createdAt);
    if (age >= STALE_AFTER_MINUTES && !alreadyEscalated.has(deposit.id)) {
      outcome.stale.push(deposit.id);
      await createAuditLog({
        action: 'deposit.stale',
        resourceType: 'wallet_deposit',
        resourceId: deposit.id,
        actorType: 'system',
        metadata: {
          userId: deposit.userId,
          chain: deposit.chain,
          asset: deposit.asset,
          amount: deposit.amount,
          ageMinutes: Math.round(age),
          note: 'Deposit still unconfirmed. Money may be spendable - the badge is wrong, not the balance.',
        },
      }).catch(() => undefined);
    }
  }

  return outcome;
}
