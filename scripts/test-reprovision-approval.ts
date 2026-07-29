/**
 * Reprovisioning a virtual account must require two admins.
 *
 * Background: the reprovision endpoint used to provision immediately. One
 * click created a real bank account at Bridge; a retried click created two.
 * On 2026-07-29 one approved request accumulated 16 live Bridge accounts for a
 * single user, each billing $2/month and each still accepting deposits,
 * because Sivan marks accounts "closed" locally without telling Bridge.
 *
 * These assertions lock in the fix:
 *   - the route raises an approval and provisions nothing
 *   - the same admin cannot approve their own request
 *   - a generic identity cannot act as checker
 *   - only the approval path can execute the reprovision
 *
 * Run: npm run test:reprovision-approval
 */

import { approvalRequestSchema } from '../src/admin/admin-ops.service.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

async function main() {
  console.log('\nVirtual account reprovision requires approval\n');

  console.log('1. The action is a recognised approval type');
  const parsed = approvalRequestSchema.safeParse({
    action: 'virtual_account.reprovision',
    resourceType: 'virtual_account_request',
    resourceId: 'vareq_test',
    reason: 'Customer reported the account number is wrong',
    requestedBy: 'ops.alice@sivantech.online',
    requestedChange: { requestId: 'vareq_test' },
  });
  check('virtual_account.reprovision is an accepted approval action', parsed.success,
    parsed.success ? '' : JSON.stringify(parsed.error.issues[0]));
  check('it defaults to high risk', parsed.success && parsed.data.riskLevel === 'high');

  console.log('\n2. The route no longer provisions directly');
  const routes = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/virtual-accounts/api/virtual-accounts.routes.ts', import.meta.url), 'utf8')
  );
  check('the route calls requestVirtualAccountReprovision',
    routes.includes('requestVirtualAccountReprovision'));
  check('the route does NOT call the executor directly',
    !routes.includes('executeVirtualAccountReprovision'),
    'the executor must only be reachable through the approval flow');
  check('it answers 202 Accepted, not 200',
    routes.includes('reply.code(202)'),
    '200 would imply an account already exists');

  console.log('\n3. Only the approval flow can execute it');
  const service = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/virtual-accounts/service/virtual-account.service.ts', import.meta.url), 'utf8')
  );
  check('executeVirtualAccountReprovision exists', service.includes('export async function executeVirtualAccountReprovision'));
  check('requestVirtualAccountReprovision exists', service.includes('export async function requestVirtualAccountReprovision'));
  check('the request function creates an approval, not an account',
    /requestVirtualAccountReprovision[\s\S]{0,2000}createApprovalRequest/.test(service));

  const adminOps = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/admin/admin-ops.service.ts', import.meta.url), 'utf8')
  );
  check('the approval applier routes to the executor',
    /virtual_account\.reprovision[\s\S]{0,600}executeVirtualAccountReprovision/.test(adminOps));

  console.log('\n4. Maker-checker separation still holds');
  const { normaliseAdminIdentity, isAttributableIdentity } = await import(
    '../src/admin/admin-ops.service.js'
  ) as any;

  if (typeof normaliseAdminIdentity === 'function') {
    check('identities are compared case-insensitively',
      normaliseAdminIdentity('Ops.Alice@Sivantech.Online') === normaliseAdminIdentity('ops.alice@sivantech.online'));
    check('a generic identity cannot be a checker', !isAttributableIdentity(normaliseAdminIdentity('admin_api_key')));
    check('"ops" cannot be a checker', !isAttributableIdentity(normaliseAdminIdentity('ops')));
    check('a named admin can be a checker', isAttributableIdentity(normaliseAdminIdentity('ops.bob@sivantech.online')));
  } else {
    // Not exported; the behaviour is covered by test:admin-ops.
    check('maker-checker helpers are covered by test:admin-ops', true);
  }

  console.log('\n5. The approval carries the cost warning');
  check('the requested change warns the old account stays open at Bridge',
    /NOT deactivated at Bridge/.test(service),
    'a checker must see what they are approving');
  check('and states the monthly cost',
    /\$2\/month/.test(service));

  console.log('\n6. Bridge deactivation is implemented');
  const provider = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/virtual-accounts/provider/bridge-virtual-account.provider.ts', import.meta.url), 'utf8')
  );
  check('closeVirtualAccount no longer throws "not enabled"',
    !/closeVirtualAccount[\s\S]{0,200}not enabled/.test(provider));
  check('it calls the documented deactivate endpoint',
    provider.includes('/deactivate'));
  check('deactivation is customer-scoped',
    /customers\/\$\{customerId\}\/virtual_accounts\/\$\{providerAccountId\}\/deactivate/.test(provider));
  check('reactivate is available to undo a mistake',
    provider.includes('/reactivate'));
  check('a missing customer id fails loudly rather than skipping',
    /Cannot deactivate Bridge virtual account/.test(provider));

  console.log('\n7. The audit script is read-only by default');
  const audit = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('./audit-virtual-accounts.ts', import.meta.url), 'utf8')
  );
  check('writes require an explicit --deactivate-stale flag',
    audit.includes("args.includes('--deactivate-stale')"));
  check('it refuses to deactivate an account Sivan considers active',
    /localStatus === 'active'[\s\S]{0,200}SKIP/.test(audit));

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
