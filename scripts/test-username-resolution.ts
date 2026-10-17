import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import type { UserRecord, DatabaseShape } from '../src/database/types.js';

// No developer credentials, external database, HTTP server or provider calls.
createRequire(import.meta.url)('dotenv').config = () => ({ parsed: {} });
process.env.DATABASE_PROVIDER = 'json';
process.env.APP_ENV = 'development';
process.env.USER_JWT_SECRET = 'isolated-username-resolution-test-secret';
const { JsonDatabase, db } = await import('../src/database/json-database.js');
const { PostgresDatabase } = await import('../src/database/postgres-database.js');
const { checkUsernameAvailability } = await import('../src/users/username.service.js');
const pg = new PGlite();
await pg.exec(`
  CREATE TABLE users (user_id text PRIMARY KEY, username text, telegram_username text,
    telegram_user_id text, whatsapp_number text, first_name text, last_name text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE customer_identity_links (payment_user_id text, telegram_user_id text,
    telegram_username text, whatsapp_number text, linked_at timestamptz);
`);
let users: UserRecord[] = [];
const snapshot = () => ({ users, customerIdentityLinks: [] }) as unknown as DatabaseShape;
const json = new JsonDatabase('/tmp/unused-username-resolution.json');
json.read = async () => snapshot();
let releases = 0;
// Exercise the real Postgres methods and SQL using embedded PostgreSQL.
const postgres = Object.create(PostgresDatabase.prototype) as InstanceType<typeof PostgresDatabase>;
Object.assign(postgres, { pool: { connect: async () => ({
  query: (sql: string, params?: unknown[]) => pg.query(sql, params),
  release: () => { releases++; },
}) } });
async function seed(records: Array<{ id: string; username?: string; telegramUsername?: string }>) {
  users = records.map((u) => ({ ...u, email: `${u.id}@example.invalid`, fullName: 'Alice Smith', telegramUserId: `tg-${u.id}`,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  await pg.exec('DELETE FROM users');
  for (const u of users) await pg.query(`INSERT INTO users
    (user_id, username, telegram_username, telegram_user_id, first_name, last_name)
    VALUES ($1,$2,$3,$4,'Alice','Smith')`, [u.id,u.username ?? null,u.telegramUsername ?? null,u.telegramUserId]);
}
const ambiguous = (error: unknown) => Boolean(error && typeof error === 'object' &&
  'code' in error && error.code === 'ambiguous_username' && 'statusCode' in error && error.statusCode === 409);
let checks = 0;
const originalRead = db.read;
const originalFinder = db.findUserByUsername;
try {
  for (const [name, store] of [['JSON', json], ['PostgreSQL', postgres]] as const) {
    await seed([{ id: 'one', username: 'Alice', telegramUsername: 'TELEGRAMALICE' }]);
    for (const method of ['findUserByUsername','findUserByTarget'] as const) {
      assert.equal((await store[method]('@aLiCe'))?.id, 'one'); checks++;
      assert.equal((await store[method]('telegramalice'))?.id, 'one'); checks++;
      assert.equal(await store[method]('AliceSmith'), undefined); checks++;
      assert.equal(await store[method]('Alice Smith'), undefined); checks++;
      assert.equal(await store[method]('unknown'), undefined); checks++;
      assert.equal(await store[method](''), undefined); checks++;
    }
    await seed([{ id:'one',username:'shared' },{ id:'two',telegramUsername:'SHARED' }]);
    for (const method of ['findUserByUsername','findUserByTarget'] as const) {
      await assert.rejects(store[method]('@Shared'), ambiguous); checks++;
    }
    assert.equal((await store.findUserByTarget('one'))?.id, 'one'); checks++;
    await seed([{ id:'one',telegramUsername:'duplicate' },{ id:'two',telegramUsername:'DUPLICATE' }]);
    await assert.rejects(store.findUserByUsername('duplicate'), ambiguous); checks++;
    await seed([{ id:'one',username:'same',telegramUsername:'SAME' }]);
    assert.equal((await store.findUserByUsername('same'))?.id,'one'); checks++;
    console.log(`PASS ${name}: collisions, case-insensitivity, direct IDs, no full-name fallback`);
  }
  // Also exercise the service's compatibility fallback, formerly missing data.
  Object.assign(db, { read: async () => snapshot(), findUserByUsername: undefined });
  await seed([{ id:'one',username:'shared' },{ id:'two',telegramUsername:'SHARED' }]);
  await assert.rejects(checkUsernameAvailability('shared'), ambiguous); checks++;
  await seed([{ id:'one',telegramUsername:'ALICE' }]);
  assert.equal((await checkUsernameAvailability('alice')).available,false); checks++;
  assert.equal((await checkUsernameAvailability('alice','one')).available,true); checks++;
  assert.equal((await checkUsernameAvailability('unused')).available,true); checks++;
  assert.ok(releases > 0); checks++;
  console.log(`Username resolution: ${checks} checks passed`);
} finally {
  Object.assign(db, { read: originalRead, findUserByUsername: originalFinder });
  await pg.close();
}
