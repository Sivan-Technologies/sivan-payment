/**
 * ASK SIVAN, INLINE ON EVERY TRANSACTION.
 *
 * Reported from a deposit screenshot: the "Need support?" box offered only
 * "Share the Request ID" with no way to ask anything. The button existed - but
 * only on the timeline branch, which serves withdrawals, buy orders and naira
 * transfers. Deposits, crypto sends and supplier payouts render through the
 * activityRow fallback, which never had it.
 *
 * And where the button DID exist it was one-shot: a single answer in a <pre>,
 * no follow-up, and a second click silently replaced the first.
 *
 * WHY A BROWSER TEST. The unit suite proves the SERVER resolves each kind. It
 * cannot prove the panel renders the control, sends the right resourceType for
 * the row on screen, keeps a thread, or resets that thread when the user picks
 * a different transaction. Those are all composition, and only the real
 * rendered panel shows them.
 *
 * Run: node e2e/transaction-ask-sivan.mjs
 */

import { chromium } from 'playwright';

const FE = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4178';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const USER = 'usr_tx_ace';
const U = `/api/users/${USER}`;
const NOW = new Date().toISOString();
const OLDER = new Date(Date.now() - 86_400_000).toISOString();

const DEP_ID = 'dep_6999232a-578c-4486-aedd-0a4a02d3b43c';
const NGN_ID = 'ngnt_c217e14a-2eb8-46fc-ba48-8d4b848a66ef';

/** Records the resourceType/resourceId each ask actually sent. */
const sent = [];

const routes = (page) => page.route('**/api/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const p = url.pathname;
  const j = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

  if (p.endsWith('/ace/support')) {
    const body = JSON.parse(request.postData() || '{}');
    sent.push(body);
    return j({
      answer: `Answer about ${body.resourceType} ${body.resourceId}. Question was: ${body.message}`,
      confidence: 'high',
      needsHuman: false,
      evidenceChecked: ['Transaction'],
      suggestedActions: [],
      sessionId: 'ace_test',
    });
  }
  if (p === '/api/ace/warmup') return j({ warm: true, ms: 1 });

  if (p === '/api/offramp/controls') return j({
    customerTypes: [{ customerType: 'individual', enabled: true, label: 'Individual' }],
    payoutCurrencies: [{ currency: 'ngn', enabled: true, label: 'NGN', accountType: 'ngn', defaultPaymentRail: 'bank' }],
    virtualAccounts: [], sourceAssets: [{ asset: 'usdc', enabled: true, label: 'USDC' }],
    sourceNetworks: [{ network: 'solana', enabled: true, label: 'Solana', sortOrder: 10 }],
    supplierPayoutsEnabled: false, transfersEnabled: true,
  });

  if (p === `${U}/verification-summary`) return j({
    level: 2, levelLabel: 'Level 2: Identity verified', path: 'ngn_bank', country: 'NG',
    checks: { identity: 'verified', bank: 'verified' }, upliftApplies: false,
    terms: { required: false, accepted: true }, identityComplete: true, pathComplete: true,
    hasPayoutAccount: true, hasPendingPayoutReview: false, windowDays: 30, allowances: [],
  });

  /** A wallet deposit - the kind whose panel had NO button at all. */
  if (p === `${U}/balance/deposits`) return j([{
    id: DEP_ID, userId: USER, walletId: 'w1', address: '4JStq', chain: 'solana',
    asset: 'usdc', amount: '19.500000', status: 'confirmed',
    detectionSource: 'balance_poll', idempotencyKey: 'k1', createdAt: NOW, updatedAt: NOW,
  }]);

  /** A naira payout - the timeline branch, which had the one-shot version. */
  if (p === `${U}/ngn-transfers`) return j([{
    id: NGN_ID, userId: USER, quoteId: 'q1', direction: 'offramp',
    status: 'settlement_processing', provider: 'breet',
    sourceCurrency: 'usdt', destinationCurrency: 'ngn',
    sourceAmount: '15', destinationAmount: '24990.24', rate: '1600', feeAmount: '50',
    createdAt: OLDER, updatedAt: OLDER,
  }]);

  if (p === `/api/customers/${USER}`) return j({ id: 'cus_1', provider: 'bridge', kycStatus: 'kyc_approved', tosStatus: 'approved' });
  if (p === `${U}/balance/unified`) return j({ userId: USER, updatedAt: NOW, wallets: [], balances: [] });
  if (p === '/api/system/status') return j({ mode: 'active', message: '' });
  return j([]);
});

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
const p = await ctx.newPage();
const consoleErrors = [];
p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await routes(p);
await p.goto(FE, { waitUntil: 'domcontentloaded' });
await p.evaluate((id) => {
  localStorage.setItem('sivan.authToken', 'e2e-token');
  localStorage.setItem('sivan.user', JSON.stringify({ id, email: 'tx@sivan.test', fullName: 'Olaleye Micheal Samson', country: 'NG' }));
}, USER);
await p.goto(`${FE}/history`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

const onScreen = await p.evaluate(() => Boolean(document.querySelector('.transaction-ledger-layout')));
check('the transactions page is the one under test', onScreen,
  (await p.evaluate(() => document.body.innerText.slice(0, 120))).replace(/\n/g, ' '));

/**
 * Click a row by its visible label.
 *
 * `.activity-list > *` alone is not enough: innerText on the wrapper returns
 * only the direction glyph ("↓"), because the label lives in a nested node.
 * textContent on the whole subtree is what actually contains "Deposit
 * received" / "Withdrawal to naira".
 */
const selectRow = async (labelMatch) => {
  const clicked = await p.evaluate((wanted) => {
    const rows = [...document.querySelectorAll('.activity-list > *')];
    const row = rows.find((el) => new RegExp(wanted, 'i').test(el.textContent || ''));
    if (!row) return { ok: false, seen: rows.map((r) => (r.textContent || '').slice(0, 40)) };
    (row.querySelector('button') ?? row).click();
    return { ok: true };
  }, labelMatch);
  if (!clicked.ok) throw new Error(`row "${labelMatch}" not found. Rows: ${JSON.stringify(clicked.seen)}`);
  await p.waitForTimeout(900);
};

const readBlock = () => p.evaluate(() => {
  const box = document.querySelector('.ask-sivan-inline');
  if (!box) return null;
  const btn = [...box.querySelectorAll('button')].find((x) => /Ask Sivan about this transaction/i.test(x.innerText));
  return {
    present: true,
    hasButton: Boolean(btn),
    bubbles: box.querySelectorAll('.ask-sivan-message').length,
    chips: [...box.querySelectorAll('.ask-sivan-quick button')].map((x) => x.innerText.trim()),
    hasComposer: Boolean(box.querySelector('.ask-sivan-compose')),
    limits: [...box.querySelectorAll('.ask-sivan-limits span')].map((x) => x.innerText.trim()),
    text: box.innerText,
  };
});

const clickAsk = async () => {
  await p.evaluate(() => {
    const box = document.querySelector('.ask-sivan-inline');
    [...box.querySelectorAll('button')].find((x) => /Ask Sivan about this transaction/i.test(x.innerText))?.click();
  });
  await p.waitForFunction(
    () => document.querySelectorAll('.ask-sivan-inline .ask-sivan-message').length >= 2,
    null, { timeout: 15000 }
  ).catch(() => {});
  await p.waitForTimeout(300);
};

if (onScreen) {
  console.log('\n══ a WALLET DEPOSIT - the branch that had no button at all ══');
  await selectRow('Deposit received');
  const deposit = await readBlock();
  check('the Ask Sivan block renders on a deposit', Boolean(deposit?.present),
    'the activityRow fallback branch never had it');
  check('and it offers the opening question', Boolean(deposit?.hasButton), JSON.stringify(deposit?.text?.slice(0, 90)));

  await clickAsk();
  const afterAsk = await readBlock();
  check('asking produces a thread, not a single <pre>', (afterAsk?.bubbles ?? 0) >= 2, `bubbles=${afterAsk?.bubbles}`);

  /**
   * THE LOAD-BEARING ASSERTION. The old handler read tx.direction off the
   * detail record, which a deposit does not have - it would have asked
   * "Where is my buy order?" about a deposit, if it had rendered at all.
   */
  const depositCall = sent[sent.length - 1];
  check('it asks about wallet_deposit, not a buy order',
    depositCall?.resourceType === 'wallet_deposit', JSON.stringify(depositCall));
  check('and it passes THAT deposit\'s id',
    depositCall?.resourceId === DEP_ID, String(depositCall?.resourceId));
  check('the question names a deposit',
    /deposit/i.test(depositCall?.message ?? ''), depositCall?.message);

  console.log('\n══ follow-ups ═══════════════════════════════════════════');
  check('follow-up chips appear once there is something to follow up on',
    (afterAsk?.chips.length ?? 0) > 0, JSON.stringify(afterAsk?.chips));
  check('at most three, so it stays a prompt and not a menu',
    (afterAsk?.chips.length ?? 0) <= 3, String(afterAsk?.chips.length));
  check('a free-text composer is available as the secondary path',
    Boolean(afterAsk?.hasComposer));
  check('and the remaining allowance is shown once a conversation exists',
    (afterAsk?.limits.length ?? 0) === 2, JSON.stringify(afterAsk?.limits));

  const before = sent.length;
  await p.evaluate(() => document.querySelector('.ask-sivan-inline .ask-sivan-quick button')?.click());
  await p.waitForTimeout(1200);
  check('tapping a chip asks a real follow-up', sent.length === before + 1, `${before} -> ${sent.length}`);
  check('and the follow-up stays on the same transaction',
    sent[sent.length - 1]?.resourceId === DEP_ID, String(sent[sent.length - 1]?.resourceId));

  console.log('\n══ switching transactions ═══════════════════════════════');
  await selectRow('Withdrawal to naira');
  const afterSwitch = await readBlock();
  /**
   * The thread MUST reset. Leaving answers about the previous row under a new
   * timeline is the most misleading thing this panel could do - every answer
   * names a Request ID the user is no longer looking at.
   */
  check('selecting another transaction clears the previous thread',
    (afterSwitch?.bubbles ?? 0) === 0, `${afterSwitch?.bubbles} bubbles carried over`);
  /**
   * A naira payout renders through a THIRD branch - not the timeline, not the
   * activityRow fallback. It is the panel in the original screenshot, and it
   * was the last one still missing the block. Found only by reading the
   * rendered DOM; the source of the other two branches looked complete.
   */
  const asideTail = await p.evaluate(() => (document.querySelector('.transaction-timeline-card')?.innerText ?? '').slice(-120));
  check('and the block is present on the naira payout branch too',
    Boolean(afterSwitch?.present), asideTail.replace(/\n/g, ' | '));

  await clickAsk();
  const ngnCall = sent[sent.length - 1];
  check('a naira payout asks about ngn_transfer',
    ngnCall?.resourceType === 'ngn_transfer', JSON.stringify(ngnCall));
  check('with that payout\'s id', ngnCall?.resourceId === NGN_ID, String(ngnCall?.resourceId));
  check('and the question mentions where the money is going',
    /where|going|status/i.test(ngnCall?.message ?? ''), ngnCall?.message);

  await p.screenshot({ path: '/tmp/tx-ask-sivan.png', fullPage: false });
}

const relevant = consoleErrors.filter((e) => !/favicon|manifest|404|Failed to load resource/i.test(e));
check('no console errors', relevant.length === 0, relevant.slice(0, 2).join(' | '));

await ctx.close();
await b.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
process.exit(fail === 0 ? 0 : 1);
