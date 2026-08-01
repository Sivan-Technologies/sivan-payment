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

  if (!isFlaggedEvent(event.eventType, payload)) return undefined;

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

export async function listNgnWebhooks() {
  return (await db.listNgnWebhooks()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
