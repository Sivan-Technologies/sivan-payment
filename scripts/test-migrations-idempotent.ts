/**
 * Every migration must survive being run TWICE.
 *
 * WHY THIS EXISTS
 *
 * scripts/db-migrate.ts has no applied-migrations table. It reads every .sql
 * file in order and executes all of them, on every single deploy. So a
 * migration that is not idempotent does not fail once - it succeeds on the
 * deploy that introduces it and then breaks EVERY deploy after that.
 *
 * That is exactly what happened. Migration 036 used a bare
 *
 *     alter table users add constraint users_country_iso2 ...
 *
 * which Postgres has no IF NOT EXISTS form for. It applied cleanly the first
 * time, then failed with 42710 "constraint already exists" on the next build
 * and took the whole deploy down with it. Nothing merged afterwards shipped -
 * the country routing, the payout accounts table, the verification summary
 * endpoint, all of it sat on main while the API kept serving old code, and
 * the only visible symptom was a 404 on the new routes.
 *
 * A build failure that only appears on the SECOND deploy is close to
 * invisible in review, so it gets a test rather than a code comment.
 *
 * PGlite is the real Postgres source compiled to WASM, so an error raised
 * here is the same error Render raises.
 *
 * Run: npm run test:migrations
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  const dir = path.join(process.cwd(), 'database', 'migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const db = new PGlite();
  await db.waitReady;

  /** Apply every migration in order, returning the file that failed. */
  async function runAll(): Promise<{ file: string; error: any } | null> {
    for (const file of files) {
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await db.exec(sql);
      } catch (error) {
        return { file, error };
      }
    }
    return null;
  }

  console.log(`\nREPLAYING ${files.length} MIGRATIONS AGAINST REAL POSTGRES`);
  {
    const first = await runAll();
    check('a clean database migrates', first === null,
      first ? `${first.file}: ${first.error?.message}` : '');
    if (first) { console.log('\nFirst pass failed; the rest cannot be judged.'); process.exit(1); }
  }

  console.log('\nAND AGAIN, BECAUSE EVERY DEPLOY REPLAYS ALL OF THEM');
  {
    // THE ONE THAT MATTERS. db-migrate.ts tracks nothing, so this is what
    // actually happens on the next push to main.
    const second = await runAll();
    check('the same migrations run a second time', second === null,
      second ? `${second.file}: ${second.error?.code} ${second.error?.message}` : '');

    // A third pass, because a two-run bug can hide behind a two-run fix -
    // for instance a guard that drops and recreates rather than skipping.
    const third = await runAll();
    check('and a third time', third === null,
      third ? `${third.file}: ${third.error?.code} ${third.error?.message}` : '');
  }

  console.log('\nTHE GUARDED OBJECTS ACTUALLY EXIST');
  {
    // A migration can be made "idempotent" by accident - by never creating
    // anything. Existence is asserted separately from replay.
    const constraint = await db.query<{ conname: string }>(
      `select conname from pg_constraint where conname = 'users_country_iso2'`
    );
    check('users_country_iso2 was created, not silently skipped',
      constraint.rows.length === 1, String(constraint.rows.length));

    const table = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where tablename = 'payments_ngn_payout_accounts'`
    );
    check('payments_ngn_payout_accounts exists', table.rows.length === 1);

    const indexes = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'payments_ngn_payout_accounts'`
    );
    const names = indexes.rows.map((r) => r.indexname);
    check('the review-queue index exists', names.includes('idx_ngn_payout_accounts_status'), names.join(', '));
    // Without this, a rejected user could resubmit until a fresh pending row
    // appeared and farm the queue for a different reviewer.
    check('the unique (user, provider, bank, account) index exists',
      names.includes('idx_ngn_payout_accounts_unique'), names.join(', '));
  }

  console.log('\nTHE COUNTRY CONSTRAINT ENFORCES WHAT IT CLAIMS');
  {
    await db.exec(`insert into users (user_id, email, country) values ('mig_u1','a@b.test','NG')`);
    check('a valid ISO-2 country is accepted', true);

    let rejected = false;
    try {
      await db.exec(`insert into users (user_id, email, country) values ('mig_u2','c@d.test','nga')`);
    } catch { rejected = true; }
    check('a malformed country is rejected by the database', rejected);

    // NOT VALID means existing rows are not re-checked. New rows with no
    // country must still be allowed - most users have none.
    let nullAllowed = true;
    try {
      await db.exec(`insert into users (user_id, email, country) values ('mig_u3','e@f.test',null)`);
    } catch { nullAllowed = false; }
    check('a null country is still allowed for existing users', nullAllowed);
  }

  console.log('\nA USER WITH NO BRIDGE CUSTOMER CAN STILL BE GIVEN A WALLET');
  {
    // THE NIGERIAN PATH HAS NO BRIDGE CUSTOMER, EVER.
    //
    // payments_user_wallets.payments_customer_id was `not null references
    // payments_customers(id)`, written in 031 when a wallet only existed as
    // "the wallet belonging to a Bridge customer". A user who verifies by
    // NUBAN name check never becomes one, so wallet creation died with 23502
    // and they got a bare 500 - no deposit address, no off-ramp, no on-ramp.
    //
    // Caught by walking the actual product against the deployed test API, not
    // by any suite: every wallet test seeds a Bridge customer first, so the
    // constraint was structurally invisible to all of them.
    await db.exec(`insert into users (user_id, email) values ('mig_w1','w1@b.test')`);

    let noCustomerAllowed = true;
    let failure = '';
    try {
      await db.exec(`insert into payments_user_wallets
        (id, user_id, payments_customer_id, provider, provider_wallet_id, chain, address, status, custodial)
        values ('mig_uw1','mig_w1',null,'privy','pw_1','solana','SoLaddr1','active',false)`);
    } catch (error) { noCustomerAllowed = false; failure = (error as Error).message.slice(0, 120); }
    check('a wallet can be created with no Bridge customer', noCustomerAllowed, failure);

    // The FK must still bite. Dropping NOT NULL must not have become "any
    // string is fine" - a dangling customer id is a different bug.
    let danglingRejected = false;
    try {
      await db.exec(`insert into payments_user_wallets
        (id, user_id, payments_customer_id, provider, provider_wallet_id, chain, address, status, custodial)
        values ('mig_uw2','mig_w1','cus_does_not_exist','privy','pw_2','ethereum','0xaddr2','active',false)`);
    } catch { danglingRejected = true; }
    check('but a customer id that does not exist is still rejected', danglingRejected);
  }

  console.log('\nNO MIGRATION USES AN UNGUARDED add constraint');
  {
    // Static check as well as the behavioural one, so the failure names the
    // file rather than only the symptom.
    const offenders: string[] = [];
    for (const file of files) {
      const sql = (await fs.readFile(path.join(dir, file), 'utf8')).toLowerCase();
      // Strip comments so a mention in prose is not a false positive.
      const code = sql.replace(/--[^\n]*/g, '');
      if (!/add\s+constraint/.test(code)) continue;
      /**
       * Two guards are valid, not one.
       *
       * This accepted only a pg_constraint existence check, and reported 053
       * as an offender for using the other correct form:
       *
       *     alter table t drop constraint if exists c;
       *     alter table t add  constraint c check (...);
       *
       * That IS idempotent - the drop makes the add safe on every later run -
       * and the behavioural half of this same suite proves it, migrating a
       * clean database three times in a row without error. So the failure was
       * this heuristic being too narrow, not the migration being unsafe.
       *
       * The `drop if exists` must target the SAME constraint name being added,
       * otherwise it guards nothing; that is what the name capture below
       * checks, so this stays strict rather than merely permissive.
       */
      if (/pg_constraint/.test(code)) continue;
      const added = [...code.matchAll(/add\s+constraint\s+([a-z0-9_]+)/g)].map((m) => m[1]);
      const dropped = new Set(
        [...code.matchAll(/drop\s+constraint\s+if\s+exists\s+([a-z0-9_]+)/g)].map((m) => m[1])
      );
      if (!added.every((name) => dropped.has(name))) offenders.push(file);
    }
    check('every add constraint is wrapped in an existence check',
      offenders.length === 0, offenders.join(', '));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
