import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import type { BridgeWebhookPayload } from '../webhooks/webhooks.service.js';

/**
 * Bridge `bridge_wallet.activity` webhook handling.
 *
 * This is what makes a deposit visible. Without it a user could send USDC to
 * their Sivan address and nothing in the platform would ever notice.
 *
 * Deliberately narrow in scope: this records that activity happened and leaves
 * an audit trail. It does NOT write a balance into Sivan's database. Bridge is
 * the custodian and the source of truth for balances, so balances are read
 * back from Bridge on demand. Mirroring them here would create the class of
 * bug where our books and the custodian's disagree, and would edge toward
 * "holding funds on behalf of users" under Bridge ToS 2.1(m).
 */

export function isWalletActivityWebhook(payload: BridgeWebhookPayload): boolean {
  const category = String(payload?.event_category ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s.\-]+/g, '_');
  return category === 'bridge_wallet_activity';
}

/**
 * Bridge nests the wallet id differently depending on the event shape, so try
 * the documented locations in order rather than assuming one.
 */
function extractWalletId(payload: BridgeWebhookPayload): string | undefined {
  const object = payload?.event_object ?? {};
  return (
    object.bridge_wallet_id ||
    object.wallet_id ||
    object.destination?.bridge_wallet_id ||
    object.source?.bridge_wallet_id ||
    // For a bridge_wallet.activity event the object id IS the wallet id.
    payload?.event_object_id ||
    undefined
  );
}

function extractAmount(payload: BridgeWebhookPayload): { amount?: string; currency?: string } {
  const object = payload?.event_object ?? {};
  const amount = object.amount ?? object.balance ?? object.destination?.amount;
  const currency = object.currency ?? object.destination?.currency;
  return {
    // Kept as a string. Bridge expresses amounts in whole US cents and
    // parsing to a number would introduce float drift into a money value.
    amount: amount === undefined || amount === null ? undefined : String(amount),
    currency: currency ? String(currency).toLowerCase() : undefined,
  };
}

export interface WalletActivityResult {
  matched: boolean;
  userId?: string;
  walletId?: string;
  reason?: string;
}

/**
 * Resolve the event to a Sivan user and record it.
 *
 * An unmatched event is not an error: it may belong to a treasury wallet or to
 * a wallet created outside this environment. It is logged and ignored rather
 * than throwing, because throwing would make Bridge retry an event that can
 * never succeed.
 */
export async function applyWalletActivityEvent(
  payload: BridgeWebhookPayload
): Promise<WalletActivityResult> {
  const providerWalletId = extractWalletId(payload);
  if (!providerWalletId) {
    return { matched: false, reason: 'no_wallet_id_in_payload' };
  }

  const data = await db.read();
  const wallets = (data as any).userWallets ?? [];
  const wallet = wallets.find((item: any) => item.providerWalletId === providerWalletId);

  if (!wallet) {
    // Worth an audit line: an unrecognised wallet receiving funds is either a
    // treasury wallet (fine) or a sign that wallet records are out of sync
    // with Bridge (not fine). Silence would hide the second case.
    await createAuditLog({
      actorType: 'system',
      actorId: 'bridge-webhook',
      action: 'wallet.activity.unmatched',
      resourceType: 'user_wallet',
      resourceId: providerWalletId,
      severity: 'warning',
      metadata: {
        providerWalletId,
        eventId: payload.event_id,
        eventType: payload.event_type,
      },
    });
    return { matched: false, walletId: providerWalletId, reason: 'wallet_not_found' };
  }

  const { amount, currency } = extractAmount(payload);

  await createAuditLog({
    actorType: 'system',
    actorId: 'bridge-webhook',
    action: 'wallet.activity',
    resourceType: 'user_wallet',
    resourceId: wallet.id,
    severity: 'info',
    metadata: {
      userId: wallet.userId,
      providerWalletId,
      chain: wallet.chain,
      amount,
      currency,
      eventId: payload.event_id,
      eventType: payload.event_type,
      eventStatus: payload.event_object_status,
      // Balances are intentionally NOT written to Sivan's database here.
      // Bridge remains the source of truth; the UI reads through to it.
      note: 'Balance not mirrored locally by design; Bridge is the custodian of record.',
    },
  });

  return { matched: true, userId: wallet.userId, walletId: wallet.id };
}
