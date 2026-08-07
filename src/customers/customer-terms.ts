import { badRequest } from '../shared/errors.js';
import type { CustomerRecord } from '../database/types.js';

/**
 * THE PROVIDER TERMS GATE.
 *
 * Bridge requires each end user to accept its terms of service. Sivan already
 * stored the answer and showed it on a card - but nothing enforced it, and the
 * verification page HID the step entirely from Nigerian users and rendered it
 * as a permanently-disabled button for everyone else. So the product asked for
 * a signature it never collected and never checked.
 *
 * WHO THIS APPLIES TO: users with a Bridge customer record. That is the whole
 * rule, and it is deliberately not "everyone".
 *
 * A Nigerian verifying by bank-name resolution has no Bridge relationship -
 * Bridge has never heard of them, there is no terms document that applies, and
 * there is no link they could possibly open. Demanding acceptance from them
 * would be demanding they complete a step that does not exist. The moment such
 * a user starts a Bridge verification they get a customer record, and from
 * that moment this gate applies to them too. Presence of the customer record
 * is the honest test, not their country.
 *
 * WHY A SEPARATE FUNCTION AND NOT AN INLINE COMPARISON: there are six places
 * that gate on KYC approval, and terms have to be checked at every one of them
 * or the gate is decorative. An inline `!== 'approved'` at each site is six
 * chances to write a different error message, and six places to miss when the
 * rule changes.
 */

/** True when this customer still owes Bridge a terms acceptance. */
export function customerTermsOutstanding(customer: Pick<CustomerRecord, 'provider' | 'tosStatus'> | null | undefined): boolean {
  if (!customer) return false;
  // Only the real provider has terms. A 'mock' customer in a test or sandbox
  // fixture has no Bridge relationship behind it.
  if (customer.provider !== 'bridge') return false;
  return customer.tosStatus !== 'approved';
}

/**
 * The user-facing refusal.
 *
 * Names the step, says where it is, and says what happens after - an error
 * that only says "terms required" leaves the user hunting for a link that
 * used to be buried in a status card near the bottom of the page.
 */
export const TERMS_REQUIRED_MESSAGE =
  'Accept the provider terms to finish verification. Open the Terms step on your verification page, accept, then return here.';

/** Throws the standard 400 when terms are outstanding. Otherwise returns. */
export function requireCustomerTerms(customer: Pick<CustomerRecord, 'provider' | 'tosStatus'> | null | undefined): void {
  if (customerTermsOutstanding(customer)) throw badRequest(TERMS_REQUIRED_MESSAGE);
}
