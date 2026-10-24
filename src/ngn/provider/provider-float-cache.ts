/**
 * WHAT WE BELIEVE EACH PROVIDER'S WALLET HOLDS, AND HOW SURE WE ARE.
 *
 * The point of this cache is to let routing skip a provider that cannot pay
 * for a purchase, BEFORE dispatching to it, without putting a vendor API call
 * on the critical path of every sale.
 *
 * THE FAILURE MODE THIS IS DESIGNED AROUND
 *
 * The obvious implementation - ask the provider for its balance before each
 * purchase - trades a rare failure for a common one. SME API would then sit in
 * front of every transaction: when it is slow, every purchase is slow, and
 * when it is down, every purchase fails even though most would have succeeded.
 * That is strictly worse than the problem it solves.
 *
 * So nothing here ever blocks. Three rules hold throughout:
 *
 *   1. ONLY CACHED VALUES ARE READ ON THE PURCHASE PATH. A refresh is kicked
 *      off in the background and the current request does not wait for it.
 *   2. UNKNOWN NEVER MEANS NO. If we have no recent figure, the provider is
 *      tried. A cache that has never been populated must behave exactly like
 *      the system did before this file existed.
 *   3. WE LEARN FROM FAILURES, WHICH ARE FREE. A provider that just told us
 *      its wallet is empty is the most reliable signal available, and it costs
 *      no extra call. That alone prevents the repeated pointless dispatches
 *      that motivated this.
 */

type FloatSource =
  /** Read directly from the provider. */
  | 'probe'
  /** The provider itself declined for insufficient funds. Authoritative. */
  | 'upstream_decline'
  /** Our own running estimate after a successful spend. */
  | 'optimistic';

interface FloatSnapshot {
  balanceNgn: number;
  at: number;
  source: FloatSource;
}

const cache = new Map<string, FloatSnapshot>();
const inFlight = new Set<string>();

/** Younger than this and we do not even bother refreshing. */
const FRESH_MS = 60_000;

/**
 * Older than this and the figure is discarded rather than trusted.
 *
 * A stale balance is more dangerous than no balance: someone topping the
 * wallet up by hand would otherwise be ignored for as long as we kept
 * believing an old zero, and the operator would watch a funded wallet still
 * refusing traffic.
 */
const USABLE_MS = 10 * 60_000;

/**
 * An optimistic estimate is a guess, so it is only trusted to REFUSE a
 * provider when it is well clear of the line. Without this, accumulated
 * rounding and any spend we failed to observe would eventually push a healthy
 * wallet below a threshold and take a working provider out of rotation.
 */
const OPTIMISTIC_SAFETY_MARGIN_NGN = 500;

export function recordFloatProbe(provider: string, balanceNgn: number): void {
  cache.set(provider.toLowerCase(), { balanceNgn, at: Date.now(), source: 'probe' });
}

/** The provider said it cannot pay. Nothing is more authoritative than that. */
export function recordFloatExhausted(provider: string): void {
  cache.set(provider.toLowerCase(), { balanceNgn: 0, at: Date.now(), source: 'upstream_decline' });
}

/** Keep the estimate moving between probes so a drain is noticed early. */
export function recordFloatSpend(provider: string, costNgn: number): void {
  const key = provider.toLowerCase();
  const current = cache.get(key);
  if (!current) return;
  cache.set(key, {
    balanceNgn: Math.max(0, current.balanceNgn - costNgn),
    at: current.at,
    // A probe minus a spend is no longer a probe. Downgrading the source is
    // what stops a derived number being trusted like a measured one.
    source: current.source === 'upstream_decline' ? 'upstream_decline' : 'optimistic',
  });
}

export function peekFloat(provider: string): FloatSnapshot | null {
  const snapshot = cache.get(provider.toLowerCase());
  if (!snapshot) return null;
  if (Date.now() - snapshot.at > USABLE_MS) return null;
  return snapshot;
}

/**
 * Can this provider pay for a purchase of this size?
 *
 * 'unknown' is a first-class answer and the caller must treat it as yes. Only
 * 'no' removes a provider from the chain.
 */
export function canAfford(provider: string, costNgn: number): 'yes' | 'no' | 'unknown' {
  const snapshot = peekFloat(provider);
  if (!snapshot) return 'unknown';
  if (!Number.isFinite(costNgn) || costNgn <= 0) return 'unknown';

  const required =
    snapshot.source === 'optimistic' ? costNgn + OPTIMISTIC_SAFETY_MARGIN_NGN : costNgn;

  return snapshot.balanceNgn >= required ? 'yes' : 'no';
}

/**
 * Refresh in the background. Returns immediately; the caller never waits.
 *
 * Deduplicated per provider, because a burst of purchases would otherwise
 * each start their own probe and we would have built the stampede we were
 * trying to avoid.
 */
export function refreshFloatInBackground(
  provider: string,
  probe: () => Promise<number>
): void {
  const key = provider.toLowerCase();
  const snapshot = cache.get(key);
  const fresh = snapshot && Date.now() - snapshot.at < FRESH_MS;
  if (fresh || inFlight.has(key)) return;

  inFlight.add(key);
  void (async () => {
    try {
      const balanceNgn = await probe();
      if (Number.isFinite(balanceNgn)) recordFloatProbe(key, balanceNgn);
    } catch {
      // A failed probe must not poison the cache: leaving the old value, or
      // leaving it empty, both degrade to "try the provider anyway".
    } finally {
      inFlight.delete(key);
    }
  })();
}

/** Test seam. */
export function __resetFloatCache(): void {
  cache.clear();
  inFlight.clear();
}
