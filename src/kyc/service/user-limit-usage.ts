import { db } from '../../database/json-database.js';
import { VOLUME_WINDOW_DAYS } from '../types/verification.types.js';
import type { FlowType, RailFamily } from '../types/verification.types.js';

/**
 * How much of the rolling window actually counts against a user, after any
 * admin reset.
 *
 * Split into its own module rather than living in verification-state.ts to
 * keep the import graph acyclic: user-limits.service.ts needs this, and
 * verification-state.ts is imported by almost everything.
 *
 * THE WATERMARK MODEL, and why it is not a subtraction.
 *
 * The obvious implementation is `used - forgiven`, storing a number. It is
 * wrong within one window: volume recorded BEFORE the reset ages out of the
 * 30-day window on its own, and a stored subtraction keeps deducting it after
 * it has already fallen off. The user would silently gain headroom twice for
 * the same transactions.
 *
 * Recomputing from a timestamp cannot drift that way. Volume at or before the
 * watermark is excluded because it is excluded, not because a counter said so,
 * and the arithmetic stays correct however long the reset sits there.
 */
export async function effectiveUsedNgn(
  userId: string,
  flow: FlowType,
  rail: RailFamily,
  /**
   * The caller's already-computed raw window total. Passed in because
   * getUserLimitDetail() needs it for six (flow, rail) pairs and re-reading
   * the transfer list per pair would turn one query into six.
   */
  rawUsedNgn?: number
): Promise<number> {
  /**
   * THE PRE-COMPUTED TOTAL IS A NAIRA TOTAL, so it may only be used for the
   * naira rail.
   *
   * getUserLimitDetail() computes one raw figure and passes it in for all six
   * (flow, rail) pairs to avoid six queries. That is correct for the three
   * `ngn` rows and WRONG for the `foreign` one, which is measured from a
   * different table entirely. Honouring the shortcut there is precisely how
   * the foreign rail ended up reporting naira volume - or, before that source
   * existed, zero.
   *
   * So the shortcut is ignored for `foreign`, which costs one extra bounded
   * query per user detail view and buys a figure that is actually about the
   * rail it is printed under.
   */
  const usableRaw = rail === 'foreign' ? undefined : rawUsedNgn;

  const resets = await db.listUserLimitResets(userId);
  const forFlow = resets
    .filter((row) => row.flow === flow && row.rail === rail)
    .sort((a, b) => Date.parse(b.resetAt) - Date.parse(a.resetAt));

  const watermark = forFlow[0]?.resetAt;

  // No reset for this flow: the raw window total already is the answer.
  if (!watermark) {
    if (typeof usableRaw === 'number') return usableRaw;
    const { getCumulativeVolumeNgn } = await import('./verification-state.js');
    return getCumulativeVolumeNgn(userId, rail, VOLUME_WINDOW_DAYS);
  }

  const windowStart = Date.now() - VOLUME_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const cutoffMs = Date.parse(watermark);

  /**
   * Once the watermark is older than the window itself, it no longer excludes
   * anything - every transfer still in the window is after it. Short-circuited
   * so an ancient reset costs nothing, and so a stale watermark can never keep
   * suppressing volume it was never meant to cover.
   */
  if (!Number.isFinite(cutoffMs) || cutoffMs <= windowStart) {
    if (typeof usableRaw === 'number') return usableRaw;
    const { getCumulativeVolumeNgn } = await import('./verification-state.js');
    return getCumulativeVolumeNgn(userId, rail, VOLUME_WINDOW_DAYS);
  }

  /**
   * A RESET ON THE FOREIGN RAIL MUST FORGIVE FOREIGN VOLUME.
   *
   * Everything below re-reads NGN transfers from the watermark. Left
   * unbranched, resetting a user's foreign window would recompute their NAIRA
   * volume and write it under `offramp/foreign` - so an admin clearing a
   * customer's foreign usage could silently give them a figure belonging to a
   * different rail. Same measurement, same floor, correct table.
   */
  if (rail === 'foreign') {
    const { getCumulativeForeignVolumeNgn } = await import('./verification-state.js');
    const sinceMs = Date.now() - cutoffMs;
    return getCumulativeForeignVolumeNgn(userId, sinceMs / (24 * 60 * 60 * 1000));
  }

  // Re-read from the watermark rather than the window start. The DB filter is
  // the same one getCumulativeNgnVolume uses, just with a later floor.
  const transfers = await db.listNgnTransfersByUserSince(userId, new Date(cutoffMs).toISOString());

  return transfers.reduce((sum: number, transfer: any) => {
    // Whichever leg is naira is the leg that counts toward an NGN threshold -
    // identical to getCumulativeNgnVolume, deliberately, so a reset cannot
    // change HOW volume is measured, only WHICH transfers are measured.
    const ngnAmount =
      transfer.sourceCurrency === 'ngn'
        ? Number(transfer.sourceAmount ?? 0)
        : transfer.destinationCurrency === 'ngn'
          ? Number(transfer.destinationAmount ?? 0)
          : 0;
    return sum + (Number.isFinite(ngnAmount) ? ngnAmount : 0);
  }, 0);
}
