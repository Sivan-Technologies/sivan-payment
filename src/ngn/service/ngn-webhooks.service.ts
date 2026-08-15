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
  const transfer = findTransferForEvent(transfers, String(providerRef), payload);
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
 * FIND THE TRANSFER A BREET EVENT BELONGS TO.
 *
 * THE ID IN THE WEBHOOK IS NOT THE ID WE STORED.
 *
 * createOfframpTransfer saves the DEPOSIT ADDRESS id as providerTransferId -
 * that is all Breet gives back at address-generation time. But every event
 * afterwards is keyed on something else:
 *
 *   trade.address.created  id = wallet/address id      (matches)
 *   trade.pending          id = TRADE id               (no match)
 *   trade.completed        id = TRADE id               (no match)
 *   withdrawal.*           id = WITHDRAWAL id          (no match)
 *
 * Verified against six real deliveries: address 6a70ad8c040553cd1f89a0c2,
 * trade 6a70adbe0b4ad380586424a1, withdrawal 6a70adbea4f8526669d89013 - three
 * different ids for one settlement. So even with a correct secret, only the
 * useless first event would ever have matched, and `trade.completed` - the one
 * that finishes the transfer - would have been dropped on the floor by the
 * `if (!transfer) return undefined` above.
 *
 * The link back is the ADDRESS, which every payload carries under one of
 * several names, and which is stable because Breet addresses are permanent.
 * A withdrawal names its parent trade rather than an address, so the trade id
 * learned from an earlier event is matched too.
 */
function findTransferForEvent(
  transfers: NgnTransferRecord[],
  providerRef: string,
  payload: any
): NgnTransferRecord | undefined {
  const meta = (transfer: NgnTransferRecord) =>
    (typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata : {}) as any;
  const transferMeta = (transfer: NgnTransferRecord) => meta(transfer).transferMetadata ?? {};

  const byId = transfers.find(
    (item) =>
      item.providerTransferId === providerRef ||
      item.id === providerRef ||
      meta(item).breetAddressId === providerRef ||
      meta(item).breetTradeId === providerRef ||
      meta(item).breetWithdrawalId === providerRef
  );
  if (byId) return byId;

  const txHash = String(payload?.txHash ?? payload?.hash ?? '').toLowerCase();
  if (txHash) {
    const byTxHash = transfers.find((item) => {
      const m = meta(item);
      return String(item.destinationTxHash ?? '').toLowerCase() === txHash
        || String(m.depositTxHash ?? '').toLowerCase() === txHash
        || String(m.breetDepositTxHash ?? '').toLowerCase() === txHash;
    });
    if (byTxHash) return byTxHash;
  }

  // A withdrawal points at its trade; the trade was recorded when its own
  // event arrived.
  const tradeRef = payload?.trade ? String(payload.trade) : '';
  if (tradeRef) {
    const byTrade = transfers.find(
      (item) => meta(item).breetTradeId === tradeRef || item.providerTransferId === tradeRef
    );
    if (byTrade) return byTrade;
  }

  // The deposit address. Case-insensitive because EVM addresses arrive
  // checksummed in some payloads and lowercased in others, and a case-
  // sensitive compare here would silently drop a real settlement.
  const address = String(
    payload?.destinationAddress ?? payload?.address ?? payload?.walletAddress ?? ''
  ).toLowerCase();
  if (address) {
    const byAddress = bestBreetAddressMatch(transfers.filter(
      (item) =>
        String(item.depositAddress ?? '').toLowerCase() === address ||
        String(transferMeta(item).depositAddress ?? '').toLowerCase() === address
    ), payload);
    if (byAddress) return byAddress;
  }

  // Last resort: the label we generated when creating the address. It embeds
  // our user id and the asset id, so it is ours and unambiguous.
  const label = String(payload?.label ?? payload?.wallet ?? '');
  if (label) {
    const byLabel = transfers.find((item) => transferMeta(item).label === label);
    if (byLabel) return byLabel;
  }

  /**
   * A WITHDRAWAL THAT NAMES NEITHER AN ADDRESS NOR A KNOWN TRADE.
   *
   * Every strategy above needs one of: a provider id we stored, a txHash, a
   * known trade id, a destinationAddress, or a label. A real
   * `withdrawal.completed` from Breet carries NONE of them:
   *
   *   { id, trade, amount, originalAmount, payoutAmount, currency,
   *     status, reference, meta:{ bankId, accountNumber, ... }, event }
   *
   * `trade` is only useful once some earlier `trade.*` event taught us that
   * id, and `providerTransferId` holds the WALLET id, not the trade id. So if
   * the trade event is missed, delayed, or never fires in the shape we expect,
   * the payout that actually moved the user's money matched nothing and the
   * order sat at `settlement_processing` while the naira was in their bank.
   * Observed in production: Breet delivered on attempt 1, we 200'd it, and
   * the screen stayed wrong.
   *
   * The payout amount is the join key of last resort. It is denominated in
   * NGN - the DESTINATION - so it is compared against destinationAmount, not
   * sourceAmount. Note `amount` and `payoutAmount` differ (24699 vs 24649:
   * Breet's ₦50 transfer fee), so both are tried.
   *
   * DELIBERATELY THE LAST STRATEGY, AND DELIBERATELY EXACT-OR-NOTHING. It runs
   * only on withdrawal events, only over open offramps, and refuses when two
   * orders could equally claim the payout - completing an arbitrary order on a
   * fuzzy amount match would be worse than leaving one pending, because the
   * user whose money is still in flight would be told it had arrived.
   */
  if (String(payload?.event ?? '').toLowerCase().startsWith('withdrawal')) {
    const payoutAmounts = [payload?.amount, payload?.originalAmount, payload?.payoutAmount]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);

    if (payoutAmounts.length) {
      const openOfframps = transfers.filter(
        (item) =>
          item.direction === 'offramp' &&
          item.destinationCurrency === 'ngn' &&
          item.status !== 'completed' &&
          item.status !== 'failed'
      );

      // Within one naira: Breet rounds, and a kobo of drift must not orphan a
      // real payout. Wide enough to absorb rounding, far tighter than the
      // gap between two genuinely different orders.
      const byAmount = openOfframps.filter((item) => {
        const destination = Number(item.destinationAmount);
        if (!Number.isFinite(destination)) return false;
        return payoutAmounts.some((value) => Math.abs(value - destination) <= 1);
      });

      // Exactly one, or nothing. Ambiguity here is a refusal, not a guess.
      if (byAmount.length === 1) return byAmount[0];
    }
  }

  return undefined;
}

function bestBreetAddressMatch(
  candidates: NgnTransferRecord[],
  payload: any
): NgnTransferRecord | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const eventTime = Date.parse(String(payload?.createdAt ?? payload?.updatedAt ?? ''));
  const eventAmount = Number(payload?.cryptoAmount ?? payload?.amountReceived ?? payload?.amountInUSD ?? payload?.amount);
  const eventAsset = String(payload?.asset ?? '').toLowerCase();

  const open = candidates.filter((item) => !['completed', 'failed', 'expired', 'cancelled'].includes(item.status));
  const pool = open.length ? open : candidates;

  /**
   * Breet deposit addresses are reusable. Address match alone is therefore
   * not a transaction id; it is a user+asset funding rail. Pick the transfer
   * that best fits this specific trade, otherwise a second withdrawal to the
   * same address can be advanced by an old trade webhook.
   */
  const scored = pool.map((item) => {
    const created = Date.parse(item.createdAt);
    const amount = Number(item.sourceAmount);
    const transferAsset = String(item.sourceCurrency ?? '').toLowerCase();
    let score = 0;
    if (eventAsset && transferAsset && eventAsset.includes(transferAsset)) score += 4;
    if (Number.isFinite(eventAmount) && Number.isFinite(amount) && Math.abs(eventAmount - amount) < 0.000001) score += 8;
    if (Number.isFinite(eventTime) && Number.isFinite(created) && created <= eventTime) score += 2;
    return { item, score, created };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.created - a.created;
  });

  return scored[0]?.item;
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
  const next = mapBreetEvent(event.eventType, payload?.status);
  if (!next) return undefined;

  // NEVER MOVE A TERMINAL TRANSFER. Breet retries for up to 24 hours, so a
  // late duplicate of an earlier event is routine - and rewinding a completed
  // transfer to processing would show a user their finished payout had
  // reverted.
  const TERMINAL = new Set(['completed', 'failed', 'expired']);
  if (TERMINAL.has(transfer.status)) return transfer;

  // NEVER MOVE BACKWARDS EITHER. Breet's events do not arrive in order - in
  // the six real deliveries observed, withdrawal.completed was generated
  // BEFORE trade.completed, and Breet retries each independently over 24
  // hours. Without this, a late trade.pending after a withdrawal.completed
  // would drag a finished payout back to "settling".
  //
  // FAILURE IS EXEMPT, AND THAT EXEMPTION IS NOT OPTIONAL.
  //
  // 'failed' is not a point on the happy path, so it has no rank - it scored 0
  // and this guard silently swallowed every trade.failed, leaving a rejected
  // transfer sitting at awaiting_crypto_deposit forever. I introduced that
  // while fixing the reordering problem and test:failure-paths caught it.
  // A transfer must always be able to fail, from any non-terminal state.
  if (next !== 'failed' && rank(next) < rank(transfer.status)) return transfer;

  if (transfer.status === next) return transfer;

  const eventIds = learnBreetIds(event.eventType, payload);

  const updated: NgnTransferRecord = {
    ...transfer,
    status: next,
    completedAt: next === 'completed' ? new Date().toISOString() : transfer.completedAt,
    destinationTxHash: payload?.txHash ? String(payload.txHash) : transfer.destinationTxHash,
    settlementReference: next === 'completed'
      ? String(payload?.reference ?? payload?.settlementReference ?? payload?.id ?? transfer.settlementReference ?? '')
      : transfer.settlementReference,
    metadata: {
      ...(typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata : {}),
      ...eventIds,
      lastWebhookEvent: event.eventType,
      lastWebhookAt: new Date().toISOString(),
      /**
       * Breet's own figures, kept for reconciliation and support. The naira
       * amount actually paid can differ from the quote if the rate moved.
       *
       * ONE EVENT MUST NOT ERASE ANOTHER'S NUMBERS.
       *
       * A settlement arrives as two events carrying DIFFERENT fields: the
       * trade knows the crypto amount and the USD value, the withdrawal knows
       * the naira paid and the payout fee. Writing all of them on every event
       * meant the withdrawal - which always arrives second on the happy path -
       * overwrote the trade's figures with undefined and reconciliation lost
       * the amounts. Caught by test:full-system, but only after that suite was
       * extended to deliver BOTH events; every suite that stopped at the trade
       * was blind to it.
       */
      ...keepKnown(settledFigures(event.eventType, payload)),
      settlementProof: settlementProof(event.eventType, payload, next),
    },
    updatedAt: new Date().toISOString(),
  };

  await db.upsertNgnTransferRecord(updated);
  return updated;
}

function settlementProof(
  eventType: string,
  payload: any,
  next: NgnTransferRecord['status']
): Record<string, unknown> {
  const event = String(eventType ?? '').toLowerCase();
  if (event.startsWith('withdrawal') && next === 'completed') {
    return {
      kind: 'bank_payout_completed',
      withdrawalId: payload?.id,
      tradeId: payload?.trade,
      reference: payload?.reference ?? payload?.settlementReference,
      amount: payload?.payoutAmount ?? payload?.amount ?? payload?.amountInNGN,
      completedAt: payload?.updatedAt ?? new Date().toISOString(),
    };
  }

  if (event.startsWith('trade') && next === 'settlement_processing') {
    return {
      kind: Number(payload?.amountSettled ?? 0) > 0 ? 'trade_converted_settlement_reported' : 'trade_converted_no_bank_payout_yet',
      tradeId: payload?.id,
      txHash: payload?.txHash,
      amountSettled: payload?.amountSettled,
      completedAt: payload?.updatedAt ?? new Date().toISOString(),
    };
  }

  return {};
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

/**
 * THE EVENT MATTERS AS MUCH AS THE STATUS. A completed TRADE is not a
 * completed PAYOUT.
 *
 * `trade.completed` means the crypto was converted and Breet credited its own
 * NGN wallet. The naira has not reached the user's bank at that point - that
 * is `withdrawal.completed`, a separate event with a separate id. Mapping on
 * status alone marked the transfer "completed" the moment the trade settled,
 * which tells a user their money has arrived while it is still inside Breet.
 * On a non-autoSettlement account it may never leave.
 *
 * So only a withdrawal event may complete an off-ramp. A completed trade is
 * `settlement_processing`: converted, payout in flight.
 */
function mapBreetEvent(
  eventType: string,
  status?: string
): NgnTransferRecord['status'] | undefined {
  const mapped = mapBreetStatus(status);
  if (!mapped) return undefined;
  const event = String(eventType ?? '').toLowerCase();

  if (event.startsWith('withdrawal')) {
    if (mapped === 'completed') return 'completed';
    if (mapped === 'failed') return 'failed';
    return 'bank_processing';
  }

  if (event.startsWith('trade')) {
    if (mapped === 'completed') return 'settlement_processing';
    if (mapped === 'failed') return 'failed';
    return 'blockchain_confirmed';
  }

  return mapped;
}

/**
 * How far along a status is, for the no-going-backwards guard. Terminal
 * states rank highest; an unknown status ranks 0 so it can never hold a
 * transfer back.
 */
function rank(status: string): number {
  const order = [
    'created',
    'quote_created',
    'quote_accepted',
    'awaiting_deposit',
    'awaiting_crypto_deposit',
    'deposit_received',
    'blockchain_confirmed',
    'processing',
    'settlement_processing',
    'bank_processing',
    'crypto_sent',
    'completed',
  ];
  const index = order.indexOf(status);
  return index < 0 ? 0 : index;
}

/**
 * Remember the ids Breet used, so the NEXT event can be matched.
 *
 * Each stage of one settlement has its own id, and the only place they are
 * ever correlated is here, as they arrive. Storing them turns the second and
 * third events from unmatchable into trivial lookups.
 */
/**
 * WHICH NUMBER IS WHICH DEPENDS ON THE EVENT.
 *
 * `amount` means different things on the two events - on a trade it is crypto,
 * on a withdrawal it is naira - so a shared fallback chain
 * (`cryptoAmount ?? amount`) read a withdrawal's 94,221 NGN as 94,221 USDC and
 * wrote it into settledCryptoAmount. That is a wrong number in the record that
 * support and reconciliation read, wrong by a factor of the exchange rate.
 *
 * Each event therefore only contributes the fields it actually knows.
 */
function settledFigures(eventType: string, payload: any): Record<string, unknown> {
  const event = String(eventType ?? '').toLowerCase();

  if (event.startsWith('withdrawal')) {
    return {
      settledFiatAmount: payload?.payoutAmount ?? payload?.amount ?? payload?.amountInNGN,
      settledPayoutFee: payload?.meta?.fee,
    };
  }

  return {
    settledCryptoAmount: payload?.cryptoAmount ?? payload?.amountReceived ?? payload?.amount,
    settledFiatAmount: payload?.fiatAmount ?? payload?.amountInNGN ?? payload?.amountSettled,
    settledAmountUsd: payload?.amountInUSD ?? payload?.amountInUsd,
  };
}

/**
 * Drop undefined entries so a spread cannot blank a value that is already
 * known. `{...a, b: undefined}` still writes the key.
 */
function keepKnown(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function learnBreetIds(eventType: string, payload: any): Record<string, unknown> {
  const event = String(eventType ?? '').toLowerCase();
  const learned: Record<string, unknown> = {};
  if (payload?.id && event.startsWith('trade')) learned.breetTradeId = String(payload.id);
  if (payload?.id && event.startsWith('withdrawal')) learned.breetWithdrawalId = String(payload.id);
  if (payload?.trade) learned.breetTradeId = String(payload.trade);
  if (payload?.txHash) learned.depositTxHash = String(payload.txHash);
  if (payload?.destinationAddress) learned.breetDepositAddress = String(payload.destinationAddress);
  return learned;
}

export async function listNgnWebhooks() {
  return (await db.listNgnWebhooks()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
