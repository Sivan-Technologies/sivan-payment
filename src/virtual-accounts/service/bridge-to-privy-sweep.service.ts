import { db } from '../../database/json-database.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { getWalletProvider } from '../../wallets/provider/provider-registry.js';
import { ensureUserWallet } from '../../wallets/user-wallet.service.js';
import { getVirtualAccountProviderSettings } from './virtual-account-provider-settings.service.js';
import { env } from '../../config/env.js';
import { nowIso } from '../../shared/id.js';
import type { VirtualAccountTransactionRecord } from '../types/virtual-account.types.js';

/**
 * MOVE A VIRTUAL-ACCOUNT SETTLEMENT OUT OF BRIDGE CUSTODY AND INTO THE USER'S
 * OWN PRIVY WALLET, AUTOMATICALLY.
 *
 * A bank deposit into a Sivan virtual account settles into a BRIDGE wallet -
 * Bridge holds the keys. Everything the user can actually do with money spends
 * from their PRIVY wallet: crypto sends sign there, and the NGN off-ramp sweep
 * reads an on-chain balance there. The two never met, which produced a real
 * and reproducible dead end:
 *
 *     unified balance   1000 USDC spendable   (credited, ledger-only)
 *     NGN quote         priced fine
 *     NGN order         created
 *     sweep             ngn.sweep_skipped  reason: no_wallet_for_network
 *
 * The user's own money, visible and quotable and impossible to move.
 *
 * WHY SWEEPING BEATS SPENDING FROM BOTH.
 *
 * The alternative was to leave funds in Bridge and teach every spend path to
 * choose a wallet. That keeps two funded custodians forever, and every future
 * money path has to get the choice right - the send path already got it wrong
 * once, handing a Bridge wallet id to Privy. Sweeping means the Bridge wallet
 * is EMPTY in steady state: one funded wallet, one spend path, nothing to
 * choose between. It also shortens how long Sivan's partner holds user funds,
 * which is the better answer to Bridge ToS 2.1(m), not a worse one.
 *
 * THE USER NEVER SEES THE BRIDGE ADDRESS. It is plumbing between the bank and
 * their wallet. Exposing it would invite deposits Sivan cannot attribute.
 */

/**
 * The floor below which sweeping costs more than it moves.
 *
 * SIX DOLLARS, AND IT APPLIES TO THIS SWEEP ONLY. Not to Sivan/Privy user
 * transfers, not to the NGN off-ramp sweep, not to anything else - those move
 * money the user has explicitly asked to move, and a minimum there would block
 * a legitimate instruction. This one is an automatic internal hand-off that
 * nobody requested, so it is the only place where "not worth the gas" is a
 * sensible thing to say.
 *
 * The cost being avoided is not the network fee - Solana's is a fraction of a
 * cent. It is the ~$0.31 associated-token-account rent charged the first time
 * a wallet receives a given SPL token. On a $2 deposit that is 15%; at $6 it
 * is 5% of the smallest sweep and falls away immediately after.
 *
 * Below the floor the money is NOT lost and NOT stuck: it stays credited and
 * spendable in the ledger, and the next deposit that pushes the balance over
 * the line sweeps the whole accumulated amount at once.
 */
export const MIN_BRIDGE_SWEEP_USD = Number(env.BRIDGE_TO_PRIVY_MIN_SWEEP_USD ?? 6);

export interface BridgeSweepOutcome {
  swept: boolean;
  reason?: string;
  providerTransferId?: string;
  amount?: string;
}

const num = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Sweep one settled virtual-account deposit into the user's Privy wallet.
 *
 * Never throws. A failed sweep must not roll back the deposit record or the
 * ledger credit - the money genuinely arrived, and the user's balance should
 * say so whether or not the hand-off succeeded. Failures are audited and left
 * for the retry pass.
 */
export async function sweepVirtualAccountDepositToPrivy(
  transaction: VirtualAccountTransactionRecord
): Promise<BridgeSweepOutcome> {
  try {
    if (!transaction.userId) return skip(transaction, 'no_user');
    if (transaction.status !== 'completed') return skip(transaction, 'not_settled');

    const amount = num(transaction.destinationAmount ?? transaction.sourceAmount);
    if (amount <= 0) return skip(transaction, 'zero_amount');

    /**
     * Below the floor, hold. Deliberately not an error and not a retry: the
     * balance is already spendable in the ledger, and the next deposit sweeps
     * the accumulated total.
     */
    if (amount < MIN_BRIDGE_SWEEP_USD) {
      return skip(transaction, 'below_minimum', { amount: String(amount), minimum: MIN_BRIDGE_SWEEP_USD });
    }

    /**
     * The SOURCE must be the Bridge wallet that received the settlement, not
     * "the user's wallet" - by the time this runs they have two, and reading
     * the wrong one would ask Privy to send funds it does not hold.
     */
    const wallets = await db.listUserWallets(transaction.userId);
    const bridgeWallet = wallets.find(
      (wallet) => wallet.provider === 'bridge' && wallet.status !== 'closed'
    );
    if (!bridgeWallet) return skip(transaction, 'no_bridge_wallet');

    /**
     * The DESTINATION is the user's own Privy wallet, created on demand.
     *
     * ensureUserWallet is idempotent, so a user who already has one keeps it.
     * A user who has only ever received a bank deposit may have none at all -
     * which is exactly the case that produced the dead end above - so it is
     * created here rather than assumed.
     */
    const settings = await getVirtualAccountProviderSettings();
    const chain = settings.defaultSettlementNetwork;
    const privyWallet = await ensureUserWallet(transaction.userId, chain as any);

    if (!privyWallet?.address) return skip(transaction, 'no_privy_address');
    if (privyWallet.provider === 'bridge') {
      // Both wallets are Bridge, so there is nothing to hand off to. Not an
      // error - it means this deployment is not running the Privy split.
      return skip(transaction, 'destination_is_also_bridge');
    }

    const provider = getWalletProvider('bridge');
    const result = await provider.createTransfer({
      providerWalletId: bridgeWallet.providerWalletId,
      providerCustomerId: bridgeWallet.customerId,
      asset: (transaction.destinationCurrency ?? 'usdc').toLowerCase() as any,
      chain: chain as any,
      amount: String(amount),
      toAddress: privyWallet.address,
      /**
       * Keyed on the DEPOSIT, so a webhook redelivery or a retry pass cannot
       * sweep the same settlement twice. Bridge returns the original transfer
       * for a repeated idempotency key.
       */
      idempotencyKey: `va-sweep-${transaction.id}`,
      reference: `sivan-va-sweep-${transaction.id}`,
    });

    await createAuditLog({
      actorType: 'system',
      actorId: 'bridge_to_privy_sweep',
      action: 'virtual_account.swept_to_privy',
      resourceType: 'virtual_account_transaction',
      resourceId: transaction.id,
      metadata: {
        userId: transaction.userId,
        amount: String(amount),
        chain,
        from: bridgeWallet.providerWalletId,
        to: privyWallet.address,
        providerTransferId: result.providerTransferId,
      },
    }).catch(() => undefined);

    return { swept: true, providerTransferId: result.providerTransferId, amount: String(amount) };
  } catch (error) {
    /**
     * ESCALATED, NOT SWALLOWED.
     *
     * A failed sweep strands money in a wallet the user cannot see and did not
     * ask for. Their balance still shows it - the ledger credit stands - so
     * nothing looks wrong from the outside, which is precisely why this has to
     * be loud on the inside.
     */
    await createAuditLog({
      actorType: 'system',
      actorId: 'bridge_to_privy_sweep',
      action: 'virtual_account.sweep_to_privy_failed',
      resourceType: 'virtual_account_transaction',
      resourceId: transaction.id,
      severity: 'error',
      metadata: {
        userId: transaction.userId,
        amount: transaction.destinationAmount ?? transaction.sourceAmount,
        reason: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);

    return { swept: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function skip(
  transaction: VirtualAccountTransactionRecord,
  reason: string,
  extra: Record<string, unknown> = {}
): Promise<BridgeSweepOutcome> {
  await createAuditLog({
    actorType: 'system',
    actorId: 'bridge_to_privy_sweep',
    action: 'virtual_account.sweep_to_privy_skipped',
    resourceType: 'virtual_account_transaction',
    resourceId: transaction.id,
    metadata: { userId: transaction.userId, reason, ...extra },
  }).catch(() => undefined);
  return { swept: false, reason };
}

/**
 * Fire the sweep without making the webhook wait for it.
 *
 * setImmediate, for the same reason the NGN off-ramp sweep uses it: Bridge
 * expects a prompt 2xx on a webhook, and an on-chain hand-off is not something
 * to do inside that request. A slow or failing sweep must never turn a
 * successfully received deposit into a webhook Bridge retries.
 */
export function scheduleBridgeToPrivySweep(transaction: VirtualAccountTransactionRecord): void {
  setImmediate(() => {
    void sweepVirtualAccountDepositToPrivy(transaction).catch(() => undefined);
  });
}

/** Placeholder for a future retry pass over failed sweeps. */
export function bridgeSweepMinimumUsd(): number {
  return MIN_BRIDGE_SWEEP_USD;
}
