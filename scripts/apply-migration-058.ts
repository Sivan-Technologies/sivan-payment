import pg from 'pg';
import { env } from '../src/config/env.js';

const { Client } = pg;

async function migrate() {
  console.log('Running Migration 058: Expand payments_user_wallets_chain_check for Arbitrum, Arc, and Starknet...');

  if (!env.DATABASE_URL) {
    console.log('DATABASE_URL is not set. Skipping postgres migration.');
    return;
  }

  const sql = `
    alter table payments_user_wallets
      drop constraint if exists payments_user_wallets_chain_check;

    alter table payments_user_wallets
      add constraint payments_user_wallets_chain_check
      check (chain in ('solana', 'base', 'ethereum', 'celo', 'bsc', 'bnb', 'stellar', 'arbitrum', 'arc', 'starknet'));
  `;

  const client = new Client({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_URL.includes('localhost') || env.DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log('✅ PostgreSQL constraint payments_user_wallets_chain_check updated successfully to include arbitrum, arc, and starknet!');
  } finally {
    await client.end();
  }
}

migrate().catch(console.error);
