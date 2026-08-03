/**
 * BREET'S DASHBOARD URL-VERIFICATION PING.
 *
 * Saving a webhook URL in Breet's dashboard POSTs to it and requires a 200.
 * That ping has no `x-webhook-secret` - the secret does not exist yet while
 * you are configuring the URL - and no event body.
 *
 * The endpoint returned 403 and the dashboard refused to save with "Webhook
 * URL must acknowledge the verification request with a 200 response".
 *
 * The danger in fixing this is obvious: acknowledge too much and you have
 * built an unauthenticated endpoint that credits balances. These assertions
 * exist to prove the hole was not opened.
 *
 * Run: npm run test:breet-webhook-verification
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

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

  async function post(body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/api/webhooks/breet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  }

  try {
    console.log('\nTHE DASHBOARD PING IS ACKNOWLEDGED');
    {
      const empty = await post({});
      check('an empty POST returns 200', empty.status === 200, String(empty.status));
      check('and is marked as a verification, not a real event',
        empty.body?.data?.verification === true, JSON.stringify(empty.body).slice(0, 120));

      // Breet may send something minimal rather than nothing at all.
      const minimal = await post({ test: true });
      check('a body with no event and no id also returns 200',
        minimal.status === 200, String(minimal.status));
    }

    console.log('\nTHE HOLE WAS NOT OPENED');
    {
      // The whole risk of this change: a real event must STILL require the
      // secret. If any of these pass without one, the endpoint credits
      // balances for anyone who can reach it.
      const noSecret = await post({ event: 'trade.completed', id: 'evt_forged' });
      check('a real event with NO secret is refused',
        noSecret.status === 403, `${noSecret.status} ${JSON.stringify(noSecret.body).slice(0, 100)}`);

      const wrongSecret = await post(
        { event: 'trade.completed', id: 'evt_forged' },
        { 'x-webhook-secret': 'not-the-secret' }
      );
      check('a real event with the WRONG secret is refused',
        wrongSecret.status === 403, String(wrongSecret.status));

      // An id alone, with no event, must not be treated as a ping and waved
      // through - it is a partially-formed event.
      const idOnly = await post({ id: 'evt_forged' });
      check('a payload carrying an id is NOT treated as a ping',
        idOnly.status === 403, `${idOnly.status} ${JSON.stringify(idOnly.body).slice(0, 100)}`);

      const eventOnly = await post({ event: 'trade.completed' });
      check('a payload carrying an event is NOT treated as a ping',
        eventOnly.status === 403, String(eventOnly.status));
    }

    console.log('\nTHE PING CHANGES NOTHING');
    {
      const { db } = await import('../src/database/json-database.js');
      const before: any = await (db as any).read();
      const webhooksBefore = (before.ngnWebhooks ?? []).length;
      await post({});
      const after: any = await (db as any).read();
      check('no webhook record is stored for a ping',
        ((after.ngnWebhooks ?? []).length) === webhooksBefore,
        `${webhooksBefore} -> ${(after.ngnWebhooks ?? []).length}`);
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
