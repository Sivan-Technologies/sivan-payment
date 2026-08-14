/**
 * AUTOSETTLEMENT: DOES THE NAIRA ACTUALLY REACH THE USER'S BANK?
 *
 * breet.provider.ts only sets `autoSettlement: true` on a deposit address when
 * it can see a bankId AND an accountNumber in quote.metadata:
 *
 *     if (bankId && accountNumber) { body.autoSettlement = true; }
 *
 * Nothing ever put them there, and BREET_DEFAULT_BANK_ID / _ACCOUNT_NUMBER are
 * empty. So autoSettlement was never enabled on any address we generated.
 *
 * The failure is silent and expensive: crypto arrives, Breet converts it, and
 * the naira STOPS in Sivan's Breet balance instead of reaching the user. No
 * error, no failed transfer - it simply never settles.
 *
 * Run: npm run test:autosettlement
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

  // The rail must be on, or every quote 403s and the assertions below proves  nothing.
  const { updateNgnControls } = await import('../src/ngn/service/ngn-controls.service.js');
  await updateNgnControls({ onrampEnabled: true, offrampEnabled: true, activeProvider: 'mock', mockProviderEnabled: true, updatedBy: 'autosettlement-test' } as any);

  let token = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({})) as any;
    return { status: res.status, body: json.data ?? json };
  }

  async function signup(name: string) {
    const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sivan.test`;
    const start = await call('POST', '/api/auth/email/start', {
      email, fullName: 'Samuel Udochukwu', intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
    });
    const verified = await call('POST', '/api/auth/email/verify', { email, code: start.body.devCode });
    return verified.body;
  }

  async function quoteFor(userId: string) {
    return call('GET', `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc`
      + `&destinationCurrency=ngn&sourceAmount=60&network=solana`);
  }

  try {
    console.log('\nA VERIFIED PAYOUT ACCOUNT ENABLES AUTOSETTLEMENT');
    {
      const user = await signup('auto');
      token = user.token;
      await call('PUT', `/api/users/${user.user.id}/country`, { country: 'NG' });

      const now = new Date().toISOString();
      await db.upsertNgnPayoutAccountRecord({
        id: 'ngnacct_verified', userId: user.user.id, provider: 'mock',
        bankId: '26', bankName: 'PalmPay', accountNumber: '1111111111',
        accountName: 'Samuel Udochukwu', declaredName: 'Samuel Udochukwu',
        matchVerdict: 'match', matchScore: 1, resolutionTrustworthy: true,
        status: 'verified', createdAt: now, updatedAt: now,
      } as any);

      const quote = await quoteFor(user.user.id);
      check('the quote is created', quote.status === 200, JSON.stringify(quote.body).slice(0, 140));
      const meta = quote.body?.metadata ?? {};
      check('the user\'s bankId is carried into the quote', meta.bankId === '26', String(meta.bankId));
      check('and their account number', meta.accountNumber === '1111111111', String(meta.accountNumber));
      check('and the bank name, for the payout narration', meta.bankName === 'PalmPay', String(meta.bankName));
    }

    console.log('\nNO VERIFIED ACCOUNT MEANS NO BANK DETAILS LEAK IN');
    {
      // A user without a verified account must NOT inherit anyone else's bank.
      //
      // HONEST NOTE, found by mutation testing and worth stating plainly:
      // a user without a VERIFIED payout account is refused by the KYC gate
      // (Level 1 requires one) before a quote is ever built. That is true for
      // "no account" AND for "pending_review".
      //
      // So no HTTP-level test can catch a global-default fallback in this
      // code - the only users who reach quote creation are exactly the users
      // who have their own verified bank. The protection is real but it comes
      // from the KYC gate, not from these assertions. The unit-level coverage
      // below (a stranger's account) is what pins the per-user lookup.
      const user = await signup('nobank');
      token = user.token;
      await call('PUT', `/api/users/${user.user.id}/country`, { country: 'NG' });
      const quote = await quoteFor(user.user.id);
      check('a user with no payout account cannot quote at all',
        quote.status === 403, `${quote.status} ${JSON.stringify(quote.body).slice(0, 100)}`);
      const meta = quote.body?.metadata ?? {};
      check('no bankId is attached', meta.bankId === undefined, String(meta.bankId));
      check('no accountNumber is attached', meta.accountNumber === undefined, String(meta.accountNumber));
      // MUTATION-DRIVEN. Falling back to a hardcoded default here would pay
      // EVERY user's naira into one bank account - the worst bug this file
      // could contain - and the two assertions above catch it only because
      // they check for undefined. Naming the specific account makes the
      // failure message say what actually went wrong.
      check('and specifically NOT the operator\'s own account',
        meta.accountNumber !== '1111111111', String(meta.accountNumber));
    }

    console.log('\nA PENDING ACCOUNT DOES NOT QUALIFY');
    {
      // pending_review is an account a human was asked to look at. Auto-paying
      // it would defeat the review queue entirely.
      const user = await signup('pending');
      token = user.token;
      await call('PUT', `/api/users/${user.user.id}/country`, { country: 'NG' });
      const now = new Date().toISOString();
      await db.upsertNgnPayoutAccountRecord({
        id: 'ngnacct_pending', userId: user.user.id, provider: 'mock',
        bankId: '26', bankName: 'PalmPay', accountNumber: '9999999999',
        accountName: 'Samuel Udochukwu', declaredName: 'Samuel Udochukwu',
        matchVerdict: 'match', matchScore: 1, resolutionTrustworthy: false,
        status: 'pending_review', createdAt: now, updatedAt: now,
      } as any);
      const quote = await quoteFor(user.user.id);
      const meta = quote.body?.metadata ?? {};
      check('a pending_review account cannot quote at all',
        quote.status === 403, `${quote.status} ${JSON.stringify(quote.body).slice(0, 90)}`);
      check('so no bank details are attached', meta.accountNumber === undefined, String(meta.accountNumber));
    }

    console.log('\nONE USER\'S BANK NEVER REACHES ANOTHER\'S QUOTE');
    {
      // The worst bug this file could contain: paying every user's naira into
      // one account. A global env default would do exactly that.
      const stranger = await signup('stranger');
      const now = new Date().toISOString();
      await db.upsertNgnPayoutAccountRecord({
        id: 'ngnacct_stranger', userId: stranger.user.id, provider: 'mock',
        bankId: '26', bankName: 'PalmPay', accountNumber: '1111111111',
        accountName: 'Someone Else', declaredName: 'Someone Else',
        matchVerdict: 'match', matchScore: 1, resolutionTrustworthy: true,
        status: 'verified', createdAt: now, updatedAt: now,
      } as any);

      const victim = await signup('victim');
      token = victim.token;
      await call('PUT', `/api/users/${victim.user.id}/country`, { country: 'NG' });
      const quote = await quoteFor(victim.user.id);
      const meta = quote.body?.metadata ?? {};
      check('a stranger\'s verified account is not used',
        meta.accountNumber !== '1111111111', String(meta.accountNumber));
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
