export type NgnProviderName = 'mock' | 'linkio' | 'eversend' | 'nomba' | 'paj' | 'breet';
export type NgnDirection = 'onramp' | 'offramp';
export type NgnOfframpRevenueMode = 'sivan_fee_wallet' | 'breet_markup' | 'disabled';
export type NgnQuoteStatus = 'quote_created' | 'quote_accepted' | 'expired' | 'failed';
export type NgnTransferStatus =
  | 'created'
  | 'quote_created'
  | 'quote_accepted'
  | 'awaiting_deposit'
  | 'awaiting_crypto_deposit'
  | 'deposit_received'
  | 'blockchain_confirmed'
  | 'processing'
  | 'settlement_processing'
  | 'bank_processing'
  | 'crypto_sent'
  | 'completed'
  | 'failed'
  | 'expired'
  /**
   * The USER changed their mind, as opposed to 'expired' where the clock ran
   * out. Kept distinct deliberately: "I cancelled this" and "Sivan closed this
   * because you did not fund it" are different facts, and collapsing them
   * would make the off-ramp funnel unreadable - you could no longer tell
   * abandonment from a UX problem.
   */
  | 'cancelled'
  | 'requires_review';

/**
 * STATUSES THAT CONSUME A USER'S LIMIT HEADROOM.
 *
 * THE BUG THIS FIXES. getCumulativeNgnVolume counted only
 * `status in ('completed','settled')`, so money mid-flight counted as ZERO.
 * Measured, not assumed:
 *
 *     in-flight NGN 90,000 + completed NGN 15,000
 *     counted against the limit -> 15,000
 *
 * At the Level 2 ceiling of NGN 100,000 that is a real bypass. A user starts a
 * 90,000 withdrawal; while it sits in settlement_processing they start another;
 * the second quote sees 15,000 used and 85,000 free and is approved. 180,000 is
 * now in flight against a 100,000 limit, and no single request broke a rule.
 *
 * WHY THE OLD BEHAVIOUR WAS DEFENSIBLE, AND STILL WRONG. Its comment said
 * "counting pending ones would let a user reduce their own consumed volume by
 * abandoning transactions". That risk is real - but the answer is not to
 * ignore live money, it is to count live states and RELEASE terminal-failed
 * ones. Abandonment refunds headroom precisely because the transfer lands in
 * 'expired' or 'cancelled', both excluded below.
 *
 * INCLUDED: everything from the moment an order exists until it is terminal.
 * The cancellable early states (created, quote_accepted, awaiting_deposit...)
 * are included too. They hold no crypto yet, but they hold a live deposit
 * address, and two open addresses are two ways to be over the ceiling.
 *
 * EXCLUDED: 'failed', 'expired', 'cancelled' - nothing moved, or it moved back.
 *
 *
 * 'requires_review' CONSUMES. THIS REVERSES AN EARLIER DECISION HERE.
 *
 * It was excluded, with a fair argument: a flagged transfer is frozen pending a
 * human, and holding a user's headroom hostage to a queue WE control punishes
 * them for our latency. That concern is real and is answered below - but not
 * by releasing the headroom.
 *
 * What the status actually means, from breet.provider.ts mapStatus():
 *
 *     'flagged' -> confirmed on-chain but below the asset minimum. Breet holds
 *                  the funds and does NOT credit. That needs a human.
 *
 * So the user's crypto HAS left their wallet, no naira has been paid, and the
 * transfer may still be resolved in their favour. It is pending, not cancelled.
 * Releasing its headroom means a user with NGN 90,000 held in review can start
 * another NGN 50,000 withdrawal; if the review then approves, NGN 140,000 has
 * been paid against a NGN 100,000 tier ceiling. Nobody broke a rule at any
 * single moment, and the ceiling has still been exceeded.
 *
 * The two positions fail in opposite directions, which is what decides it:
 *
 *     release -> a user can exceed their verification limit  (compliance breach)
 *     consume -> a user waits until we clear our own queue    (inconvenience)
 *
 * A limit that leaks is not a limit. The fairness problem is answered by the
 * `flagged_review_age` operational signal, which escalates to CRITICAL once a
 * flagged transfer has sat for FLAGGED_REVIEW_CRITICAL_HOURS - so "we are slow"
 * becomes an alert on us rather than a silent cost to the customer.
 *
 * Note also that the transfer is flagged because something was UNUSUAL about
 * it. That is the moment to hold a ceiling tighter, not looser.
 */
export const NGN_LIMIT_CONSUMING_STATUSES: ReadonlySet<NgnTransferStatus> = new Set([
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
  /**
   * Held by us, still payable - see the header. Money the user has already
   * parted with and that a human may yet release must not free up headroom.
   */
  'requires_review',
  /**
   * 'settled' WAS HERE AND HAS BEEN REMOVED - it is not a real status.
   *
   * Typing this set to NgnTransferStatus (rather than string) made the
   * compiler reject it immediately. The original query read
   * `status in ('completed','settled')`, so that half of the predicate matched
   * nothing, ever - a value the system cannot produce. An untyped status list
   * in a hand-written query is exactly how a security predicate ends up
   * testing for something impossible while still running cleanly.
   *
   * It also hid a second bug: scripts/test-user-limits.ts seeded fixtures with
   * status 'settled', so a fake status matched a fake predicate and the pair
   * looked correct.
   */
]);

/** Terminal states that release headroom. The complement of the set above. */
export const NGN_LIMIT_RELEASING_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'expired',
  'cancelled',
]);

export interface NgnControlsRecord {
  id: 'global';
  onrampEnabled: boolean;
  offrampEnabled: boolean;
  mockProviderEnabled: boolean;
  bankSettlementEnabled: boolean;
  virtualAccountEnabled: boolean;
  activeProvider: NgnProviderName;
  backupProvider?: NgnProviderName;
  /**
   * Master switch for NIN/BVN identity verification.
   *
   * OFF for MVP. No NIN/BVN provider is integrated yet, so requiring it would
   * block every user at Level 1 and there would be no way to clear them. With
   * it off, Level 2 is reachable on the bank check alone.
   *
   * This is a deliberate, visible, auditable compromise rather than a silent
   * one - an admin can see it is off, and turning it on is one toggle once a
   * provider exists.
   */
  identityVerificationEnabled: boolean;
  /**
   * Whether the user may fund an off-ramp by SENDING CRYPTO THEMSELVES.
   *
   * OFF for launch, at the founders' request. The withdraw screen offered two
   * buttons - "From my Sivan balance" and "I'll send crypto myself" - and the
   * second is the path that produced "its got delivered to the breet sandbox
   * but i kept seeing waiting for your asset till now". It shows a bare
   * deposit address with no balance check in front of it, while the balance
   * path shows a concrete "60.00 USDC available to withdraw" the user can act
   * on. Narrowing launch to the guarded path removes the flow that has
   * actually confused people.
   *
   * WHAT THIS FLAG DOES, STATED PRECISELY, BECAUSE THE NAME OVERPROMISES.
   *
   * It hides the manual-funding INSTRUCTIONS. It does not disable a code path,
   * because there is no separate code path to disable: both buttons POST the
   * same /api/ngn/offramp/orders, the server creates a deposit address either
   * way, and ngn-transfers.service.ts always calls scheduleSweep() from the
   * user's balance. "I'll send crypto myself" is simply what happens when that
   * sweep cannot fund the order - the deposit address stays valid and still
   * settles, exactly as its own comment says:
   *
   *     "The deposit address is valid either way, so the manual route still
   *      works for anyone who would rather send the crypto themselves."
   *
   * So a user who already knows an address can still fund one. Genuinely
   * refusing externally-funded deposits would mean rejecting settled on-chain
   * money, which loses funds and is not something to ship days before launch.
   * This is a UI narrowing, deliberately, and it is reversible from the admin
   * hub without a deploy.
   */
  externalFundingEnabled: boolean;
  /**
   * Exactly one NGN off-ramp revenue path.
   *
   * sivan_fee_wallet collects Sivan's visible margin into SIVAN_FEE_WALLET_SOLANA
   * during the Privy sweep. breet_markup assumes Breet applies markup inside
   * the provider rate/settlement. disabled charges no Sivan margin.
   */
  offrampRevenueMode: NgnOfframpRevenueMode;
  /**
   * May a user send naira to an account that is NOT their own?
   *
   * OFF, and enforced server side in createNgnQuote() - not merely hidden in
   * the UI, because a hidden button is not a control.
   *
   * UNLIKE bankSettlementEnabled ABOVE, THIS ONE IS LOAD-BEARING. That flag is
   * documented in ngn-controls.service.ts as inert: forcing it false left 179
   * assertions green, which is how you can tell nothing reads it. This flag is
   * read in exactly one place and has a test that fails when that read is
   * removed, so it cannot decay into decoration without someone noticing.
   *
   * It is off because the rail genuinely cannot do it safely. Breet binds the
   * destination bank to the user's PERMANENT deposit address, not to a
   * transfer, so paying a third party means re-linking that wallet - and since
   * the address is reusable, a late deposit then settles to whoever was linked
   * last. See migration 052 for the full reasoning.
   */
  thirdPartyPayoutsEnabled: boolean;
  /**
   * PER-FLOW ENFORCEMENT OF VERIFICATION-TIER CEILINGS.
   *
   * Deliberately three switches and NOT one master "limits off".
   *
   * A global kill switch is a single click that removes every ceiling for
   * every user at once, and it is exactly the control that gets flipped during
   * a 2am incident and never flipped back. This is the compliance boundary;
   * it should not have a single point of total failure. Per-flow means an
   * operator loosening on-ramp cannot silently uncap off-ramp, which is the
   * riskier direction (crypto of unknown origin becoming naira).
   *
   * Default TRUE. A deployment that forgets to seed these enforces limits
   * rather than skipping them - the safe direction for a control whose whole
   * job is to refuse.
   *
   * Turning one OFF does not release money already moving: in-flight transfers
   * always complete. See assertNgnLimit for the grandfathering rule.
   */
  limitEnforcementOfframp: boolean;
  limitEnforcementOnramp: boolean;
  limitEnforcementEscrow: boolean;
  maxTransactionNgn: string;
  dailyLimitNgn: string;
  highValueReviewThresholdNgn: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface NgnQuoteRecord {
  id: string;
  userId: string;
  customerId?: string;
  direction: NgnDirection;
  provider: NgnProviderName;
  sourceCurrency: 'ngn' | 'usdc' | 'usdt';
  destinationCurrency: 'ngn' | 'usdc' | 'usdt';
  sourceAmount: string;
  destinationAmount: string;
  rate: string;
  feeAmount: string;
  status: NgnQuoteStatus;
  providerQuoteId?: string;
  expiresAt: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface NgnTransferRecord {
  id: string;
  quoteId: string;
  userId: string;
  customerId?: string;
  direction: NgnDirection;
  provider: NgnProviderName;
  sourceCurrency: 'ngn' | 'usdc' | 'usdt';
  destinationCurrency: 'ngn' | 'usdc' | 'usdt';
  sourceAmount: string;
  destinationAmount: string;
  rate: string;
  feeAmount: string;
  status: NgnTransferStatus;
  providerQuoteId?: string;
  providerTransferId?: string;
  bankReference?: string;
  depositAddress?: string;
  virtualAccount?: unknown;
  settlementReference?: string;
  destinationTxHash?: string;
  metadata?: unknown;
  timeline?: NgnTimelineStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface NgnWebhookRecord {
  id: string;
  provider: NgnProviderName;
  providerEventId: string;
  eventType: string;
  transferId?: string;
  payload: unknown;
  processedAt?: string;
  createdAt: string;
}

export interface NgnProviderHealth {
  provider: NgnProviderName;
  available: boolean;
  mode: 'mock' | 'sandbox' | 'live_disabled' | 'live';
  message?: string;
  checkedAt: string;
}

export interface NgnQuoteInput {
  userId: string;
  customerId?: string;
  direction: NgnDirection;
  sourceCurrency: 'ngn' | 'usdc' | 'usdt';
  destinationCurrency: 'ngn' | 'usdc' | 'usdt';
  sourceAmount: string;
  /**
   * The chain the crypto leg moves on.
   *
   * This field did not exist, so the user's chosen network was dropped before
   * the provider ever saw it: createQuote() priced with
   * BREET_DEFAULT_NETWORK and stamped THAT network's assetId into the quote.
   * A user selecting Base got a quote carrying Solana's asset, and accepting
   * it asked Breet to generate a Base address against a Solana id -
   * "you have entered an invalid _id".
   */
  network?: string;
}

export interface NgnTimelineStep { key: string; label: string; status: 'completed' | 'current' | 'pending' | 'failed'; at?: string; description: string }
