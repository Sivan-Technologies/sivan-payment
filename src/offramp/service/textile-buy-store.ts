import crypto from 'node:crypto';
import pg from 'pg';

export type BuyAttempt = { wallet: string; chainId: number; provider: string; intentKey: string; amount: string };
export type BuyResult = { transfer: { id: string; status: string; [key: string]: any }; claimToken: string };
export type RecoveredBuy = BuyAttempt & { result: BuyResult | null };
export interface BuyOrderStore {
  create(attempt: BuyAttempt, book: () => Promise<BuyResult>): Promise<BuyResult>;
  list(owner: Pick<BuyAttempt, 'wallet' | 'chainId'>): Promise<RecoveredBuy[]>;
  close(): Promise<void>;
}

function unavailable(): never {
  throw Object.assign(new Error('Buy order recovery storage is unavailable. No new purchase was started.'), { statusCode: 503 });
}

/** Dedicated small pool; connects lazily. No schema changes on application startup. */
export class PostgresBuyOrderStore implements BuyOrderStore {
  private pool?: pg.Pool;
  constructor(pool?: pg.Pool) { this.pool = pool; }
  private key(): Buffer {
    const value = process.env.TEXTILE_BUY_STORAGE_KEY;
    if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) return unavailable();
    return Buffer.from(value, 'hex');
  }
  private database(): pg.Pool {
    this.key(); // Refuse to book anything unless recoverable credentials can be stored.
    if (this.pool) return this.pool;
    if (!process.env.DATABASE_URL) return unavailable();
    return this.pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000 });
  }
  private aad(a: BuyAttempt): Buffer { return Buffer.from(JSON.stringify([a.wallet.toLowerCase(), a.chainId, a.provider, a.intentKey, a.amount])); }
  private encrypt(result: BuyResult, attempt: BuyAttempt): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(this.aad(attempt));
    const data = Buffer.concat([cipher.update(JSON.stringify(result), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  private decrypt(value: string, attempt: BuyAttempt): BuyResult {
    const data = Buffer.from(value, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12));
    cipher.setAAD(this.aad(attempt)); cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
  }
  async create(input: BuyAttempt, book: () => Promise<BuyResult>): Promise<BuyResult> {
    const attempt = { ...input, wallet: input.wallet.toLowerCase() };
    const params = [attempt.wallet, attempt.chainId, attempt.provider, attempt.intentKey];
    let client: pg.PoolClient | undefined;
    try {
      client = await this.database().connect();
      // Commit the intent BEFORE the provider call. A lost response remains recoverable.
      await client.query('insert into textile_buy_orders(wallet,chain_id,provider,intent_key,amount) values($1,$2,$3,$4,$5) on conflict do nothing', [...params, attempt.amount]);
    } catch { client?.release(); return unavailable(); }
    try {
      await client.query('begin');
      await client.query("set local lock_timeout = '5s'");
      const { rows } = await client.query('select * from textile_buy_orders where wallet=$1 and chain_id=$2 and provider=$3 and intent_key=$4 for update', params);
      const row = rows[0];
      if (row.amount !== attempt.amount) throw Object.assign(new Error('This purchase reference belongs to a different amount.'), { statusCode: 409 });
      if (row.encrypted_result) {
        const result = this.decrypt(row.encrypted_result, attempt);
        await client.query('commit');
        return result;
      }
      // Row lock serializes concurrent retries. Textile receives the original intentKey.
      const result = await book();
      await client.query('update textile_buy_orders set provider_transfer_id=$5, encrypted_result=$6, updated_at=now() where wallet=$1 and chain_id=$2 and provider=$3 and intent_key=$4', [...params, result.transfer.id, this.encrypt(result, attempt)]);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async list(owner: Pick<BuyAttempt, 'wallet' | 'chainId'>): Promise<RecoveredBuy[]> {
    try {
      const { rows } = await this.database().query('select * from textile_buy_orders where wallet=$1 and chain_id=$2 order by created_at desc limit 50', [owner.wallet.toLowerCase(), owner.chainId]);
      return rows.map(row => {
        const attempt = { wallet: row.wallet, chainId: Number(row.chain_id), provider: row.provider, intentKey: row.intent_key, amount: row.amount };
        return { ...attempt, result: row.encrypted_result ? this.decrypt(row.encrypted_result, attempt) : null };
      });
    } catch { return unavailable(); }
  }
  async close() { await this.pool?.end(); }
}
