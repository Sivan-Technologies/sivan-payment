/**
 * autoSettlement MUST BE ENABLED ON AN OFF-RAMP DEPOSIT ADDRESS.
 *
 * breet.provider.ts only sets it when it can read a bank from the quote:
 *
 *   if (bankId && accountNumber) { body.autoSettlement = true; }
 *
 * Nothing ever wrote those into quote.metadata and both env fallbacks are
 * empty, so autoSettlement was never enabled on any off-ramp ever created.
 *
 * There is no error when this is wrong. The user sends crypto, Breet converts
 * it, and the naira sits in OUR balance instead of reaching their bank - while
 * the order shows awaiting_crypto_deposit forever. That silence is exactly why
 * this needs a test rather than a look.
 *
 * Run: npm run test:offramp-autosettlement
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

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  let token = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({})) as any;
    return { status: res.status, body: json.data ?? json };
  }

  try {
    const email = `autoset-${Date.now()}@sivan.test`;
    const start = await call('POST', '/api/auth/email/start', {
      email, fullName: 'Samuel Udochukwu', intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' }
    });
    const verified = await call('POST', '/api/auth/email/verify', { email, code: start.body.devCode });
    token = verified.body.token;
    const userId = verified.body.user.id;
    await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });

    // The rails default to disabled; enable them as an operator would.
    await fetch(`${base}/api/admin/ngn/controls`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-api-key': process.env.ADMIN_API_KEY ?? '' },
      body: JSON.stringify({ onrampEnabled: true, offrampEnabled: true, activeProvider: 'mock', updatedBy: 'autoset-test' })
    });

    const now = new Date().toISOString();

    console.log('\nNO VERIFIED ACCOUNT MEANS NO AUTO-SETTLEMENT');
    {
      // A pending_review NUBAN has not cleared the name match. Paying out to
      // it would settle to an account a human is still being asked to check.
      await db.upsertNgnPayoutAccountRecord({
        // A DIFFERENT NUBAN to the verified one. upsertNgnPayoutAccountRecord
        // dedupes on (userId, provider, bankId, accountNumber), so sharing a
        // number silently merged the two fixtures into one record and the
        // ordering assertion below tested nothing.
        id: 'ngnacct_pending', userId, provider: 'mock', bankId: '26', bankName: 'PalmPay',
        accountNumber: '9999999999', accountName: 'Someone Unchecked', declaredName: 'Samuel Udochukwu',
        matchVerdict: 'partial', matchScore: 0.6, resolutionTrustworthy: false,
        status: 'pending_review', createdAt: now, updatedAt: now
      } as any);

      const quote = await call('GET', `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=60&network=solana`);
      // A pending_review NUBAN leaves the user at Level 0, whose NGN off-ramp
      // ceiling is 0, so the quote is refused before metadata is ever built.
      //
      // ASSERTED EXPLICITLY, because the obvious check - "metadata has no
      // bankId" - passes vacuously against an error body. Mutation-testing
      // caught that: removing the `status === 'verified'` filter left the
      // suite green, so the guard was untested. The real guarantee here is
      // that the KYC gate refuses first.
      check('a pending-review account cannot even get a quote',
        quote.status === 403, `${quote.status} ${JSON.stringify(quote.body).slice(0, 120)}`);
    }

    console.log('\nA VERIFIED ACCOUNT IS ATTACHED');
    {
      await db.upsertNgnPayoutAccountRecord({
        id: 'ngnacct_verified', userId, provider: 'mock', bankId: '26', bankName: 'PalmPay',
        accountNumber: '1111111111', accountName: 'Samuel Udochukwu', declaredName: 'Samuel Udochukwu',
        matchVerdict: 'match', matchScore: 1, resolutionTrustworthy: true,
        status: 'verified', createdAt: now, updatedAt: now
      } as any);

      const quote = await call('GET', `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=60&network=solana`);
      check('the quote is created', quote.status === 200, `${quote.status} ${JSON.stringify(quote.body).slice(0, 140)}`);
      const meta = quote.body?.metadata ?? {};
      check('the bank id reaches the quote metadata', meta.bankId === '26', String(meta.bankId));
      check('the account number reaches the quote metadata',
        meta.accountNumber === '1111111111', String(meta.accountNumber));
      check('and the bank name is carried for support', meta.bankName === 'PalmPay', String(meta.bankName));
      // accountName is deliberately NOT carried by the implementation on main -
      // the bank id and number are what Breet needs, and the name is already on
      // the payout account record for support to look up.

      console.log('\nAND THE ORDER STILL COMPLETES');
      const order = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: quote.body.id });
      check('the order is accepted', order.status === 200, `${order.status} ${JSON.stringify(order.body).slice(0, 140)}`);
      check('a deposit address was issued', Boolean(order.body?.depositAddress), String(order.body?.depositAddress));

      // autoSettlement itself is set by the BREET adapter, from exactly the
      // two metadata fields asserted above:
      //
      //   if (bankId && accountNumber) { body.autoSettlement = true; }
      //
      // The mock provider never sets the flag at all, so asserting it here
      // would be asserting on the fixture rather than the behaviour. The
      // fields reaching the metadata IS the thing this suite can honestly
      // prove; the flag is verified against real Breet in
      // e2e/offramp-journey.mjs, which runs against the deployed API.
    }

    console.log('\nTHE VERIFIED ACCOUNT IS CHOSEN, NOT MERELY THE FIRST');
    {
      // Both a pending_review and a verified account now exist for this user,
      // and the pending one was inserted FIRST. A plain .find() with no status
      // filter would return it and settle to an account a human was still
      // being asked to check. This is the assertion that actually guards the
      // filter - mutation-tested: relaxing it to () => true fails here.
      const accounts = await db.listNgnPayoutAccounts(userId);
      check('the pending account is still first in insertion order',
        accounts[0]?.status === 'pending_review', String(accounts[0]?.status));

      // Deliberately small. The order placed earlier in this suite already
      // consumed most of the Level 1 30-day allowance, so a second 60 USDC
      // quote is refused for the limit before any payout account is attached -
      // leaving metadata empty and failing this check for a reason that has
      // nothing to do with account selection. The amount is irrelevant to what
      // is being proven here: only that the quote succeeds and carries the
      // VERIFIED account rather than the pending one inserted first.
      const quote = await call('GET', `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=5&network=solana`);
      check('the quote is created', quote.status === 200, `${quote.status} ${JSON.stringify(quote.body).slice(0, 140)}`);
      const meta = quote.body?.metadata ?? {};
      check('but the VERIFIED account number is the one attached',
        meta.accountNumber === '1111111111',
        JSON.stringify({ attached: meta.accountNumber, unchecked: '9999999999' }));
      check('and the unchecked account is NOT used',
        meta.accountNumber !== '9999999999',
        JSON.stringify({ attached: meta.accountNumber }));
    }

    console.log('\nON-RAMP IS UNAFFECTED');
    {
      // An on-ramp pays crypto TO the user; a payout bank is meaningless and
      // attaching one would be misleading in the record.
      const quote = await call('GET', `/api/ngn/quote?userId=${userId}&direction=onramp&sourceCurrency=ngn&destinationCurrency=usdc&sourceAmount=80000&network=solana`);
      const meta = quote.body?.metadata ?? {};
      check('an on-ramp quote carries no payout bank',
        !meta.bankId && !meta.accountNumber, JSON.stringify({ bankId: meta.bankId, accountNumber: meta.accountNumber }));
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
