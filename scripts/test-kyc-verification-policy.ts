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
import { bridgeUpliftApplies } from '../src/kyc/types/verification.types.js';

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

console.log('\noff-ramp is held tighter than escrow');
{
  const escrow = decide(bankVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 80_000, priorVolumeNgn: 0 });
  const offramp = decide(bankVerified, { flow: 'offramp', rail: 'ngn', amountNgn: 80_000, priorVolumeNgn: 0 });
  check('NGN 80,000 escrow is allowed', escrow.allowed);
  check('the same NGN 80,000 off-ramp is not', !offramp.allowed);
  check('off-ramp ceiling is half of escrow at every level',
    limitFor('offramp', 'ngn', VerificationLevel.BANK) === 50_000 &&
    limitFor('offramp', 'ngn', VerificationLevel.IDENTITY) === 500_000);
}

console.log('\nidentity level: up to NGN 1,000,000 escrow');
{
  const ok = decide(identityVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 900_000, priorVolumeNgn: 0 });
  check('NGN 900,000 passes', ok.allowed);

  const over = decide(identityVerified, { flow: 'escrow', rail: 'ngn', amountNgn: 1_200_000, priorVolumeNgn: 0 });
  check('NGN 1,200,000 is refused', !over.allowed);
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
  check('NGN 5,000,000 escrow -> enhanced',
    lowestSufficientLevel('escrow', 'ngn', 5_000_000) === VerificationLevel.ENHANCED);
}

console.log('\nBRIDGE UPLIFT: unlimited, but never a shortcut past the basics');
{
  // The intended case: Bridge approved AND Sivan's floor complete.
  const full = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    ninStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'approved',
  });
  check('Bridge approved + basics done = uplift applies', bridgeUpliftApplies(full));

  const big = decide(full, { flow: 'offramp', rail: 'ngn', amountNgn: 40_000_000, priorVolumeNgn: 900_000_000 });
  check('NGN 40m off-ramp is allowed despite only being Level 2', big.allowed);
  check('the ceiling is reported as removed', big.limitNgn === null);
  check('and the reason is attributed to Bridge, not to the level', big.bridgeUplift === true);

  // THE GUARD. Bridge approved, but no payout bank verified.
  const noBank = state({
    level: VerificationLevel.NONE,
    ninStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'approved',
  });
  check('Bridge approval WITHOUT a verified payout bank gives no uplift',
    !bridgeUpliftApplies(noBank));
  check('and such a user still cannot move NGN 5,000',
    !decide(noBank, { flow: 'offramp', rail: 'ngn', amountNgn: 5_000, priorVolumeNgn: 0 }).allowed);

  // Bridge approved, bank done, but Sivan holds no identity of its own.
  const noIdentity = state({
    level: VerificationLevel.BANK,
    bankStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_approved',
    bridgeTosStatus: 'approved',
  });
  check('Bridge approval WITHOUT Sivan holding NIN/BVN gives no uplift',
    !bridgeUpliftApplies(noIdentity));
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
  check('Bridge KYC without Bridge terms accepted gives no uplift', !bridgeUpliftApplies(noTos));

  // Rejected by Bridge must not read as approved.
  const rejected = state({
    level: VerificationLevel.IDENTITY,
    bankStatus: CheckStatus.VERIFIED,
    identityStatus: CheckStatus.VERIFIED,
    ninStatus: CheckStatus.VERIFIED,
    bridgeKycStatus: 'kyc_rejected',
  });
  check('a Bridge rejection gives no uplift', !bridgeUpliftApplies(rejected));
  check('and the user falls back to their Level 2 ceiling',
    !decide(rejected, { flow: 'escrow', rail: 'ngn', amountNgn: 2_000_000, priorVolumeNgn: 0 }).allowed);

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
  check("Bridge's 'active' spelling also grants uplift", bridgeUpliftApplies(activeSpelling));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
