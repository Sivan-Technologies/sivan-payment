import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { env } from '../src/config/env.js';

const { Client } = pg;

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run migrations');
}

const migrationsDir = path.join(process.cwd(), 'database', 'migrations');
const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

const client = new Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`Running migration ${file}`);
    await client.query(sql);
  }
  console.log('Migrations complete');
} finally {
  await client.end();
}
