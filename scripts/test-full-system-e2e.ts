/**
 * The whole product, both verification paths, over real HTTP.
 *
 * This is the pre-launch rehearsal. It boots the app and drives it exactly as
 * the frontend does - no service calls, no direct database writes except where
 * a provider result has to be forced (marked clearly).
 *
 *   PATH A  Nigeria  -> bank name resolution -> review -> Level 1 -> NGN
 *                       off-ramp -> Breet webhook -> settled
 *   PATH B  US       -> Bridge KYC handoff -> approval -> Level 2 -> foreign
 *                       rails open, virtual accounts unlock
 *
 * The point is the SEAM between them: country decides the path, the two must
 * not leak into each other, and a user on one must not be gated by the
 * other's evidence.
 *
 * Run: npm run test:full-system
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const WEBHOOK_SECRET = process.env.BREET_WEBHOOK_SECRET || 'full-e2e-webhook-secret';

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  let token = '';
  const admin = { 'x-admin-api-key': env.ADMIN_API_KEY || 'full-e2e-admin-key' };

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
    check(`signup OTP issued for ${fullName}`, Boolean(start.body?.devCode), JSON.stringify(start.body).slice(0, 120));
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

  const allowanceOf = (summary: any, flow: string, rail: string) =>
    (summary.allowances as any[]).find((a) => a.flow === flow && a.rail === rail);

  try {
    await call('PUT', '/api/admin/ngn/controls', {
      onrampEnabled: true, offrampEnabled: true, bankSettlementEnabled: true,
    }, admin);

    // ================================================================
    console.log('\n══ ONBOARDING ══');
    // ================================================================
    const ngUser = await signup('Sharafa Ogunmepon');
    token = ngUser.token;
    const ngId = ngUser.user.id;
    check('a session token is issued', Boolean(ngUser.token));
    check('the user record comes back', Boolean(ngId));
    check('signup does NOT collect a country', !ngUser.user.country, String(ngUser.user.country));

    {
      // Country is asked in the modal, so a fresh user has none - and an
      // unknown country must route to Bridge, never to a NUBAN check the
      // user's account could not pass.
      const plan = await call('GET', `/api/users/${ngId}/verification-plan`);
      check('no country routes to Bridge as a fallback', plan.body.path === 'bridge_kyc', plan.body.path);
      check('and it is flagged as a fallback', plan.body.isFallback === true);

      const summary = await call('GET', `/api/users/${ngId}/verification-summary`);
      check('a new user is Level 0', summary.body.level === 0, String(summary.body.level));
      check('with every NGN rail closed',
        allowanceOf(summary.body, 'offramp', 'ngn').limitNgn === 0);
    }

    // ================================================================
    console.log('\n══ PATH A · NIGERIA ══');
    // ================================================================
    {
      const set = await call('PUT', `/api/users/${ngId}/country`, { country: 'NG' });
      check('country saves', set.status === 200 && set.body.country === 'NG', String(set.body.country));

      const plan = await call('GET', `/api/users/${ngId}/verification-plan`);
      check('Nigeria routes to the bank check', plan.body.path === 'ngn_bank', plan.body.path);
      check('and it costs Sivan nothing', plan.body.costsProviderFee === false);

      const banks = await call('GET', `/api/ngn/banks?userId=${ngId}`);
      check('the bank directory loads', Array.isArray(banks.body) && banks.body.length > 0,
        String((banks.body as any[])?.length));

      const resolved = await call('GET',
        `/api/ngn/bank-account/resolve?userId=${ngId}&bankId=2&accountNumber=1111111111`);
      check('an account resolves to a holder name', Boolean(resolved.body?.accountName), JSON.stringify(resolved.body).slice(0, 120));
      check('a sandbox resolution is flagged untrustworthy', resolved.body?.trustworthy === false);

      const saved = await call('POST', '/api/ngn/payout-accounts', {
        userId: ngId, bankId: '2', accountNumber: '1111111111',
      });
      check('the payout account saves', saved.status === 201);
      check('the name matcher ran', saved.body.matchVerdict === 'match', saved.body.matchVerdict);
      check('an untrustworthy resolution only queues it', saved.body.status === 'pending_review', saved.body.status);

      // Level 1 must NOT be granted by a queued account.
      const mid = await call('GET', `/api/users/${ngId}/verification-summary`);
      check('a queued account grants nothing', mid.body.level === 0, String(mid.body.level));

      // The name is frozen while a reviewer is mid-decision.
      const frozen = await call('PUT', `/api/users/${ngId}/name`, { fullName: 'Someone Else' });
      check('the name is locked during review', frozen.status === 400, String(frozen.status));

      token = '';
      const queue = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined, admin);
      check('the case is in the admin queue', (queue.body as any[]).some((i) => i.id === saved.body.id));
      const approved = await call('PUT', `/api/admin/ngn/payout-accounts/${saved.body.id}/review`,
        { decision: 'approve', note: 'full e2e' }, admin);
      check('a reviewer approves it', approved.body.status === 'verified', approved.body.status);
      token = ngUser.token;

      const summary = await call('GET', `/api/users/${ngId}/verification-summary`);
      check('the user reaches Level 1', summary.body.level === 1, String(summary.body.level));
      check('the NGN ceiling is the raised 100,000',
        allowanceOf(summary.body, 'offramp', 'ngn').limitNgn === 100_000,
        String(allowanceOf(summary.body, 'offramp', 'ngn').limitNgn));

      // THE SEAM. Level 1 is a Nigerian bank check; it says nothing about
      // USD rails, and Bridge issues those.
      check('foreign rails stay CLOSED at Level 1',
        allowanceOf(summary.body, 'offramp', 'foreign').limitNgn === 0,
        String(allowanceOf(summary.body, 'offramp', 'foreign').limitNgn));

      const locked = await call('PUT', `/api/users/${ngId}/name`, { fullName: 'Stranger Name' });
      check('the name is permanently locked once verified', locked.status === 400, String(locked.status));
    }

    let ngTransferId = '';
    let ngProviderRef = '';
    console.log('\n══ PATH A · OFF-RAMP TO NAIRA ══');
    {
      const quote = await call('GET',
        `/api/ngn/quote?userId=${ngId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=25&network=solana`);
      check('a quote is priced', quote.status === 200, JSON.stringify(quote.body).slice(0, 140));
      check('naira is quoted out', Number(quote.body?.destinationAmount) > 0);

      const order = await call('POST', '/api/ngn/offramp/orders', { userId: ngId, quoteId: quote.body.id });
      ngTransferId = order.body?.id;
      ngProviderRef = order.body?.providerTransferId;
      check('the order is accepted', Boolean(ngTransferId), JSON.stringify(order.body).slice(0, 140));
      check('a deposit address is issued', Boolean(order.body?.depositAddress));
      check('and it awaits the crypto deposit', order.body?.status === 'awaiting_crypto_deposit', order.body?.status);

      // ---- the chain hop happens here in production. Breet has no testnet,
      // so it cannot be rehearsed; the webhook stands in for it. ----
      const bad = await webhook({ event: 'trade.completed', id: ngProviderRef }, 'wrong-secret');
      check('a forged webhook is refused', bad.status >= 400, String(bad.status));

      const good = await webhook({
        event: 'trade.completed', id: ngProviderRef, status: 'completed',
        amountInUSD: 25, cryptoAmount: '25', fiatAmount: '40125',
      });
      check('a genuine webhook is accepted', good.status === 200 || good.status === 201, String(good.status));

      const settled = (await db.listNgnTransfers()).find((t) => t.id === ngTransferId);
      check('the transfer settles', settled?.status === 'completed', String(settled?.status));
      check("Breet's own figures are retained for reconciliation",
        (settled?.metadata as any)?.settledFiatAmount === '40125',
        String((settled?.metadata as any)?.settledFiatAmount));

      const listed = await call('GET', `/api/users/${ngId}/ngn-transfers`);
      check('the user sees it as completed',
        (listed.body as any[]).find((t) => t.id === ngTransferId)?.status === 'completed');

      // Cumulative: the used volume must now show against the ceiling.
      const after = await call('GET', `/api/users/${ngId}/verification-summary`);
      const a = allowanceOf(after.body, 'offramp', 'ngn');
      check('used volume is counted', a.usedNgn > 0, String(a.usedNgn));
      check('and headroom has shrunk', a.remainingNgn < 100_000, String(a.remainingNgn));
    }

    // ================================================================
    console.log('\n══ PATH B · UNITED STATES (BRIDGE) ══');
    // ================================================================
    const usUser = await signup('Grace Hopper');
    token = usUser.token;
    const usId = usUser.user.id;
    {
      await call('PUT', `/api/users/${usId}/country`, { country: 'US' });
      const plan = await call('GET', `/api/users/${usId}/verification-plan`);
      check('the US routes to Bridge', plan.body.path === 'bridge_kyc', plan.body.path);
      check('Bridge costs a provider fee', plan.body.costsProviderFee === true);
      check('and it promises virtual accounts',
        plan.body.unlocks.some((u: string) => /virtual account/i.test(u)), JSON.stringify(plan.body.unlocks));

      // THE OTHER HALF OF THE SEAM. A NUBAN cannot verify a US user - the
      // resolver only understands Nigerian account numbers.
      const summary0 = await call('GET', `/api/users/${usId}/verification-summary`);
      check('a US user starts at Level 0', summary0.body.level === 0);
      check('their path is not complete', summary0.body.pathComplete === false);

      // This is the call the modal's "Start verification" button makes.
      const kyc = await call('POST', '/api/customers/kyc-link', {
        userId: usId, type: 'individual', redirectUri: 'https://example.test/verification-complete',
      });
      check('the Bridge KYC flow opens', kyc.status === 201 || kyc.status === 200,
        `${kyc.status} ${JSON.stringify(kyc.body).slice(0, 160)}`);
      check('a hosted verification link is returned',
        Boolean(kyc.body?.hostedKycLink || kyc.body?.kycLink),
        JSON.stringify(kyc.body).slice(0, 200));
      check('a customer record is created', Boolean(kyc.body?.id));
      // NOT asserted as unapproved: BRIDGE_MOCK_MODE auto-approves so the
      // suite can run without hitting Bridge. In production this comes back
      // kyc_not_started and only a completed hosted flow approves it.
      check('a KYC status is set', Boolean(kyc.body?.kycStatus), String(kyc.body?.kycStatus));

      // Virtual accounts must be refused before approval - Bridge issues them.
      const vaEarly = await call('POST', `/api/users/${usId}/virtual-accounts`, { currency: 'usd' });
      check('a virtual account is refused before KYC approval', vaEarly.status >= 400, String(vaEarly.status));
    }

    console.log('\n══ PATH B · AFTER BRIDGE APPROVAL ══');
    {
      // FORCED: Bridge's hosted flow cannot be completed headlessly. This is
      // the one place the test writes provider state directly, standing in for
      // the user finishing document + selfie on Bridge's domain.
      const data = await db.read();
      const customer = (data.customers ?? []).find((c: any) => c.userId === usId);
      check('the customer row exists to approve', Boolean(customer));
      if (customer) {
        await db.updateCustomerRecord({
          ...customer, kycStatus: 'kyc_approved', tosStatus: 'approved',
          updatedAt: new Date().toISOString(),
        } as any);
      }
      const now = new Date().toISOString();
      await db.insertExternalAccountRecord({
        id: 'ext_full_e2e', userId: usId, customerId: customer?.id ?? 'cus_x', provider: 'bridge',
        providerExternalAccountId: 'pe_x', currency: 'usd', accountType: 'us',
        accountOwnerName: 'Grace Hopper', paymentRail: 'ach', status: 'verified',
        createdAt: now, updatedAt: now,
      } as any);

      const summary = await call('GET', `/api/users/${usId}/verification-summary`);
      check('a Bridge-approved user reaches Level 2', summary.body.level === 2, String(summary.body.level));
      check('their path reads complete', summary.body.pathComplete === true);
      check('identity is attributed to Bridge, not invented',
        summary.body.identitySource === 'bridge', String(summary.body.identitySource));
      check('the uplift applies', summary.body.upliftApplies === true);
      check('foreign rails are OPEN for them',
        allowanceOf(summary.body, 'offramp', 'foreign').limitNgn > 0,
        String(allowanceOf(summary.body, 'offramp', 'foreign').limitNgn));
      check('and the ceiling is the uplifted one, not unlimited',
        allowanceOf(summary.body, 'offramp', 'ngn').limitNgn === 10_000_000,
        String(allowanceOf(summary.body, 'offramp', 'ngn').limitNgn));
      check('above it they are asked for source of funds',
        allowanceOf(summary.body, 'offramp', 'ngn').nextLevel === 3,
        String(allowanceOf(summary.body, 'offramp', 'ngn').nextLevel));
    }

    // ================================================================
    console.log('\n══ THE TWO PATHS DO NOT LEAK ══');
    // ================================================================
    {
      token = ngUser.token;
      const ng = await call('GET', `/api/users/${ngId}/verification-summary`);
      check('the Nigerian user never became a Bridge customer',
        ng.body.identitySource === undefined, String(ng.body.identitySource));
      check('and is still Level 1, not lifted by the other user',
        ng.body.level === 1, String(ng.body.level));

      // Cross-user isolation on every new surface.
      const crossSummary = await call('GET', `/api/users/${usId}/verification-summary`);
      check('one user cannot read another summary', crossSummary.status === 403, String(crossSummary.status));
      const crossName = await call('PUT', `/api/users/${usId}/name`, { fullName: 'Hijack' });
      check('one user cannot rename another', crossName.status === 403, String(crossName.status));
      const crossCountry = await call('PUT', `/api/users/${usId}/country`, { country: 'NG' });
      check('one user cannot re-route another', crossCountry.status === 403, String(crossCountry.status));
      const crossPayout = await call('POST', '/api/ngn/payout-accounts',
        { userId: usId, bankId: '2', accountNumber: '1111111111' });
      check('one user cannot add another payout account', crossPayout.status === 403, String(crossPayout.status));
    }

    // ================================================================
    console.log('\n══ SYSTEM CONTROLS ══');
    // ================================================================
    {
      token = '';
      const health = await call('GET', '/api/admin/wallets/health', undefined, admin);
      check('wallet health is reportable', health.status === 200, String(health.status));

      const status = await call('GET', '/api/admin/system/status', undefined, admin);
      check('system status is readable', status.status === 200, String(status.status));

      // A paused system must stop new money movement.
      token = ngUser.token;
      const liveQuote = await call('GET',
        `/api/ngn/quote?userId=${ngId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=5&network=solana`);
      check('a quote is available while active', liveQuote.status === 200, String(liveQuote.status));

      token = '';
      await call('PUT', '/api/admin/system/status', { mode: 'paused', message: 'e2e pause' }, admin);
      token = ngUser.token;

      // THE KILL SWITCH. Accepting a quote is what commits money, so this is
      // the call that must stop. Quoting stays available on purpose - seeing
      // a rate moves nothing, and erroring there just confuses.
      const pausedOrder = await call('POST', '/api/ngn/offramp/orders',
        { userId: ngId, quoteId: liveQuote.body.id });
      check('pausing the system blocks NGN off-ramp orders',
        pausedOrder.status >= 400, String(pausedOrder.status));

      const pausedPayout = await call('POST', '/api/ngn/payout-accounts',
        { userId: ngId, bankId: '3', accountNumber: '2222222222' });
      check('and blocks new payout-account lookups', pausedPayout.status >= 400, String(pausedPayout.status));

      token = '';
      await call('PUT', '/api/admin/system/status', { mode: 'active', message: '' }, admin);
      token = ngUser.token;
      const resumedQuote = await call('GET',
        `/api/ngn/quote?userId=${ngId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=5&network=solana`);
      const resumed = await call('POST', '/api/ngn/offramp/orders',
        { userId: ngId, quoteId: resumedQuote.body.id });
      check('and resuming restores them', resumed.status === 200 || resumed.status === 201, String(resumed.status));
    }

    await app.close();
  } catch (error) {
    await app.close();
    throw error;
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
