import { db } from '../../database/json-database.js';
import type { Chain } from '../../database/types.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { listPaymentControls, requireAssetSupportedOnChain } from '../../controls/payment-controls.service.js';
import { verificationPathFor } from '../../kyc/service/verification-path.js';
import type { CreateOnrampOrderInput } from '../types/onramp.schemas.js';
import { requireCustomerTerms } from '../../customers/customer-terms.js';

/**
 * WHY THIS ORDERS ITSELF THE WAY IT DOES.
 *
 * Reported from a phone: a Nigerian user at Level 1 - bank check done, the app
 * showing "Verified" and 100% set up - filled in the whole buy form, pressed
 * "Create buy order", waited, and got a wall of red saying the payments-api
 * service did not respond.
 *
 * Two separate defects, both reproduced against the deployed test API.
 *
 * 1. THE ANSWER WAS RIGHT AND THE WORDS WERE WRONG.
 *
 *    Buying stablecoins runs on Bridge, which requires ITS OWN identity check.
 *    A Nigerian bank check is Level 1 by our ladder but is not evidence Bridge
 *    accepts, so this correctly refuses. But it refused with "Complete
 *    verification before buying stablecoins" to someone the dashboard had just
 *    told was verified. That reads as the app contradicting itself, and it
 *    gives no hint that a DIFFERENT, higher check is the way through.
 *
 *    The frontend gate had the same split brain: `isVerified` there is
 *    `summary.pathComplete`, which is true for a Nigerian at Level 1, so the
 *    buy form rendered and the button was live. The user could only discover
 *    the real rule by failing.
 *
 * 2. IT TOOK EIGHTEEN SECONDS TO SAY NO.
 *
 *    Measured, warm, three times in a row: 18155ms, 17625ms, 17977ms. The
 *    Cloudflare gateway gives up at 12s, so the user never even saw the
 *    refusal - they saw UPSTREAM_UNAVAILABLE, "this was a POST and was NOT
 *    retried", which is the scariest message we own. It implies their money
 *    might be in flight.
 *
 *    The cause was four separate control guards, each calling
 *    listPaymentControls(), each doing a full db.read() - which on Postgres is
 *    47 sequential `select *` queries, every table. Four times. Before the
 *    cheap "is this user allowed" check had even run.
 *
 * So: read the controls ONCE, check the user BEFORE the provider work, and
 * name the actual next step when refusing.
 */
export async function validateOnrampOrderInput(input: CreateOnrampOrderInput) {
  /**
   * ONE read of the controls, shared by all four checks.
   *
   * These were four calls to four guards that each re-read the whole database.
   * The controls cannot change between them - it is the same request - so the
   * other three reads bought nothing but latency.
   */
  const [controls, user, customer] = await Promise.all([
    listPaymentControls(),
    db.findUserById(input.userId),
    db.findCustomerByUserId(input.userId),
  ]);

  if (!user) throw notFound('User');

  /**
   * THE USER CHECK COMES FIRST.
   *
   * It is the most likely refusal and the cheapest to compute, and every
   * control check below is wasted work when the user was never eligible. It
   * also means the eighteen seconds cannot happen before the honest answer.
   */
  const path = verificationPathFor(user.country);
  if (!customer || customer.kycStatus !== 'kyc_approved') {
    throw badRequest(bridgeRequiredMessage(path, customer?.kycStatus));
  }
  requireCustomerTerms(customer);

  const currency = controls.payoutCurrencies.find((item) => item.currency === input.sourceCurrency);
  if (!currency?.enabled) {
    throw badRequest(`${input.sourceCurrency.toUpperCase()} payments are currently unavailable`);
  }

  const asset = controls.sourceAssets.find((item) => item.asset === input.destinationCurrency);
  if (!asset?.enabled) {
    throw badRequest(`${input.destinationCurrency.toUpperCase()} purchases are currently unavailable`);
  }

  const network = controls.sourceNetworks.find((item) => item.network === input.destinationChain);
  if (!network?.enabled) {
    throw badRequest(`${network?.label ?? input.destinationChain} network is currently unavailable`);
  }

  // Reject impossible pairs such as USDT on Base before an order is created
  // and a deposit address is handed to the customer. Pure, no read.
  await requireAssetSupportedOnChain(input.destinationCurrency, input.destinationChain as Chain);

  return { user, customer };
}

/**
 * Refuse in a way that names the real next step.
 *
 * "Complete verification" is what a Nigerian at Level 1 was told, and it is
 * not actionable: they DID complete verification - the one their country's
 * path asked for. What they have not done is the document check, and that
 * distinction is the entire content of the message.
 *
 * NO PROVIDER NAME HERE, DELIBERATELY.
 *
 * My first version of this said "our partner Bridge" and was silently replaced
 * at the edge with "We could not complete that request" - safeUserMessage()
 * treats every name in PROVIDER_NAMES as a leak, so the careful wording never
 * reached the user at all. Caught by running it, not by reading it.
 *
 * The FRONTEND may name the partner - it does so already in the verification
 * modal, as a deliberate disclosure before a handoff to their domain. An API
 * error string is a different thing: it is logged, forwarded and screenshotted,
 * and our provider relationships are not part of it.
 *
 * Exported so the frontend gate and this one can be tested against the same
 * substance rather than drifting apart, which is how the two got out of step.
 */
export function bridgeRequiredMessage(
  path: 'ngn_bank' | 'bridge_kyc',
  kycStatus?: string
): string {
  // Already submitted and waiting. Telling this user to "verify" would invite
  // them to start again on something that is already in progress.
  if (kycStatus === 'kyc_under_review') {
    return 'Your identity verification is being reviewed. Buying stablecoins unlocks as soon as it is approved.';
  }
  if (kycStatus === 'kyc_rejected' || kycStatus === 'kyc_incomplete') {
    return 'Your identity verification was not completed. Reopen it from the Verification page, or contact support.';
  }
  // The Nigerian case, and the reason this function exists: acknowledge what
  // they HAVE done before naming what is missing.
  if (path === 'ngn_bank') {
    return 'Buying stablecoins needs identity verification - a photo ID and a selfie. '
      + 'Your bank verification covers naira payouts, but not this. Start it from the Verification page.';
  }
  return 'Complete identity verification - a photo ID and a selfie - before buying stablecoins.';
}
