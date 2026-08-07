/**
 * VIRTUAL ACCOUNTS: A COMPULSORY FEE, SOLANA SETTLEMENT, AND A CUSTODY HAND-OFF.
 *
 * Four defects, all found by tracing a virtual-account deposit end to end.
 *
 * 1. THE FEE WAS ZERO AND UNRECLAIMABLE.
 *    virtualAccountFeePercent falls back to SIVAN_OFFRAMP_FEE_PERCENT, which
 *    defaulted to 0, so getVirtualAccountFeeSelection() returned "no fee
 *    configured" and provisioned accounts earning nothing. Bridge FIXES
 *    developer_fee_percent at creation and will not apply a later change to
 *    deposits already received - so this is not a setting to correct later, it
 *    is permanent revenue loss per account.
 *
 * 2. BRIDGE WAS HANDED A PRIVY WALLET ID.
 *    destinationPayload sends `bridge_wallet_id`, but the wallet came from
 *    ensureUserWallet(), which returns whatever the ACTIVE provider issued -
 *    Privy on this deployment. Bridge does not recognise those ids, so every
 *    provisioning attempt failed and the platform had zero virtual accounts.
 *
 * 3. THE SEND PATH PICKED THE WRONG PROVIDER.
 *    balance.service.ts resolved the ACTIVE wallet provider rather than the
 *    provider that issued THIS wallet. Invisible while one provider was in
 *    use; a live money bug the moment a user holds both.
 *
 * 4. CREDITED BALANCE COULD NOT BE SPENT.
 *    A virtual-account settlement is ledger credit with no chain behind it.
 *    The NGN quote priced it, the order was created, and the sweep skipped
 *    with no_wallet_for_network - leaving the user told to send crypto Sivan
 *    had promised to move for them.
 *
 * Run: npm run test:va-fee-and-bridge-sweep
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-va-fee-sweep.json';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'va-fee-admin-key';
process.env.USER_JWT_SECRET = 'va-fee-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-va-fee-sweep.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { env } = await import('../src/config/env.js');
const { db } = await import('../src/database/json-database.js');

console.log('\n── 1. the fee is 1.25% and compulsory ────────────────────────');

/**
 * ASSERTED AGAINST THE SCHEMA SOURCE, NOT THE LOADED VALUE.
 *
 * `env.SIVAN_OFFRAMP_FEE_PERCENT === 1.25` passes whether the 1.25 comes from
 * the schema default or from the repo's own .env - which sets it. Mutation
 * testing proved that: reverting the default to 0 left the suite green,
 * because .env supplied 1.25 anyway. A deployment WITHOUT that variable is
 * exactly the case this is meant to protect, so the default itself is what
 * has to be checked.
 */
const envSrc = fs.readFileSync('src/config/env.ts', 'utf8');
check('SIVAN_OFFRAMP_FEE_PERCENT DEFAULTS to 1.25, not 0',
  /SIVAN_OFFRAMP_FEE_PERCENT:[^\n]*\.default\(1\.25\)/.test(envSrc),
  'a deployment that never sets this must still charge a fee');
check('BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT DEFAULTS to 1.25',
  /BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT:[^\n]*\.default\('1\.25'\)/.test(envSrc),
  'Bridge fixes this at creation - a 0 default is permanent revenue loss');
check('and the loaded value agrees',
  env.SIVAN_OFFRAMP_FEE_PERCENT === 1.25, String(env.SIVAN_OFFRAMP_FEE_PERCENT));

const fees = await import('../src/offramp/service/fees.service.js');
check('the enforced floor is 1.25%',
  fees.MINIMUM_VIRTUAL_ACCOUNT_FEE_PERCENT === 1.25,
  String(fees.MINIMUM_VIRTUAL_ACCOUNT_FEE_PERCENT));

const selection = await fees.getVirtualAccountFeeSelection();
check('a fee is actually selected for Bridge',
  Number(selection.developerFeePercent) > 0,
  JSON.stringify(selection));

const okFee = await fees.assertVirtualAccountFeeConfigured().then(() => true).catch(() => false);
check('provisioning is allowed at the default fee', okFee);

/**
 * THE ASSERTION THAT PROTECTS UNRECLAIMABLE REVENUE. A zero fee must REFUSE,
 * not quietly substitute a default - an operator who set 0 needs to see it,
 * and Bridge will not let the fee be corrected on deposits already taken.
 */
const { updateAdminFeeSettings } = await import('../src/admin/admin-fees.service.js');
await updateAdminFeeSettings({ virtualAccountFeePercent: 0 } as any, {} as any).catch(() => undefined);
let zeroError = '';
try { await fees.assertVirtualAccountFeeConfigured(); } catch (e) { zeroError = (e as Error).message; }
check('a 0% fee REFUSES provisioning', Boolean(zeroError), 'it was allowed');
check('and the refusal explains it cannot be reclaimed',
  /reclaim/i.test(zeroError), zeroError.slice(0, 120));
await updateAdminFeeSettings({ virtualAccountFeePercent: 1.25 } as any, {} as any).catch(() => undefined);

console.log('\n── 2. settlement defaults to Solana ──────────────────────────');

check('the env rail default is solana',
  env.BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL === 'solana',
  env.BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL);

const settings = await (await import('../src/virtual-accounts/service/virtual-account-provider-settings.service.js'))
  .getVirtualAccountProviderSettings();
check('settlement network resolves to solana',
  settings.defaultSettlementNetwork === 'solana', settings.defaultSettlementNetwork);

/**
 * The fallback and its warning must name the SAME chain. This returned 'base'
 * while the message said solana, so a typo in the env var produced Base
 * settlement while telling the operator it had fallen back to Solana.
 */
const settingsSrc = fs.readFileSync('src/virtual-accounts/service/virtual-account-provider-settings.service.ts', 'utf8');
check('the unsupported-network fallback returns what its warning claims',
  /falling back to .solana.[\s\S]{0,600}return 'solana';/.test(settingsSrc),
  'a warning that misreports its own behaviour is worse than none');

const renderYaml = fs.readFileSync('render.yaml', 'utf8');
check('render.yaml pins the rail to solana on BOTH services',
  (renderYaml.match(/BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL\s*\n\s*value: solana/g) ?? []).length === 2,
  String((renderYaml.match(/BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL/g) ?? []).length));
check('and pins the VA fee on both',
  (renderYaml.match(/BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT\s*\n\s*value: "1\.25"/g) ?? []).length === 2);
check('and the sweep minimum on both',
  (renderYaml.match(/BRIDGE_TO_PRIVY_MIN_SWEEP_USD\s*\n\s*value: "6"/g) ?? []).length === 2);

console.log('\n── 3. a non-Bridge wallet is refused, loudly ─────────────────');

const vaProviderSrc = fs.readFileSync('src/virtual-accounts/provider/bridge-virtual-account.provider.ts', 'utf8');
check('destinationPayload rejects a wallet issued by another provider',
  /issuer !== 'bridge'/.test(vaProviderSrc),
  'bridge_wallet_id only accepts Bridge ids; a Privy id fails at their API');
check('and provisioning asserts the fee first',
  /assertVirtualAccountFeeConfigured\(\)/.test(vaProviderSrc));

console.log('\n── 4. the send path uses the WALLET\'S provider ───────────────');

const balanceSrc = fs.readFileSync('src/balances/balance.service.ts', 'utf8');
check('createTransfer resolves the provider that issued the wallet',
  /getWalletProvider\(wallet\.provider \?\? \(await resolveActiveWalletProvider\(\)\)\)/.test(balanceSrc),
  'the active provider is for NEW wallets; existing ones keep their custodian');

console.log('\n── 5. Bridge wallets can now send ────────────────────────────');

const bridgeWalletSrc = fs.readFileSync('src/wallets/provider/bridge-wallet.provider.ts', 'utf8');
check('createTransfer no longer throws "not enabled"',
  !/Bridge wallet transfers are not enabled\./.test(bridgeWalletSrc),
  'this was an internal decision, not a Bridge restriction');
check('it uses the orchestration API with payment_rail bridge_wallet',
  /payment_rail: 'bridge_wallet'/.test(bridgeWalletSrc)
  && /this\.client\.request\('\/transfers'/.test(bridgeWalletSrc),
  'Bridge requires orchestration; direct sends from the address are forbidden');
check('it reports submitted, not confirmed',
  /status: 'submitted'/.test(bridgeWalletSrc),
  'Bridge accepting an instruction is not the chain including it');
check('and charges no second developer fee',
  /developer_fee: '0\.0'/.test(bridgeWalletSrc),
  "Sivan's fee is already deducted upstream - charging here takes it twice");

console.log('\n── 6. the Bridge -> Privy sweep ──────────────────────────────');

const sweep = await import('../src/virtual-accounts/service/bridge-to-privy-sweep.service.js');
check('the minimum is $6', sweep.MIN_BRIDGE_SWEEP_USD === 6, String(sweep.MIN_BRIDGE_SWEEP_USD));

const now = () => new Date().toISOString();
const tx = (amount: string, id = 'vatx_1'): any => ({
  id, provider: 'bridge', userId: 'usr_s', customerId: 'cus_s',
  virtualAccountId: 'va_1', providerAccountId: 'bva_1', depositId: 'dep_1',
  sourceCurrency: 'usd', destinationCurrency: 'usdc',
  sourceAmount: amount, destinationAmount: amount,
  status: 'completed', createdAt: now(), updatedAt: now(),
});

await db.mutate((d: any) => {
  d.users = [{ id: 'usr_s', email: 's@t.test', country: 'NG', fullName: 'S T', createdAt: now(), updatedAt: now() }];
  d.userWallets = [];
  return 1;
});

const below = await sweep.sweepVirtualAccountDepositToPrivy(tx('3.00'));
check('a $3 settlement is held, not swept', below.swept === false && below.reason === 'below_minimum',
  JSON.stringify(below));

const noWallet = await sweep.sweepVirtualAccountDepositToPrivy(tx('50.00', 'vatx_2'));
check('a $50 settlement with no Bridge wallet is skipped, not crashed',
  noWallet.swept === false && noWallet.reason === 'no_bridge_wallet',
  JSON.stringify(noWallet));

const pending = await sweep.sweepVirtualAccountDepositToPrivy({ ...tx('50.00', 'vatx_3'), status: 'funds_received' });
check('an unsettled deposit is not swept', pending.reason === 'not_settled', JSON.stringify(pending));

/**
 * Skips are AUDITED. A settlement sitting below the floor is money the user
 * can see and Sivan has not moved; if that is not findable it is not managed.
 */
const skips = await db.listAuditLogsByActions(['virtual_account.sweep_to_privy_skipped']);
check('every skip is audited with its reason', skips.length >= 3, String(skips.length));

const eventsSrc = fs.readFileSync('src/virtual-accounts/service/virtual-account-events.service.ts', 'utf8');
check('the sweep fires only on a COMPLETED settlement',
  /status === 'completed'\)\s*\{\s*\n\s*scheduleBridgeToPrivySweep/.test(eventsSrc),
  'a pending settlement has no funds in the Bridge wallet yet');
check('and the pending credit lands BEFORE it, so money is never invisible',
  eventsSrc.indexOf("kind: 'credit_pending'") < eventsSrc.indexOf('scheduleBridgeToPrivySweep(transaction)'),
  'between arrival and sweep the balance must already show it');

console.log('\n── 7. credited-but-unspendable is refused at the quote ───────');

const quotesSrc = fs.readFileSync('src/ngn/service/ngn-quotes.service.ts', 'utf8');
/**
 * SCOPED TO VIRTUAL-ACCOUNT CREDIT SPECIFICALLY.
 *
 * An earlier version asserted on `credited > 0` generally, and the code
 * matched it - which caught admin balance adjustments too and broke
 * test:failure-paths (55/55 -> 42/13, "a verified user can quote -> 403").
 * An admin credit is a deliberate operator action that can be settled
 * deliberately; a virtual-account settlement is the one with no chain
 * behind it.
 */
check('the quote refuses on a virtual-account settlement with no on-chain wallet',
  /listVirtualAccountTransactions\(\)/.test(quotesSrc) && /findUserWalletForNetwork/.test(quotesSrc),
  'pricing an unmovable balance creates an order that hangs forever');
check('and does NOT refuse on an ordinary admin credit',
  !/credited \?\? 0\) > 0/.test(quotesSrc),
  'that is how support funds a user who then legitimately quotes');
check('and says so in words a user can act on',
  /contact support/i.test(quotesSrc),
  'a refusal with no next step is just a dead end');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
