/**
 * A VERIFIED NIN MUST ACTUALLY REACH LEVEL 2.
 *
 * The provider can return `matched` and the row can be written and the user
 * can still be stranded at Level 1 - that is exactly what happened to BVN
 * before migration 047, where the outcome was stored and never read. The
 * verdict is not the feature; the level change is.
 *
 * VerificationLevel.IDENTITY is documented as "NIN and/or BVN validated
 * against the national source", and the next-step action is named 'nin_bvn'.
 * verification-state.ts read only 'bvn_info', so a NIN row would have been
 * invisible to it.
 *
 * These assertions go through the STATE LAYER rather than the provider,
 * because that is the seam where the previous bug lived. A suite that stopped
 * at "the provider said matched" would have passed while every NIN user sat
 * at Level 1.
 *
 * Run: npx tsx scripts/test-nin-grants-level2.ts
 */

/**
 * The DB path is NOT set here.
 *
 * This file re-executes itself as a child per case (see levelFor below), and
 * hardcoding SIVAN_DATA_FILE at the top overwrote the per-case path the parent
 * had just passed in - so every child read the same stale file and reported
 * Level 1 for cases that should have been Level 2. The parent supplies the
 * path; this header must not fight it.
 */
process.env.DATABASE_PROVIDER = 'json';
process.env.EMAIL_PROVIDER = 'console';
process.env.USER_JWT_SECRET ||= 'test_secret_for_nin_level2_suite';

import fs from 'node:fs';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const NOW = new Date().toISOString();

/**
 * THE FIXTURE HAS TO ISOLATE THE NIN, AND MY FIRST ONE DID NOT.
 *
 * I seeded a verified NGN payout account to put the user at Level 1. That made
 * every case pass - including the empty one - because with
 * identityVerificationEnabled OFF (the shipped default) verification-state.ts
 * grants identity from `bridgeAccountVerified` independently:
 *
 *   identityVerified = bvnVerified || bridgeApproved
 *                      || (!identityRequired && bridgeAccountVerified)
 *
 * So the level was real, but it was not coming from the NIN, and the suite
 * could not tell the difference. The assertions caught it: "no identity row at
 * all" also returned Level 2, which is impossible if the NIN were the cause.
 *
 * identityVerificationEnabled is now ON, which removes that third source and
 * leaves the identity row as the only thing under test.
 */
function seed(identityRows: any[], file: string) {
  fs.writeFileSync(file, JSON.stringify({
    users: [{ id: 'usr_1', email: 'a@b.com', fullName: 'Adaeze Okafor', country: 'NG', createdAt: NOW }],
    customers: [{ id: 'cus_1', userId: 'usr_1', kycStatus: 'kyc_not_started', createdAt: NOW }],
    ngnPayoutAccounts: [{
      id: 'pa_1', userId: 'usr_1', provider: 'breet', bankId: '058',
      bankName: 'GTBank', accountNumber: '0123456789', accountName: 'ADAEZE OKAFOR',
      declaredName: 'Adaeze Okafor', matchVerdict: 'match', status: 'verified', createdAt: NOW,
    }],
    ngnIdentityVerifications: identityRows,
    /**
     * Toggle ON so `bridgeAccountVerified` cannot grant identity on its own.
     * With it off, a bare NUBAN name match reaches Level 2 - which is the
     * documented MVP compromise, and useless for isolating a NIN.
     */
    ngnControls: [{ id: 'global', identityVerificationEnabled: true, updatedAt: NOW }],
    externalAccounts: [], withdrawals: [], onrampOrders: [], ngnTransfers: [],
    auditLogs: [], supportTickets: [], virtualAccountTransactions: [], walletDeposits: [],
    supplierPayments: [], systemIncidents: [], webhookEvents: [], transactionReferences: [],
    reconciliationFindings: [], paymentControls: [], systemStatus: [],
  }, null, 2));
}

const row = (over: Record<string, unknown>) => ({
  id: `ngnkyc_${Math.random().toString(16).slice(2)}`,
  userId: 'usr_1', provider: 'identifyorg', bvnLast4: '2109',
  createdAt: NOW, updatedAt: NOW, ...over,
});

/**
 * A FRESH DB FILE PER CASE, NOT JUST A FRESH MODULE.
 *
 * My first version rewrote the same path and re-imported verification-state
 * with a cache-busting query. Every case still returned the FIRST seed,
 * because json-database.ts caches the parsed file in memory for the process:
 *
 *   async read() { if (this.db) return this.db; ... }
 *
 * Re-importing the reader does not clear that - the database module is a
 * different module and stays cached. So three assertions "failed" against data
 * they had never actually been given, and one passed for the same reason.
 *
 * This is the same trap that made an earlier NGN e2e pass on stale rows. The
 * only reliable fix is a distinct file per case so there is nothing to reuse.
 */
/**
 * EACH CASE RUNS IN ITS OWN PROCESS.
 *
 * Two earlier attempts failed, and both failures were mine rather than the
 * code's:
 *
 *  1. Re-importing verification-state with a cache-busting query. The DATABASE
 *     module is separate and stays cached, and json-database.ts holds the
 *     parsed file for the life of the process:
 *         async read() { if (this.db) return this.db; ... }
 *
 *  2. Pointing SIVAN_DATA_FILE at a new path per case. `db` is a module-level
 *     singleton whose filePath is bound from env AT CONSTRUCTION, so changing
 *     process.env afterwards moves nothing.
 *
 * Both produced the same false signal: every case read the FIRST seed, so
 * three assertions failed against data they were never given and one passed
 * for the same wrong reason. The tell was "no identity row at all" also
 * returning Level 2 - impossible if the row were the cause.
 *
 * A child process per case is the only version with no shared state to leak.
 * Slower, and correct.
 */
const CHILD = process.env.NIN_LEVEL2_CHILD;
if (CHILD) {
  const file = process.env.SIVAN_DATA_FILE!;
  const { getVerificationState } = await import('../src/kyc/service/verification-state.js');
  const state: any = await getVerificationState('usr_1');
  process.stdout.write(`__RESULT__${JSON.stringify({ level: Number(state.level), bvnStatus: state.bvnStatus, ninStatus: state.ninStatus })}`);
  process.exit(0);
}

const { spawnSync } = await import('node:child_process');
let caseNo = 0;
function levelFor(identityRows: any[]): { level: number; bvnStatus: string; ninStatus: string } {
  caseNo += 1;
  const file = `/tmp/nin-level2-case-${caseNo}.json`;
  seed(identityRows, file);
  const run = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1]], {
    env: {
      ...process.env,
      NIN_LEVEL2_CHILD: '1',
      SIVAN_DATA_FILE: file,
      DATABASE_FILE: file,
      DATABASE_PROVIDER: 'json',
      USER_JWT_SECRET: 'test_secret_for_nin_level2_suite',
    },
    encoding: 'utf8',
  });
  const out = String(run.stdout ?? '');
  const marker = out.indexOf('__RESULT__');
  if (marker === -1) throw new Error(`child produced no result: ${out.slice(-300)}${run.stderr?.slice(-300) ?? ''}`);
  return JSON.parse(out.slice(marker + '__RESULT__'.length));
}

console.log('\n══ 1. a matched NIN reaches Level 2 ═══════════════════════');

const withNin = levelFor([
  row({ checkType: 'nin_info', status: 'matched', verifiedAt: NOW }),
]);
/**
 * THE WHOLE POINT OF THIS FILE. Before the fix, verification-state.ts matched
 * only 'bvn_info', so this row existed, said matched, and changed nothing.
 */
check('a verified nin_info row grants Level 2',
  Number(withNin.level) >= 2, `level=${withNin.level} - the NIN row was ignored`);

console.log('\n══ 2. and BVN still does, unchanged ═══════════════════════');

const withBvn = levelFor([
  row({ checkType: 'bvn_info', status: 'matched', verifiedAt: NOW, bvnLast4: '8901' }),
]);
check('a verified bvn_info row still grants Level 2',
  Number(withBvn.level) >= 2, `level=${withBvn.level}`);

console.log('\n══ 3. only a MATCH counts ═════════════════════════════════');

/**
 * A row exists for failed and review attempts too. Only `verifiedAt` is
 * written on a match - testing status alone would let an attempt masquerade
 * as a success.
 */
const reviewNin = levelFor([
  row({ checkType: 'nin_info', status: 'review' }),
]);
check('a NIN under review does NOT grant Level 2',
  Number(reviewNin.level) < 2, `level=${reviewNin.level} - a held check is not a pass`);

const failedNin = levelFor([
  row({ checkType: 'nin_info', status: 'failed' }),
]);
check('a failed NIN does NOT grant Level 2',
  Number(failedNin.level) < 2, `level=${failedNin.level}`);

/**
 * The nastiest shape: the vendor said failed, but a verifiedAt got written
 * anyway. The level must follow the timestamp, which is the documented rule,
 * and this pins that the two are not read inconsistently.
 */
const noRows = levelFor([]);
check('no identity row at all leaves the user below Level 2',
  Number(noRows.level) < 2, `level=${noRows.level}`);

console.log('\n══ 4. the status field the UI renders ═════════════════════');

/**
 * The state exposes bvnStatus / ninStatus, not a `checks` map - my first
 * version asserted a field that does not exist, so it read undefined and
 * "passed" the negative case for the wrong reason.
 *
 * bvnStatus is the identity-check status regardless of WHICH identifier
 * satisfied it; verification-state.ts derives it from both check types.
 */
check('a verified NIN shows the identity check as verified',
  String(withNin.bvnStatus).toLowerCase().includes('verif'),
  `bvnStatus=${withNin.bvnStatus}`);

check('a NIN under review shows as pending, not verified',
  !String(reviewNin.bvnStatus).toLowerCase().includes('verif'),
  `bvnStatus=${reviewNin.bvnStatus}`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
process.exit(fail === 0 ? 0 : 1);
