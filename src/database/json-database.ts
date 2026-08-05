import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { AceSupportMessageRecord, AceSupportResolutionRecord, AceSupportSessionRecord, AceToolCallRecord, AuditLogRecord, AuthChallengeRecord, CustomerRecord, DatabaseShape, ExternalAccountRecord, NgnPayoutAccountRecord, LiquidationAddressRecord, UserWalletRecord, OnrampOrderRecord, ReconciliationFindingRecord, ReconciliationRunRecord, UserRecord, CustomerIdentityLinkRecord, IdentityPairingTokenRecord, UserPreferencesRecord, UserTwoFactorRecord, UserTwoFactorRecoveryQuestionRecord, LegalAcceptanceRecord, WithdrawalRecord, PaymentControlRecord, VirtualAccountControlRecord, AssetControlRecord, NetworkControlRecord, SystemStatusRecord, SystemIncidentRecord, SupportTicketRecord, SupportTicketMessageRecord, TransactionReferenceRecord, SupplierRecord, SupplierPaymentRecord, SupplierControlsRecord, VerificationLimitOverrideRecord, UserLimitOverrideRecord, UserLimitResetRecord, WalletControlsRecord, WalletDepositRecord } from './types.js';
import type { NgnControlsRecord, NgnQuoteRecord, NgnTransferRecord, NgnWebhookRecord } from '../ngn/types/ngn.types.js';
import { PostgresDatabase } from './postgres-database.js';
import { walletServesNetwork } from '../wallets/chain-family.js';
import type { VirtualAccountEventRecord, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord } from '../virtual-accounts/types/virtual-account.types.js';

const emptyDb = (): DatabaseShape => ({
  users: [],
  customerIdentityLinks: [],
  identityPairingTokens: [],
  userPreferences: [],
  userTwoFactor: [],
  userTwoFactorRecoveryQuestions: [],
  legalAcceptances: [],
  customers: [],
  externalAccounts: [],
  ngnPayoutAccounts: [],
  liquidationAddresses: [],
  userWallets: [],
  withdrawals: [],
  onrampOrders: [],
  suppliers: [],
  supplierPayments: [],
  supplierControls: [],
  webhookEvents: [],
  authChallenges: [],
  auditLogs: [],
  reconciliationRuns: [],
  reconciliationFindings: [],
  paymentControls: [],
  virtualAccountControls: [],
  assetControls: [],
  networkControls: [],
  systemStatus: [],
  systemIncidents: [],
  customerTypeControls: [],
  unifiedWebhookLogs: [],
  transactionReferences: [],
  aceSupportSessions: [],
  aceSupportMessages: [],
  aceToolCalls: [],
  aceSupportResolutions: [],
  supportTickets: [],
  supportTicketMessages: [],
  virtualAccountRequests: [],
  virtualAccounts: [],
  virtualAccountEvents: [],
  virtualAccountTransactions: [],
  ngnControls: [],
  verificationLimitOverrides: [],
  userLimitOverrides: [],
  userLimitResets: [],
  walletControls: [],
  ngnQuotes: [],
  ngnTransfers: [],
  ngnWebhooks: [],
  walletDeposits: []
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

  async getUserTwoFactorRecord(userId: string) {
    const data = await this.read();
    return (data.userTwoFactor ?? []).find((item) => item.userId === userId);
  }

  async upsertUserTwoFactorRecord(record: UserTwoFactorRecord) {
    return this.mutate((data) => {
      data.userTwoFactor = data.userTwoFactor ?? [];
      const index = data.userTwoFactor.findIndex((item) => item.userId === record.userId);
      if (index >= 0) data.userTwoFactor[index] = record;
      else data.userTwoFactor.push(record);
      return record;
    });
  }

  async listUserTwoFactorRecoveryQuestionRecords(userId: string) {
    const data = await this.read();
    return (data.userTwoFactorRecoveryQuestions ?? [])
      .filter((item) => item.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async replaceUserTwoFactorRecoveryQuestionRecords(userId: string, records: UserTwoFactorRecoveryQuestionRecord[]) {
    return this.mutate((data) => {
      data.userTwoFactorRecoveryQuestions = (data.userTwoFactorRecoveryQuestions ?? []).filter((item) => item.userId !== userId);
      data.userTwoFactorRecoveryQuestions.push(...records);
      return records;
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


  async findUserByUsername(username: string) {
    const data = await this.read();
    return data.users.find((user) => user.username?.toLowerCase() === username.toLowerCase());
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

  /**
   * Mirrors the Postgres targeted lookup. See that implementation for why.
   *
   * The lowercasing here is a REAL second guard, not decoration. Two
   * independent things stop `SAM@x.com` buying a second email after
   * `sam@x.com`: startEmailAuthSchema lowercases the input, and this
   * comparison lowercases again.
   *
   * Mutation-tested all three ways: removing EITHER one alone leaves the
   * suite green, because the other still catches it. Removing BOTH fails
   * "the same address in different case is still throttled". That is the
   * correct shape for a bypass guard - it should take two mistakes, not one.
   */
  /** Mirror of the Postgres targeted audit query. Cheap on JSON. */
  async listAuditLogsByActions(actions: string[], resourceId?: string) {
    const data = await this.read();
    return (data.auditLogs ?? [])
      .filter((log) => actions.includes(log.action))
      .filter((log) => !resourceId || log.resourceId === resourceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200);
  }

  async latestAuditLogByAction(action: string) {
    const data = await this.read();
    return (data.auditLogs ?? [])
      .filter((log) => log.action === action)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async listReconciliationRunsView({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const data = await this.read();
    return (data.reconciliationRuns ?? [])
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(offset, offset + limit)
      .map((run) => ({ ...run, findings: (data.reconciliationFindings ?? []).filter((finding) => finding.runId === run.id) }));
  }


  async insertAceSupportRecords(input: { session: AceSupportSessionRecord; messages: AceSupportMessageRecord[]; toolCalls: AceToolCallRecord[]; resolution?: AceSupportResolutionRecord }) {
    return this.mutate((data) => {
      data.aceSupportSessions = data.aceSupportSessions ?? [];
      data.aceSupportMessages = data.aceSupportMessages ?? [];
      data.aceToolCalls = data.aceToolCalls ?? [];
      data.aceSupportResolutions = data.aceSupportResolutions ?? [];
      data.aceSupportSessions.push(input.session);
      data.aceSupportMessages.push(...input.messages);
      data.aceToolCalls.push(...input.toolCalls);
      if (input.resolution) data.aceSupportResolutions.push(input.resolution);
      return input.session;
    });
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

  /** Mirrors the Postgres targeted lookup. See that implementation for why. */
  async latestAuthChallengeForEmail(email: string): Promise<AuthChallengeRecord | null> {
    const data = await this.read();
    const target = email.toLowerCase();
    return (data.authChallenges ?? [])
      .filter((item) => item.email.toLowerCase() === target)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  /** Mirror of the Postgres targeted challenge query. */
  async activeAuthChallengesForEmail(email: string): Promise<AuthChallengeRecord[]> {
    const data = await this.read();
    const now = Date.now();
    return (data.authChallenges ?? [])
      .filter((item) => item.email.toLowerCase() === email.toLowerCase())
      .filter((item) => !item.consumedAt)
      .filter((item) => new Date(item.expiresAt).getTime() > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
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

  async listNgnPayoutAccounts(userId?: string): Promise<NgnPayoutAccountRecord[]> {
    const data = await this.read();
    const all = data.ngnPayoutAccounts ?? [];
    return userId ? all.filter((item) => item.userId === userId) : all;
  }

  async findNgnPayoutAccountById(id: string): Promise<NgnPayoutAccountRecord | null> {
    const data = await this.read();
    return (data.ngnPayoutAccounts ?? []).find((item) => item.id === id) ?? null;
  }

  /**
   * Mirrors the Postgres targeted lookups. See that implementation for why -
   * on this backend read() is a cached in-memory object, so the three calls
   * cost nothing and the win is entirely on Postgres.
   */
  async findCustomerByUserId(userId: string): Promise<CustomerRecord | null> {
    const data = await this.read();
    return (data.customers ?? []).find((item) => item.userId === userId) ?? null;
  }

  async listExternalAccountsByUser(userId: string): Promise<ExternalAccountRecord[]> {
    const data = await this.read();
    return (data.externalAccounts ?? []).filter((item) => item.userId === userId);
  }

  async listNgnTransfersByUserSince(userId: string, sinceIso: string): Promise<NgnTransferRecord[]> {
    const data = await this.read();
    const cutoff = Date.parse(sinceIso);
    return (data.ngnTransfers ?? []).filter((item: any) => {
      if (item.userId !== userId) return false;
      if (item.status !== 'completed' && item.status !== 'settled') return false;
      const at = Date.parse(item.updatedAt ?? item.createdAt ?? '');
      return Number.isFinite(at) && at >= cutoff;
    });
  }

  /**
   * Upsert on (userId, provider, bankId, accountNumber), matching the unique
   * index in migration 037.
   *
   * Re-submitting the same account must UPDATE, not insert. Otherwise a user
   * whose account was rejected could resubmit until a fresh pending row
   * appeared, and the review queue would fill with copies of one decision.
   */
  async upsertNgnPayoutAccountRecord(record: NgnPayoutAccountRecord) {
    return this.mutate((data) => {
      data.ngnPayoutAccounts = data.ngnPayoutAccounts ?? [];
      const index = data.ngnPayoutAccounts.findIndex(
        (item) =>
          item.userId === record.userId &&
          item.provider === record.provider &&
          item.bankId === record.bankId &&
          item.accountNumber === record.accountNumber
      );
      if (index >= 0) {
        // Keep the original id and createdAt: this is the same account, and a
        // reviewer following a link to it must not 404 because a resubmit
        // minted a new id.
        const existing = data.ngnPayoutAccounts[index];
        const merged = { ...record, id: existing.id, createdAt: existing.createdAt };
        data.ngnPayoutAccounts[index] = merged;
        return merged;
      }
      data.ngnPayoutAccounts.push(record);
      return record;
    });
  }

  async insertUserWallet(record: UserWalletRecord) {
    return this.mutate((data) => {
      data.userWallets = data.userWallets ?? [];
      // Idempotent on (userId, chain): a user must never end up with two
      // wallets on the same chain, or deposits could land somewhere the UI
      // is not showing.
      const existing = data.userWallets.find((w) => w.userId === record.userId && w.chain === record.chain && w.status !== 'closed');
      if (existing) return existing;
      data.userWallets.push(record);
      return record;
    });
  }

  async listUserWallets(userId: string): Promise<UserWalletRecord[]> {
    const data = await this.read();
    return (data.userWallets ?? []).filter((w) => w.userId === userId);
  }

  async findUserWallet(userId: string, chain: UserWalletRecord['chain']): Promise<UserWalletRecord | undefined> {
    const data = await this.read();
    return (data.userWallets ?? []).find((w) => w.userId === userId && w.chain === chain && w.status !== 'closed');
  }

  /**
   * The wallet that can SIGN for a network, regardless of which chain string
   * the row happens to be filed under.
   *
   * findUserWallet above matches the chain literally, which is right when you
   * are asking "do I already have a base row" before provisioning one. It is
   * WRONG for spending: base and ethereum are one secp256k1 key at one 0x
   * address, so a wallet stored as 'base' can sign an ethereum transfer and
   * vice versa. Asking literally is what left a real user's 10 USDC send in
   * pending_review with "No ethereum wallet" while their funds sat in a row
   * filed as 'base'.
   *
   * Prefers an exact match so the row's own chain still wins when both exist,
   * then falls back to any wallet in the same family.
   */
  async findUserWalletForNetwork(userId: string, network: string): Promise<UserWalletRecord | undefined> {
    const data = await this.read();
    const open = (data.userWallets ?? []).filter((w) => w.userId === userId && w.status !== 'closed');
    return (
      open.find((w) => w.chain === network) ??
      open.find((w) => walletServesNetwork(w.chain, network))
    );
  }

  /**
   * Every open wallet, across all users.
   *
   * The deposit poller needs to sweep wallets, not users. Going via users would
   * be an N+1 - one listUserWallets call per user - and would silently skip a
   * wallet whose user row was removed. Wallets are the thing money arrives at,
   * so they are the thing to enumerate.
   */
  async listAllOpenWallets(): Promise<UserWalletRecord[]> {
    const data = await this.read();
    return (data.userWallets ?? []).filter((w) => w.status !== 'closed');
  }

  /**
   * Find a wallet by the id the PROVIDER knows it by.
   *
   * Every other lookup here starts from a userId, because every other caller
   * already knows whose wallet it wants. A deposit webhook does not: Privy's
   * wallet.funds_deposited identifies the wallet as `wallet_id` and says
   * nothing about the user, so without this there is no way to answer "whose
   * money is this". Kept for the webhook detectors even though the balance
   * poller does not need it - the poller iterates users and already has one.
   */
  async findWalletByProviderWalletId(providerWalletId: string): Promise<UserWalletRecord | undefined> {
    const data = await this.read();
    return (data.userWallets ?? []).find((w) => w.providerWalletId === providerWalletId && w.status !== 'closed');
  }

  /**
   * Find a wallet by on-chain address, case-insensitively.
   *
   * The address is what an RPC webhook keys on, and it is the only identifier
   * that survives a change of wallet provider - which is the specific reason
   * address-based detection was preferred over Privy's.
   *
   * LOWERCASED ON BOTH SIDES. EVM addresses are hex and arrive in wildly
   * inconsistent case: EIP-55 checksummed from most tooling, all-lowercase
   * from some RPC responses, and whatever the user pasted. A case-sensitive
   * comparison here would silently fail to match a real deposit, which is
   * indistinguishable from the deposit never arriving. Solana base58 IS
   * case-sensitive, but lowercasing both sides of a comparison never creates a
   * false match between two distinct base58 addresses in practice, and being
   * permissive is the safe direction: a missed deposit is a support ticket
   * about lost money, a theoretical collision is not a real failure mode here.
   */
  async findWalletByAddress(address: string): Promise<UserWalletRecord | undefined> {
    const data = await this.read();
    const needle = address.trim().toLowerCase();
    return (data.userWallets ?? []).find((w) => w.address?.trim().toLowerCase() === needle && w.status !== 'closed');
  }

  /**
   * Record a deposit, or return the one already recorded.
   *
   * IDEMPOTENT BY CONTRACT, not by convention. Every detector delivers at
   * least once, and during the poll -> webhook migration two of them run
   * deliberately at the same time. The caller must be able to hand the same
   * observation over repeatedly and get one record.
   *
   * The JSON store is single-process and mutate() serialises, so a scan is
   * safe here. Postgres does this with a UNIQUE index instead, because there
   * a read-then-write genuinely races.
   */
  async insertWalletDepositIfNew(record: WalletDepositRecord): Promise<{ record: WalletDepositRecord; created: boolean }> {
    return this.mutate((data) => {
      data.walletDeposits = data.walletDeposits ?? [];
      const existing = data.walletDeposits.find((d) => d.idempotencyKey === record.idempotencyKey);
      if (existing) return { record: existing, created: false };
      data.walletDeposits.push(record);
      return { record, created: true };
    });
  }

  async listWalletDeposits(userId: string): Promise<WalletDepositRecord[]> {
    const data = await this.read();
    return (data.walletDeposits ?? [])
      .filter((d) => d.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Deposits nobody has been told about yet. Drives the notifier. */
  async listUnnotifiedWalletDeposits(limit = 50): Promise<WalletDepositRecord[]> {
    const data = await this.read();
    return (data.walletDeposits ?? [])
      .filter((d) => !d.notifiedAt && d.status !== 'failed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  /**
   * Stamp notifiedAt, but only if it is still unset.
   *
   * The guard is what makes a double-send impossible: two notifier ticks that
   * overlap both try to claim the row, and only the first succeeds. Returns
   * whether this caller won, so the loser can skip sending.
   */
  async markWalletDepositNotified(id: string, at: string): Promise<boolean> {
    return this.mutate((data) => {
      const found = (data.walletDeposits ?? []).find((d) => d.id === id);
      if (!found || found.notifiedAt) return false;
      found.notifiedAt = at;
      found.updatedAt = at;
      return true;
    });
  }

  async updateWalletDepositStatus(id: string, status: WalletDepositRecord['status'], at: string): Promise<WalletDepositRecord | undefined> {
    return this.mutate((data) => {
      const found = (data.walletDeposits ?? []).find((d) => d.id === id);
      if (!found) return undefined;
      found.status = status;
      found.updatedAt = at;
      return found;
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

  async insertSupplierRecord(record: SupplierRecord) {
    return this.mutate((data) => {
      data.suppliers = data.suppliers ?? [];
      data.suppliers.push(record);
      return record;
    });
  }

  async updateSupplierRecord(record: SupplierRecord) {
    return this.mutate((data) => {
      data.suppliers = data.suppliers ?? [];
      const index = data.suppliers.findIndex((item) => item.id === record.id);
      if (index >= 0) data.suppliers[index] = record;
      else data.suppliers.push(record);
      return record;
    });
  }

  async insertSupplierPaymentRecord(record: SupplierPaymentRecord) {
    return this.mutate((data) => {
      data.supplierPayments = data.supplierPayments ?? [];
      data.supplierPayments.push(record);
      return record;
    });
  }

  async updateSupplierPaymentRecord(record: SupplierPaymentRecord) {
    return this.mutate((data) => {
      data.supplierPayments = data.supplierPayments ?? [];
      const index = data.supplierPayments.findIndex((item) => item.id === record.id);
      if (index >= 0) data.supplierPayments[index] = record;
      else data.supplierPayments.push(record);
      return record;
    });
  }

  async upsertSupplierControlsRecord(record: SupplierControlsRecord) {
    return this.mutate((data) => {
      data.supplierControls = data.supplierControls ?? [];
      const index = data.supplierControls.findIndex((item) => item.id === record.id);
      if (index >= 0) data.supplierControls[index] = record;
      else data.supplierControls.push(record);
      return record;
    });
  }


  async updatePaymentControlsSnapshot(input: { customerTypes: any[]; payoutCurrencies: PaymentControlRecord[]; virtualAccounts: VirtualAccountControlRecord[]; sourceAssets: AssetControlRecord[]; sourceNetworks: NetworkControlRecord[] }) {
    return this.mutate((data) => {
      data.customerTypeControls = input.customerTypes as any;
      data.paymentControls = input.payoutCurrencies;
      data.virtualAccountControls = input.virtualAccounts;
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

  /** Mirrors the Postgres targeted read. See that implementation for why. */
  async getSystemStatusRecord() {
    const data = await this.read();
    return (data.systemStatus ?? []).find((item) => item.id === 'global') ?? null;
  }

  async listSystemIncidentRecords(): Promise<SystemIncidentRecord[]> {
    const data = await this.read();
    return data.systemIncidents ?? [];
  }

  async upsertSystemIncidentRecord(record: SystemIncidentRecord) {
    return this.mutate((data) => {
      data.systemIncidents = data.systemIncidents ?? [];
      const index = data.systemIncidents.findIndex((item) => item.id === record.id);
      if (index >= 0) data.systemIncidents[index] = record;
      else data.systemIncidents.push(record);
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


  async listTransactionReferences(): Promise<TransactionReferenceRecord[]> {
    const data = await this.read();
    return data.transactionReferences ?? [];
  }

  async upsertTransactionReferenceRecord(record: TransactionReferenceRecord) {
    return this.mutate((data) => {
      data.transactionReferences = data.transactionReferences ?? [];
      const index = data.transactionReferences.findIndex((item) => item.id === record.id || (item.provider === record.provider && item.referenceType === record.referenceType && item.referenceValue === record.referenceValue && item.resourceType === record.resourceType && item.resourceId === record.resourceId));
      if (index >= 0) data.transactionReferences[index] = { ...data.transactionReferences[index], ...record };
      else data.transactionReferences.push(record);
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


  async listVirtualAccountRequests(): Promise<VirtualAccountRequestRecord[]> {
    const data = await this.read();
    return data.virtualAccountRequests ?? [];
  }

  async upsertVirtualAccountRequestRecord(record: VirtualAccountRequestRecord) {
    return this.mutate((data) => {
      data.virtualAccountRequests = data.virtualAccountRequests ?? [];
      const index = data.virtualAccountRequests.findIndex((item) => item.id === record.id);
      if (index >= 0) data.virtualAccountRequests[index] = record;
      else data.virtualAccountRequests.push(record);
      return record;
    });
  }

  async listVirtualAccounts(): Promise<VirtualAccountRecord[]> {
    const data = await this.read();
    return data.virtualAccounts ?? [];
  }

  async upsertVirtualAccountRecord(record: VirtualAccountRecord) {
    return this.mutate((data) => {
      data.virtualAccounts = data.virtualAccounts ?? [];
      const index = data.virtualAccounts.findIndex((item) => item.id === record.id);
      if (index >= 0) data.virtualAccounts[index] = record;
      else data.virtualAccounts.push(record);
      return record;
    });
  }


  async listVirtualAccountEvents(): Promise<VirtualAccountEventRecord[]> {
    const data = await this.read();
    return data.virtualAccountEvents ?? [];
  }

  async upsertVirtualAccountEventRecord(record: VirtualAccountEventRecord) {
    return this.mutate((data) => {
      data.virtualAccountEvents = data.virtualAccountEvents ?? [];
      const index = data.virtualAccountEvents.findIndex((item) => item.id === record.id);
      if (index >= 0) data.virtualAccountEvents[index] = record;
      else data.virtualAccountEvents.push(record);
      return record;
    });
  }

  async listVirtualAccountTransactions(): Promise<VirtualAccountTransactionRecord[]> {
    const data = await this.read();
    return data.virtualAccountTransactions ?? [];
  }

  async upsertVirtualAccountTransactionRecord(record: VirtualAccountTransactionRecord) {
    return this.mutate((data) => {
      data.virtualAccountTransactions = data.virtualAccountTransactions ?? [];
      const index = data.virtualAccountTransactions.findIndex((item) => item.id === record.id);
      if (index >= 0) data.virtualAccountTransactions[index] = record;
      else data.virtualAccountTransactions.push(record);
      return record;
    });
  }



  /** Mirror of the Postgres targeted control read. On JSON this is already cheap. */
  async readControlTables() {
    const data = await this.read();
    return {
      customerTypeControls: data.customerTypeControls ?? [],
      paymentControls: data.paymentControls ?? [],
      virtualAccountControls: data.virtualAccountControls ?? [],
      assetControls: data.assetControls ?? [],
      networkControls: data.networkControls ?? [],
    };
  }

  async listNgnControls(): Promise<NgnControlsRecord[]> {
    const data = await this.read();
    return data.ngnControls ?? [];
  }

  async upsertNgnControlsRecord(record: NgnControlsRecord) {
    return this.mutate((data) => {
      data.ngnControls = data.ngnControls ?? [];
      const index = data.ngnControls.findIndex((item) => item.id === record.id);
      if (index >= 0) data.ngnControls[index] = record;
      else data.ngnControls.push(record);
      return record;
    });
  }

  async listWalletControls(): Promise<WalletControlsRecord[]> {
    const data = await this.read();
    return data.walletControls ?? [];
  }

  async upsertWalletControlsRecord(record: WalletControlsRecord) {
    return this.mutate((data) => {
      data.walletControls = data.walletControls ?? [];
      const index = data.walletControls.findIndex((item) => item.id === record.id);
      if (index >= 0) data.walletControls[index] = record;
      else data.walletControls.push(record);
      return record;
    });
  }

  async listVerificationLimitOverrides(): Promise<VerificationLimitOverrideRecord[]> {
    const data = await this.read();
    return data.verificationLimitOverrides ?? [];
  }

  async upsertVerificationLimitOverride(record: Omit<VerificationLimitOverrideRecord, 'id'>) {
    return this.mutate((data) => {
      data.verificationLimitOverrides = data.verificationLimitOverrides ?? [];
      // Keyed on the combination, never on a generated id: two rows for one
      // (flow, rail, level) would make the effective ceiling ambiguous, and
      // which one won would depend on insertion order.
      const index = data.verificationLimitOverrides.findIndex(
        (item) => item.flow === record.flow && item.rail === record.rail && item.level === record.level
      );
      const full: VerificationLimitOverrideRecord = {
        id: `vlo_${record.flow}_${record.rail}_${record.level}`,
        ...record,
      };
      if (index >= 0) data.verificationLimitOverrides[index] = full;
      else data.verificationLimitOverrides.push(full);
      return full;
    });
  }

  async deleteVerificationLimitOverride(flow: string, rail: string, level: number) {
    return this.mutate((data) => {
      data.verificationLimitOverrides = (data.verificationLimitOverrides ?? []).filter(
        (item) => !(item.flow === flow && item.rail === rail && item.level === level)
      );
      return true;
    });
  }

  async listUserLimitOverrides(userId?: string): Promise<UserLimitOverrideRecord[]> {
    const data = await this.read();
    const rows = data.userLimitOverrides ?? [];
    return userId ? rows.filter((item) => item.userId === userId) : rows;
  }

  async upsertUserLimitOverride(record: Omit<UserLimitOverrideRecord, 'id' | 'createdAt'>) {
    return this.mutate((data) => {
      data.userLimitOverrides = data.userLimitOverrides ?? [];
      // Keyed on (user, flow, rail) to match the UNIQUE constraint in
      // migration 043. A second row for the same triple would make "which
      // ceiling applies" depend on insertion order.
      const index = data.userLimitOverrides.findIndex(
        (item) => item.userId === record.userId && item.flow === record.flow && item.rail === record.rail
      );
      const existing = index >= 0 ? data.userLimitOverrides[index] : undefined;
      const full: UserLimitOverrideRecord = {
        id: existing?.id ?? `ulo_${record.userId}_${record.flow}_${record.rail}`,
        createdAt: existing?.createdAt ?? record.updatedAt,
        ...record,
      };
      if (index >= 0) data.userLimitOverrides[index] = full;
      else data.userLimitOverrides.push(full);
      return full;
    });
  }

  async deleteUserLimitOverride(userId: string, flow: string, rail: string) {
    return this.mutate((data) => {
      data.userLimitOverrides = (data.userLimitOverrides ?? []).filter(
        (item) => !(item.userId === userId && item.flow === flow && item.rail === rail)
      );
      return true;
    });
  }

  async listUserLimitResets(userId?: string): Promise<UserLimitResetRecord[]> {
    const data = await this.read();
    const rows = data.userLimitResets ?? [];
    return userId ? rows.filter((item) => item.userId === userId) : rows;
  }

  /**
   * Append-only. A reset is evidence that an admin forgave volume, and
   * overwriting the previous one would erase the fact that it happened.
   */
  async createUserLimitReset(record: UserLimitResetRecord) {
    return this.mutate((data) => {
      data.userLimitResets = data.userLimitResets ?? [];
      data.userLimitResets.push(record);
      return record;
    });
  }

  async listNgnQuotes(): Promise<NgnQuoteRecord[]> {
    const data = await this.read();
    return data.ngnQuotes ?? [];
  }

  async upsertNgnQuoteRecord(record: NgnQuoteRecord) {
    return this.mutate((data) => {
      data.ngnQuotes = data.ngnQuotes ?? [];
      const index = data.ngnQuotes.findIndex((item) => item.id === record.id);
      if (index >= 0) data.ngnQuotes[index] = record;
      else data.ngnQuotes.push(record);
      return record;
    });
  }

  async listNgnTransfers(): Promise<NgnTransferRecord[]> {
    const data = await this.read();
    return data.ngnTransfers ?? [];
  }

  async upsertNgnTransferRecord(record: NgnTransferRecord) {
    return this.mutate((data) => {
      data.ngnTransfers = data.ngnTransfers ?? [];
      const index = data.ngnTransfers.findIndex((item) => item.id === record.id);
      if (index >= 0) data.ngnTransfers[index] = record;
      else data.ngnTransfers.push(record);
      return record;
    });
  }

  async listNgnWebhooks(): Promise<NgnWebhookRecord[]> {
    const data = await this.read();
    return data.ngnWebhooks ?? [];
  }

  async upsertNgnWebhookRecord(record: NgnWebhookRecord) {
    return this.mutate((data) => {
      data.ngnWebhooks = data.ngnWebhooks ?? [];
      const index = data.ngnWebhooks.findIndex((item) => item.id === record.id || (item.provider === record.provider && item.providerEventId === record.providerEventId));
      if (index >= 0) data.ngnWebhooks[index] = record;
      else data.ngnWebhooks.push(record);
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

export const db = (env.DATABASE_PROVIDER === 'postgres' && Boolean(env.DATABASE_URL))
  ? new PostgresDatabase()
  : new JsonDatabase();

