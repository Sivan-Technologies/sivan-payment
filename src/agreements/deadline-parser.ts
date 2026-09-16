/**
 * NATURAL LANGUAGE DELIVERY DEADLINE EXTRACTOR
 *
 * A pure function. No I/O, no side effects, easy to unit-test in isolation.
 *
 * CONTRACT:
 *   - Input: any string (the raw agreement description typed by buyer or AI agent).
 *   - Output: { deadlineDays, matched } — the extracted integer and the phrase
 *     that triggered the match (for audit logging and UI display).
 *   - Fallback: 3 days when nothing matches. This is the same default the
 *     FUTURE_BUILD_DELIVERY_DEADLINE_TIMER spec documents.
 *
 * PATTERNS RECOGNISED (case-insensitive, global):
 *   "deliver in 1 day"       → 1
 *   "deliver in 3 days"      → 3
 *   "deliver in 24 hours"    → 1  (ceiling division: 24h → 1d, 48h → 2d)
 *   "due in 7 days"          → 7
 *   "3-day delivery"         → 3
 *   "by friday"              → days until next matching weekday from now
 *   "in 2 weeks"             → 14
 *
 * WHY CEILING FOR HOURS:
 *   A seller who says "24 hours" expects a 1-day window, not 0.04 days.
 *   Rounding up matches human expectation while keeping the unit an integer.
 */

export interface DeadlineParseResult {
  /** Number of whole days for the delivery window. Always >= 1. */
  deadlineDays: number;
  /** The substring that triggered the match, or 'default' when nothing matched. */
  matched: string;
}

const DEFAULT_DEADLINE_DAYS = 3;

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Days from today until the next occurrence of the named weekday (1–7). */
function daysUntilWeekday(target: number, fromDate = new Date()): number {
  const todayDow = fromDate.getDay();
  const diff = (target - todayDow + 7) % 7;
  // If today IS that weekday, treat as "next week" (7 days), not 0.
  return diff === 0 ? 7 : diff;
}

export function parseDeliveryDeadline(text: string, now = new Date()): DeadlineParseResult {
  if (!text || typeof text !== 'string') {
    return { deadlineDays: DEFAULT_DEADLINE_DAYS, matched: 'default' };
  }

  const normalized = text.toLowerCase();

  // --- Pattern 1: "N hour(s)" variants ---
  // "deliver in 24 hours", "done in 6 hours", "complete in 48 hours"
  const hoursMatch = normalized.match(
    /(?:deliver(?:ed)?|due|complete(?:d)?|done|ready|finish(?:ed)?)?(?:\s+in\s+|\s*)(\d+)\s*(?:hours?|hrs?)/
  );
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1], 10);
    const deadlineDays = Math.max(1, Math.ceil(hours / 24));
    return { deadlineDays, matched: hoursMatch[0].trim() };
  }

  // --- Pattern 2: "N day(s)" variants ---
  // "deliver in 3 days", "due in 1 day", "complete in 5 days"
  const daysMatch = normalized.match(
    /(?:deliver(?:ed)?|due|complete(?:d)?|done|ready|finish(?:ed)?)?(?:\s+in\s+|\s*)(\d+)\s*(?:days?)/
  );
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const deadlineDays = Math.max(1, days);
    return { deadlineDays, matched: daysMatch[0].trim() };
  }

  // --- Pattern 3: "N-day delivery" / "N-day turnaround" ---
  // "3-day delivery", "2-day turnaround"
  const hyphenDaysMatch = normalized.match(/(\d+)[- ]day(?:\s+(?:delivery|turnaround|timeline|window))?/);
  if (hyphenDaysMatch) {
    const days = parseInt(hyphenDaysMatch[1], 10);
    const deadlineDays = Math.max(1, days);
    return { deadlineDays, matched: hyphenDaysMatch[0].trim() };
  }

  // --- Pattern 4: "N week(s)" ---
  // "deliver in 2 weeks", "done in 1 week"
  const weeksMatch = normalized.match(
    /(?:deliver(?:ed)?|due|complete(?:d)?|done)?(?:\s+in\s+|\s*)(\d+)\s*(?:weeks?)/
  );
  if (weeksMatch) {
    const weeks = parseInt(weeksMatch[1], 10);
    const deadlineDays = Math.max(1, weeks * 7);
    return { deadlineDays, matched: weeksMatch[0].trim() };
  }

  // --- Pattern 5: "by <weekday>" ---
  // "by friday", "by monday", "due by Thursday"
  const byWeekdayMatch = normalized.match(/(?:by|due\s+by)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (byWeekdayMatch) {
    const dayName = byWeekdayMatch[1];
    const targetDow = WEEKDAY_NAMES.indexOf(dayName);
    const deadlineDays = daysUntilWeekday(targetDow, now);
    return { deadlineDays, matched: byWeekdayMatch[0].trim() };
  }

  // --- No match: return the configured default ---
  return { deadlineDays: DEFAULT_DEADLINE_DAYS, matched: 'default' };
}
