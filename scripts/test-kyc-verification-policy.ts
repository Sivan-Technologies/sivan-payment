/**
 * Sivan verification policy.
 *
 * The cases that matter are not "does a small transfer pass". They are:
 *
 *   - can somebody walk past a threshold in slices (structuring)
 *   - does a stale level survive a check that has since failed
 *   - does a NGN-only transfer ever trigger Bridge's $2
 *   - is the user asked for the LEAST verification that unblocks them
 *
 * Run: npm run test:kyc-policy
 */

import {
  CheckStatus,
  VerificationLevel,
  isApprovedKycStatus,
  type VerificationState,
} from '../src/kyc/types/verification.types.js';
import {
  decide,
  limitFor,
  lowestSufficientLevel,
  levelIsIntact,
  requiresBridgeCustomer,
} from '../src/kyc/service/verification-policy.js';
import { upliftApplies, hasSivanIdentity, UPLIFT_CEILING_NGN } from '../src/kyc/types/verification.types.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function state(overrides: Partial<VerificationState> = {}): VerificationState {
  return {
    level: VerificationLevel.NONE,
    identityStatus: CheckStatus.NOT_STARTED,
    bankStatus: CheckStatus.NOT_STARTED,
    bvnStatus: CheckStatus.NOT_STARTED,
    ninStatus: CheckStatus.NOT_STARTED,
    livenessStatus: CheckStatus.NOT_STARTED,
    proofOfAddressStatus: CheckStatus.NOT_STARTED,
    sourceOfFundsStatus: CheckStatus.NOT_STARTED,
    riskLevel: 'low',
    enhancedDueDiligence: false,
    ...overrides,
  };
}

const bankVerified = state({
  level: VerificationLevel.BANK,
  bankStatus: CheckStatus.VERIFIED,
});

const identityVerified = state({
  level: VerificationLevel.IDENTITY,
  bankStatus: CheckStatus.VERIFIED,
  identityStatus: CheckStatus.VERIFIED,
  ninStatus: CheckStatus.VERIFIED,
});

const enhanced = state({
  level: VerificationLevel.ENHANCED,
  bankStatus: CheckStatus.VERIFIED,
  identityStatus: CheckStatus.VERIFIED,
  ninStatus: CheckStatus.VERIFIED,
  bvnStatus: CheckStatus.VERIFIED,
  proofOfAddressStatus: CheckStatus.VERIFIED,
});

console.log('\nlevel 0 moves nothing');
{
  const d = decide(state(), { flow: 'escrow', rail: 'ngn', amountNgn: 1000, priorVolumeNgn: 0 });
  check('an unverified account cannot transact', !d.allowed);
  check('and is told the cheapest way forward', d.requiredLevel === VerificationLevel.BANK,
    `got ${d.requiredLevel}`);
}

console.log('\nbank level: escrow up to NGN 100,000');
{
  const under = decide(bankVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 99_000, priorVolumeNgn: 0 });
  check('NGN 99,000 passes', under.allowed);

  const exact = decide(bankVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 100_000, priorVolumeNgn: 0 });
  check('exactly NGN 100,000 passes (boundary is inclusive)', exact.allowed);

  const over = decide(bankVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 100_001, priorVolumeNgn: 0 });
  check('NGN 100,001 is refused', !over.allowed);
  check('and asks for NIN/BVN, not an ID document', over.requiredLevel === VerificationLevel.IDENTITY,
    `got ${over.requiredLevel}`);
}

console.log('\nSTRUCTURING: the reason thresholds are cumulative');
{
  // Ten transfers of NGN 99,000. Each is individually under the NGN 100,000
  // line; together they are NGN 990,000. A per-transaction limit would pass
  // every one of these.
  let volume = 0;
  let allowedCount = 0;
  for (let i = 0; i < 10; i += 1) {
    const d = decide(bankVerified, {
      flow: 'escrow',
      rail: 'ngn',
      amountNgn: 99_000,
      priorVolumeNgn: volume,
    });
    if (!d.allowed) break;
    allowedCount += 1;
    volume += 99_000;
  }
  check('slicing stops at the cumulative limit, not the per-transaction one',
    allowedCount === 1 && volume === 99_000,
    `allowed ${allowedCount} transfers totalling ${volume}`);

  const second = decide(bankVerified, {
    flow: 'escrow',
    rail: 'ngn',
    amountNgn: 99_000,
    priorVolumeNgn: 99_000,
  });
  check('the second NGN 99,000 is refused', !second.allowed);
  check('and the user is told what headroom remains', second.remainingNgn === 1_000,
    `remaining ${second.remainingNgn}`);
  check('the message states the remaining amount', /1,000/.test(second.reason), second.reason);
}

console.log('\noff-ramp is never held looser than escrow');
{
  // The Level 1 off-ramp ceiling was raised 50,000 -> 100,000, so it now
  // EQUALS escrow at that level rather than sitting at half. The invariant
  // that actually matters is not the ratio - it is that off-ramp is never
  // MORE permissive than escrow.
  //
  // Why: escrow is two Nigerian bank accounts settling with each other, and
  // both ends already carry a bank's KYC. Off-ramp is crypto of unknown
  // origin becoming naira. Same number, different risk. If off-ramp ever
  // exceeded escrow, the looser limit would be on the riskier flow.
  for (const level of [VerificationLevel.BANK, VerificationLevel.IDENTITY]) {
    const escrowLimit = limitFor('escrow', 'ngn', level);
    const offrampLimit = limitFor('offramp', 'ngn', level);
    check(`off-ramp <= escrow at level ${level}`,
      offrampLimit !== null && escrowLimit !== null && offrampLimit <= escrowLimit,
      `offramp ${offrampLimit} vs escrow ${escrowLimit}`);
  }

  // The raised Level 1 ceiling: one sandbox-minimum withdrawal fits, a second
  // does not, because the threshold is cumulative.
  const first = decide(bankVerified, { flow: 'offramp', rail: 'ngn', amountNgn: 80_000, priorVolumeNgn: 0 });
  check('one NGN 80,000 off-ramp fits under the raised ceiling', first.allowed);
  const second = decide(bankVerified, { flow: 'offramp', rail: 'ngn', amountNgn: 80_000, priorVolumeNgn: 80_000 });
  check('a second one in the same window does not', !second.allowed);
  check('and IDENTITY is what lifts it', second.requiredLevel === VerificationLevel.IDENTITY);
}

console.log('\nidentity level: up to NGN 5,000,000 escrow');
{
  const ok = decide(identityVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 900_000, priorVolumeNgn: 0 });
  check('NGN 900,000 passes', ok.allowed);

  /**
   * RAISED WITH THE LEVEL 2 CEILING. Escrow at IDENTITY went 1,000,000 ->
   * 5,000,000 when BVN verification became a real, persisted check rather than
   * a promise, so 1,200,000 now PASSES and the refusal has to be tested above
   * the new line. Left as 1,200,000 this asserted the old policy and failed
   * against correct code.
   */
  const stillOk = decide(identityVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 1_200_000, priorVolumeNgn: 0 });
  check('NGN 1,200,000 now passes at the raised ceiling', stillOk.allowed);

  const over = decide(identityVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 6_000_000, priorVolumeNgn: 0 });
  check('NGN 6,000,000 is refused', !over.allowed);
  check('and now asks for ID plus address', over.requiredLevel === VerificationLevel.ENHANCED,
    `got ${over.requiredLevel}`);
}

console.log('\nenhanced level is uncapped');
{
  const d = decide(enhanced, { flow: 'escrow', rail: 'ngn', amountNgn: 50_000_000, priorVolumeNgn: 900_000_000 });
  check('a large transfer passes at enhanced', d.allowed);
  check('and reports no ceiling', d.limitNgn === null);
}

console.log('\na stale level does not survive a failed check');
{
  // Level says IDENTITY, but the BVN check has since been revoked and there is
  // no NIN. The cached level must not be honoured.
  const revoked = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    bvnStatus: CheckStatus.FAILED,
    ninStatus: CheckStatus.NOT_STARTED,
  });
  check('levelIsIntact rejects it', !levelIsIntact(revoked));
  const d = decide(revoked, { flow: 'escrow', rail: 'ngn', amountNgn: 5_000, priorVolumeNgn: 0 });
  check('and even a tiny transfer is blocked', !d.allowed && d.code === 'blocked_check_failed',
    d.code);

  const expired = state({
    level: VerificationLevel.BANK,
    bankStatus: CheckStatus.EXPIRED,
  });
  check('an expired check is not a pass', !levelIsIntact(expired));
}

console.log('\nNIN or BVN is enough - not both');
{
  const ninOnly = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    ninStatus: CheckStatus.VERIFIED,
  });
  const bvnOnly = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    bvnStatus: CheckStatus.VERIFIED,
  });
  check('NIN alone is intact', levelIsIntact(ninOnly));
  check('BVN alone is intact', levelIsIntact(bvnOnly));
}

console.log('\nhigh risk overrides the level');
{
  const risky = state({
    level: VerificationLevel.ENHANCED,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    ninStatus: CheckStatus.VERIFIED,
    proofOfAddressStatus: CheckStatus.VERIFIED,
    riskLevel: 'high',
  });
  const d = decide(risky, { flow: 'escrow', rail: 'ngn', amountNgn: 10_000, priorVolumeNgn: 0 });
  check('a fully verified but high-risk account is stopped', !d.allowed && d.code === 'blocked_risk');

  const cleared = { ...risky, enhancedDueDiligence: true };
  check('unless EDD has been completed',
    decide(cleared, { flow: 'escrow', rail: 'ngn', amountNgn: 10_000, priorVolumeNgn: 0 }).allowed);
}

console.log('\nTHE $2: naira never reaches Bridge');
{
  check('NGN rails do not need a Bridge customer', !requiresBridgeCustomer('ngn'));
  check('foreign rails do', requiresBridgeCustomer('foreign'));

  const d = decide(bankVerified, { flow: 'offramp', rail: 'foreign', amountNgn: 10_000, priorVolumeNgn: 0 });
  check('foreign rails are closed below identity level', !d.allowed);
  check('and require identity, which collects exactly what Bridge asks for',
    d.requiredLevel === VerificationLevel.IDENTITY, `got ${d.requiredLevel}`);
}

console.log('\nbad input fails closed');
{
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = decide(bankVerified, { flow: 'escrow', rail: 'ngn', amountNgn: amount, priorVolumeNgn: 0 });
    check(`amount ${String(amount)} is refused`, !d.allowed);
  }
  // Unknown history is not zero history.
  const unknown = decide(bankVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 1_000, priorVolumeNgn: Number.NaN });
  check('unknown prior volume fails closed rather than assuming zero', !unknown.allowed);
}

console.log('\nthe two spellings of "verified" both count');
{
  check("'kyc_approved' is approved", isApprovedKycStatus('kyc_approved'));
  check("'active' is approved", isApprovedKycStatus('active'));
  check("'approved' is approved", isApprovedKycStatus('approved'));
  check("'kyc_rejected' is not", !isApprovedKycStatus('kyc_rejected'));
  check('undefined is not', !isApprovedKycStatus(undefined));
}

console.log('\nthe ladder asks for the least that unblocks');
{
  check('NGN 60,000 escrow -> identity',
    lowestSufficientLevel('escrow', 'ngn', 60_000) === VerificationLevel.BANK);
  check('NGN 600,000 escrow -> identity',
    lowestSufficientLevel('escrow', 'ngn', 600_000) === VerificationLevel.IDENTITY);
  // 5,000,000 is now exactly the IDENTITY ceiling, so it is satisfied AT
  // identity. Only above it does enhanced become the lowest sufficient level.
  check('NGN 5,000,000 escrow -> identity (the new ceiling)',
    lowestSufficientLevel('escrow', 'ngn', 5_000_000) === VerificationLevel.IDENTITY);
  check('NGN 6,000,000 escrow -> enhanced',
    lowestSufficientLevel('escrow', 'ngn', 6_000_000) === VerificationLevel.ENHANCED);
}

console.log('\nBRIDGE UPLIFT: unlimited, but never a shortcut past the basics');
{
  // The intended case: Bridge approved AND Sivan's floor complete.
  const full = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    ninStatus: CheckStatus.VERIFIED,
    identitySource: 'bridge',
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'approved',
  });
  check('Bridge approved + basics done = uplift applies', upliftApplies(full));

  // THE UPLIFT IS A HIGH CEILING, NOT AN ABSENT ONE.
  //
  // It used to return limitNgn: null - unlimited, forever, on every rail. An
  // identity check states WHO someone is at one point in time; it cannot say
  // whether this NGN 40m today is normal for them. Unlimited means no amount
  // ever triggers a second look.
  const big = decide(full, { flow: 'offramp', rail: 'ngn', amountNgn: 40_000_000, priorVolumeNgn: 900_000_000 });
  check('NGN 40m off-ramp is NOT waved through on a Level 2 identity check', !big.allowed);
  check('the uplifted ceiling is reported, not a null one', big.limitNgn === UPLIFT_CEILING_NGN, String(big.limitNgn));
  check('and the user is asked for source of funds', big.requiredLevel === VerificationLevel.ENHANCED);
  check('the uplift is still attributed', big.bridgeUplift === true);

  // Under the ceiling it behaves exactly as before: allowed, well past the
  // Level 2 table figure of 500,000.
  const withinUplift = decide(full, { flow: 'offramp', rail: 'ngn', amountNgn: 5_000_000, priorVolumeNgn: 0 });
  check('NGN 5m is allowed, far above the Level 2 table ceiling', withinUplift.allowed);
  check('and it reports the uplifted ceiling', withinUplift.limitNgn === UPLIFT_CEILING_NGN);
  // remainingNgn is headroom BEFORE this transaction, matching the non-uplift
  // path - prior volume was 0, so the full ceiling is still reported.
  check('remaining headroom is measured before this transaction, as elsewhere',
    withinUplift.remainingNgn === UPLIFT_CEILING_NGN, String(withinUplift.remainingNgn));

  // Cumulative, like every other threshold. Structuring under the uplift must
  // not work either.
  const structured = decide(full, { flow: 'offramp', rail: 'ngn', amountNgn: 1_000_000, priorVolumeNgn: 9_500_000 });
  check('the uplifted ceiling is cumulative, not per-transaction', !structured.allowed);
  check('and only the genuine headroom remains',
    structured.remainingNgn === 500_000, String(structured.remainingNgn));

  console.log('\nA NIGERIAN WHO NEVER TOUCHES BRIDGE GETS THE SAME CEILING');
  {
    // The point: the uplift is a consequence of being verified, not of having
    // paid for a foreign rail. This user validated NIN/BVN with Sivan, has no
    // Bridge customer at all, and wants no USD account.
    const ngnOnly = state({
      level: VerificationLevel.IDENTITY,
      bankStatus: CheckStatus.VERIFIED,
      identityStatus: CheckStatus.VERIFIED,
      bvnStatus: CheckStatus.VERIFIED,
      identitySource: 'sivan',
    });
    check('no Bridge customer at all', ngnOnly.bridgeKycStatus === undefined);
    check('Sivan-held identity qualifies for the uplift', upliftApplies(ngnOnly));

    const d = decide(ngnOnly, { flow: 'offramp', rail: 'ngn', amountNgn: 5_000_000, priorVolumeNgn: 0 });
    check('and they may move NGN 5m', d.allowed);
    check('on exactly the same ceiling as a Bridge user',
      d.limitNgn === UPLIFT_CEILING_NGN, String(d.limitNgn));

    const over = decide(ngnOnly, { flow: 'offramp', rail: 'ngn', amountNgn: 12_000_000, priorVolumeNgn: 0 });
    check('and they hit the same source-of-funds ask above it',
      over.requiredLevel === VerificationLevel.ENHANCED);

    // NIN alone is equally acceptable - Bridge accepts either for Nigeria and
    // requiring both would block users who hold only one.
    const ninOnly = state({
      level: VerificationLevel.IDENTITY,
      bankStatus: CheckStatus.VERIFIED,
      identityStatus: CheckStatus.VERIFIED,
      ninStatus: CheckStatus.VERIFIED,
      identitySource: 'sivan',
    });
    check('NIN alone also qualifies', upliftApplies(ninOnly));

    // The floor still binds. Identity without a payout account is not enough:
    // knowing who someone is says nothing about where their naira should land.
    const noBankSivan = state({
      level: VerificationLevel.NONE,
      identityStatus: CheckStatus.VERIFIED,
      bvnStatus: CheckStatus.VERIFIED,
      identitySource: 'sivan',
    });
    check('Sivan identity WITHOUT a payout bank gives no uplift', !upliftApplies(noBankSivan));
  }

  console.log('\nTHE FLOOR IS NOT SATISFIED BY BRIDGE VOUCHING FOR BRIDGE');
  {
    // The circularity this fixes: ninStatus was SET from bridgeApproved, so
    // the "Sivan must hold its own identity" floor was reading a flag that
    // existed only because Bridge approved the user.
    const inherited = state({
      level: VerificationLevel.IDENTITY,
      bankStatus: CheckStatus.VERIFIED,
      identityStatus: CheckStatus.VERIFIED,
      ninStatus: CheckStatus.VERIFIED,
      identitySource: 'bridge',
      bridgeKycStatus: 'kyc_approved',
      bridgeTosStatus: 'approved',
    });
    check('inherited identity is not counted as Sivan-held', !hasSivanIdentity(inherited));
    check('but it still grants the uplift by the Bridge route', upliftApplies(inherited));

    // Unattributed identity grants nothing. A VERIFIED ninStatus with no
    // recorded source is exactly the ambiguity that hid the circularity.
    const unattributed = state({
      level: VerificationLevel.IDENTITY,
      bankStatus: CheckStatus.VERIFIED,
      identityStatus: CheckStatus.VERIFIED,
      ninStatus: CheckStatus.VERIFIED,
      bridgeKycStatus: 'kyc_approved',
      bridgeTosStatus: 'approved',
    });
    check('a NIN with no recorded source grants no uplift', !upliftApplies(unattributed));

    // Bridge offboarding must remove what Bridge gave, and nothing else.
    const offboarded = { ...inherited, bridgeKycStatus: 'offboarded' };
    check('Bridge offboarding withdraws the inherited uplift', !upliftApplies(offboarded));

    // The same user, had Sivan held the identity itself, keeps it.
    const ownIdentity = { ...inherited, identitySource: 'sivan' as const, bridgeKycStatus: 'offboarded' };
    check('Sivan-held identity survives Bridge offboarding', upliftApplies(ownIdentity));
  }

  console.log('\nENHANCED IS STILL UNCAPPED - IT HAS ALREADY ANSWERED THE ASK');
  {
    // The uplift caps in order to ask for source of funds. A user who has
    // supplied it has nothing left to be asked, so the table's own null wins.
    const l3 = state({
      level: VerificationLevel.ENHANCED,
      bankStatus: CheckStatus.VERIFIED,
      identityStatus: CheckStatus.VERIFIED,
      ninStatus: CheckStatus.VERIFIED,
      identitySource: 'sivan',
      proofOfAddressStatus: CheckStatus.VERIFIED,
      sourceOfFundsStatus: CheckStatus.VERIFIED,
    });
    const d = decide(l3, { flow: 'offramp', rail: 'ngn', amountNgn: 40_000_000, priorVolumeNgn: 0 });
    check('a Level 3 user is genuinely uncapped', d.allowed && d.limitNgn === null);
  }

  // THE GUARD. Bridge approved, but no payout bank verified.
  const noBank = state({
    level: VerificationLevel.NONE,
    ninStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'approved',
  });
  check('Bridge approval WITHOUT a verified payout bank gives no uplift',
    !upliftApplies(noBank));
  check('and such a user still cannot move NGN 5,000',
    !decide(noBank, { flow: 'offramp', rail: 'ngn', amountNgn: 5_000, priorVolumeNgn: 0 }).allowed);

  // Bridge approved, bank done, but Sivan holds no identity of its own.
  const noIdentity = state({
    level: VerificationLevel.BANK,
    bankStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'approved',
  });
  check('Bridge approval WITHOUT any NIN/BVN gives no uplift',
    !upliftApplies(noIdentity));
  const capped = decide(noIdentity, { flow: 'escrow', rail: 'ngn', amountNgn: 500_000, priorVolumeNgn: 0 });
  check('that user is still held to the Level 1 ceiling', !capped.allowed);
  check('and is asked for NIN/BVN', capped.requiredLevel === VerificationLevel.IDENTITY);

  // Bridge TOS outstanding.
  const noTos = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    bvnStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'pending',
  });
  check('Bridge KYC without Bridge terms accepted gives no uplift', !upliftApplies(noTos));

  // Rejected by Bridge must not read as approved.
  const rejected = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    ninStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_rejected',
  });
  check('a Bridge rejection gives no uplift', !upliftApplies(rejected));
  // 2,000,000 sits UNDER the raised Level 2 ceiling, so it no longer proves a
  // fallback. Tested above 5,000,000, where the uplift would have mattered.
  check('and the user falls back to their Level 2 ceiling',
    !decide(rejected, { flow: 'escrow', rail: 'ngn', amountNgn: 6_000_000, priorVolumeNgn: 0 }).allowed);

  // A failed underlying check still wins, even with Bridge approval.
  const revokedBank = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.EXPIRED,
    identityStatus: CheckStatus.VERIFIED,
    ninStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'approved',
  });
  check('an expired bank check blocks even a Bridge-approved user',
    !decide(revokedBank, { flow: 'escrow', rail: 'ngn', amountNgn: 1_000, priorVolumeNgn: 0 }).allowed);

  // High risk is a decision about the person and outranks Bridge.
  const risky = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    ninStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'approved',
    riskLevel: 'high',
  });
  check('high risk still blocks a Bridge-approved user',
    !decide(risky, { flow: 'escrow', rail: 'ngn', amountNgn: 1_000, priorVolumeNgn: 0 }).allowed);

  // 'active' is Bridge's own spelling of approved.
  const activeSpelling = { ...full, bridgeKycStatus: 'active', bridgeTosStatus: 'approved' };
  check("Bridge's 'active' spelling also grants uplift", upliftApplies(activeSpelling));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
