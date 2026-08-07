/**
 * REAL BRIDGE SANDBOX SMOKE: customer -> virtual account -> wallet transfer.
 *
 * Not a unit test. This talks to api.sandbox.bridge.xyz with a real key and
 * asserts on what Bridge actually returns, because "the code is right" and
 * "the provider accepts it" are different claims and only the second one
 * matters at launch.
 *
 * Run: npm run bridge:va-smoke
 *      BRIDGE_SMOKE_CUSTOMER_ID=<uuid> npm run bridge:va-smoke   (pin a customer)
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE OUTBOUND TRANSFER CANNOT COMPLETE IN SANDBOX, and why that is
 * recorded rather than worked around.
 *
 * Bridge support said wallet -> external-address transfers are testable in
 * sandbox. They are testable up to a point, and the point is the balance:
 *
 *   - POST /v0/customers/{id}/wallets/{id}/simulate_deposit  -> 401 on this key
 *   - POST /v0/transfers  ach_push -> bridge_wallet          -> 201, and it
 *     genuinely settles: awaiting_funds -> funds_received ->
 *     payment_processed, all observed
 *   - the wallet balance stays 0.0 anyway
 *
 * So every outbound attempt is refused with "amount is higher than the balance
 * of the wallet" - on solana AND on ethereum, identically. That is Bridge
 * refusing on funds, NOT on shape, permissions, or compliance, which is the
 * useful signal: the request we send in production is accepted right up to the
 * balance check.
 *
 * The script therefore asserts what is knowable and says plainly what is not.
 * A test that pretended to prove settlement here would be lying.
 */

import crypto from 'node:crypto';

const BASE = process.env.BRIDGE_SMOKE_BASE_URL || 'https://api.sandbox.bridge.xyz';
const KEY = process.env.BRIDGE_API_KEY || '';

let pass = 0, fail = 0, skip = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};
const note = (name: string, detail = '') => {
  skip += 1; console.log(`  --   ${name}${detail ? ` -> ${detail}` : ''}`);
};

if (!KEY) {
  console.log('BRIDGE_API_KEY is not set. Nothing to smoke.');
  process.exit(1);
}

const idem = () => crypto.randomUUID();

async function bridge(path: string, init: RequestInit & { idempotent?: boolean } = {}) {
  const headers: Record<string, string> = {
    'Api-Key': KEY,
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.method && init.method !== 'GET' && init.idempotent !== false) {
    headers['Idempotency-Key'] = idem();
  }
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as any };
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n── 0. the key works, and against the RIGHT environment ──────`);

/**
 * A sandbox key sent to api.bridge.xyz returns
 * "Invalid credentials - it appears an API key from a wrong environment is
 * used". Worth asserting: pointing a live deploy at the sandbox key (or the
 * reverse) fails in a way that looks like an outage rather than a config
 * mistake.
 */
const auth = await bridge('/v0/customers?limit=1');
check('the API key authenticates', auth.status === 200, `HTTP ${auth.status} ${JSON.stringify(auth.body).slice(0, 140)}`);
if (auth.status !== 200) {
  console.log(`\n❌ ${pass} passed, ${fail} failed`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. find (or make) an APPROVED customer ───────────────────');

let customerId = process.env.BRIDGE_SMOKE_CUSTOMER_ID || '';

if (!customerId) {
  const all = await bridge('/v0/customers?limit=100');
  const active = (all.body.data || []).filter((c: any) => c.status === 'active');
  customerId = active[0]?.id || '';
  if (customerId) console.log(`     using existing active customer ${customerId} (${active[0]?.email})`);
}

if (!customerId) {
  note('no approved customer available', 'create one via /v0/kyc_links and complete the hosted flow');
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed, ${skip} not provable here`);
  process.exit(fail === 0 ? 0 : 1);
}

const customer = await bridge(`/v0/customers/${customerId}`);
check('the customer is retrievable', customer.status === 200, `HTTP ${customer.status}`);
check('and is APPROVED (status active)', customer.body.status === 'active', String(customer.body.status));

/**
 * Capabilities are the honest readout of what this customer may actually do -
 * a status of "active" with payin_crypto "pending" still cannot receive.
 */
const caps = customer.body.capabilities || {};
check('payin_crypto is active', caps.payin_crypto === 'active', JSON.stringify(caps));
check('payout_crypto is active', caps.payout_crypto === 'active', JSON.stringify(caps));

const endorsements = customer.body.endorsements || [];
check('every endorsement is approved',
  endorsements.length > 0 && endorsements.every((e: any) => e.status === 'approved'),
  JSON.stringify(endorsements.map((e: any) => `${e.name}=${e.status}`)));

/**
 * THE DATE-OF-BIRTH REQUIREMENT, asserted from the provider's own view.
 *
 * This is the one that produced "Verification needs one more step" with
 * nothing on screen to act on. An approved customer must not still be missing
 * it.
 */
const missingAll = endorsements.flatMap((e: any) => (e.requirements?.missing?.all_of) || []);
check('date_of_birth is not outstanding', !missingAll.includes('date_of_birth'), JSON.stringify(missingAll));
check('min_age_18 is not outstanding', !missingAll.includes('min_age_18'), JSON.stringify(missingAll));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. the virtual account, and the compulsory 1.25% fee ─────');

const vas = await bridge(`/v0/customers/${customerId}/virtual_accounts`);
check('virtual accounts are listable', vas.status === 200, `HTTP ${vas.status}`);

let va = (vas.body.data || [])[0];

if (!va) {
  /**
   * Created with the SAME fee the product enforces. If Bridge ever rejects
   * 1.25 the whole revenue model needs revisiting, so it is asserted rather
   * than assumed - and the fee is fixed at creation and unreclaimable after.
   */
  const walletsForVa = await bridge(`/v0/customers/${customerId}/wallets`);
  const walletId = (walletsForVa.body.data || walletsForVa.body || [])[0]?.id;
  const created = await bridge(`/v0/customers/${customerId}/virtual_accounts`, {
    method: 'POST',
    body: JSON.stringify({
      source: { currency: 'usd' },
      destination: walletId
        ? { currency: 'usdc', payment_rail: 'solana', bridge_wallet_id: walletId }
        : { currency: 'usdc', payment_rail: 'solana', address: 'PLACEHOLDER' },
      developer_fee_percent: '1.25',
    }),
  });
  check('a virtual account can be created', created.status === 201,
    `HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  va = created.body;
}

if (va?.id) {
  check('the VA is activated', va.status === 'activated', String(va.status));
  /**
   * THE FEE, READ BACK FROM BRIDGE. Not from our config - from theirs. This is
   * the assertion that proves the 1.25% actually landed on the provider side,
   * which is the only place it earns anything.
   */
  check('developer_fee_percent is 1.25 ON BRIDGE',
    String(va.developer_fee_percent) === '1.25', String(va.developer_fee_percent));

  const dep = va.source_deposit_instructions || {};
  check('it has USD bank deposit instructions', dep.currency === 'usd' && Boolean(dep.bank_account_number),
    JSON.stringify(dep).slice(0, 160));
  check('with at least one payment rail', Array.isArray(dep.payment_rails) && dep.payment_rails.length > 0,
    JSON.stringify(dep.payment_rails));

  /**
   * The custody design: fiat lands in a BRIDGE wallet, and the Bridge -> Privy
   * sweep moves it to the user afterwards. A VA pointing at a bare address
   * instead would bypass that hand-off entirely.
   */
  const dest = va.destination || {};
  check('it settles to USDC', dest.currency === 'usdc', JSON.stringify(dest));
  check('and the destination is a real address', Boolean(dest.address), JSON.stringify(dest));
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. the Bridge wallet ─────────────────────────────────────');

const wallets = await bridge(`/v0/customers/${customerId}/wallets`);
const wallet = (wallets.body.data || wallets.body || [])[0];
check('the customer has a Bridge wallet', Boolean(wallet?.id), JSON.stringify(wallets.body).slice(0, 160));

if (!wallet?.id) {
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed, ${skip} not provable here`);
  process.exit(fail === 0 ? 0 : 1);
}

check('it has an address', Boolean(wallet.address), String(wallet.address));
/**
 * `initiation_required` means Bridge wants a payment-initiation object on
 * transfers sourced from this wallet. We do not send one, so if this ever
 * flips to true our createTransfer starts failing - asserted so it is caught
 * here rather than in production.
 */
check('it does NOT require an initiation object',
  !wallet.initiation_required,
  'if this flips true, bridge-wallet.provider.ts must start sending `initiation`');

const usdc = (wallet.balances || []).find((b: any) => b.currency === 'usdc');
const usdcBalance = Number(usdc?.balance ?? 0);
console.log(`     wallet ${wallet.id} (${wallet.chain}) usdc=${usdcBalance}`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. the outbound transfer Bridge support described ────────');

const EXTERNAL_SOLANA = 'B5YyF9W4GhET9xxuiLkTmGoMecJY5QsYascLc8XJfgTv';

const outbound = await bridge('/v0/transfers', {
  method: 'POST',
  body: JSON.stringify({
    amount: '10.0',
    on_behalf_of: customerId,
    developer_fee: '0.0',
    source: { payment_rail: 'bridge_wallet', currency: 'usdc', bridge_wallet_id: wallet.id },
    destination: { payment_rail: String(wallet.chain), currency: 'usdc', to_address: EXTERNAL_SOLANA },
  }),
});

if (outbound.status === 201) {
  check('the transfer was accepted', true);
  check('it has a state', Boolean(outbound.body.state), JSON.stringify(outbound.body).slice(0, 200));

  // Poll to a terminal-ish state. Sandbox has no chain, so the useful proof is
  // the state machine advancing and the receipt's fee columns.
  let state = outbound.body.state;
  for (let i = 0; i < 8 && !['payment_processed', 'error', 'returned'].includes(state); i += 1) {
    await new Promise((r) => setTimeout(r, 8000));
    const polled = await bridge(`/v0/transfers/${outbound.body.id}`);
    state = polled.body.state;
    console.log(`     poll ${i + 1}: ${state}`);
  }
  check('it reached a settled state', state === 'payment_processed', String(state));

  const receipt = (await bridge(`/v0/transfers/${outbound.body.id}`)).body.receipt || {};
  console.log(`     receipt: ${JSON.stringify(receipt)}`);
  check('GAS IS NOT CHARGED TO US', String(receipt.gas_fee ?? '0.0') === '0.0',
    `gas_fee=${receipt.gas_fee} - if this is ever non-zero, MIN_BRIDGE_SWEEP_USD must cover it`);
} else if (/higher than the balance/i.test(JSON.stringify(outbound.body))) {
  /**
   * THE EXPECTED SANDBOX WALL, and it is still worth asserting.
   *
   * Bridge validated the whole request - shape, permissions, customer,
   * rail, currency - and refused ONLY on funds. That is the strongest
   * available evidence that the request we send in production is correct,
   * short of a funded wallet.
   */
  check('the request shape is ACCEPTED by Bridge (refused only on balance)', true);
  check('so the failure is funds, not shape or permissions',
    outbound.status === 400 && usdcBalance === 0,
    `HTTP ${outbound.status}, wallet usdc=${usdcBalance}`);
  note('settlement not provable in sandbox',
    'simulate_deposit returns 401 on this key and ach_push->wallet settles without crediting the balance');
} else {
  check('the transfer was accepted or refused only on balance', false,
    `HTTP ${outbound.status} ${JSON.stringify(outbound.body).slice(0, 220)}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. funding a wallet DOES settle, even if it does not credit ─');

/**
 * The one money-movement state machine that is fully observable here:
 * ach_push -> bridge_wallet runs awaiting_funds -> funds_received ->
 * payment_processed on its own. The receipt is the real prize - it is where
 * gas_fee is reported, and it reads 0.0.
 */
const inbound = await bridge('/v0/transfers', {
  method: 'POST',
  body: JSON.stringify({
    amount: '100.0',
    on_behalf_of: customerId,
    source: { payment_rail: 'ach_push', currency: 'usd' },
    destination: { payment_rail: String(wallet.chain), currency: 'usdc', bridge_wallet_id: wallet.id },
  }),
});
check('a wallet-funding transfer is accepted', inbound.status === 201,
  `HTTP ${inbound.status} ${JSON.stringify(inbound.body).slice(0, 200)}`);

if (inbound.status === 201) {
  check('it returns deposit instructions', Boolean(inbound.body.source_deposit_instructions),
    JSON.stringify(inbound.body.source_deposit_instructions).slice(0, 160));
  const r = inbound.body.receipt || {};
  check('and its receipt reports NO gas fee', String(r.gas_fee ?? '0.0') === '0.0', JSON.stringify(r));
  check('and no exchange fee on a same-value leg', String(r.exchange_fee ?? '0.0') === '0.0', JSON.stringify(r));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed, ${skip} not provable in sandbox`);
process.exit(fail === 0 ? 0 : 1);
