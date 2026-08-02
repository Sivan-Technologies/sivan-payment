import { db } from '../../database/json-database.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import type { NgnProviderName, NgnTransferRecord } from '../types/ngn.types.js';

/**
 * Record an inbound provider webhook.
 *
 * Typed against NgnProviderName rather than a hand-written union: the union had
 * drifted and omitted 'breet', which meant the Breet adapter's verification -
 * secret comparison and fetch-by-id confirmation - was unreachable code. A new
 * provider must not be able to be registered without its webhooks working.
 */
export async function recordNgnWebhook(providerName: NgnProviderName, payload: unknown, headers: unknown) {
  const provider = getNgnProvider(providerName);
  const event = await provider.verifyWebhook(payload, headers);
  await db.upsertNgnWebhookRecord({ ...event, processedAt: new Date().toISOString() });

  // Storing the event was previously the whole of this function, which meant a
  // webhook changed nothing a user could see. Apply it.
  await applyWebhookToTransfer(event);

  return event;
}

/**
 * A deposit that landed below the asset minimum.
 *
 * Breet's behaviour, from their docs: the deposit is confirmed on-chain, the
 * funds are HELD, nothing is credited, and a `trade.flagged` webhook is sent.
 * Recovering it costs the asset's `flagFeeUSD`.
 *
 * This is the worst possible state to leave silent. The money has left the
 * user's wallet, no naira has arrived, and without this the transfer sits at
 * `awaiting_crypto_deposit` forever - looking, to the user, exactly like a
 * deposit that never arrived. They would reasonably send again.
 */
const FLAGGED_EVENTS = new Set(['trade.flagged', 'transaction.flagged']);

function isFlaggedEvent(eventType: string, payload: any): boolean {
  if (FLAGGED_EVENTS.has(eventType)) return true;
  // Breet may also express it as a status on an ordinary trade event, so the
  // event name alone is not sufficient.
  return String(payload?.status ?? '').toLowerCase() === 'flagged';
}

/**
 * Move the transfer the webhook refers to.
 *
 * Deliberately tolerant: a webhook for an unknown transfer is recorded and
 * ignored rather than throwing. Breet retries non-2xx for 24 hours and then
 * marks the event permanently failed, so responding with an error to an event
 * we simply have no row for would burn a real delivery.
 */
async function applyWebhookToTransfer(event: {
  eventType: string;
  transferId?: string;
  payload?: unknown;
}): Promise<NgnTransferRecord | undefined> {
  const payload = event.payload as any;
  const providerRef = event.transferId ?? payload?.id;
  if (!providerRef) return undefined;

  const transfers = await db.listNgnTransfers();
  const transfer = transfers.find(
    (item) =>
      item.providerTransferId === String(providerRef) ||
      item.id === String(providerRef) ||
      (item.metadata as any)?.breetAddressId === String(providerRef)
  );
  if (!transfer) return undefined;

  if (!isFlaggedEvent(event.eventType, payload)) {
    return applySettlementToTransfer(transfer, event, payload);
  }

  // requires_review, not failed. The funds are not lost - Breet is holding
  // them - and calling it failed would tell the user their money is gone while
  // support can still recover it.
  const amountUsd = payload?.amountInUSD ?? payload?.amountInUsd ?? payload?.amount;
  const minimumUsd = payload?.minimum;

  const updated: NgnTransferRecord = {
    ...transfer,
    status: 'requires_review',
    metadata: {
      ...(typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata : {}),
      flagged: true,
      flaggedAt: new Date().toISOString(),
      flaggedEvent: event.eventType,
      flaggedAmountUsd: amountUsd,
      flaggedMinimumUsd: minimumUsd,
      // The user-facing sentence, composed once here rather than in each of
      // the surfaces that will render it.
      flaggedReason:
        amountUsd && minimumUsd
          ? `Your deposit of ${amountUsd} USD is below the ${minimumUsd} USD minimum for this asset. ` +
            'Breet is holding the funds - contact support to recover them.'
          : 'Your deposit was below the minimum for this asset and is being held. Contact support to recover it.',
    },
    updatedAt: new Date().toISOString(),
  };

  await db.upsertNgnTransferRecord(updated);
  return updated;
}

/**
 * Advance a transfer on a NON-flagged webhook.
 *
 * THIS DID NOT EXIST. applyWebhookToTransfer handled `trade.flagged` and
 * returned early for everything else, so a `trade.completed` was verified,
 * stored, and then thrown away. The user's crypto had been converted and the
 * naira paid out, and the transfer still read `awaiting_crypto_deposit` -
 * indistinguishable, to them, from a deposit that never arrived. The flagged
 * path was fixed in 8a935a7 for exactly this reason; the SUCCESS path had the
 * same hole and nobody noticed, because a stored webhook looks like a handled
 * one.
 *
 * The status comes from Breet's own record. verifyWebhook re-fetches the
 * transaction from Breet and merges it over the delivered body, so what is
 * read here is Breet's number rather than the caller's - a replayed payload
 * with an inflated amount cannot settle anything.
 */
async function applySettlementToTransfer(
  transfer: NgnTransferRecord,
  event: { eventType: string },
  payload: any
): Promise<NgnTransferRecord | undefined> {
  const next = mapBreetStatus(payload?.status);
  if (!next) return undefined;

  // NEVER MOVE A TERMINAL TRANSFER. Breet retries for up to 24 hours, so a
  // late duplicate of an earlier event is routine - and rewinding a completed
  // transfer to processing would show a user their finished payout had
  // reverted.
  const TERMINAL = new Set(['completed', 'failed', 'expired']);
  if (TERMINAL.has(transfer.status)) return transfer;

  if (transfer.status === next) return transfer;

  const updated: NgnTransferRecord = {
    ...transfer,
    status: next,
    metadata: {
      ...(typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata : {}),
      lastWebhookEvent: event.eventType,
      lastWebhookAt: new Date().toISOString(),
      // Breet's own figures, kept for reconciliation and support. The naira
      // amount actually paid can differ from the quote if the rate moved.
      settledCryptoAmount: payload?.cryptoAmount ?? payload?.amount,
      settledFiatAmount: payload?.fiatAmount ?? payload?.amountInNGN,
      settledAmountUsd: payload?.amountInUSD ?? payload?.amountInUsd,
    },
    updatedAt: new Date().toISOString(),
  };

  await db.upsertNgnTransferRecord(updated);
  return updated;
}

/**
 * Breet's transaction states, mapped onto Sivan's.
 *
 * Returns undefined for a status we do not recognise, which leaves the
 * transfer untouched. Guessing at an unknown state is how a transfer ends up
 * marked completed because a provider added a word we had not seen.
 */
function mapBreetStatus(status?: string): NgnTransferRecord['status'] | undefined {
  const value = String(status ?? '').toLowerCase();
  if (!value) return undefined;
  if (value === 'completed' || value === 'success' || value === 'successful') return 'completed';
  if (value === 'failed' || value === 'rejected' || value === 'reversed') return 'failed';
  if (value === 'processing' || value === 'pending' || value === 'confirmed') return 'processing';
  return undefined;
}

export async function listNgnWebhooks() {
  return (await db.listNgnWebhooks()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
