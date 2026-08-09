import { env } from '../config/env.js';
import { badRequest } from '../shared/errors.js';
import { consumeStepUpToken, hasWithdrawalPin, verifyPinForUserId } from './withdrawal-pin.service.js';

/**
 * The single gate every money-out request passes through.
 *
 * There are TWO rails out of Sivan and they were built at different times by
 * different code paths:
 *
 *   POST /api/withdrawals          USD/GBP/EUR, via Bridge
 *   POST /api/ngn/offramp/orders   NGN, via Breet
 *
 * Enforcing on the first alone would have produced the most expensive kind of
 * security control: one that is documented, demoed, believed, and bypassed by
 * changing the destination currency to NGN. Both call this, so neither can
 * quietly diverge from the other.
 *
 * The PIN answers a question a session cannot: on WhatsApp and Telegram the
 * user is behind possession of a phone number and nothing else, and the
 * identity link never expires. See docs/withdrawal-pin.md.
 */

export type WithdrawalAuthorisation = {
  userId: string;
  /** Web: the PIN itself, verified inside this request. */
  pin?: string;
  /** Chat: a token minted by /api/identity/verify-pin, bound to one payout. */
  stepUpToken?: string;
  /**
   * What is being authorised. Required whenever a stepUpToken is used, because
   * the token's binding is recomputed from these and compared.
   */
  amount?: string;
  currency?: string;
  destinationRef?: string;
};

export async function assertWithdrawalAuthorised(input: WithdrawalAuthorisation): Promise<void> {
  /**
   * OFF BY DEFAULT. See WITHDRAWAL_PIN_ENFORCED in env.ts.
   *
   * The check is written, wired to both rails and tested; it simply does not
   * bite until the clients can prompt for a PIN. Shipping it enabled would
   * reject every withdrawal on both rails on the deploy that introduced it.
   */
  if (!env.WITHDRAWAL_PIN_ENFORCED) return;

  const { userId, pin, stepUpToken } = input;

  if (stepUpToken) {
    /**
     * A token authorises ONE payout, and proving that requires knowing which.
     *
     * If a caller presents a token without the amount and destination, the
     * binding cannot be recomputed, and the only two options are to accept the
     * token unbound or to refuse. Accepting it unbound would make a token
     * minted for a £5 test payout valid for any payout of any size to any
     * destination - which is precisely the replay the binding exists to stop.
     *
     * So it refuses. This matters most on the NGN rail, whose request body is
     * only { userId, quoteId }: that route must load the quote and pass its
     * amount and destination, not shrug and omit them.
     */
    if (!input.amount || !input.currency || !input.destinationRef) {
      throw badRequest('This withdrawal could not be verified. Please confirm again.', {
        code: 'PIN_BINDING_UNAVAILABLE',
      });
    }
    await consumeStepUpToken({
      token: stepUpToken,
      userId,
      amount: input.amount,
      currency: input.currency,
      destinationRef: input.destinationRef,
    });
    return;
  }

  if (pin) {
    await verifyPinForUserId(userId, pin);
    return;
  }

  /**
   * Nothing was presented.
   *
   * The two cases are told apart deliberately: a user who has never set a PIN
   * needs to be sent to Settings, and a user who has one simply needs to be
   * asked. Returning the same error for both would send someone who has
   * already set a PIN to a page telling them to set the PIN they have.
   */
  const configured = await hasWithdrawalPin(userId);
  throw badRequest(
    configured
      ? 'Enter your withdrawal PIN to approve this withdrawal.'
      : 'Set a withdrawal PIN before you withdraw.',
    { code: configured ? 'PIN_REQUIRED' : 'PIN_NOT_SET' }
  );
}
