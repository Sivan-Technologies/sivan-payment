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

  /** A raw POST, for the shapes a dashboard probe actually sends. */
  async function raw(init: RequestInit) {
    const res = await fetch(`${base}/api/webhooks/breet`, { method: 'POST', ...init });
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

      // THE THREE SHAPES THAT DIED IN FASTIFY'S PARSER, BEFORE ANY HANDLER.
      //
      // Each returned a 4xx, so Breet refused to save the URL, and no amount
      // of handler logic could help because the handler never ran. Found by
      // probing the deployed endpoint with the shapes a dashboard probe
      // plausibly sends, after the first fix still did not let the user save.
      const emptyJson = await raw({ headers: { 'Content-Type': 'application/json' }, body: '' });
      check('JSON content-type with an EMPTY body returns 200',
        emptyJson.status === 200, `${emptyJson.status} (was 400 "Body cannot be empty")`);

      const noContentType = await raw({ body: '' });
      check('a POST with NO content-type returns 200',
        noContentType.status === 200, `${noContentType.status} (was 415)`);

      const formEncoded = await raw({
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b',
      });
      check('a form-encoded POST returns 200',
        formEncoded.status === 200, `${formEncoded.status} (was 415)`);

      // Breet's probe names a placeholder event. Refusing this is what kept
      // the dashboard failing after the first fix.
      const placeholder = await post({ event: 'verification' });
      check('a placeholder event name is treated as a ping, not a webhook',
        placeholder.status === 200, `${placeholder.status} (was 403)`);
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
      check('a payload carrying a REAL event name is NOT treated as a ping',
        eventOnly.status === 403, String(eventOnly.status));

      // The namespace match is what keeps the placeholder allowance safe: a
      // forged payload must not buy a 200 by inventing an event name.
      for (const name of ['trade.pending', 'trade.flagged', 'withdrawal.completed', 'WITHDRAWAL.PENDING']) {
        const forged = await post({ event: name });
        check(`  "${name}" still requires the secret`, forged.status === 403, String(forged.status));
      }
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
