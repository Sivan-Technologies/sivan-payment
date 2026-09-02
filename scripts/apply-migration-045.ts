import { db } from '../src/database/json-database.js';

async function migrate() {
  console.log('Running Migration 045: Expand payments_user_wallets_chain_check for multi-chain support...');

  const sql = `
    alter table payments_user_wallets
      drop constraint if exists payments_user_wallets_chain_check;

    alter table payments_user_wallets
      add constraint payments_user_wallets_chain_check
      check (chain in ('solana', 'base', 'ethereum', 'celo', 'bsc', 'bnb', 'stellar'));
  `;

  if ((db as any).pool) {
    const client = await (db as any).pool.connect();
    try {
      await client.query(sql);
      console.log('✅ PostgreSQL constraint payments_user_wallets_chain_check updated successfully!');
    } finally {
      client.release();
    }
  } else {
    console.log('Database is in JSON mode or pool not attached directly, checking PostgresDatabase...');
  }
}

migrate().catch(console.error);
