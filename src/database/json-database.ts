import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { AuditLogRecord, AuthChallengeRecord, CustomerRecord, DatabaseShape, ExternalAccountRecord, LiquidationAddressRecord, OnrampOrderRecord, ReconciliationFindingRecord, ReconciliationRunRecord, UserRecord, CustomerIdentityLinkRecord, IdentityPairingTokenRecord, UserPreferencesRecord, LegalAcceptanceRecord, WithdrawalRecord, PaymentControlRecord, AssetControlRecord, NetworkControlRecord, SystemStatusRecord, SupportTicketRecord, SupportTicketMessageRecord } from './types.js';
import { PostgresDatabase } from './postgres-database.js';

const emptyDb = (): DatabaseShape => ({
  users: [],
  customerIdentityLinks: [],
  identityPairingTokens: [],
  userPreferences: [],
  legalAcceptances: [],
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
  unifiedWebhookLogs: [],
  supportTickets: [],
  supportTicketMessages: []
});

export class JsonDatabase {
  private filePath: string;
  private db: DatabaseShape | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath = env.DATABASE_FILE) {
    this.filePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  }

  getPoolStats() {
    return { totalCount: 0, idleCount: 0, waitingCount: 0, provider: 'json' };
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






  async insertLegalAcceptanceRecord(record: LegalAcceptanceRecord) {
    return this.mutate((data) => {
      data.legalAcceptances = data.legalAcceptances ?? [];
      data.legalAcceptances.push(record);
      return record;
    });
  }

  async listLegalAcceptancesForUser(userId: string) {
    const data = await this.read();
    return (data.legalAcceptances ?? [])
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  }

  async getUserPreferencesRecord(userId: string) {
    const data = await this.read();
    return data.userPreferences.find((item) => item.userId === userId);
  }

  async upsertUserPreferencesRecord(record: UserPreferencesRecord) {
    return this.mutate((data) => {
      data.userPreferences = data.userPreferences ?? [];
      const index = data.userPreferences.findIndex((item) => item.userId === record.userId);
      if (index >= 0) data.userPreferences[index] = record;
      else data.userPreferences.push(record);
      return record;
    });
  }

  async getAdminOverviewView() {
    const data = await this.read();
    const withdrawalsByStatus = data.withdrawals.reduce<Record<string, number>>((acc, withdrawal) => {
      acc[withdrawal.status] = (acc[withdrawal.status] ?? 0) + 1;
      return acc;
    }, {});
    const webhookEventsByType = data.webhookEvents.reduce<Record<string, number>>((acc, event) => {
      const key = event.eventCategory || event.eventType || 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return {
      counts: {
        users: data.users.length,
        customers: data.customers.length,
        externalAccounts: data.externalAccounts.length,
        liquidationAddresses: data.liquidationAddresses.length,
        withdrawals: data.withdrawals.length,
        onrampOrders: (data.onrampOrders ?? []).length,
        webhookEvents: data.webhookEvents.length
      },
      withdrawalsByStatus,
      webhookEventsByType,
      recent: {
        users: data.users.slice(-10).reverse(),
        customers: data.customers.slice(-10).reverse(),
        withdrawals: data.withdrawals.slice(-10).reverse(),
        onrampOrders: (data.onrampOrders ?? []).slice(-10).reverse(),
        webhookEvents: data.webhookEvents.slice(-10).reverse()
      }
    };
  }

  async findUserById(userId: string) {
    const data = await this.read();
    return data.users.find((user) => user.id === userId);
  }

  async findUserByEmail(email: string) {
    const data = await this.read();
    return data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
  }

  async findUserByWhatsappNumber(whatsappNumber: string) {
    const data = await this.read();
    return data.users.find((user) => user.whatsappNumber === whatsappNumber);
  }

  async listAdminUsersView({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const data = await this.read();
    return data.users.slice(offset, offset + limit).map((user) => ({
      ...user,
      customer: data.customers.find((customer) => customer.userId === user.id) ?? null,
      identityLink: (data.customerIdentityLinks ?? []).find((link) => link.paymentUserId === user.id && link.status === 'linked') ? { linked: true } : { linked: false },
      externalAccountCount: data.externalAccounts.filter((account) => account.userId === user.id).length,
      withdrawalCount: data.withdrawals.filter((withdrawal) => withdrawal.userId === user.id).length,
      onrampOrderCount: (data.onrampOrders ?? []).filter((order) => order.userId === user.id).length
    }));
  }

  async listAdminWithdrawalsView({ limit = 100, offset = 0, status }: { limit?: number; offset?: number; status?: string } = {}) {
    const data = await this.read();
    return data.withdrawals
      .filter((withdrawal) => !status || withdrawal.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit)
      .map((withdrawal) => ({
        ...withdrawal,
        user: data.users.find((user) => user.id === withdrawal.userId) ?? null,
        externalAccount: data.externalAccounts.find((account) => account.id === withdrawal.externalAccountId) ?? null,
        liquidationAddress: data.liquidationAddresses.find((address) => address.id === withdrawal.liquidationAddressId) ?? null
      }));
  }

  async listAdminOnrampOrdersView({ limit = 100, offset = 0, status }: { limit?: number; offset?: number; status?: string } = {}) {
    const data = await this.read();
    return (data.onrampOrders ?? [])
      .filter((order) => !status || order.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit)
      .map((order) => ({
        ...order,
        user: data.users.find((user) => user.id === order.userId) ?? null,
        customer: data.customers.find((customer) => customer.id === order.customerId) ?? null
      }));
  }

  async listWebhookEventsView({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const data = await this.read();
    return data.webhookEvents.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit);
  }

  async listAuditLogsView({ limit = 200, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const data = await this.read();
    return (data.auditLogs ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit);
  }

  async listReconciliationRunsView({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const data = await this.read();
    return (data.reconciliationRuns ?? [])
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(offset, offset + limit)
      .map((run) => ({ ...run, findings: (data.reconciliationFindings ?? []).filter((finding) => finding.runId === run.id) }));
  }


  async insertSupportTicketRecord(record: SupportTicketRecord) {
    return this.mutate((data) => {
      data.supportTickets = data.supportTickets ?? [];
      data.supportTickets.push(record);
      return record;
    });
  }

  async updateSupportTicketRecord(record: SupportTicketRecord) {
    return this.mutate((data) => {
      data.supportTickets = data.supportTickets ?? [];
      const index = data.supportTickets.findIndex((item) => item.id === record.id);
      if (index >= 0) data.supportTickets[index] = record;
      return record;
    });
  }

  async insertSupportTicketMessageRecord(record: SupportTicketMessageRecord) {
    return this.mutate((data) => {
      data.supportTicketMessages = data.supportTicketMessages ?? [];
      data.supportTicketMessages.push(record);
      const ticket = (data.supportTickets ?? []).find((item) => item.id === record.ticketId);
      if (ticket) {
        ticket.lastMessageAt = record.createdAt;
        ticket.updatedAt = record.createdAt;
      }
      return record;
    });
  }

  async getSupportTicketView(ticketId: string) {
    const data = await this.read();
    const ticket = (data.supportTickets ?? []).find((item) => item.id === ticketId);
    if (!ticket) return undefined;
    return { ...ticket, messages: (data.supportTicketMessages ?? []).filter((message) => message.ticketId === ticket.id).sort((a,b) => a.createdAt.localeCompare(b.createdAt)), user: data.users.find((user) => user.id === ticket.userId) ?? null };
  }

  async listUserSupportTicketsView(userId: string, { limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const data = await this.read();
    return (data.supportTickets ?? []).filter((ticket) => ticket.userId === userId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit);
  }

  async listAdminSupportTicketsView({ limit = 100, offset = 0, status, priority, type, assignedTo, search, dateFrom, dateTo }: { limit?: number; offset?: number; status?: string; priority?: string; type?: string; assignedTo?: string; search?: string; dateFrom?: string; dateTo?: string } = {}) {
    const data = await this.read();
    const lowerSearch = search?.toLowerCase();
    const fromTime = dateFrom ? new Date(dateFrom).getTime() : 0;
    const toTime = dateTo ? new Date(dateTo).getTime() : Number.POSITIVE_INFINITY;
    return (data.supportTickets ?? [])
      .filter((ticket) => (!status || ticket.status === status) && (!priority || ticket.priority === priority) && (!type || ticket.type === type) && (!assignedTo || ticket.assignedTo === assignedTo) && new Date(ticket.createdAt).getTime() >= fromTime && new Date(ticket.createdAt).getTime() <= toTime && (!lowerSearch || [ticket.id, ticket.userId, ticket.subject, ticket.resourceId].filter(Boolean).some((value) => String(value).toLowerCase().includes(lowerSearch))))
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit)
      .map((ticket) => ({ ...ticket, user: data.users.find((user) => user.id === ticket.userId) ?? null, messageCount: (data.supportTicketMessages ?? []).filter((message) => message.ticketId === ticket.id).length }));
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

  async updateUserRecord(record: UserRecord) {
    return this.mutate((data) => {
      const index = data.users.findIndex((item) => item.id === record.id);
      if (index >= 0) data.users[index] = record;
      else data.users.push(record);
      return record;
    });
  }

  async listCustomerIdentityLinks(): Promise<CustomerIdentityLinkRecord[]> {
    const data = await this.read();
    return data.customerIdentityLinks ?? [];
  }

  async upsertCustomerIdentityLinkRecord(record: CustomerIdentityLinkRecord) {
    return this.mutate((data) => {
      data.customerIdentityLinks = data.customerIdentityLinks ?? [];
      const index = data.customerIdentityLinks.findIndex((item) => item.id === record.id);
      if (index >= 0) data.customerIdentityLinks[index] = record;
      else data.customerIdentityLinks.push(record);
      return record;
    });
  }

  async listIdentityPairingTokens(): Promise<IdentityPairingTokenRecord[]> {
    const data = await this.read();
    return data.identityPairingTokens ?? [];
  }

  async upsertIdentityPairingTokenRecord(record: IdentityPairingTokenRecord) {
    return this.mutate((data) => {
      data.identityPairingTokens = data.identityPairingTokens ?? [];
      const index = data.identityPairingTokens.findIndex((item) => item.id === record.id);
      if (index >= 0) data.identityPairingTokens[index] = record;
      else data.identityPairingTokens.push(record);
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

  async insertUnifiedWebhookLogRecord(record: any) {
    return this.mutate((data) => {
      data.unifiedWebhookLogs = data.unifiedWebhookLogs ?? [];
      data.unifiedWebhookLogs.push(record);
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
