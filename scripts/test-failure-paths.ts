/**
 * Failure paths. Every one of these WILL happen in production.
 *
 * The objective, stated as a property: every possible state has a
 * deterministic outcome, and the user is told what is happening in words they
 * can act on.
 *
 * Two failure modes are being hunted here, and they are different:
 *
 *   WRONG OUTCOME    money moves twice, or a limit is bypassed
 *   SILENT OUTCOME   nothing crashes, nothing errors, and the user is left
 *                    looking at a screen that never changes
 *
 * The second is the one that produced every real incident in this codebase.
 * A stored-but-unapplied webhook, a flagged deposit with no handler, a stale
 * deploy behind a 200 - none of them threw. So most assertions below check
 * the MESSAGE as well as the status: an error a user cannot act on is only
 * marginally better than silence.
 *
 * Run: npm run test:failure-paths
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';
import { validateAddressForChain } from '../src/wallets/address-validation.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** An error is only useful if it tells the user what to do next. */
function isActionable(message: string): boolean {
  if (!message || message.length < 12) return false;
  return !/^(internal server error|error|failed|bad request|forbidden)\.?$/i.test(message.trim());
}

const WEBHOOK_SECRET = 'failure-paths-secret';

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  let token = '';
  const admin = { 'x-admin-api-key': env.ADMIN_API_KEY || 'failure-admin-key' };

  async function call(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    return { status: res.status, body: json.data ?? json, message: json?.error?.message ?? json?.message ?? '' };
  }

  async function signup(fullName: string) {
    const email = `${fullName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@sivan.test`;
    const start = await call('POST', '/api/auth/email/start', {
      email, fullName, intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
    });
    const verified = await call('POST', '/api/auth/email/verify', { email, code: start.body.devCode });
    return verified.body;
  }

  async function webhook(payload: unknown, secret = WEBHOOK_SECRET) {
    const res = await fetch(`${baseUrl}/api/webhooks/breet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  try {
    await call('PUT', '/api/admin/ngn/controls',
      { onrampEnabled: true, offrampEnabled: true, bankSettlementEnabled: true }, admin);

    const user = await signup('Sharafa Ogunmepon');
    token = user.token;
    const userId = user.user.id;
    await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });

    // ============================================================
    console.log('\n1. INVALID WALLET ADDRESS');
    // ============================================================
    {
      // Pure-function checks first: these are the shapes that reach a chain.
      const wrongChain = validateAddressForChain('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'base');
      check('a Solana address on Base is rejected', !wrongChain.valid);
      check('and the error names the actual mistake',
        /Solana address.*selected base|Pick Solana/i.test(wrongChain.reason ?? ''), wrongChain.reason);

      const evmOnSolana = validateAddressForChain('0x6d7D2Eb4667395437739634D3382A90Fff238295', 'solana');
      check('an EVM address on Solana is rejected', !evmOnSolana.valid);
      check('and it says which network to pick',
        /EVM address.*Solana|Pick a network/i.test(evmOnSolana.reason ?? ''), evmOnSolana.reason);

      check('a truncated EVM address is rejected',
        !validateAddressForChain('0x6d7D2Eb4667395437739634D3382A90Fff23829', 'base').valid);
      check('non-hex characters are rejected',
        !validateAddressForChain('0xZZZZ2Eb4667395437739634D3382A90Fff238295', 'base').valid);
      check('the zero address is rejected - funds there are destroyed',
        !validateAddressForChain('0x0000000000000000000000000000000000000000', 'base').valid);
      check('base58-illegal characters are rejected on Solana',
        !validateAddressForChain('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl', 'solana').valid);
      check('a pasted address with a line break is rejected',
        !validateAddressForChain('0x6d7D2Eb46673954377\n39634D3382A90Fff238295', 'base').valid);

      // ...and the good ones must still pass, or the guard is just an outage.
      check('a real EVM address passes',
        validateAddressForChain('0x6d7D2Eb4667395437739634D3382A90Fff238295', 'base').valid);
      check('a real Solana address passes',
        validateAddressForChain('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'solana').valid);

      // FUND THE USER FIRST. With a zero balance the insufficient-balance
      // check fires before the address is ever examined, so the HTTP
      // assertion below would pass with the guard deleted. Three mutation
      // rounds were needed to find that: transfers disabled, then below the
      // minimum, then no balance. Each fix was necessary and none alone was
      // sufficient - which is exactly why mutation testing is worth the time.
      token = '';
      await call('POST', '/api/admin/balance/adjustments', {
        userId, asset: 'usdc', amount: '500', direction: 'credit',
        reason: 'failure-path test funding',
      }, admin);
      token = user.token;
      const funded = await call('GET', `/api/users/${userId}/balance`);
      const usdc = (funded.body?.balances ?? []).find((b: any) => b.asset === 'usdc');
      check('the test user is funded, so the address check is reachable',
        Number(usdc?.available ?? 0) >= 50, JSON.stringify(funded.body).slice(0, 160));

      // And over HTTP, before any balance is held.
      //
      // BALANCE_TRANSFERS_ENABLED=true is required here. Without it the route
      // returns 403 "transfers are disabled" BEFORE reaching the address
      // check - which is how the first version of this test passed while the
      // guard was removed. Mutation testing caught that; the assertion was
      // decorative.
      // Amount must clear the 10 USDC minimum, or the request is refused for
      // being too small BEFORE the address is ever looked at - which is how
      // this assertion passed while the guard was deleted. Two mutation
      // rounds were needed to find that; the first fix (enabling transfers)
      // was necessary but not sufficient.
      const res = await call('POST', `/api/users/${userId}/balance/transfers`, {
        asset: 'usdc', network: 'base', amount: 50,
        destinationAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      });
      check('the API refuses a wrong-chain address', res.status >= 400, String(res.status));
      check('with an actionable message', isActionable(res.message), res.message);

      const ledger = await call('GET', `/api/users/${userId}/balance/ledger`);
      const held = (ledger.body as any[] ?? []).filter((e: any) => e.kind === 'hold');
      check('and NO hold was placed on the rejected transfer', held.length === 0, String(held.length));
    }

    // ============================================================
    console.log('\n2. INSUFFICIENT BALANCE');
    // ============================================================
    {
      const res = await call('POST', `/api/users/${userId}/balance/transfers`, {
        asset: 'usdc', network: 'base', amount: 999999,
        destinationAddress: '0x6d7D2Eb4667395437739634D3382A90Fff238295',
      });
      check('an over-balance transfer is refused', res.status >= 400, String(res.status));
      check('and the reason is the balance, not something vague',
        /insufficient|balance/i.test(res.message), res.message);

      // The ledger now legitimately contains the admin funding credit, so
      // "empty" is the wrong assertion. What must be true is that no HOLD was
      // created by the rejected transfer.
      const ledger2 = await call('GET', `/api/users/${userId}/balance/ledger`);
      const holds2 = ((ledger2.body as any[]) ?? []).filter((e: any) => e.kind === 'hold');
      check('no hold is left behind', holds2.length === 0, `${holds2.length} holds`);
    }

    // ============================================================
    console.log('\n3. EXPIRED / STALE KYC — ACTING ABOVE YOUR LEVEL');
    // ============================================================
    {
      // A Level 0 user must not be able to quote at all.
      const res = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=25&network=solana`);
      check('an unverified user cannot get a quote', res.status >= 400, String(res.status));
      check('and is told what verification would unlock it',
        isActionable(res.message) && /verif|bank|limit/i.test(res.message), res.message);
    }

    // Get to Level 1 for the rest.
    const saved = await call('POST', '/api/ngn/payout-accounts', { userId, bankId: '2', accountNumber: '1111111111' });
    for (const account of await db.listNgnPayoutAccounts(userId)) {
      await db.upsertNgnPayoutAccountRecord({ ...account, resolutionTrustworthy: true, status: 'verified' });
    }

    // ============================================================
    console.log('\n4. EXPIRED QUOTE');
    // ============================================================
    {
      const quote = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=25&network=solana`);
      check('a verified user can quote', quote.status === 200, String(quote.status));

      // Age the quote past its expiry. A quote is priced against a moving
      // rate; honouring a stale one means settling at a rate Sivan cannot get.
      const quotes = await db.listNgnQuotes();
      const stored = quotes.find((q: any) => q.id === quote.body.id)!;
      await db.upsertNgnQuoteRecord({ ...stored, expiresAt: new Date(Date.now() - 60_000).toISOString() } as any);

      const accepted = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quote.body.id });
      check('an expired quote cannot be accepted', accepted.status >= 400, String(accepted.status));
      check('and the user is told to request a new one',
        /expired|new quote/i.test(accepted.message), accepted.message);
    }

    // ============================================================
    console.log('\n5. DUPLICATE WEBHOOK');
    // ============================================================
    let transferId = '';
    let providerRef = '';
    {
      const quote = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=solana`);
      const order = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quote.body.id });
      transferId = order.body.id;
      providerRef = order.body.providerTransferId;

      const payload = { event: 'trade.completed', id: providerRef, status: 'completed', amountInUSD: 20, fiatAmount: '32100' };
      const first = await webhook(payload);
      check('the first delivery is accepted', first.status === 200 || first.status === 201);

      const afterFirst = (await db.listNgnTransfers()).find((t: any) => t.id === transferId);
      check('the transfer settles', afterFirst?.status === 'completed', String(afterFirst?.status));

      // Breet retries for up to 24 hours. Duplicates are routine, not
      // exceptional, and double-crediting is the worst outcome in the system.
      for (let i = 0; i < 5; i++) await webhook(payload);
      const afterRetries = (await db.listNgnTransfers()).find((t: any) => t.id === transferId);
      check('five duplicate deliveries change nothing',
        afterRetries?.status === 'completed' && afterRetries?.updatedAt === afterFirst?.updatedAt,
        `${afterRetries?.status} @ ${afterRetries?.updatedAt}`);

      const events = (await db.listNgnWebhooks()).filter((w: any) => w.transferId === providerRef);
      check('and the duplicates are deduplicated by (id, event)',
        events.length === 1, `${events.length} stored`);
    }

    // ============================================================
    console.log('\n6. REJECTED TRANSACTION');
    // ============================================================
    {
      const quote = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=10&network=solana`);
      const order = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quote.body.id });

      await webhook({ event: 'trade.failed', id: order.body.providerTransferId, status: 'failed', reason: 'provider rejected' });
      const t = (await db.listNgnTransfers()).find((x: any) => x.id === order.body.id);
      check('a rejected transaction is marked failed', t?.status === 'failed', String(t?.status));
      check('and it is terminal, not left in flight',
        !['awaiting_crypto_deposit', 'processing'].includes(String(t?.status)));
    }

    // ============================================================
    console.log('\n7. DELAYED SETTLEMENT / INTERRUPTED TRANSACTION');
    // ============================================================
    {
      const quote = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=8&network=solana`);
      const order = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quote.body.id });

      // A deposit that confirms but does not settle. The user has sent funds
      // and is waiting - the state must SAY that, not sit blank.
      await webhook({ event: 'trade.processing', id: order.body.providerTransferId, status: 'processing' });
      const t = (await db.listNgnTransfers()).find((x: any) => x.id === order.body.id);
      check('a delayed settlement moves to processing', t?.status === 'processing', String(t?.status));

      const timeline = await call('GET', `/api/users/${userId}/ngn-transfers`);
      const mine = (timeline.body as any[]).find((x: any) => x.id === order.body.id);
      check('and the user can see it is in progress', Boolean(mine), 'transfer not listed');

      // INTERRUPTED: the transfer is aged out with no further webhook. The
      // operational endpoint is what surfaces this - nothing throws.
      const stale = (await db.listNgnTransfers()).find((x: any) => x.id === order.body.id)!;
      const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
      await db.upsertNgnTransferRecord({ ...stale, updatedAt: old } as any);

      const health = await fetch(`${baseUrl}/health/operational`);
      const hb: any = await health.json();
      const stuck = hb.signals.find((s: any) => s.name === 'transfers_stuck_in_flight');
      check('an interrupted transfer is detected as stuck', stuck.value >= 1, String(stuck.value));
      check('and it is critical, so a monitor pages someone', stuck.severity === 'critical');
      check('the endpoint returns 503 for a dumb monitor', health.status === 503, String(health.status));
    }

    // ============================================================
    console.log('\n8. PROVIDER UNAVAILABLE / TIMEOUT');
    // ============================================================
    {
      // A bank id the provider does not know. The provider throws; the user
      // must get a 4xx they can act on, never a bare 500.
      const res = await call('GET',
        `/api/ngn/bank-account/resolve?userId=${userId}&bankId=NOT_A_REAL_BANK&accountNumber=1111111111`);
      check('an unknown bank does not 500', res.status !== 500, String(res.status));
      check('and the message is actionable', isActionable(res.message), res.message);

      // A malformed account number must never reach a paid provider call.
      const short = await call('GET',
        `/api/ngn/bank-account/resolve?userId=${userId}&bankId=2&accountNumber=123`);
      check('a malformed NUBAN is rejected locally', short.status >= 400, String(short.status));
      check('with the exact requirement stated',
        /10 digits/i.test(short.message), short.message);
    }

    // ============================================================
    console.log('\n9. USER RETRIES WHILE PROCESSING');
    // ============================================================
    {
      const quote = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=6&network=solana`);

      // Double-submit: the same quote accepted twice, as an impatient user
      // double-tapping produces. Two transfers from one quote would mean two
      // deposit addresses and a user who does not know which to fund.
      const first = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quote.body.id });
      const second = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quote.body.id });

      check('the first acceptance succeeds', first.status === 200 || first.status === 201);
      const duplicated = second.status < 400 && second.body?.id && second.body.id !== first.body.id;
      check('accepting the same quote twice does not create a second transfer',
        !duplicated, `first=${first.body?.id} second=${second.body?.id}`);
      if (second.status >= 400) {
        check('and the refusal explains itself', isActionable(second.message), second.message);
      } else {
        check('or it returns the SAME transfer, idempotently',
          second.body?.id === first.body?.id, `${first.body?.id} vs ${second.body?.id}`);
      }
    }

    // ============================================================
    console.log('\n10. LIMIT BREACH MID-FLIGHT');
    // ============================================================
    {
      // Cumulative thresholds must count completed volume, so a user cannot
      // stay under the ceiling by splitting into many small transfers.
      const summary = await call('GET', `/api/users/${userId}/verification-summary`);
      const allowance = (summary.body.allowances as any[]).find((a) => a.flow === 'offramp' && a.rail === 'ngn');
      check('the ceiling is reported to the user', allowance.limitNgn > 0, String(allowance.limitNgn));

      const over = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=500&network=solana`);
      check('a quote above the ceiling is refused', over.status >= 400, String(over.status));
      check('and the message states the remaining headroom',
        /left of your|limit/i.test(over.message), over.message);
      // The upgrade named depends on which level clears the amount: IDENTITY
      // asks for NIN/BVN, ENHANCED asks for a photo ID and proof of address.
      // My first regex only covered the former and failed on a correct
      // message - the code was right, the assertion was too narrow.
      check('and names the upgrade that raises it',
        /NIN|BVN|photo ID|proof of address|verif/i.test(over.message), over.message);
    }

    // ============================================================
    console.log('\n11. FORGED AND MALFORMED WEBHOOKS');
    // ============================================================
    {
      const noSecret = await fetch(`${baseUrl}/api/webhooks/breet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'trade.completed', id: providerRef, status: 'completed' }),
      });
      check('a webhook with no secret is refused', noSecret.status >= 400, String(noSecret.status));

      const wrong = await webhook({ event: 'trade.completed', id: providerRef, status: 'completed' }, 'wrong');
      check('a wrong secret is refused', wrong.status >= 400, String(wrong.status));

      // Length-mismatched secrets must not crash timingSafeEqual.
      const shortSecret = await webhook({ event: 'trade.completed', id: providerRef }, 'x');
      check('a length-mismatched secret does not 500',
        shortSecret.status >= 400 && shortSecret.status !== 500, String(shortSecret.status));

      // An event for a transfer we have no row for must return 2xx, or Breet
      // retries for 24h and then marks the delivery permanently failed.
      const unknown = await webhook({ event: 'trade.completed', id: 'breet_nonexistent_ref', status: 'completed' });
      check('an unknown transfer is accepted, not errored',
        unknown.status === 200 || unknown.status === 201, String(unknown.status));

      const empty = await webhook({});
      check('an empty payload does not crash the service',
        empty.status < 500, String(empty.status));
    }

    // ============================================================
    console.log('\n12. THE KILL SWITCH STOPS EVERYTHING');
    // ============================================================
    {
      const quoteBefore = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=5&network=solana`);

      token = '';
      await call('PUT', '/api/admin/system/status', { mode: 'paused', message: 'incident' }, admin);
      token = user.token;

      const blocked = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quoteBefore.body.id });
      check('paused blocks new orders', blocked.status >= 400, String(blocked.status));
      // The operator's own pause message is echoed to the user verbatim, which
      // is right - "incident" is what THEY chose to say. My isActionable()
      // helper rejected it for being short, which was the helper being wrong
      // about a message it does not own.
      check('and the operator message reaches the user',
        blocked.message === 'incident', blocked.message);

      // With no custom message, the default must still be useful on its own.
      token = '';
      await call('PUT', '/api/admin/system/status', { mode: 'paused', message: '' }, admin);
      token = user.token;
      const defaulted = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quoteBefore.body.id });
      check('and the default pause message explains the situation',
        isActionable(defaulted.message) && /paused|unavailable/i.test(defaulted.message), defaulted.message);

      // In-flight money must still be able to settle while paused.
      const stillWorks = await webhook({ event: 'trade.completed', id: providerRef, status: 'completed' });
      check('webhooks still land while paused - in-flight money must settle',
        stillWorks.status === 200 || stillWorks.status === 201, String(stillWorks.status));

      token = '';
      await call('PUT', '/api/admin/system/status', { mode: 'active', message: '' }, admin);
      token = user.token;
    }

    await app.close();
  } catch (error) {
    await app.close();
    throw error;
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`\n  - ${failures.join('\n  - ')}`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
