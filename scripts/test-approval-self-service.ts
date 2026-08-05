/**
 * A SINGLE-ADMIN TEAM COULD NOT APPROVE ANYTHING, AND THE RISK QUEUE 503'd.
 *
 * Three reported problems, all from the same console session.
 *
 * 1. POST /api/admin/approvals/apr_3787d617.../approve -> 400, twice.
 *
 *    That request was literally "Disable ETHEREUM for network controls".
 *    Reproduced with the identity the hub sends:
 *      maker: "sup_ola"  checker: "sup_ola"  reason: "maker_equals_checker"
 *
 *    The rule was correct and the product was unusable: with ONE admin
 *    account, every approval is permanently unapprovable. That is not a
 *    control, it is a deadlock - and the thing it was blocking was a
 *    reversible config flag.
 *
 * 2. GET /api/admin/risk/cases -> 503.
 *
 *    Not broken, SLOW. Measured 7.4s / 7.7s / 7.9s direct and 8.1s / 8.4s
 *    through the proxy, all returning 200. listRiskCases() called db.read(),
 *    which issues ~40 sequential `select *` queries - including the entire
 *    audit log - to build a page that needs six tables.
 *
 * 3. Ethereum still enabled for USDC deposits.
 *
 * WHAT IS DELIBERATELY NOT DONE: removing maker-checker. A superadmin may now
 * self-approve, and reversible control changes skip approvals entirely, but
 * refunds, recoveries, manual status changes and admin-user changes still need
 * two people even for a superadmin. Those move money or grant access, and are
 * not undone by toggling something back.
 *
 * Run: npm run test:approval-self-service
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-approval-self.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'approval-self-admin-key';
process.env.USER_JWT_SECRET = 'approval-self-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-approval-self.json', { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { buildApp } = await import('../src/app.js');
const app = await buildApp();

const KEY = 'approval-self-admin-key';
function headers(role?: string, email?: string) {
  return {
    'x-admin-api-key': KEY,
    'content-type': 'application/json',
    ...(role ? { 'x-sivan-admin-role': role } : {}),
    ...(email ? { 'x-sivan-admin-email': email } : {}),
  };
}

async function raise(action: string, role: string, email?: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/approvals',
    headers: headers(role, email),
    payload: {
      action,
      resourceType: 'admin_control',
      reason: 'reproducing the reported approval failure',
      requestedChange: { sourceNetworks: [{ network: 'ethereum', enabled: false }] },
      riskLevel: 'high',
    },
  });
  return (response.json() as any)?.data?.id as string;
}

async function approve(id: string, role: string, email?: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/approvals/${id}/approve`,
    headers: headers(role, email),
    payload: { reviewer: 'ignored-by-the-route', reason: 'approving my own control change', apply: false },
  });
  return { status: response.statusCode, body: response.json() as any };
}

console.log('\n── 1. the reported failure: superadmin blocked by their own rule ──');

/**
 * THE EXACT REPORTED CASE. sup_ola raises it and sup_ola approves it.
 */
const supId = await raise('controls.update', 'superadmin', 'sup_ola@sivantech.online');
const supResult = await approve(supId, 'superadmin', 'sup_ola@sivantech.online');
check('a SUPERADMIN can now approve their own control change',
  supResult.status === 200,
  JSON.stringify(supResult.body).slice(0, 220));

console.log('\n── 2. but the rule still binds everyone else ─────────────────');

const opsId = await raise('controls.update', 'ops', 'ops@sivantech.online');
const opsResult = await approve(opsId, 'ops', 'ops@sivantech.online');
check('a non-superadmin still cannot approve their own request',
  opsResult.status === 400 && opsResult.body?.error?.details?.reason === 'maker_equals_checker',
  `${opsResult.status} ${JSON.stringify(opsResult.body?.error?.details)}`);
check('and the refusal now names the way out',
  /superadmin can approve it directly/i.test(String(opsResult.body?.error?.message)),
  String(opsResult.body?.error?.message));

const otherId = await raise('controls.update', 'ops', 'maker@sivantech.online');
const otherResult = await approve(otherId, 'compliance', 'checker@sivantech.online');
check('two DIFFERENT admins still work as before',
  otherResult.status === 200,
  JSON.stringify(otherResult.body).slice(0, 160));

console.log('\n── 3. the line a superadmin does not cross alone ─────────────');

/**
 * The whole judgement of this change. A config flag is reversible; a refund is
 * not. If this passes, self-approval has been scoped rather than switched on.
 */
for (const action of ['refund_recovery.request', 'manual_status_change.request', 'admin_user_change.request']) {
  const id = await raise(action, 'superadmin', 'sup_ola@sivantech.online');
  const result = await approve(id, 'superadmin', 'sup_ola@sivantech.online');
  check(`a superadmin CANNOT self-approve ${action}`,
    result.status === 400 && result.body?.error?.details?.reason === 'high_risk_requires_second_admin',
    `${result.status} ${JSON.stringify(result.body?.error?.details)}`);
}

const refundTwoPerson = await approve(
  await raise('refund_recovery.request', 'ops', 'maker@sivantech.online'),
  'superadmin',
  'sup_ola@sivantech.online'
);
check('but a second admin can still approve a refund',
  refundTwoPerson.status === 200,
  'the rule is about SELF-approval, not about blocking refunds');

console.log('\n── 4. the role cannot be claimed by the caller ───────────────');

/**
 * The security hole this change could have opened. If a body-supplied role
 * were trusted, any caller could post reviewerRole:'superadmin' and approve
 * their own request - the right would not be a right, it would be a bypass.
 */
const spoofId = await raise('controls.update', 'ops', 'ops@sivantech.online');
const spoof = await app.inject({
  method: 'POST',
  url: `/api/admin/approvals/${spoofId}/approve`,
  headers: headers('ops', 'ops@sivantech.online'),
  payload: { reviewer: 'ops@sivantech.online', reason: 'trying to claim superadmin', apply: false, reviewerRole: 'superadmin' },
});
check('a body-supplied reviewerRole is IGNORED',
  spoof.statusCode === 400,
  `${spoof.statusCode} - the session role must win, or self-approval is a bypass`);

console.log('\n── 5. a self-approval is visible in the audit log ────────────');

const { db } = await import('../src/database/json-database.js');
const logs = await db.listAuditLogsByActions(['admin.approval_approved']);
const selfLog = logs.find((log: any) => log.metadata?.approvalId === supId);
const twoPersonLog = logs.find((log: any) => log.metadata?.approvalId === otherId);

check('the self-approval is flagged selfApproved: true',
  (selfLog?.metadata as any)?.selfApproved === true,
  'a weakened control that is not recorded cannot be reviewed');
check('a two-person approval is NOT flagged',
  (twoPersonLog?.metadata as any)?.selfApproved === false,
  'the two must be distinguishable in the log');
check('the log records the checker ROLE that permitted it',
  (selfLog?.metadata as any)?.checkerRole === 'superadmin');
check('and it records who the maker was',
  Boolean((selfLog?.metadata as any)?.maker));

console.log('\n── 6. a control change needs no approval at all ──────────────');

const { APPROVAL_EXEMPT_ACTIONS } = await import('../src/admin/admin-ops.service.js');
check('controls.update is exempt from approvals', APPROVAL_EXEMPT_ACTIONS.has('controls.update'));
check('system_status.update is exempt', APPROVAL_EXEMPT_ACTIONS.has('system_status.update'));
check('refunds are NOT exempt', !APPROVAL_EXEMPT_ACTIONS.has('refund_recovery.request'),
  'the exempt list must stay small and explicit');
check('admin user changes are NOT exempt', !APPROVAL_EXEMPT_ACTIONS.has('admin_user_change.request'));

/**
 * The direct route, which is what the exemption means in practice: a
 * superadmin can turn a network off in one call, with no queue involved.
 */
const direct = await app.inject({
  method: 'PUT',
  url: '/api/admin/offramp/controls',
  headers: headers('superadmin', 'sup_ola@sivantech.online'),
  payload: { sourceNetworks: [{ network: 'ethereum', enabled: false }] },
});
check('PUT /api/admin/offramp/controls applies immediately',
  direct.statusCode === 200,
  `${direct.statusCode} ${JSON.stringify(direct.json()).slice(0, 140)}`);

console.log('\n── 7. ethereum is off for deposits, base and solana stay on ──');

const controlsAfter = (direct.json() as any)?.data;
const networks: any[] = controlsAfter?.sourceNetworks ?? [];
const eth = networks.find((n) => n.network === 'ethereum');
const base = networks.find((n) => n.network === 'base');
const solana = networks.find((n) => n.network === 'solana');

check('ethereum is disabled', eth && eth.enabled === false, JSON.stringify(eth));
check('base is still enabled', base ? base.enabled === true : true, JSON.stringify(base));
check('solana is still enabled', solana ? solana.enabled === true : true, JSON.stringify(solana));

/**
 * The guard that makes this safe to do from a console: turning off the LAST
 * network would leave nowhere to deposit, and the service refuses.
 */
const killAll = await app.inject({
  method: 'PUT',
  url: '/api/admin/offramp/controls',
  headers: headers('superadmin', 'sup_ola@sivantech.online'),
  payload: {
    sourceNetworks: networks.map((n) => ({ network: n.network, enabled: false })),
  },
});
check('disabling EVERY network is refused',
  killAll.statusCode >= 400,
  `${killAll.statusCode} - a user with no deposit network cannot fund anything`);

console.log('\n── 8. the risk queue no longer reads the whole database ──────');

const opsSrc = fs.readFileSync('src/admin/admin-ops.service.ts', 'utf8');
/**
 * Comments stripped BEFORE matching. The first version of this assertion
 * searched the raw slice and failed on the explanatory comment above the fix,
 * which quotes `db.read()` as the thing that was removed - a test that fails
 * because the fix is documented is worse than no test.
 */
const listRiskBody = opsSrc
  .slice(
    opsSrc.indexOf('export async function listRiskCases'),
    opsSrc.indexOf('export async function reviewRiskCase')
  )
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check('listRiskCases no longer calls db.read()',
  !/db\.read\(\)/.test(listRiskBody),
  '~40 sequential `select *` queries, measured at 7.4-8.4s -> proxy 503');
check('it reads the six tables it actually needs, in parallel',
  /Promise\.all/.test(listRiskBody) && /db\.listCustomers\(\)/.test(listRiskBody));
check('the audit log is read by ACTION, not in full',
  /listAuditLogsByActions\(\['risk\.case_reviewed'\]\)/.test(listRiskBody),
  'the audit table grows without bound - a select * against it gets slower every day');

const started = Date.now();
const riskResponse = await app.inject({ method: 'GET', url: '/api/admin/risk/cases', headers: headers('superadmin') });
const elapsed = Date.now() - started;
check('GET /api/admin/risk/cases still returns 200', riskResponse.statusCode === 200, String(riskResponse.statusCode));
check('and it returns an array of cases', Array.isArray((riskResponse.json() as any)?.data));
console.log(`       (in-process latency ${elapsed}ms - the real gain is against Postgres, not the JSON file)`);

await app.close();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
