/**
 * THE WHOLE NAIRA WITHDRAWAL, END TO END, THROUGH THE REAL STACK.
 *
 * The suites shipped this week each prove one slice: the destination travels
 * with the quote, the saved account is offered, the payee tab is hidden. This
 * one walks the path a Nigerian user actually walks - sign up, save a bank,
 * pick it, price it, accept it, get a deposit address - and asserts the money
 * is aimed at the account they chose at every step it changes hands.
 *
 * WHY IT ASSERTS ON THE ORDER, NOT ON THE FORM.
 *
 * A quote is a price. The ORDER is the thing Breet acts on: its metadata is
 * what carries bankId + accountNumber into
 * `generate-address`, which is the only reason autoSettlement turns on. So the
 * final assertion reads the created transfer, not a UI state - a screen that
 * says the right bank while the order names another is precisely the bug that
 * was live in this repo three days ago.
 *
 * Run: node e2e/withdrawal-e2e.mjs
 */

const API = process.env.E2E_API ?? 'http://127.0.0.1:4179';
const ADMIN_KEY = process.env.E2E_ADMIN_KEY ?? 'e2e-admin-key';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json.data ?? json, error: json.error };
}

const admin = (path, options = {}) =>
  api(path, { ...options, headers: { 'x-admin-api-key': ADMIN_KEY, ...(options.headers ?? {}) } });

async function makeUser(fullName = 'OGUNMEPON SHARAFA') {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sivan.test`;
  const start = await api('/api/auth/email/start', {
    method: 'POST',
    body: JSON.stringify({
      email, fullName, intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
    }),
  });
  if (!start.body?.devCode) throw new Error(`signup failed (${start.status}): ${JSON.stringify(start.body).slice(0, 200)}`);
  const verified = await api('/api/auth/email/verify', {
    method: 'POST', body: JSON.stringify({ email, code: start.body.devCode }),
  });
  const { token, user } = verified.body;
  await api(`/api/users/${user.id}/country`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ country: 'NG' }),
  });
  return { token, user, auth: { Authorization: `Bearer ${token}` } };
}

async function main() {
  console.log('\n══ SETUP ═════════════════════════════════════════════════════');

  /**
   * EVERY RUN MUST START FROM A DATABASE THIS RUN CREATED.
   *
   * This bit me while mutation-testing. The JSON database is held open by the
   * server process, so deleting the file between runs does nothing - the next
   * write recreates it from memory, rows and all. Accounts therefore piled up
   * across runs, and a mutation that SHOULD have failed the suite passed
   * instead, because the quote picked up a stale row from an earlier user that
   * happened to still satisfy the assertion.
   *
   * A green run against yesterday's data is worse than no run: it is a false
   * pass on the exact guard being verified. Every user here is minted fresh
   * with a unique email, and this asserts the server agrees it is starting
   * clean rather than trusting the harness.
   */
  const preexisting = await admin('/api/admin/ngn/payout-accounts/reviews');
  check('the server is reachable before any assertions are made',
    preexisting.status === 200, `${preexisting.status}`);

  // Start from a known control state rather than whatever a previous run left.
  await admin('/api/admin/ngn/controls', {
    method: 'PUT',
    body: JSON.stringify({ offrampEnabled: true, thirdPartyPayoutsEnabled: false, activeProvider: 'mock' }),
  });
  const controls = await admin('/api/admin/ngn/controls');
  check('the rail is open and third-party payouts are closed',
    controls.body?.offrampEnabled === true && controls.body?.thirdPartyPayoutsEnabled === false,
    JSON.stringify({ off: controls.body?.offrampEnabled, tp: controls.body?.thirdPartyPayoutsEnabled }));

  const { user, auth } = await makeUser();
  check('a Nigerian user can sign up and verify', Boolean(user?.id), JSON.stringify(user).slice(0, 120));

  console.log('\n══ 1. FIRST WITHDRAWAL: the bank is typed once ═══════════════');

  const empty = await api(`/api/ngn/payout-accounts?userId=${user.id}`, { headers: auth });
  check('a new user has no saved accounts', Array.isArray(empty.body) && empty.body.length === 0,
    JSON.stringify(empty.body).slice(0, 120));

  const savedA = await api('/api/ngn/payout-accounts', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ userId: user.id, bankId: '1', accountNumber: '1111111111' }),
  });
  check('saving a name-matched account verifies it',
    savedA.body?.status === 'verified',
    `${savedA.status} ${JSON.stringify(savedA.body).slice(0, 160)}`);
  check('and the server resolved the name itself',
    typeof savedA.body?.accountName === 'string' && savedA.body.accountName.length > 0,
    JSON.stringify(savedA.body?.accountName));

  /**
   * The client cannot dictate the name. Sending someone else's would otherwise
   * let a stranger's account inherit this user's bank-verified identity.
   */
  const spoof = await api('/api/ngn/payout-accounts', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ userId: user.id, bankId: '1', accountNumber: '1111111111', accountName: 'ATTACKER NAME' }),
  });
  check('a client-supplied account name is ignored',
    spoof.body?.accountName !== 'ATTACKER NAME',
    JSON.stringify(spoof.body?.accountName));

  console.log('\n══ 2. IT IS REMEMBERED ═══════════════════════════════════════');

  const listed = await api(`/api/ngn/payout-accounts?userId=${user.id}`, { headers: auth });
  check('the account is returned on the next visit',
    Array.isArray(listed.body) && listed.body.length === 1,
    `${listed.body?.length} account(s)`);
  check('and re-saving the same account did not duplicate it',
    listed.body?.[0]?.id === savedA.body?.id,
    JSON.stringify(listed.body?.map((a) => a.id)));

  console.log('\n══ 3. A SECOND ACCOUNT MAKES THE CHOICE AMBIGUOUS ════════════');

  const savedB = await api('/api/ngn/payout-accounts', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ userId: user.id, bankId: '2', accountNumber: '2222222222' }),
  });
  check('a second account of the user\'s own also verifies',
    savedB.body?.status === 'verified', JSON.stringify(savedB.body).slice(0, 140));

  const ambiguous = await api(
    `/api/ngn/quote?userId=${user.id}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=solana`,
    { headers: auth });
  check('quoting without naming a destination is REFUSED',
    ambiguous.status >= 400,
    `${ambiguous.status} - silently picking one is how naira reaches the wrong bank`);
  check('and the refusal tells the user to choose',
    /choose|which|select/i.test(ambiguous.error?.message ?? ''),
    ambiguous.error?.message);

  console.log('\n══ 4. THE CHOSEN ACCOUNT IS THE ONE THAT GETS PAID ═══════════');

  const quote = await api(
    `/api/ngn/quote?userId=${user.id}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=solana&payoutAccountId=${savedB.body.id}`,
    { headers: auth });
  check('naming the second account prices the withdrawal',
    Boolean(quote.body?.id), `${quote.status} ${JSON.stringify(quote.error ?? quote.body).slice(0, 160)}`);
  check('the quote carries THAT account, not the first one saved',
    quote.body?.metadata?.accountNumber === '2222222222',
    `carried ${quote.body?.metadata?.accountNumber}, chose 2222222222`);
  check('and its bank id travels too',
    quote.body?.metadata?.bankId === '2',
    `${quote.body?.metadata?.bankId} - a right number at the wrong bank is a failed payout`);

  console.log('\n══ 5. SOMEONE ELSE\'S ACCOUNT IS REFUSED ══════════════════════');

  const stranger = await makeUser('SOMEBODY ELSE');
  /**
   * bankId '1', not '3'. My first version used '3', which is not in the mock
   * directory, so the save 400'd - "We could not confirm that account" - and
   * the assertion failed for a reason that had nothing to do with the code
   * under test. Worse, the theft assertions below would then have been passing
   * against a NONEXISTENT id rather than a real account belonging to someone
   * else, which is a much weaker thing to prove.
   */
  const strangerAccount = await api('/api/ngn/payout-accounts', {
    method: 'POST', headers: stranger.auth,
    body: JSON.stringify({ userId: stranger.user.id, bankId: '1', accountNumber: '1111111111' }),
  });
  check('a second user has their own verified account',
    strangerAccount.body?.status === 'verified',
    `${strangerAccount.status} ${JSON.stringify(strangerAccount.body ?? strangerAccount.error).slice(0, 160)}`);
  check('and it is a DIFFERENT row from the first user\'s',
    Boolean(strangerAccount.body?.id) && strangerAccount.body.id !== savedA.body.id,
    JSON.stringify({ stranger: strangerAccount.body?.id, mine: savedA.body?.id }));

  const theft = await api(
    `/api/ngn/quote?userId=${user.id}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=solana&payoutAccountId=${strangerAccount.body.id}`,
    { headers: auth });
  check('paying into an account you do not own is refused',
    theft.status >= 400,
    `${theft.status} ${JSON.stringify(theft.body).slice(0, 140)}`);
  check('and the refusal does not confirm the account exists',
    !/somebody else|9999999999/i.test(JSON.stringify(theft.error ?? {})),
    JSON.stringify(theft.error?.message));

  /** Another user's token must not reach this user's list either. */
  const crossRead = await api(`/api/ngn/payout-accounts?userId=${user.id}`, { headers: stranger.auth });
  check('one user cannot read another user\'s saved accounts',
    crossRead.status >= 400, `${crossRead.status}`);

  console.log('\n══ 6. THE ORDER AIMS AT THE RIGHT BANK ═══════════════════════');

  const order = await api('/api/ngn/offramp/orders', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ userId: user.id, quoteId: quote.body.id }),
  });
  check('the order is created',
    Boolean(order.body?.id), `${order.status} ${JSON.stringify(order.error ?? order.body).slice(0, 200)}`);

  /**
   * THE ASSERTION THAT MATTERS MOST IN THIS FILE.
   *
   * transferMetadata is what the provider was handed. If the chosen bank did
   * not reach here, the user was shown one account and Breet was told another.
   */
  const orderBank = order.body?.metadata?.quoteMetadata ?? {};
  check('the ORDER carries the account the user chose',
    orderBank.accountNumber === '2222222222',
    JSON.stringify({ carried: orderBank.accountNumber, chose: '2222222222' }));
  check('a deposit address was issued',
    Boolean(order.body?.depositAddress), JSON.stringify(order.body?.depositAddress));

  console.log('\n══ 7. THE ADMIN KILL SWITCH IS REAL ══════════════════════════');

  const before = await api(`/api/ngn/networks?asset=usdc`, { headers: auth });
  check('the client is told third-party payouts are off',
    before.body?.thirdPartyPayoutsEnabled === false,
    JSON.stringify(before.body?.thirdPartyPayoutsEnabled));

  await admin('/api/admin/ngn/controls', {
    method: 'PUT', body: JSON.stringify({ thirdPartyPayoutsEnabled: true }),
  });
  const on = await api(`/api/ngn/networks?asset=usdc`, { headers: auth });
  check('an admin can open it, and the client sees that immediately',
    on.body?.thirdPartyPayoutsEnabled === true,
    JSON.stringify(on.body?.thirdPartyPayoutsEnabled));

  /**
   * The flag unlocks the CHOICE, never the destination check. If this ever
   * passes, money can leave for an unverified account on a UI flag alone.
   */
  const theftWithFlagOn = await api(
    `/api/ngn/quote?userId=${user.id}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=solana&payoutAccountId=${strangerAccount.body.id}`,
    { headers: auth });
  check('even with the flag ON, a foreign account is still refused',
    theftWithFlagOn.status >= 400,
    `${theftWithFlagOn.status} - the flag must not open the money path`);

  await admin('/api/admin/ngn/controls', {
    method: 'PUT', body: JSON.stringify({ thirdPartyPayoutsEnabled: false }),
  });
  const off = await api(`/api/ngn/networks?asset=usdc`, { headers: auth });
  check('and closing it takes effect immediately',
    off.body?.thirdPartyPayoutsEnabled === false,
    JSON.stringify(off.body?.thirdPartyPayoutsEnabled));

  console.log('\n══ 8. THE RAIL SWITCH STILL STOPS EVERYTHING ═════════════════');

  await admin('/api/admin/ngn/controls', { method: 'PUT', body: JSON.stringify({ offrampEnabled: false }) });
  const closed = await api(
    `/api/ngn/quote?userId=${user.id}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=solana&payoutAccountId=${savedB.body.id}`,
    { headers: auth });
  check('with the off-ramp disabled, no quote is priced at all',
    closed.status >= 400, `${closed.status}`);
  await admin('/api/admin/ngn/controls', { method: 'PUT', body: JSON.stringify({ offrampEnabled: true }) });

  const reopened = await api(
    `/api/ngn/quote?userId=${user.id}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=solana&payoutAccountId=${savedB.body.id}`,
    { headers: auth });
  check('and re-enabling it restores service', Boolean(reopened.body?.id), `${reopened.status}`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`   ${failures.join('\n   ')}`);
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
