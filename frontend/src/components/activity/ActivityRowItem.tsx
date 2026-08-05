import type { ActivityRow } from '../../activityFeed';

/**
 * ONE ROW, USED BY BOTH THE DASHBOARD AND THE TRANSACTIONS PAGE.
 *
 * Shared for the same reason the merge is shared: two implementations of "a
 * transaction row" is how the dashboard ended up showing two sources while the
 * Transactions page showed three.
 *
 * WHAT A ROW HAS TO ANSWER, in the order a person reads it:
 *
 *   1. what happened          the label, and an arrow for direction
 *   2. how much               right-aligned, signed
 *   3. is it done             one status word from the shared vocabulary
 *   4. when                   relative, because "2h ago" is what people think in
 *
 * The arrow carries the direction rather than colour alone: red/green is
 * invisible to a red-green colourblind user, and roughly 1 in 12 men are.
 */

/** Relative time, because nobody thinks in ISO timestamps. */
function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  // Past a week a date is more useful than "43d ago".
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const DIRECTION_ICON: Record<ActivityRow['direction'], string> = {
  in: '↓',
  out: '↑',
  // Not an arrow: a self-transfer is neither gain nor loss, and showing it as
  // an outgoing payment beside a supplier payout would misdescribe it.
  internal: '⇄',
};

export function ActivityRowItem({ row, onOpen, selected }: { row: ActivityRow; onOpen?: () => void; selected?: boolean }) {
  /**
   * The sign is on the AMOUNT, where the eye lands, not only on the icon.
   * Internal moves are unsigned - the money has not left the user.
   */
  const sign = row.direction === 'in' ? '+' : row.direction === 'out' ? '−' : '';

  const content = (
    <>
      <span className={`activity-icon ${row.direction}`} aria-hidden="true">{DIRECTION_ICON[row.direction]}</span>
      <span className="activity-main">
        <strong>{row.label}</strong>
        <small>
          {/* The asset is only worth saying when it differs from the currency:
              "10 USDC · USDC" is noise. */}
          {row.asset && row.asset !== row.currency ? `${row.asset} · ` : ''}
          {/* Capitalised by its own class, not by the parent: a blanket
              text-transform on this line also hit the timestamp and rendered
              "2h ago" as "2h Ago". */}
          {row.network ? <><span className="activity-network">{row.network.replaceAll('_', ' ')}</span>{' · '}</> : ''}
          {timeAgo(row.createdAt)}
        </small>
      </span>
      <span className="activity-figures">
        <b className={`activity-amount ${row.direction}`}>{sign}{row.amount} {row.currency}</b>
        <span className={`activity-status ${row.state}`}>{row.statusLabel}</span>
      </span>
    </>
  );

  // A row that does nothing must not look clickable, so it renders as a plain
  // element rather than a disabled button.
  if (!onOpen) {
    return <div className={`activity-row ${selected ? 'selected' : ''}`}>{content}</div>;
  }

  return (
    <button
      type="button"
      className={`activity-row ${selected ? 'selected' : ''}`}
      onClick={onOpen}
      // Screen readers get the whole row as one sentence; the visual split into
      // three columns is layout, not meaning.
      aria-label={`${row.label}, ${row.amount} ${row.currency}, ${row.statusLabel}`}
    >
      {content}
    </button>
  );
}
