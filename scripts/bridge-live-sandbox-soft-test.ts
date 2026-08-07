/**
 * SOFT TEST AGAINST THE REAL BRIDGE SANDBOX.
 *
 * Everything else in scripts/ runs against mocks. This one talks to
 * api.sandbox.bridge.xyz with a real key, because "our code is correct" and
 * "Bridge accepts it" are different claims and only the second one predicts
 * production.
 *
 * It is READ-MOSTLY and SAFE TO RE-RUN:
 *   - it never creates a customer (each one costs $2)
 *   - it reuses an existing verified customer and its virtual account
 *   - the one write it makes is an idempotent PUT of a birth_date the
 *     customer already has
 *   - the transfer probe is deliberately sized ABOVE the wallet balance, so
 *     Bridge validates the whole request and then refuses on funds. Nothing
 *     moves. See section 5 for why that is the strongest assertion available.
 *
 * WHY IT SKIPS RATHER THAN FAILS WITHOUT A KEY. CI has no Bridge credentials,
 * and a suite that goes red on a missing secret trains people to ignore red.
 *
 * Run: npm run test:bridge-sandbox
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THIS HAS PROVEN, AND WHAT IT CANNOT
 *
 * PROVEN: customer verification state, virtual-account provisioning with the
 * compulsory 1.25% developer fee, and that the exact bridge_wallet -> chain
 * transfer body our sweep sends is ACCEPTED by Bridge (validated to the point
 * of a balance check).
 *
 * NOT PROVEN: a settled transfer. Bridge's sandbox funding endpoints -
 * POST /wallets/{id}/simulate_deposit and the virtual-account test_deposit -
 * both return 401 on this key. Measured, repeatedly, while PUT /customers and
 * POST /transfers on the SAME key return 200/400. So it is an account
 * permission, not a wrong path or a bad key.
 *
 * Until Bridge enables deposit simulation, no wallet-sourced transfer can
 * reach a terminal state here and the receipt/fee/tx-hash of a completed
 * sweep remains unobserved. That gap is stated rather than papered over.
 */

/**
 * Marks this file a MODULE. Everything here uses dynamic import(), so without
 * a static import or export TypeScript treats it as a global script - and then
 * top-level await is an error and `pass`/`fail` collide with every other test
 * file in the same program. tsc caught it; tsx did not.
 */
export {};

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-bridge-sandbox.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.APP_ENV = 'development';
process.env.USER_JWT_SECRET = 'bridge-sandbox-jwt-secret-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

/**
 * Load .env the same way every other live-calling script does - by importing
 * the config module, which runs dotenv as a side effect. Reading process.env
 * directly returned an empty key and skipped the whole suite while the key
 * was sitting in .env the entire time.
 */
const { env: appEnv } = await import('../src/config/env.js');

let pass = 0, fail = 0, skipped = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}
function note(message: string) { console.log(`  ..   ${message}`); }

const API_KEY = process.env.BRIDGE_API_KEY || appEnv.BRIDGE_API_KEY || '';
const BASE = process.env.BRIDGE_SANDBOX_URL || 'https://api.sandbox.bridge.xyz';
/** The verified sandbox customer this suite reads. Override to use another. */
const EMAIL = process.env.BRIDGE_SANDBOX_EMAIL || 'solianetwork0@gmail.com';

if (!API_KEY) {
  console.log('\n⏭  BRIDGE_API_KEY is not set — skipping the live sandbox soft test.');
  console.log('   This suite talks to the real Bridge sandbox and is skipped, not failed,');
  console.log('   when no key is present. A suite that reddens on a missing secret is a');
  console.log('   suite people learn to ignore.\n');
  process.exit(0);
}

const uuid = () => crypto.randomUUID();

async function bridge(path: string, init: RequestInit & { idempotent?: boolean } = {}) {
  const headers: Record<string, string> = {
    'Api-Key': API_KEY,
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  /**
   * POST only. Bridge REFUSES an Idempotency-Key on PUT with
   * 422 "Cannot set Idempotency-Key on this request" - measured. Our
   * updateCustomer() already omits it, but this helper sent one on every
   * non-GET and turned a working call into a failure. Fixed here, and
   * asserted below so nobody re-adds it.
   */
  if (init.method === 'POST') headers['Idempotency-Key'] = uuid();
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as any };
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the key authenticates against the SANDBOX host ────────');

const list = await bridge('/v0/customers?limit=100');
check('GET /v0/customers returns 200', list.status === 200, `HTTP ${list.status}`);

/**
 * The production host REJECTS this key outright with "an API key from a wrong
 * environment is used". Worth asserting: pointing BRIDGE_API_URL at production
 * with a sandbox key fails at the first call rather than halfway through a
 * money flow.
 */
const prod = await fetch('https://api.bridge.xyz/v0/customers?limit=1', { headers: { 'Api-Key': API_KEY } });
check('the same key is REFUSED by the production host', prod.status === 401, `HTTP ${prod.status}`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. the customer is verified ──────────────────────────────');

const customer = (list.body.data || []).find((row: any) => row.email === EMAIL);
check(`${EMAIL} exists on Bridge`, Boolean(customer), 'set BRIDGE_SANDBOX_EMAIL to override');
if (!customer) {
  console.log(`\n❌ ${pass} passed, ${fail} failed — cannot continue without the customer.`);
  process.exit(1);
}

console.log(`  ..   customer ${customer.id}`);
check('status is active', customer.status === 'active', String(customer.status));
check('terms of service accepted', customer.has_accepted_terms_of_service === true);

const endorsements = customer.endorsements || [];
for (const e of endorsements) {
  const missing = (e.requirements?.missing?.all_of) || [];
  check(`endorsement "${e.name}" is approved`, e.status === 'approved', String(e.status));
  check(`  with nothing outstanding`, missing.length === 0, JSON.stringify(missing));
}

/**
 * THE DATE-OF-BIRTH REQUIREMENT, asserted where it actually lives.
 *
 * This customer was stuck on `date_of_birth` + `min_age_18` and showed the
 * user "Verification needs one more step" with nothing to act on. Both are
 * now in `complete`. Note `birth_date` on the customer object itself can read
 * null even once satisfied - the endorsement is the source of truth, so that
 * is what is checked.
 */
for (const e of endorsements) {
  const complete = e.requirements?.complete || [];
  check(`"${e.name}": date_of_birth satisfied`, complete.includes('date_of_birth'));
  check(`"${e.name}": min_age_18 satisfied`, complete.includes('min_age_18'));
}

check('crypto payin is active', customer.capabilities?.payin_crypto === 'active', JSON.stringify(customer.capabilities));
check('crypto payout is active', customer.capabilities?.payout_crypto === 'active');

// The PUT our code makes, re-run. Idempotent by design: Bridge treats it as a
// patch, so re-sending the same body is safe and must stay a 200.
const patch = await bridge(`/v0/customers/${customer.id}`, {
  method: 'PUT', body: JSON.stringify({ birth_date: '1990-01-15' }),
});
check('PUT birth_date is accepted and re-runnable', patch.status === 200, `HTTP ${patch.status} ${JSON.stringify(patch.body).slice(0, 160)}`);

/**
 * BRIDGE REFUSES AN IDEMPOTENCY KEY ON PUT.
 *
 * Found by this suite failing with 422 "Cannot set Idempotency-Key on this
 * request" while the same call by hand returned 200. Our updateCustomer()
 * omits it - PUT is a patch and naturally idempotent - and this asserts that
 * stays true, because adding one would break every date-of-birth push with an
 * error that says nothing about dates.
 */
const withKey = await fetch(`${BASE}/v0/customers/${customer.id}`, {
  method: 'PUT',
  headers: { 'Api-Key': API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
  body: JSON.stringify({ birth_date: '1990-01-15' }),
});
check('and Bridge REFUSES an Idempotency-Key on PUT (so we must not send one)',
  withKey.status === 422, `HTTP ${withKey.status}`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. the wallet ────────────────────────────────────────────');

const wallets = await bridge(`/v0/customers/${customer.id}/wallets`);
const walletRows = wallets.body.data || wallets.body || [];
check('the customer has at least one Bridge wallet', walletRows.length > 0);

const wallet = walletRows[0];
console.log(`  ..   wallet ${wallet?.id} on ${wallet?.chain}`);
check('it is on the configured settlement chain (solana)', wallet?.chain === 'solana', String(wallet?.chain));
check('it has a real address', typeof wallet?.address === 'string' && wallet.address.length > 30);

/**
 * `initiation_required` changes the transfer body: Bridge wants an extra
 * `initiation` object for some wallets, and our createTransfer does not send
 * one. Absent today - asserted so that if Bridge ever turns it on, this fails
 * here rather than in production.
 */
check('the wallet does NOT require an initiation object',
  !wallet?.initiation_required,
  'if this flips, bridge-wallet.provider.ts createTransfer must send `initiation`');

const usdc = (wallet?.balances || []).find((b: any) => b.currency === 'usdc');
const usdcBalance = Number(usdc?.balance ?? 0);
console.log(`  ..   usdc balance: ${usdcBalance}`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. the virtual account and its COMPULSORY fee ────────────');

const vas = await bridge(`/v0/customers/${customer.id}/virtual_accounts`);
const vaRows = vas.body.data || [];
check('the customer has a virtual account', vaRows.length > 0);

const va = vaRows[0];
console.log(`  ..   virtual account ${va?.id}`);
check('it is activated', va?.status === 'activated', String(va?.status));

/**
 * THE FEE IS THE POINT OF THIS SECTION.
 *
 * Bridge fixes developer_fee_percent when the account is created and it CANNOT
 * be reclaimed on deposits already received - so a VA provisioned at 0% earns
 * nothing, permanently, and nobody notices until the money has arrived. Read
 * back from Bridge rather than from our own settings, because our settings
 * saying 1.25 proves only that we asked.
 */
const feePercent = Number(va?.developer_fee_percent);
check('Bridge holds a developer fee on it', Number.isFinite(feePercent) && feePercent > 0, String(va?.developer_fee_percent));
check('and it is at least the 1.25% floor', feePercent >= 1.25, `${feePercent}%`);

const { MINIMUM_VIRTUAL_ACCOUNT_FEE_PERCENT } = await import('../src/offramp/service/fees.service.js');
check('which matches the floor our code enforces',
  feePercent >= MINIMUM_VIRTUAL_ACCOUNT_FEE_PERCENT,
  `bridge=${feePercent} ours=${MINIMUM_VIRTUAL_ACCOUNT_FEE_PERCENT}`);

// Deposit instructions are what a user is actually shown. Missing fields here
// are a support ticket, not an exception.
const src = va?.source_deposit_instructions || {};
check('USD deposit instructions carry a bank account number', Boolean(src.bank_account_number), JSON.stringify(Object.keys(src)));
check('and a routing number', Boolean(src.bank_routing_number));
check('and name the beneficiary', Boolean(src.bank_beneficiary_name));

/**
 * The VA must settle to the customer's OWN wallet. If this ever points
 * somewhere else, deposits land outside the custody chain the sweep expects.
 */
check('it settles to this customer\'s wallet address',
  va?.destination?.address === wallet?.address,
  `${va?.destination?.address} vs ${wallet?.address}`);
check('as usdc', va?.destination?.currency === 'usdc', String(va?.destination?.currency));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. the Bridge -> Privy sweep transfer body ───────────────');

/**
 * THE ASSERTION BRIDGE SUPPORT UNBLOCKED.
 *
 * This is the exact request bridge-wallet.provider.ts createTransfer() builds
 * for the Bridge -> Privy sweep. Sending it with an amount ABOVE the wallet
 * balance is deliberate: Bridge validates the ENTIRE body - customer,
 * on_behalf_of, wallet id, both payment rails, currencies, destination
 * address - and only then refuses on funds.
 *
 * So a 400 reading "amount is higher than the balance of the wallet" is a
 * PASS: every part of the request Bridge could reject has been accepted, and
 * nothing moved. Any other error means our request shape is wrong.
 *
 * This retires an earlier belief of mine that wallet-sourced sends were
 * compliance-blocked. They are not.
 */
const oversized = (usdcBalance + 1000).toFixed(2);
const probe = await bridge('/v0/transfers', {
  method: 'POST',
  body: JSON.stringify({
    amount: oversized,
    on_behalf_of: customer.id,
    developer_fee: '0.0',
    source: { payment_rail: 'bridge_wallet', currency: 'usdc', bridge_wallet_id: wallet.id },
    destination: {
      payment_rail: 'solana',
      currency: 'usdc',
      to_address: process.env.BRIDGE_SANDBOX_DEST || 'B5YyF9W4GhET9xxuiLkTmGoMecJY5QsYascLc8XJfgTv',
    },
  }),
});

const balanceRefusal = probe.status === 400 &&
  JSON.stringify(probe.body).includes('higher than the balance');

check('the sweep request body is ACCEPTED by Bridge',
  probe.status === 201 || balanceRefusal,
  `HTTP ${probe.status} ${JSON.stringify(probe.body).slice(0, 220)}`);
check('bridge_wallet -> solana is a permitted route',
  !JSON.stringify(probe.body).match(/not.?(allowed|permitted|supported)/i),
  JSON.stringify(probe.body).slice(0, 220));

if (balanceRefusal) {
  note('refused on FUNDS only — every other field validated. Nothing moved.');
}

if (probe.status === 201) {
  // The wallet was funded, so a real transfer now exists. Read it back rather
  // than trusting the create response.
  const id = probe.body.id;
  note(`transfer ${id} created — state ${probe.body.state}`);
  const fetched = await bridge(`/v0/transfers/${id}`);
  check('the transfer can be read back', fetched.status === 200);
  check('and carries a state', Boolean(fetched.body?.state), JSON.stringify(fetched.body).slice(0, 200));
  note(`receipt: ${JSON.stringify(fetched.body?.receipt ?? null)}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. what sandbox will NOT let us prove ────────────────────');

/**
 * Recorded as an assertion so it stays true or gets noticed.
 *
 * If Bridge enables deposit simulation on this key, this check FLIPS and the
 * suite goes red - which is the correct outcome, because it means the
 * completed-transfer path can finally be tested and section 5 should be
 * extended to do so.
 */
const sim = await bridge(`/v0/customers/${customer.id}/wallets/${wallet.id}/simulate_deposit`, {
  method: 'POST', body: JSON.stringify({ amount: '100.0', currency: 'usdc' }),
});
if (sim.status === 401) {
  skipped += 1;
  note('simulate_deposit is 401 on this key — wallet funding is not permitted,');
  note('so a SETTLED wallet->chain transfer stays unproven. Ask Bridge to enable it.');
  check('this limitation is a permission, not a broken request',
    JSON.stringify(sim.body).toLowerCase().includes('unauthorized'),
    JSON.stringify(sim.body).slice(0, 160));
} else {
  check('simulate_deposit is now ENABLED — extend section 5 to prove settlement',
    false,
    `HTTP ${sim.status} — this is good news; the suite should now test a completed transfer`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed${skipped ? `, ${skipped} limitation noted` : ''}`);
process.exit(fail === 0 ? 0 : 1);
