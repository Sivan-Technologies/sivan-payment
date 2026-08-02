/**
 * The alerting endpoint, driven by real state over real HTTP.
 *
 * WHY EVERY SIGNAL IS TESTED BY CAUSING IT
 *
 * A monitoring endpoint that returns `ok` because it cannot detect anything is
 * worse than no monitoring: it actively reassures. So each signal here is
 * exercised by creating the condition and watching it flip, then clearing it
 * and watching it flip back. A signal that never leaves `ok` is decorative,
 * and this suite is designed to catch that.
 *
 * The three real incidents this endpoint exists to catch were all silent -
 * /health returned 200 throughout every one of them:
 *
 *   8a935a7  flagged deposits sat unhandled forever
 *   593fbbf  completed deposits were stored and discarded
 *   f14a514  a failed migration served stale code for six commits
 *
 * Run: npm run test:operational-health
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

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const fetchHealth = async () => {
    const res = await fetch(`${baseUrl}/health/operational`);
    return { status: res.status, body: (await res.json()) as any };
  };
  const signal = (body: any, name: string) =>
    (body.signals as any[]).find((s) => s.name === name);

  async function makeTransfer(id: string, status: string, ageHours: number) {
    const at = hoursAgo(ageHours);
    await db.upsertNgnTransferRecord({
      id, userId: 'usr_health', quoteId: `q_${id}`, direction: 'offramp',
      sourceCurrency: 'usdc', destinationCurrency: 'ngn',
      sourceAmount: '25', destinationAmount: '40125',
      status, provider: 'mock', createdAt: at, updatedAt: at,
    } as any);
  }

  try {
    console.log('\nTHE ENDPOINT IS REACHABLE WITHOUT CREDENTIALS');
    {
      // An alerting endpoint behind auth is one expired credential away from
      // silently not alerting.
      const res = await fetchHealth();
      check('no token required', res.status === 200 || res.status === 503, String(res.status));
      check('it reports a status', ['ok', 'warn', 'critical'].includes(res.body.status), res.body.status);
      check('and names the environment', Boolean(res.body.environment), res.body.environment);
      check('every signal carries an actionable detail',
        (res.body.signals as any[]).every((s) => typeof s.detail === 'string' && s.detail.length > 10));
    }

    console.log('\nA CLEAN SYSTEM IS NOT CRITICAL');
    {
      const res = await fetchHealth();
      check('a fresh install is not critical', res.body.status !== 'critical',
        JSON.stringify((res.body.signals as any[]).filter((s) => s.severity === 'critical')));
      check('stuck transfers reads zero', signal(res.body, 'transfers_stuck_in_flight').value === 0);
      check('delegated signing is configured in this run',
        signal(res.body, 'delegated_signing_configured').severity === 'ok');
    }

    console.log('\nA STUCK TRANSFER IS CRITICAL AND RETURNS 503');
    {
      // The exact shape of both webhook bugs: non-terminal, not updating.
      await makeTransfer('ngnt_stuck', 'awaiting_crypto_deposit', 5);
      const res = await fetchHealth();
      const s = signal(res.body, 'transfers_stuck_in_flight');
      check('the stuck transfer is counted', s.value === 1, String(s.value));
      check('and it is CRITICAL, not a warning', s.severity === 'critical', s.severity);
      check('the endpoint returns 503 so a dumb monitor alerts',
        res.status === 503, String(res.status));
      check('the detail tells the operator where to look',
        /webhook/i.test(s.detail), s.detail);
    }

    console.log('\nA RECENT TRANSFER IS NOT STUCK');
    {
      // The false-positive guard. Every in-flight transfer is briefly in this
      // state; alerting on all of them would train operators to ignore it.
      await db.upsertNgnTransferRecord({
        ...(await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_stuck')!,
        updatedAt: new Date().toISOString(),
      } as any);
      const res = await fetchHealth();
      check('a transfer updated just now is not flagged',
        signal(res.body, 'transfers_stuck_in_flight').value === 0,
        String(signal(res.body, 'transfers_stuck_in_flight').value));
      check('and the endpoint recovers to 200', res.status === 200, String(res.status));
    }

    console.log('\nA COMPLETED TRANSFER IS NEVER STUCK, HOWEVER OLD');
    {
      // Terminal states must be excluded or every historical transfer alerts
      // forever and the signal becomes permanently red.
      await makeTransfer('ngnt_done', 'completed', 900);
      await makeTransfer('ngnt_failed', 'failed', 900);
      const res = await fetchHealth();
      check('old completed and failed transfers are ignored',
        signal(res.body, 'transfers_stuck_in_flight').value === 0,
        String(signal(res.body, 'transfers_stuck_in_flight').value));
    }

    console.log('\nFLAGGED DEPOSITS ARE SURFACED');
    {
      await makeTransfer('ngnt_flagged', 'requires_review', 1);
      const res = await fetchHealth();
      const s = signal(res.body, 'transfers_requiring_review');
      check('a held deposit is counted', s.value === 1, String(s.value));
      check('as a warning, not critical - the funds are safe', s.severity === 'warn', s.severity);
      check('and the detail mentions the held funds', /holding|minimum/i.test(s.detail), s.detail);
    }

    console.log('\nTHE REVIEW QUEUE ESCALATES WITH AGE');
    {
      const base = {
        userId: 'usr_health', provider: 'mock', bankId: '2', accountNumber: '1111111111',
        accountName: 'OGUNMEPON SHARAFA', declaredName: 'Sharafa Ogunmepon',
        matchVerdict: 'review' as const, matchScore: 0.5,
        resolutionTrustworthy: true, status: 'pending_review' as const,
      };

      // Fresh: a queue with something in it is normal, not an alert.
      await db.upsertNgnPayoutAccountRecord({
        ...base, id: 'acct_fresh', accountNumber: '1111111111',
        createdAt: hoursAgo(1), updatedAt: hoursAgo(1),
      } as any);
      let res = await fetchHealth();
      check('a fresh review is not an alert',
        signal(res.body, 'kyc_name_reviews_pending').severity === 'ok',
        signal(res.body, 'kyc_name_reviews_pending').severity);

      // 30h: the user has waited overnight and cannot withdraw.
      await db.upsertNgnPayoutAccountRecord({
        ...base, id: 'acct_stale', accountNumber: '2222222222',
        createdAt: hoursAgo(30), updatedAt: hoursAgo(30),
      } as any);
      res = await fetchHealth();
      check('a review older than 24h warns',
        signal(res.body, 'kyc_name_reviews_pending').severity === 'warn',
        signal(res.body, 'kyc_name_reviews_pending').severity);
      check('and the count is right', signal(res.body, 'kyc_name_reviews_pending').value === 2);

      // 60h: that user has almost certainly churned.
      await db.upsertNgnPayoutAccountRecord({
        ...base, id: 'acct_ancient', accountNumber: '3333333333',
        createdAt: hoursAgo(60), updatedAt: hoursAgo(60),
      } as any);
      res = await fetchHealth();
      check('a review older than 48h is critical',
        signal(res.body, 'kyc_name_reviews_pending').severity === 'critical',
        signal(res.body, 'kyc_name_reviews_pending').severity);
      check('the oldest age is reported for triage',
        /oldest 6[0-9]/.test(signal(res.body, 'kyc_name_reviews_pending').detail),
        signal(res.body, 'kyc_name_reviews_pending').detail);

      // Clearing the queue must clear the alert - a stuck alarm is ignored.
      for (const id of ['acct_fresh', 'acct_stale', 'acct_ancient']) {
        const found = (await db.listNgnPayoutAccounts()).find((a) => a.id === id)!;
        await db.upsertNgnPayoutAccountRecord({ ...found, status: 'verified' } as any);
      }
      res = await fetchHealth();
      check('approving them clears the alert',
        signal(res.body, 'kyc_name_reviews_pending').severity === 'ok',
        signal(res.body, 'kyc_name_reviews_pending').severity);
    }

    console.log('\nSILENT WEBHOOKS ARE DETECTED');
    {
      // Transfers were started but nothing arrived from the provider. This is
      // what a wrong webhook URL or a rotated secret looks like from inside.
      const res = await fetchHealth();
      const s = signal(res.body, 'provider_webhooks_24h');
      check('no webhooks alongside in-flight transfers warns',
        s.severity === 'warn', `${s.severity} value=${s.value}`);
      check('the detail names the likely cause',
        /webhook URL|secret/i.test(s.detail), s.detail);

      await db.upsertNgnWebhookRecord({
        id: 'ngnwh_health', provider: 'breet', providerEventId: 'e:1',
        eventType: 'trade.completed', transferId: 'ngnt_done', payload: {},
        createdAt: new Date().toISOString(),
      } as any);
      const after = await fetchHealth();
      check('a delivered webhook clears it',
        signal(after.body, 'provider_webhooks_24h').severity === 'ok',
        signal(after.body, 'provider_webhooks_24h').severity);
    }

    console.log('\nCONFIGURATION MISTAKES ARE SIGNALS TOO');
    {
      const res = await fetchHealth();

      // The off-ramp ships disabled, which is correct - but an accidental
      // pause in production looks exactly like a quiet day.
      const rails = signal(res.body, 'ngn_offramp_enabled');
      check('a disabled off-ramp is surfaced', rails.severity === 'warn', rails.severity);
      check('and says what it means for users',
        /cannot withdraw/i.test(rails.detail), rails.detail);

      // BREET_ENV=development in a production app means every bank name check
      // returns a stub. Only critical when APP_ENV is production, so staging
      // is not permanently red.
      const breet = signal(res.body, 'breet_environment');
      check('the Breet environment is reported', Boolean(breet), 'missing signal');
      check('and is not critical outside production',
        env.APP_ENV === 'production' || breet.severity === 'ok', breet.severity);
    }

    console.log('\nSEVERITY ROLLS UP TO THE WORST SIGNAL');
    {
      await makeTransfer('ngnt_stuck2', 'processing', 9);
      const res = await fetchHealth();
      check('one critical signal makes the whole status critical',
        res.body.status === 'critical', res.body.status);
      check('and the endpoint returns 503', res.status === 503, String(res.status));
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
