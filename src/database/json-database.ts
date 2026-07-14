import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { AuditLogRecord, AuthChallengeRecord, CustomerRecord, DatabaseShape, ExternalAccountRecord, LiquidationAddressRecord, OnrampOrderRecord, ReconciliationFindingRecord, ReconciliationRunRecord, UserRecord, WithdrawalRecord, PaymentControlRecord, AssetControlRecord, NetworkControlRecord, SystemStatusRecord } from './types.js';
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
  customerTypeControls: []
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


  async insertAuditLogRecord(record: AuditLogRecord) {
    return this.mutate((data) => {
      data.auditLogs = data.auditLogs ?? [];
      data.auditLogs.push(record);
      return record;
    });
  }

  async insertAuthChallengeRecord(record: AuthChallengeRecord) {
    return this.mutate((data) => {
      data.authChallenges = data.authChallenges ?? [];
      data.authChallenges.push(record);
      return record;
    });
  }

  async consumeAuthChallengeAndMarkUserEmail(challengeId: string, userId: string, now: string) {
    return this.mutate((data) => {
      const challenge = (data.authChallenges ?? []).find((item) => item.id === challengeId);
      if (challenge) challenge.consumedAt = now;
      const user = data.users.find((item) => item.id === userId);
      if (user && !user.emailVerifiedAt) {
        user.emailVerifiedAt = now;
        user.updatedAt = now;
      }
      return challenge ?? null;
    });
  }

  async insertUserRecord(record: UserRecord) {
    return this.mutate((data) => {
      data.users.push(record);
      return record;
    });
  }

  async insertCustomerRecord(record: CustomerRecord) {
    return this.mutate((data) => {
      data.customers.push(record);
      return record;
    });
  }

  async updateCustomerRecord(record: CustomerRecord) {
    return this.mutate((data) => {
      const index = data.customers.findIndex((item) => item.id === record.id);
      if (index >= 0) data.customers[index] = record;
      return record;
    });
  }

  async insertExternalAccountRecord(record: ExternalAccountRecord) {
    return this.mutate((data) => {
      data.externalAccounts.push(record);
      return record;
    });
  }

  async updateExternalAccountRecord(record: ExternalAccountRecord) {
    return this.mutate((data) => {
      const index = data.externalAccounts.findIndex((item) => item.id === record.id);
      if (index >= 0) data.externalAccounts[index] = record;
      return record;
    });
  }

  async createWithdrawalRecords(liquidationAddress: LiquidationAddressRecord, withdrawal: WithdrawalRecord) {
    return this.mutate((data) => {
      data.liquidationAddresses.push(liquidationAddress);
      data.withdrawals.push(withdrawal);
      return { liquidationAddress, withdrawal };
    });
  }

  async insertOnrampOrderRecord(record: OnrampOrderRecord) {
    return this.mutate((data) => {
      data.onrampOrders = data.onrampOrders ?? [];
      data.onrampOrders.push(record);
      return record;
    });
  }

  async updateOnrampOrderRecord(record: OnrampOrderRecord) {
    return this.mutate((data) => {
      data.onrampOrders = data.onrampOrders ?? [];
      const index = data.onrampOrders.findIndex((item) => item.id === record.id);
      if (index >= 0) data.onrampOrders[index] = record;
      return record;
    });
  }


  async updatePaymentControlsSnapshot(input: { customerTypes: any[]; payoutCurrencies: PaymentControlRecord[]; sourceAssets: AssetControlRecord[]; sourceNetworks: NetworkControlRecord[] }) {
    return this.mutate((data) => {
      data.customerTypeControls = input.customerTypes as any;
      data.paymentControls = input.payoutCurrencies;
      data.assetControls = input.sourceAssets;
      data.networkControls = input.sourceNetworks;
      return input;
    });
  }

  async updateSystemStatusRecord(record: SystemStatusRecord) {
    return this.mutate((data) => {
      data.systemStatus = [record];
      return record;
    });
  }

  async insertReconciliationRecords(run: ReconciliationRunRecord, findings: ReconciliationFindingRecord[]) {
    return this.mutate((data) => {
      data.reconciliationRuns = data.reconciliationRuns ?? [];
      data.reconciliationFindings = data.reconciliationFindings ?? [];
      data.reconciliationRuns.push(run);
      data.reconciliationFindings.push(...findings);
      return run;
    });
  }

  async updateWithdrawalRecord(record: WithdrawalRecord) {
    return this.mutate((data) => {
      const index = data.withdrawals.findIndex((item) => item.id === record.id);
      if (index >= 0) data.withdrawals[index] = record;
      return record;
    });
  }


  async insertWebhookEventRecord(record: any) {
    return this.mutate((data) => {
      data.webhookEvents = data.webhookEvents ?? [];
      data.webhookEvents.push(record);
      return record;
    });
  }

  async updateWebhookEventRecord(record: any) {
    return this.mutate((data) => {
      const index = data.webhookEvents.findIndex((item) => item.id === record.id);
      if (index >= 0) data.webhookEvents[index] = record;
      return record;
    });
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
