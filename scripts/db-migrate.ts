import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { env } from '../src/config/env.js';

/**
 * Applies each migration ONCE, recording it in a ledger.
 *
 * WHY THIS CHANGED. Previously every .sql file was replayed on every deploy,
 * with `if not exists` as the only protection. That is fine while migrations
 * only ADD things, and breaks the moment one deliberately removes something an
 * earlier one created. Migration 044 drops the unique index that 015 creates,
 * so on the next deploy 015 found it genuinely absent and tried to recreate it
 * against a table 044 had widened:
 *
 *   error: could not create unique index
 *          "idx_customer_identity_links_active_payment_user"
 *   detail: Key (payment_user_id)=(usr_1c2937b2-...) is duplicated.
 *
 * A real user had linked both WhatsApp and Telegram - two 'linked' rows for one
 * payment_user_id, exactly what 044 was written to permit. The data was
 * correct; the replay was not. Every subsequent deploy would have failed the
 * same way, and the failure got WORSE with adoption rather than better.
 *
 * Replay is also not free even when it succeeds: it re-executes every ALTER and
 * backfill in the project's history on each boot.
 *
 * ADOPTING AN EXISTING DATABASE. The ledger starts empty, so a database that
 * predates it would re-run everything exactly once more. That single replay is
 * the risky one, so it is handled explicitly:
 *
 *   - Each file runs in its OWN transaction. A failure rolls that file back and
 *     stops the run, rather than leaving the schema half-changed.
 *   - A file that fails on a database where its effects are already present is
 *     reported with the ledger state, so the operator can see whether it is a
 *     genuine error or a replay artefact.
 *
 * The checksum is recorded to detect an already-applied file being EDITED - the
 * edit will not be applied, and silence about that is how two environments
 * drift apart. It warns rather than failing: refusing to boot over a corrected
 * comment in an old migration would be its own outage.
 */

const { Client } = pg;

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run migrations');
}

const migrationsDir = path.join(process.cwd(), 'database', 'migrations');
const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

const client = new Client({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL.includes('localhost') || env.DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
});
await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `);

  const { rows } = await client.query<{ filename: string; checksum: string }>(
    'select filename, checksum from schema_migrations'
  );
  const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

  if (applied.size === 0 && files.length > 0) {
    console.log(
      'No migration ledger found. Applying all migrations once and recording them. ' +
        'On an existing database this is the adoption run.'
    );
  }

  let ran = 0;
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');

    const previous = applied.get(file);
    if (previous) {
      if (previous !== checksum) {
        // Not fatal, but it must never be silent: the file on disk is no longer
        // what this database ran, and no amount of redeploying will change that.
        console.warn(
          `WARNING: ${file} has changed since it was applied. The change has NOT been applied. ` +
            'Add a new migration instead of editing an applied one.'
        );
      }
      continue;
    }

    console.log(`Running migration ${file}`);
    try {
      // Per-file transaction: a failure cannot leave this file half-applied,
      // and the ledger row commits with the change it describes.
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [
        file,
        checksum,
      ]);
      await client.query('commit');
      ran += 1;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      console.error(`Migration ${file} failed and was rolled back. No later migrations were run.`);
      throw error;
    }
  }

  console.log(
    ran === 0
      ? `Migrations complete - database already up to date (${applied.size} previously applied).`
      : `Migrations complete - applied ${ran} new migration${ran === 1 ? '' : 's'}.`
  );
} finally {
  await client.end();
}
