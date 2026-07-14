import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { DatabaseShape } from './types.js';
import { PostgresDatabase } from './postgres-database.js';

const emptyDb = (): DatabaseShape => ({
  users: [],
  customers: [],
  externalAccounts: [],
  liquidationAddresses: [],
  withdrawals: [],
  onrampOrders: [],
  webhookEvents: [],
  authChallenges: [],
  auditLogs: [],
  reconciliationRuns: [],
  reconciliationFindings: [],
  paymentControls: [],
  assetControls: [],
  networkControls: [],
  systemStatus: [],
  customerTypeControls: [],
  unifiedWebhookLogs: []
});

export class JsonDatabase {
  private filePath: string;
  private db: DatabaseShape | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath = env.DATABASE_FILE) {
    this.filePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  }

  async read(): Promise<DatabaseShape> {
    if (this.db) return this.db;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.db = { ...emptyDb(), ...JSON.parse(raw) };
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      this.db = emptyDb();
      await this.persist();
    }
    return this.db as DatabaseShape;
  }

  async mutate<T>(fn: (db: DatabaseShape) => T | Promise<T>): Promise<T> {
    const db = await this.read();
    const result = await fn(db);
    await this.persist();
    return result;
  }

  private async persist(): Promise<void> {
    if (!this.db) return;
    const data = JSON.stringify(this.db, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, data);
    });
    await this.writeQueue;
  }
}

export const db = env.DATABASE_PROVIDER === 'postgres'
  ? new PostgresDatabase()
  : new JsonDatabase();
