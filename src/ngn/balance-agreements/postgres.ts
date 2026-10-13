import type { Pool } from 'pg';
import type { Transaction } from './ledger.js';

/** Supply the application's configured pool. Never open a fallback connection,
 * apply migrations automatically, or retry a transaction with unknown commit state.
 * Callers retry using the same operation identifiers instead.
 */
export function ngnAgreementTransaction(pool: Pool): Transaction {
  return async run => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
}
