/**
 * A VERIFIED PERSON WITH NOWHERE TO BE PAID IS STILL A VERIFIED PERSON.
 *
 * The reported account: Nigerian, Bridge KYC approved, terms accepted, no
 * NUBAN. The screen said "Verification complete" and "Level 0: Starter" at the
 * same time; the wallet would not provision; Receive said "verify your
 * identity first"; every ceiling read zero.
 *
 * One cause. deriveLevel() ANDed every rung with bankVerified, so identity
 * could not count for anything until a payout destination existed. Two
 * independent facts - "do we know who you are" and "where do we send your
 * naira" - were being multiplied.
 *
 * These assertions are written against BEHAVIOUR (the level, the decision, the
 * eligibility) rather than against the presence of a helper or a constant.
 * Every one is mutation-checked at the bottom of this run.
 */
import assert from 'node:assert/strict';
import {
  CheckStatus,
  VerificationLevel,
  upliftApplies,
  type VerificationState,
} from '../src/kyc/types/verification.types.js';
import { decide, levelIsIntact } from '../src/kyc/service/verification-policy.js';
import { canProvisionWallet } from '../src/wallets/wallet-eligibility.js';

const checks: Array<[string, () => void]> = [];
function test(name: string, fn: () => void) { checks.push([name, fn]); }

/** Everything false; each case turns on only what it is about. */
function state(over: Partial<VerificationState> = {}): VerificationState {
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
    ...over,
  } as VerificationState;
}

/** The reported user: Bridge-approved, no payout account anywhere. */
const bridgeNoBank = state({
  level: VerificationLevel.IDENTITY,
  identityStatus: CheckStatus.VERIFIED,
  ninStatus: CheckStatus.VERIFIED,
  bankStatus: CheckStatus.NOT_STARTED,
  identitySource: 'bridge',
  bridgeKycStatus: 'kyc_approved',
  bridgeTosStatus: 'approved',
} as any);

/** The Nigerian NUBAN route: bank matched, no identity check of any kind. */
const nubanOnly = state({
  level: VerificationLevel.BANK,
  bankStatus: CheckStatus.VERIFIED,
});

// ------------------------------------------------------------- the ladder

test('identity alone reaches IDENTITY without a payout account', () => {
  // The whole fix in one line. Previously NONE.
  assert.equal(bridgeNoBank.level, VerificationLevel.IDENTITY);
  assert.ok(bridgeNoBank.level > VerificationLevel.NONE);
});

test('the level is not treated as stale just because no bank exists', () => {
  // If this returns false, decide() answers "one of your verification checks
  // needs attention" on EVERY transaction - a Level 2 user who still cannot
  // move, which is worse than the Level 0 they started at.
  assert.equal(levelIsIntact(bridgeNoBank), true);
});

test('a FAILED bank check still invalidates the level', () => {
  // The distinction the fix rests on: absent is fine, broken is not.
  assert.equal(levelIsIntact({ ...bridgeNoBank, bankStatus: CheckStatus.FAILED }), false);
  assert.equal(levelIsIntact({ ...bridgeNoBank, bankStatus: CheckStatus.EXPIRED }), false);
});

test('the NUBAN route still reaches BANK on its own', () => {
  // The Nigerian path must be untouched by this change.
  assert.equal(nubanOnly.level, VerificationLevel.BANK);
  assert.equal(levelIsIntact(nubanOnly), true);
});

// ------------------------------------------------------------- the wallet

test('a Bridge-approved user with no bank CAN create a wallet', () => {
  // The original report.
  const result = canProvisionWallet(bridgeNoBank);
  assert.equal(result.eligible, true, result.reason);
  assert.equal(result.code, 'eligible');
});

test('a NUBAN-verified Nigerian can still create a wallet', () => {
  assert.equal(canProvisionWallet(nubanOnly).eligible, true);
});

test('an unverified user still cannot create a wallet', () => {
  // The gate must still be a gate.
  const result = canProvisionWallet(state());
  assert.equal(result.eligible, false);
  assert.equal(result.code, 'needs_bank_verification');
});

test('the refusal names both routes, not just the bank', () => {
  // Telling a non-Nigerian to "add a payout bank account" sends them to a
  // screen their path never asks for.
  const reason = canProvisionWallet(state()).reason.toLowerCase();
  assert.ok(reason.includes('identity'), reason);
});

test('a failed bank check blocks the wallet even at IDENTITY', () => {
  const result = canProvisionWallet({ ...bridgeNoBank, bankStatus: CheckStatus.FAILED });
  assert.equal(result.eligible, false);
  assert.equal(result.code, 'blocked_check_failed');
});

test('high risk still blocks outright', () => {
  const result = canProvisionWallet({ ...bridgeNoBank, riskLevel: 'high' } as VerificationState);
  assert.equal(result.eligible, false);
  assert.equal(result.code, 'blocked_risk');
});

// -------------------------------------------------------------- the rails

const req = (rail: 'ngn' | 'foreign', amountNgn: number) =>
  ({ flow: 'offramp' as const, rail, amountNgn, priorVolumeNgn: 0 });

test('foreign rails open at IDENTITY without a payout account', () => {
  // Closed at NONE and at BANK; this is the rail the user was locked out of.
  const decision = decide(bridgeNoBank, req('foreign', 400_000));
  assert.equal(decision.allowed, true, decision.reason);
});

test('foreign rails remain closed to a NUBAN-only user', () => {
  // A ten-digit name match must not open a foreign rail - no documents, no
  // selfie, nothing Bridge would accept.
  assert.equal(decide(nubanOnly, req('foreign', 400_000)).allowed, false);
});

test('the naira ceiling rises to the IDENTITY tier', () => {
  const decision = decide(bridgeNoBank, req('ngn', 4_000_000));
  assert.equal(decision.allowed, true, decision.reason);
  assert.equal(decision.limitNgn, 5_000_000);
});

test('a level-0 user still moves nothing', () => {
  assert.equal(decide(state(), req('ngn', 1_000)).allowed, false);
  assert.equal(decide(state(), req('foreign', 1_000)).allowed, false);
});

// -------------------------------------------------------------- the uplift

test('the uplift still requires a payout account', () => {
  // Deliberate: the uplifted ceiling is the "we know you AND we can pay you"
  // tier. Adding a bank later is what unlocks it.
  assert.equal(upliftApplies(bridgeNoBank), false);
});

test('the uplift applies once a bank is added', () => {
  assert.equal(upliftApplies({ ...bridgeNoBank, bankStatus: CheckStatus.VERIFIED }), true);
});

/**
 * THE REAL DERIVATION, AGAINST A REAL DATABASE.
 *
 * Everything above hand-builds a VerificationState, so all of it would still
 * pass if deriveLevel() never produced IDENTITY from actual stored rows. That
 * gap is the shape of the original bug - the pieces were fine, the thing that
 * assembled them was not. This drives getVerificationState() on a seeded
 * customer with no payout account at all.
 */
async function integration() {
  const { db } = await import('../src/database/json-database.js');
  const { getVerificationState } = await import('../src/kyc/service/verification-state.js');

  const userId = 'u_bridge_no_bank';
  await db.insertUserRecord({
    id: userId, email: 'bridge-no-bank@sivantech.online', fullName: 'Bridge NoBank',
    country: 'NG', status: 'active', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);
  await db.insertCustomerRecord({
    id: 'cus_bnb', userId, provider: 'bridge', providerCustomerId: 'bridge_123',
    kycStatus: 'kyc_approved', tosStatus: 'approved', customerType: 'individual',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any);

  const derived = await getVerificationState(userId);

  const results: Array<[string, () => void]> = [
    ['DERIVED FROM THE DATABASE: Bridge approval alone reaches IDENTITY', () => {
      assert.equal(derived.level, VerificationLevel.IDENTITY, `got level ${derived.level}`);
    }],
    ['DERIVED: no payout account is reported honestly, not faked verified', () => {
      // bankStatus must NOT be lied into VERIFIED to make the level work -
      // that field drives withdrawal gates and would become untrue.
      assert.equal(derived.bankStatus, CheckStatus.NOT_STARTED);
    }],
    ['DERIVED: the wallet gate opens for this real user', () => {
      const result = canProvisionWallet(derived);
      assert.equal(result.eligible, true, result.reason);
    }],
    ['DERIVED: the level and its evidence agree', () => {
      assert.equal(levelIsIntact(derived), true);
    }],
  ];

  for (const [name, fn] of results) {
    try { fn(); passed += 1; console.log(`  ok   ${name}`); }
    catch (error) {
      console.error(`  FAIL ${name}`);
      console.error(`       ${(error as Error).message.split('\n')[0]}`);
      process.exitCode = 1;
    }
  }
  return results.length;
}

let passed = 0;
for (const [name, fn] of checks) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}
const extra = await integration();
const total = checks.length + extra;
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
