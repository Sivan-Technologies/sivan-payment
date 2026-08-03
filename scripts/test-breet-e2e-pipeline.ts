/**
 * The NGN off-ramp, end to end, minus the chain hop.
 *
 * WHAT THIS COVERS AND WHAT IT DOES NOT
 *
 * Covered: verification gate -> quote -> accept -> deposit address issued ->
 * transfer row created -> Breet webhook received, authenticated, applied ->
 * status advances -> ledger/timeline reflect it. Every line of Sivan's code.
 *
 * NOT covered: that Breet actually converts USDC to naira and pays a bank.
 * Only a mainnet transfer with a live key proves that. Breet has no testnet -
 * their `development` environment is a stub that resolves every account
 * number to "Samuel Udochukwu" - so the chain hop cannot be rehearsed. This
 * test deliberately stops at the boundary rather than pretending otherwise.
 *
 * Run: npm run test:breet-e2e
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const WEBHOOK_SECRET = process.env.BREET_WEBHOOK_SECRET || 'breet-e2e-webhook-secret';

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let token = '';
  const adminHeaders = { 'x-admin-api-key': env.ADMIN_API_KEY || 'breet-e2e-admin-key' };

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
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: (json as any).data ?? json };
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

  /** Deliver a webhook exactly as Breet would: shared secret in a header. */
  async function deliverWebhook(payload: unknown, secret = WEBHOOK_SECRET) {
    const res = await fetch(`${baseUrl}/api/webhooks/breet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  try {
    // Open the rails. They ship closed, which is correct.
    await call('PUT', '/api/admin/ngn/controls', {
      onrampEnabled: true, offrampEnabled: true, bankSettlementEnabled: true,
    }, adminHeaders);

    const user = await signup('Sharafa Ogunmepon');
    token = user.token;
    const userId = user.user.id;
    await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });

    console.log('\n1. AN UNVERIFIED USER CANNOT QUOTE');
    {
      // The gate must bind before anything else, or the rest is theatre.
      const res = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=25`);
      check('a Level 0 user is refused a quote', res.status >= 400, String(res.status));
    }

    console.log('\n2. LEVEL 1 VIA THE BANK NAME CHECK');
    {
      const saved = await call('POST', '/api/ngn/payout-accounts', {
        userId, bankId: '2', accountNumber: '1111111111',
      });
      check('the payout account is created', saved.status === 201, JSON.stringify(saved.body).slice(0, 120));
      check('the name matched', saved.body.matchVerdict === 'match', saved.body.matchVerdict);
      // Mock/sandbox resolutions are never trustworthy, so this queues rather
      // than verifying - exactly as Breet's real sandbox would.
      check('but a sandbox resolution only queues it',
        saved.body.status === 'pending_review', saved.body.status);

      const queue = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined, adminHeaders);
      check('it appears in the admin review queue',
        (queue.body as any[]).some((item) => item.id === saved.body.id));

      const approved = await call('PUT', `/api/admin/ngn/payout-accounts/${saved.body.id}/review`,
        { decision: 'approve', note: 'e2e' }, adminHeaders);
      check('a reviewer can approve it', approved.body.status === 'verified', approved.body.status);

      const summary = await call('GET', `/api/users/${userId}/verification-summary`);
      check('the user reaches Level 1', summary.body.level === 1, String(summary.body.level));
      check('and has a payout account', summary.body.hasPayoutAccount === true);
      const allowance = (summary.body.allowances as any[]).find((a) => a.flow === 'offramp' && a.rail === 'ngn');
      check('with a real NGN ceiling from the limit table',
        allowance.limitNgn > 0, String(allowance.limitNgn));
    }

    let quoteId = '';
    console.log('\n3. QUOTE');
    {
      const res = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=25&network=solana`);
      check('a verified user gets a quote', res.status === 200, JSON.stringify(res.body).slice(0, 160));
      quoteId = res.body?.id;
      check('the quote has an id', Boolean(quoteId), String(quoteId));
      check('it prices naira out', Number(res.body?.destinationAmount) > 0, String(res.body?.destinationAmount));
      check('at a real rate', Number(res.body?.rate) > 0, String(res.body?.rate));
      check('and carries a fee', res.body?.feeAmount !== undefined, String(res.body?.feeAmount));
    }

    let transferId = '';
    let providerRef = '';
    console.log('\n4. ACCEPT -> DEPOSIT ADDRESS + TRANSFER ROW');
    {
      const res = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId });
      check('the quote is accepted', res.status === 200 || res.status === 201, JSON.stringify(res.body).slice(0, 200));
      transferId = res.body?.id;
      providerRef = res.body?.providerTransferId;
      check('a transfer row exists', Boolean(transferId), String(transferId));
      check('it starts awaiting the crypto deposit',
        res.body?.status === 'awaiting_crypto_deposit', res.body?.status);
      check('a deposit address was issued', Boolean(res.body?.depositAddress), String(res.body?.depositAddress));

      const timeline = await call('GET', `/api/users/${userId}/ngn-transfers`);
      check('the transfer is listed for the user',
        (timeline.body as any[]).some((t) => t.id === transferId));
    }

    console.log('\n5. THE WEBHOOK IS AUTHENTICATED');
    {
      const noSecret = await fetch(`${baseUrl}/api/webhooks/breet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'trade.completed', id: providerRef }),
      });
      check('a webhook with no secret is refused', noSecret.status >= 400, String(noSecret.status));

      const wrong = await deliverWebhook({ event: 'trade.completed', id: providerRef }, 'not-the-secret');
      check('a webhook with the wrong secret is refused', wrong.status >= 400, String(wrong.status));

      // Length-differing secrets must not crash timingSafeEqual.
      const short = await deliverWebhook({ event: 'trade.completed', id: providerRef }, 'x');
      check('a short wrong secret is refused, not a 500', short.status >= 400 && short.status !== 500, String(short.status));
    }

    console.log('\n6. A COMPLETED DEPOSIT SETTLES THE TRANSFER');
    {
      const res = await deliverWebhook({
        event: 'trade.completed',
        id: providerRef,
        status: 'completed',
        amount: '25',
        amountInUSD: 25,
        cryptoAmount: '25',
        fiatAmount: '40125',
        currency: 'ngn',
      });
      check('the webhook is accepted', res.status === 200 || res.status === 201, String(res.status));

      const stored = await db.listNgnWebhooks();
      check('the event is recorded', stored.some((w) => w.eventType === 'trade.completed'));

      // THE POINT OF THE WHOLE FLOW. A webhook that is stored but changes
      // nothing leaves the user staring at "awaiting deposit" after their
      // money has already been converted and paid out.
      const transfers = await db.listNgnTransfers();
      const transfer = transfers.find((t) => t.id === transferId);
      check('the transfer advances past awaiting_crypto_deposit',
        transfer?.status !== 'awaiting_crypto_deposit', String(transfer?.status));
      /**
       * SETTLEMENT_PROCESSING, AND DELIBERATELY NOT 'completed'.
       *
       * This used to accept 'completed' among several statuses, which meant it
       * would have passed whether or not the trade/withdrawal distinction was
       * respected - a permissive assertion that could not fail. A completed
       * TRADE means Breet converted the crypto into its own naira wallet; only
       * `withdrawal.completed` means the money reached the user's bank.
       * Asserted exactly, so conflating them fails here.
       */
      check('a completed trade reaches settlement_processing',
        transfer?.status === 'settlement_processing', String(transfer?.status));

      const listed = await call('GET', `/api/users/${userId}/ngn-transfers`);
      const mine = (listed.body as any[]).find((t) => t.id === transferId);
      check('the user sees the new status', mine?.status !== 'awaiting_crypto_deposit', String(mine?.status));
    }

    console.log('\n7. A FLAGGED DEPOSIT IS HELD FOR REVIEW, NOT FAILED');
    {
      // Below Breet's minimum: confirmed on chain, funds HELD, nothing
      // credited. Silence here is the worst outcome - the user would send
      // again, thinking the first deposit never arrived.
      // A SMALL amount on purpose. The first transfer already consumed most of
      // this user's NGN 50,000 Level 1 allowance, and the cumulative ceiling
      // correctly refused a second NGN 30 quote - proving the limit binds
      // across transfers, which is the whole point of a cumulative threshold.
      const second = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=5&network=solana`);
      check('a small second quote fits under the remaining headroom',
        second.status === 200, `${second.status} ${JSON.stringify(second.body).slice(0, 160)}`);
      const accepted = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: second.body.id });
      check('the second quote is accepted', accepted.status === 200 || accepted.status === 201,
        `${accepted.status} ${JSON.stringify(accepted.body).slice(0, 200)}`);
      check('and produced a transfer row', Boolean(accepted.body?.id),
        JSON.stringify(second.body).slice(0, 200));
      const ref2 = accepted.body?.providerTransferId;

      const res = await deliverWebhook({
        event: 'trade.flagged', id: ref2, status: 'flagged',
        amountInUSD: 3, minimum: 15,
      });
      check('the flagged webhook is accepted', res.status === 200 || res.status === 201, String(res.status));

      const transfer = (await db.listNgnTransfers()).find((t) => t.id === accepted.body.id);
      check('the transfer moves to requires_review',
        transfer?.status === 'requires_review', String(transfer?.status));
      const meta = (transfer?.metadata ?? {}) as any;
      check('it is marked flagged', meta.flagged === true);
      check('the amount and minimum are kept for support',
        meta.flaggedAmountUsd === 3 && meta.flaggedMinimumUsd === 15,
        `${meta.flaggedAmountUsd}/${meta.flaggedMinimumUsd}`);
      check('and the user gets a sentence that explains it',
        /below|minimum/i.test(String(meta.flaggedReason)), String(meta.flaggedReason));
    }

    console.log('\n8. RETRIES AND UNKNOWN EVENTS DO NOT CORRUPT ANYTHING');
    {
      // Breet retries for up to 24 hours, so duplicates are routine.
      const before = (await db.listNgnTransfers()).find((t) => t.id === transferId)?.status;
      await deliverWebhook({ event: 'trade.completed', id: providerRef, status: 'completed', amountInUSD: 25 });
      const after = (await db.listNgnTransfers()).find((t) => t.id === transferId)?.status;
      check('a duplicate delivery is idempotent', before === after, `${before} -> ${after}`);

      // A LATE RETRY MUST NOT REWIND A FINISHED TRANSFER. Breet retries for 24
      // hours, so a stale 'processing' arriving after 'completed' is routine -
      // and showing a user their finished payout had reverted to in-progress
      // would generate a support ticket for a transfer that already settled.
      // Finish the payout properly first, with the withdrawal event that
      // actually pays the bank - otherwise "cannot rewind a COMPLETED
      // transfer" is tested against a transfer that was never completed.
      await deliverWebhook({ event: 'withdrawal.completed', id: `wd_${providerRef}`,
        status: 'completed', trade: providerRef, amount: 40125 });
      const settled = (await db.listNgnTransfers()).find((t) => t.id === transferId);
      check('the transfer is terminal before the stale retry',
        settled?.status === 'completed', String(settled?.status));
      await deliverWebhook({ event: 'trade.processing', id: providerRef, status: 'processing' });
      const afterStale = (await db.listNgnTransfers()).find((t) => t.id === transferId);
      check('a stale processing retry cannot rewind a completed transfer',
        afterStale?.status === 'completed', String(afterStale?.status));

      // AN UNRECOGNISED STATUS MUST CHANGE NOTHING. Guessing is how a transfer
      // ends up marked completed because the provider added a word we had not
      // seen - and completed means "the user has their naira".
      const third = await call('GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=2&network=solana`);
      const third1 = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: third.body.id });
      check('a third transfer exists to probe with', Boolean(third1.body?.id));
      await deliverWebhook({
        event: 'trade.updated', id: third1.body.providerTransferId, status: 'some_status_we_have_never_seen',
      });
      const probed = (await db.listNgnTransfers()).find((t) => t.id === third1.body.id);
      check('an unknown provider status leaves the transfer untouched',
        probed?.status === 'awaiting_crypto_deposit', String(probed?.status));

      // A webhook for a transfer we have no row for must return 2xx. A non-2xx
      // makes Breet retry for a day and then mark the event permanently
      // failed, burning a real delivery.
      const unknown = await deliverWebhook({ event: 'trade.completed', id: 'breet_unknown_ref_999', status: 'completed' });
      check('an unknown transfer is accepted, not errored',
        unknown.status === 200 || unknown.status === 201, String(unknown.status));
    }

    await app.close();
  } catch (error) {
    await app.close();
    throw error;
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
