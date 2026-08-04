import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { getWalletProvider } from '../wallets/provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallets/wallet-controls.service.js';
import { listAllBalanceTransfers } from './balance.service.js';
import { solanaRpc } from '../wallets/solana/solana-rpc.js';
import { env } from '../config/env.js';
import { nowIso } from '../shared/id.js';

/**
 * NOTHING EVER MARKED A CRYPTO SEND AS DONE.
 *
 * Reported with a screenshot: three sends, all showing "Processing", the
 * oldest two hours old. The user's reading was that the money had not arrived.
 *
 * I checked the chain. All three had SETTLED. Both Solana transfers are
 * finalised on devnet with err:null, and the recipient's balance moved 30 -> 40
 * -> 50 USDC exactly as instructed. The money was never lost. The product
 * simply never went back to look.
 *
 * `BalanceTransferStatus` declares 'completed', and grepping every assignment
 * in balance.service.ts shows it is set on LEDGER ENTRIES and never once on a
 * transfer. executeBalanceTransfer writes 'processing' after the provider
 * accepts the broadcast, and that is the last word anything ever says about
 * it. There was no poller, no webhook, no reconciler - `getTransfer()` was
 * called by the onramp, sync and supplier services, and by nothing on this
 * path at all.
 *
 * So "Processing" did not mean "in flight". It meant "submitted, and never
 * checked again". A user watching that badge would wait forever.
 *
 * WHY THIS READS THE CHAIN AND NOT ONLY THE PROVIDER
 *
 * Privy's /transactions/:id answers for transfers it tracks, but a SPONSORED
 * transfer is identified by a user-operation hash before it has a transaction
 * hash, and a Solana send is identified by its signature. The chain is the
 * authority on whether value moved; the provider is the authority on whether
 * it was accepted. Both are consulted, chain first, because a provider that
 * says "submitted" about a transaction that has since failed is the case that
 * loses money quietly.
 */

/** Statuses worth re-checking. Anything else is already final. */
const OPEN_STATUSES = new Set(['processing']);

/**
 * How long before an unconfirmed send is treated as suspicious.
 *
 * Solana finalises in seconds and Base in under a minute, so anything still
 * unconfirmed after this either failed or never reached a validator. Not
 * marked FAILED automatically - see below - but surfaced loudly.
 */
const STALE_AFTER_MINUTES = Number(env.TRANSFER_CONFIRM_STALE_MINUTES ?? 30);

export interface ConfirmationOutcome {
  checked: number;
  confirmed: string[];
  failed: string[];
  stillPending: string[];
  stale: string[];
}

function minutesSince(iso?: string): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return (Date.now() - then) / 60000;
}

/**
 * Ask Solana whether a signature landed, and whether it errored.
 *
 * getSignatureStatuses is the right call rather than getTransaction: it
 * answers for recent signatures without downloading the whole transaction,
 * and it distinguishes "not found" (null) from "found and failed" (err set).
 * Collapsing those two would mark a transfer failed the instant it is
 * broadcast but not yet propagated.
 */
async function solanaSignatureOutcome(
  signature: string,
  production: boolean
): Promise<'confirmed' | 'failed' | 'unknown'> {
  try {
    const { result } = await solanaRpc<{ value: Array<null | { err: unknown; confirmationStatus?: string }> }>(
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
      { production }
    );
    const status = result?.value?.[0];
    if (!status) return 'unknown';
    if (status.err) return 'failed';
    // 'processed' is not enough - it can still be rolled back. Only a
    // confirmed or finalised signature is worth telling a user about.
    return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized'
      ? 'confirmed'
      : 'unknown';
  } catch {
    // An RPC outage is not evidence of failure. Leave the transfer alone.
    return 'unknown';
  }
}

/**
 * Walk every transfer still saying "processing" and settle its real status.
 *
 * Never marks a transfer FAILED on the strength of a missing record. A
 * transfer we cannot find is one we do not know about, and telling a user
 * their send failed when it actually succeeded would be worse than the silence
 * this replaces - they would send it a second time.
 */
export async function confirmBalanceTransfers(): Promise<ConfirmationOutcome> {
  const outcome: ConfirmationOutcome = {
    checked: 0,
    confirmed: [],
    failed: [],
    stillPending: [],
    stale: [],
  };

  const transfers = (await listAllBalanceTransfers()).filter((transfer) =>
    OPEN_STATUSES.has(String(transfer.status))
  );
  if (!transfers.length) return outcome;

  const production = env.NETWORK_MODE !== 'testnet';
  let provider: ReturnType<typeof getWalletProvider> | undefined;
  try {
    provider = getWalletProvider(await resolveActiveWalletProvider());
  } catch {
    // No usable provider (e.g. mock outside development). Chain reads below
    // still work for Solana, so carry on rather than abandoning the sweep.
    provider = undefined;
  }

  for (const transfer of transfers) {
    outcome.checked += 1;
    const age = minutesSince(transfer.updatedAt || transfer.createdAt);

    let verdict: 'confirmed' | 'failed' | 'unknown' = 'unknown';
    let evidence = '';

    /**
     * SOLANA: the signature IS the answer, and we can read it directly.
     * This is the path the reported transfers took.
     */
    const signature = transfer.txHash;
    if (transfer.network === 'solana' && signature) {
      verdict = await solanaSignatureOutcome(signature, production);
      evidence = `solana:${signature}`;
    }

    /**
     * Otherwise ask the provider. An EVM sponsored transfer has only a
     * user-operation hash until a bundler includes it, and Privy is the one
     * that can map that back to a transaction.
     */
    if (verdict === 'unknown' && provider && transfer.providerTransferId) {
      try {
        const remote: any = await provider.getTransfer(transfer.providerTransferId);
        if (remote?.status === 'confirmed') verdict = 'confirmed';
        else if (remote?.status === 'failed') verdict = 'failed';
        evidence = `${provider.name}:${transfer.providerTransferId}`;
        // A bundler may have supplied the real hash since submission.
        if (remote?.txHash && !transfer.txHash) transfer.txHash = remote.txHash;
      } catch {
        // Provider unreachable. Same rule as the RPC: not evidence.
      }
    }

    if (verdict === 'confirmed') {
      outcome.confirmed.push(transfer.transferId);
      await createAuditLog({
        actorType: 'system',
        actorId: 'transfer_confirmer',
        action: 'balance.transfer_confirmed',
        resourceType: 'balance_transfer',
        resourceId: transfer.transferId,
        severity: 'info',
        metadata: { ...transfer, status: 'completed', evidence, confirmedAt: nowIso() },
      });
      continue;
    }

    if (verdict === 'failed') {
      /**
       * The transaction was included AND reverted. The money did not move, so
       * the debit written at submission is wrong and the user must get their
       * balance back.
       *
       * hold_release rather than a reversing credit: the original entry was a
       * hold that became a debit, and releasing it is the entry that undoes
       * that without inventing new money.
       */
      outcome.failed.push(transfer.transferId);
      const { createBalanceLedgerEntry } = await import('./balance.service.js');
      await createBalanceLedgerEntry({
        userId: transfer.userId,
        asset: transfer.asset,
        amount: transfer.amount,
        kind: 'hold_release',
        status: 'available',
        sourceType: 'balance_transfer',
        sourceId: transfer.transferId,
        description: 'Returned after the on-chain transaction failed',
        network: transfer.network,
        destinationAddress: transfer.destinationAddress,
        transferId: transfer.transferId,
      }, { actorType: 'system', actorId: 'transfer_confirmer' });

      await createAuditLog({
        actorType: 'system',
        actorId: 'transfer_confirmer',
        action: 'balance.transfer_failed',
        resourceType: 'balance_transfer',
        resourceId: transfer.transferId,
        severity: 'error',
        metadata: { ...transfer, status: 'failed', evidence, reason: 'The on-chain transaction reverted.' },
      });
      continue;
    }

    outcome.stillPending.push(transfer.transferId);
    if (age >= STALE_AFTER_MINUTES) {
      outcome.stale.push(transfer.transferId);
      /**
       * Deliberately NOT marked failed. Solana finalises in seconds, so a
       * transfer unconfirmed after 30 minutes is almost certainly broken - but
       * "almost certainly" is not a basis for telling someone their money came
       * back when it may be on chain. It is escalated to a human instead.
       */
      await createAuditLog({
        actorType: 'system',
        actorId: 'transfer_confirmer',
        action: 'balance.transfer_stale',
        resourceType: 'balance_transfer',
        resourceId: transfer.transferId,
        severity: 'warning',
        metadata: {
          ...transfer,
          ageMinutes: Math.round(age),
          reason: 'Submitted but still unconfirmed. Needs a human to check the chain before any refund.',
        },
      });
    }
  }

  return outcome;
}
