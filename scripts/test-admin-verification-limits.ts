/**
 * Admin-controlled verification ceilings.
 *
 * The ceilings were compiled into FLOW_LIMITS, so moving one meant editing
 * source and redeploying. That is the wrong shape for a compliance number, and
 * it produced a real deadlock:
 *
 *   Breet's live minimum deposit is $50, about NGN 80,000.
 *   The BANK off-ramp ceiling was NGN 50,000 per 30 days.
 *   => a Level 1 user could not clear a SINGLE withdrawal.
 *
 * The smallest transaction the provider accepts was larger than the most the
 * policy would let that user move in a month. No frontend work fixes that; the
 * number itself has to be movable.
 *
 * Run: npm run test:admin-verification-limits
 */

import {
  decide,
  limitFor,
  lowestSufficientLevel,
  type VerificationLimitOverride,
} from '../src/kyc/service/verification-policy.js';
import {
  setVerificationLimit,
  clearVerificationLimit,
  listVerificationLimitOverrides,
  getVerificationLimitMatrix,
  defaultLimitFor,
} from '../src/kyc/service/verification-limits.service.js';
import { CheckStatus, VerificationLevel } from '../src/kyc/types/verification.types.js';
import type { VerificationState } from '../src/kyc/types/verification.types.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function threw(fn: () => Promise<unknown>) {
  try { await fn(); return undefined; } catch (e: any) { return String(e?.message ?? e); }
}

/** A Level 1 (BANK) user: payout account resolved, no NIN/BVN. */
function bankLevelUser(): VerificationState {
  return {
    level: VerificationLevel.BANK,
    identityStatus: CheckStatus.NOT_STARTED,
    bankStatus: CheckStatus.VERIFIED,
    bvnStatus: CheckStatus.NOT_STARTED,
    ninStatus: CheckStatus.NOT_STARTED,
    livenessStatus: CheckStatus.NOT_STARTED,
    proofOfAddressStatus: CheckStatus.NOT_STARTED,
    sourceOfFundsStatus: CheckStatus.NOT_STARTED,
    riskLevel: 'low',
    enhancedDueDiligence: false,
  };
}

// One Breet withdrawal at the live $50 minimum, at 1605 NGN/USD.
const ONE_BREET_WITHDRAWAL_NGN = 50 * 1605; // 80,250

async function main() {
  console.log('\nTHE DEADLOCK THIS EXISTS TO BREAK');
  {
    // Ship defaults: BANK off-ramp is NGN 50,000.
    const shipped = limitFor('offramp', 'ngn', VerificationLevel.BANK);
    check('shipped BANK off-ramp ceiling is 50,000', shipped === 50_000, String(shipped));

    const blocked = decide(bankLevelUser(), {
      flow: 'offramp', rail: 'ngn',
      amountNgn: ONE_BREET_WITHDRAWAL_NGN, priorVolumeNgn: 0,
    });
    check('a single minimum Breet withdrawal is BLOCKED by default',
      !blocked.allowed, `${ONE_BREET_WITHDRAWAL_NGN} was allowed`);
    console.log(`       one $50 withdrawal = NGN ${ONE_BREET_WITHDRAWAL_NGN.toLocaleString()} vs ceiling 50,000`);

    // An admin raises it. No deploy.
    const overrides: VerificationLimitOverride[] = [
      { flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK, cumulativeNgn: 200_000 },
    ];
    const allowed = decide(bankLevelUser(), {
      flow: 'offramp', rail: 'ngn',
      amountNgn: ONE_BREET_WITHDRAWAL_NGN, priorVolumeNgn: 0,
    }, overrides);
    check('with an admin override the same withdrawal is ALLOWED', allowed.allowed, allowed.reason);
    check('the decision reports the overridden ceiling', allowed.limitNgn === 200_000, String(allowed.limitNgn));
  }

  console.log('\nTHE OVERRIDE REACHES EVERY DECISION PATH');
  {
    const overrides: VerificationLimitOverride[] = [
      { flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK, cumulativeNgn: 200_000 },
    ];

    check('limitFor honours it', limitFor('offramp', 'ngn', VerificationLevel.BANK, overrides) === 200_000);

    // Without this, a user would be told to complete IDENTITY when BANK had
    // already been raised high enough - asking for documents not needed.
    const level = lowestSufficientLevel('offramp', 'ngn', 150_000, overrides);
    check('lowestSufficientLevel stops at BANK, not IDENTITY',
      level === VerificationLevel.BANK, String(level));
    check('without the override the same amount demands IDENTITY',
      lowestSufficientLevel('offramp', 'ngn', 150_000) === VerificationLevel.IDENTITY);
  }

  console.log('\nUNLIMITED AND CLOSED ARE NOT THE SAME NUMBER');
  {
    // null = unlimited, 0 = closed. Conflating them either opens a flow that
    // should be shut or shuts one that should be open.
    const unlimited: VerificationLimitOverride[] = [
      { flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK, cumulativeNgn: null },
    ];
    check('null override means unlimited',
      limitFor('offramp', 'ngn', VerificationLevel.BANK, unlimited) === null);

    const closed: VerificationLimitOverride[] = [
      { flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK, cumulativeNgn: 0 },
    ];
    check('zero override means closed',
      limitFor('offramp', 'ngn', VerificationLevel.BANK, closed) === 0);

    const shut = decide(bankLevelUser(), {
      flow: 'offramp', rail: 'ngn', amountNgn: 1_000, priorVolumeNgn: 0,
    }, closed);
    check('a zero ceiling actually blocks', !shut.allowed);

    const open = decide(bankLevelUser(), {
      flow: 'offramp', rail: 'ngn', amountNgn: 999_999_999, priorVolumeNgn: 0,
    }, unlimited);
    check('a null ceiling actually permits', open.allowed);
  }

  console.log('\nDEFAULTS STILL APPLY WHERE NOTHING WAS OVERRIDDEN');
  {
    const overrides: VerificationLimitOverride[] = [
      { flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK, cumulativeNgn: 200_000 },
    ];
    check('an untouched combination keeps its default',
      limitFor('escrow', 'ngn', VerificationLevel.BANK, overrides) === 100_000);
    check('an untouched rail keeps its default',
      limitFor('offramp', 'foreign', VerificationLevel.BANK, overrides) === 0);
  }

  console.log('\nTHE LADDER MUST ASCEND');
  {
    // If BANK were raised above IDENTITY, a user who completed MORE
    // verification would get a SMALLER allowance, and lowestSufficientLevel
    // would send them to a level that does not unblock them.
    const err = await threw(() => setVerificationLimit({
      flow: 'offramp', rail: 'ngn',
      level: VerificationLevel.BANK,
      cumulativeNgn: 900_000, // IDENTITY default is 500,000
      updatedBy: 'test',
    }));
    check('raising BANK above IDENTITY is refused', Boolean(err), 'it was accepted');
    check('the refusal explains why', /cannot allow less/i.test(err ?? ''), err);
  }

  console.log('\nPERSISTENCE, AND REVERTING');
  {
    const saved = await setVerificationLimit({
      flow: 'offramp', rail: 'ngn',
      level: VerificationLevel.BANK,
      cumulativeNgn: 200_000,
      reason: 'Breet minimum deposit is $50 (~NGN 80,250)',
      updatedBy: 'test-admin',
    });
    check('the override is stored', saved.cumulativeNgn === 200_000);
    check('the reason is recorded for audit', Boolean(saved.reason), 'no reason stored');

    const loaded = await listVerificationLimitOverrides();
    const found = loaded.find((o) => o.flow === 'offramp' && o.level === VerificationLevel.BANK);
    check('it loads back with the right value', found?.cumulativeNgn === 200_000, String(found?.cumulativeNgn));

    // Writing the same combination twice must REPLACE, never accumulate -
    // two rows would make the effective ceiling depend on ordering.
    await setVerificationLimit({
      flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK,
      cumulativeNgn: 250_000, updatedBy: 'test-admin',
    });
    const after = await listVerificationLimitOverrides();
    const matching = after.filter((o) => o.flow === 'offramp' && o.rail === 'ngn' && o.level === VerificationLevel.BANK);
    check('a second write replaces rather than duplicates', matching.length === 1, `${matching.length} rows`);
    check('the newer value wins', matching[0]?.cumulativeNgn === 250_000, String(matching[0]?.cumulativeNgn));

    const matrix = await getVerificationLimitMatrix();
    const row = matrix.find((r) => r.flow === 'offramp' && r.rail === 'ngn' && r.level === VerificationLevel.BANK);
    check('the matrix shows the default alongside the override',
      row?.defaultCumulativeNgn === 50_000 && row?.effectiveCumulativeNgn === 250_000,
      JSON.stringify(row));
    check('the matrix flags it as overridden', row?.isOverridden === true);

    // NULL MUST SURVIVE A ROUND TRIP THROUGH STORAGE.
    //
    // The in-memory checks above never touch the database mapper, so a mapper
    // that coerced null to 0 passed them all while silently turning an admin's
    // "unlimited" into "flow closed" the moment it was read back. Persisting
    // and reloading is the only way that shows up.
    // Set on the level the test user actually HAS. Overriding ENHANCED while
    // testing a BANK-level user proves nothing: the ceiling that binds is the
    // one for the user's own level.
    await setVerificationLimit({
      flow: 'onramp', rail: 'foreign', level: VerificationLevel.ENHANCED,
      cumulativeNgn: null, reason: 'explicitly unlimited', updatedBy: 'test-admin',
    });
    const reloaded = await listVerificationLimitOverrides();
    const nullRow = reloaded.find((o) => o.flow === 'onramp' && o.rail === 'foreign' && o.level === VerificationLevel.ENHANCED);
    check('a null ceiling survives storage as null, not 0',
      nullRow !== undefined && nullRow.cumulativeNgn === null,
      `stored as ${JSON.stringify(nullRow?.cumulativeNgn)}`);

    const enhancedUser: VerificationState = { ...bankLevelUser(), level: VerificationLevel.ENHANCED, ninStatus: CheckStatus.VERIFIED, proofOfAddressStatus: CheckStatus.VERIFIED, identityStatus: CheckStatus.VERIFIED, livenessStatus: CheckStatus.VERIFIED, sourceOfFundsStatus: CheckStatus.VERIFIED };
    const stillOpen = decide(enhancedUser, {
      flow: 'onramp', rail: 'foreign', amountNgn: 999_999_999, priorVolumeNgn: 0,
    }, reloaded);
    check('and still permits after a round trip', stillOpen.allowed, stillOpen.reason);

    await clearVerificationLimit({ flow: 'onramp', rail: 'foreign', level: VerificationLevel.ENHANCED });

    const cleared = await clearVerificationLimit({
      flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK,
    });
    check('clearing reverts to the shipped default', cleared.revertedTo === 50_000, String(cleared.revertedTo));
    check('and the override is gone',
      (await listVerificationLimitOverrides()).every((o) => !(o.flow === 'offramp' && o.level === VerificationLevel.BANK)));
    check('defaultLimitFor still reports the shipped value',
      defaultLimitFor('offramp', 'ngn', VerificationLevel.BANK) === 50_000);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
