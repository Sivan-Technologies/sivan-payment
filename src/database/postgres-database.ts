import pg from 'pg';
import { env } from '../config/env.js';
import type {
  VerificationLimitOverrideRecord,
  WalletControlsRecord,
  AceSupportMessageRecord,
  AceSupportResolutionRecord,
  AceSupportSessionRecord,
  AceToolCallRecord,
  Chain,
  Currency,
  CustomerRecord,
  DatabaseShape,
  ExternalAccountRecord,
  LiquidationAddressRecord,
  UserWalletRecord,
  SourceCurrency,
  SupplierPayoutCurrency,
  SupplierRecord,
  SupplierPaymentRecord,
  SupplierControlsRecord,
  UserRecord,
  UserPreferencesRecord,
  UserTwoFactorRecord,
  UserTwoFactorRecoveryQuestionRecord,
  WebhookEventRecord,
  WithdrawalRecord,
  AuthChallengeRecord,
  AuditLogRecord,
  ReconciliationRunRecord,
  ReconciliationFindingRecord,
  PaymentControlRecord,
  VirtualAccountControlRecord,
  AssetControlRecord,
  NetworkControlRecord,
  SystemStatusRecord,
  SystemIncidentRecord,
  CustomerTypeControlRecord,
  OnrampOrderRecord,
  SupportTicketRecord,
  SupportTicketMessageRecord,
  UnifiedWebhookLogRecord,
  LegalAcceptanceRecord,
  TransactionReferenceRecord,
  CustomerIdentityLinkRecord,
  IdentityPairingTokenRecord
} from './types.js';
import type { NgnControlsRecord, NgnQuoteRecord, NgnTransferRecord, NgnWebhookRecord } from '../ngn/types/ngn.types.js';
import type { VirtualAccountEventRecord, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord } from '../virtual-accounts/types/virtual-account.types.js';

const { Pool } = pg;


async function optionalQuery(client: pg.PoolClient, sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
  try {
    return await client.query(sql, params);
  } catch (error: any) {
    if (error?.code === '42P01') return { rows: [] };
    throw error;
  }
}

function iso(value: unknown): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function optionalIso(value: unknown): string | undefined {
  if (!value) return undefined;
  return iso(value);
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function numberString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = String(value);
  if (!raw.includes('.')) return raw;
  return raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || fullName || 'Sivan',
    lastName: parts.slice(1).join(' ') || null
  };
}

export class PostgresDatabase {
  private pool: pg.Pool;

  constructor(connectionString = env.DATABASE_URL) {
    if (!connectionString) throw new Error('DATABASE_URL is required when DATABASE_PROVIDER=postgres');
    this.pool = new Pool({ connectionString });
    this.pool.on('error', (error) => {
      console.error('[postgres.pool.error]', error);
    });
    this.instrumentPoolQueries();
  }

  private instrumentPoolQueries() {
    const slowQueryMs = Number(process.env.POSTGRES_SLOW_QUERY_MS ?? 750);
    const originalConnect = this.pool.connect.bind(this.pool);
    this.pool.connect = (async (...args: any[]) => {
      const client = await (originalConnect as any)(...args);
      if ((client as any).__sivanInstrumented) return client;
      const originalQuery = client.query.bind(client);
      client.query = (async (...queryArgs: any[]) => {
        const started = Date.now();
        try {
          return await (originalQuery as any)(...queryArgs);
        } finally {
          const durationMs = Date.now() - started;
          if (durationMs >= slowQueryMs) {
            const sql = typeof queryArgs[0] === 'string' ? queryArgs[0] : queryArgs[0]?.text;
            console.warn('[postgres.slow_query]', { durationMs, sql: String(sql ?? '').replace(/\s+/g, ' ').slice(0, 500), pool: this.getPoolStats() });
          }
        }
      }) as any;
      (client as any).__sivanInstrumented = true;
      return client;
    }) as any;
  }

  getPoolStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount
    };
  }

  async read(): Promise<DatabaseShape> {
    const client = await this.pool.connect();
    try {
      const users = await client.query('select * from users order by created_at asc');
      const userPreferences = await optionalQuery(client, 'select * from payments_user_preferences order by user_id asc');
      const legalAcceptances = await optionalQuery(client, 'select * from payments_legal_acceptances order by accepted_at asc');
      const userTwoFactor = await optionalQuery(client, 'select * from payments_user_two_factor order by user_id asc');
      const userTwoFactorRecoveryQuestions = await optionalQuery(client, 'select * from payments_user_two_factor_recovery_questions order by user_id asc, created_at asc');
      const customers = await client.query('select * from payments_customers order by created_at asc');
      const externalAccounts = await client.query('select * from payments_external_accounts order by created_at asc');
      const liquidationAddresses = await client.query('select * from payments_liquidation_addresses order by created_at asc');
      const withdrawals = await client.query('select * from payments_withdrawals order by created_at asc');
      const onrampOrders = await optionalQuery(client, 'select * from payments_onramp_orders order by created_at asc');
      const suppliers = await optionalQuery(client, 'select * from payments_suppliers order by created_at asc');
      const supplierPayments = await optionalQuery(client, 'select * from payments_supplier_payments order by created_at asc');
      const supplierControls = await optionalQuery(client, 'select * from payments_supplier_controls order by id asc');
      const webhookEvents = await client.query('select * from payments_webhook_events order by created_at asc');
      const authChallenges = await client.query('select * from payments_auth_challenges order by created_at asc');
      const auditLogs = await client.query('select * from payments_audit_logs order by created_at asc');
      const reconciliationRuns = await client.query('select * from payments_reconciliation_runs order by started_at asc');
      const reconciliationFindings = await client.query('select * from payments_reconciliation_findings order by created_at asc');
      const paymentControls = await client.query('select * from payments_control_settings order by currency asc');
      const virtualAccountControls = await optionalQuery(client, 'select * from payments_virtual_account_controls order by currency asc');
      const assetControls = await client.query('select * from payments_asset_controls order by asset asc');
      const networkControls = await client.query('select * from payments_network_controls order by sort_order asc');
      const systemStatus = await client.query('select * from payments_system_status order by id asc');
      const systemIncidents = await optionalQuery(client, 'select * from payments_system_incidents order by started_at desc, created_at desc');
      const customerTypeControls = await client.query('select * from payments_customer_type_controls order by customer_type asc');
      const supportTickets = await optionalQuery(client, 'select * from payments_support_tickets order by created_at asc');
      const supportTicketMessages = await optionalQuery(client, 'select * from payments_support_ticket_messages order by created_at asc');
      const unifiedWebhookLogs = await client.query('select * from sivan_unified_webhook_logs order by created_at asc');
      const transactionReferences = await optionalQuery(client, 'select * from transaction_references order by created_at asc');
      const aceSupportSessions = await optionalQuery(client, 'select * from ace_support_sessions order by created_at asc');
      const aceSupportMessages = await optionalQuery(client, 'select * from ace_support_messages order by created_at asc');
      const aceToolCalls = await optionalQuery(client, 'select * from ace_tool_calls order by created_at asc');
      const aceSupportResolutions = await optionalQuery(client, 'select * from ace_support_resolutions order by created_at asc');
      const customerIdentityLinks = await optionalQuery(client, 'select * from customer_identity_links order by created_at asc');
      const identityPairingTokens = await optionalQuery(client, 'select * from identity_pairing_tokens order by created_at asc');
      const virtualAccountRequests = await optionalQuery(client, 'select * from payments_virtual_account_requests order by created_at asc');
      const virtualAccounts = await optionalQuery(client, 'select * from payments_virtual_accounts order by created_at asc');
      const virtualAccountEvents = await optionalQuery(client, 'select * from payments_virtual_account_events order by created_at asc');
      const virtualAccountTransactions = await optionalQuery(client, 'select * from payments_virtual_account_transactions order by created_at asc');
      const ngnControls = await optionalQuery(client, 'select * from payments_ngn_controls order by id asc');
      const ngnQuotes = await optionalQuery(client, 'select * from payments_ngn_quotes order by created_at asc');
      const ngnTransfers = await optionalQuery(client, 'select * from payments_ngn_transfers order by created_at asc');
      const ngnWebhooks = await optionalQuery(client, 'select * from payments_ngn_webhook_events order by created_at asc');
      const userWallets = await optionalQuery(client, 'select * from payments_user_wallets order by created_at asc');
      const verificationLimitOverrides = await optionalQuery(client, 'select * from payments_verification_limit_overrides order by flow asc, rail asc, level asc');
      const walletControls = await optionalQuery(client, 'select * from payments_wallet_controls order by id asc');

      return {
        users: users.rows.map(mapUser),
        customerIdentityLinks: customerIdentityLinks.rows.map(mapCustomerIdentityLink),
        identityPairingTokens: identityPairingTokens.rows.map(mapIdentityPairingToken),
        virtualAccountRequests: virtualAccountRequests.rows.map(mapVirtualAccountRequest),
        virtualAccounts: virtualAccounts.rows.map(mapVirtualAccount),
        virtualAccountEvents: virtualAccountEvents.rows.map(mapVirtualAccountEvent),
        virtualAccountTransactions: virtualAccountTransactions.rows.map(mapVirtualAccountTransaction),
        ngnControls: ngnControls.rows.map(mapNgnControls),
        verificationLimitOverrides: verificationLimitOverrides.rows.map(mapVerificationLimitOverride),
        walletControls: walletControls.rows.map(mapWalletControls),
        ngnQuotes: ngnQuotes.rows.map(mapNgnQuote),
        ngnTransfers: ngnTransfers.rows.map(mapNgnTransfer),
        ngnWebhooks: ngnWebhooks.rows.map(mapNgnWebhook),
        userPreferences: userPreferences.rows.map(mapUserPreferences),
        userTwoFactor: userTwoFactor.rows.map(mapUserTwoFactor),
        userTwoFactorRecoveryQuestions: userTwoFactorRecoveryQuestions.rows.map(mapUserTwoFactorRecoveryQuestion),
        legalAcceptances: legalAcceptances.rows.map(mapLegalAcceptance),
        customers: customers.rows.map(mapCustomer),
        externalAccounts: externalAccounts.rows.map(mapExternalAccount),
        liquidationAddresses: liquidationAddresses.rows.map(mapLiquidationAddress),
        userWallets: userWallets.rows.map(mapUserWallet),
        withdrawals: withdrawals.rows.map(mapWithdrawal),
        onrampOrders: onrampOrders.rows.map(mapOnrampOrder),
        suppliers: suppliers.rows.map(mapSupplier),
        supplierPayments: supplierPayments.rows.map(mapSupplierPayment),
        supplierControls: supplierControls.rows.map(mapSupplierControls),
        webhookEvents: webhookEvents.rows.map(mapWebhookEvent),
        authChallenges: authChallenges.rows.map(mapAuthChallenge),
        auditLogs: auditLogs.rows.map(mapAuditLog),
        reconciliationRuns: reconciliationRuns.rows.map(mapReconciliationRun),
        reconciliationFindings: reconciliationFindings.rows.map(mapReconciliationFinding),
        paymentControls: paymentControls.rows.map(mapPaymentControl),
        virtualAccountControls: virtualAccountControls.rows.map(mapVirtualAccountControl),
        assetControls: assetControls.rows.map(mapAssetControl),
        networkControls: networkControls.rows.map(mapNetworkControl),
        systemStatus: systemStatus.rows.map(mapSystemStatus),
        systemIncidents: systemIncidents.rows.map(mapSystemIncident),
        customerTypeControls: customerTypeControls.rows.map(mapCustomerTypeControl),
        unifiedWebhookLogs: unifiedWebhookLogs.rows.map(mapUnifiedWebhookLog),
        transactionReferences: transactionReferences.rows.map(mapTransactionReference),
        aceSupportSessions: aceSupportSessions.rows.map(mapAceSupportSession),
        aceSupportMessages: aceSupportMessages.rows.map(mapAceSupportMessage),
        aceToolCalls: aceToolCalls.rows.map(mapAceToolCall),
        aceSupportResolutions: aceSupportResolutions.rows.map(mapAceSupportResolution),
        supportTickets: supportTickets.rows.map(mapSupportTicket),
        supportTicketMessages: supportTicketMessages.rows.map(mapSupportTicketMessage)
      };
    } finally {
      client.release();
    }
  }

  async mutate<T>(_fn: (db: DatabaseShape) => T | Promise<T>): Promise<T> {
    throw new Error('PostgresDatabase.mutate is disabled for production safety. Use direct repository methods instead.');
  }






  async insertLegalAcceptanceRecord(record: LegalAcceptanceRecord) {
    const client = await this.pool.connect();
    try { await upsertLegalAcceptance(client, record); return record; } finally { client.release(); }
  }

  async listLegalAcceptancesForUser(userId: string) {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_legal_acceptances where user_id=$1 order by accepted_at desc', [userId]);
      return result.rows.map(mapLegalAcceptance);
    } finally { client.release(); }
  }

  async getUserPreferencesRecord(userId: string) {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_user_preferences where user_id=$1 limit 1', [userId]);
      return result.rows[0] ? mapUserPreferences(result.rows[0]) : undefined;
    } finally { client.release(); }
  }

  async upsertUserPreferencesRecord(record: UserPreferencesRecord) {
    const client = await this.pool.connect();
    try { await upsertUserPreferences(client, record); return record; } finally { client.release(); }
  }


  async getUserTwoFactorRecord(userId: string) {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_user_two_factor where user_id=$1 limit 1', [userId]);
      return result.rows[0] ? mapUserTwoFactor(result.rows[0]) : undefined;
    } finally { client.release(); }
  }

  async upsertUserTwoFactorRecord(record: UserTwoFactorRecord) {
    const client = await this.pool.connect();
    try { await upsertUserTwoFactor(client, record); return record; } finally { client.release(); }
  }

  async listUserTwoFactorRecoveryQuestionRecords(userId: string) {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_user_two_factor_recovery_questions where user_id=$1 order by created_at asc', [userId]);
      return result.rows.map(mapUserTwoFactorRecoveryQuestion);
    } finally { client.release(); }
  }

  async replaceUserTwoFactorRecoveryQuestionRecords(userId: string, records: UserTwoFactorRecoveryQuestionRecord[]) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await optionalQuery(client, 'delete from payments_user_two_factor_recovery_questions where user_id=$1', [userId]);
      for (const record of records) await upsertUserTwoFactorRecoveryQuestion(client, record);
      await client.query('commit');
      return records;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async getAdminOverviewView() {
    const client = await this.pool.connect();
    try {
      const [users, customers, externalAccounts, liquidationAddresses, withdrawals, onrampOrders, webhookEvents, withdrawalsByStatusRows, webhookEventsByTypeRows, recentUsers, recentCustomers, recentWithdrawals, recentOnrampOrders, recentWebhookEvents] = await Promise.all([
        client.query('select count(*)::int as count from users'),
        client.query('select count(*)::int as count from payments_customers'),
        client.query('select count(*)::int as count from payments_external_accounts'),
        client.query('select count(*)::int as count from payments_liquidation_addresses'),
        client.query('select count(*)::int as count from payments_withdrawals'),
        optionalQuery(client, 'select count(*)::int as count from payments_onramp_orders'),
        client.query('select count(*)::int as count from payments_webhook_events'),
        client.query('select status, count(*)::int as count from payments_withdrawals group by status'),
        client.query("select coalesce(event_category, event_type, 'unknown') as key, count(*)::int as count from payments_webhook_events group by key"),
        client.query('select * from users order by created_at desc limit 10'),
        client.query('select * from payments_customers order by created_at desc limit 10'),
        client.query('select * from payments_withdrawals order by created_at desc limit 10'),
        optionalQuery(client, 'select * from payments_onramp_orders order by created_at desc limit 10'),
        client.query('select * from payments_webhook_events order by created_at desc limit 10')
      ]);
      return {
        counts: {
          users: users.rows[0]?.count ?? 0,
          customers: customers.rows[0]?.count ?? 0,
          externalAccounts: externalAccounts.rows[0]?.count ?? 0,
          liquidationAddresses: liquidationAddresses.rows[0]?.count ?? 0,
          withdrawals: withdrawals.rows[0]?.count ?? 0,
          onrampOrders: onrampOrders.rows[0]?.count ?? 0,
          webhookEvents: webhookEvents.rows[0]?.count ?? 0
        },
        withdrawalsByStatus: Object.fromEntries(withdrawalsByStatusRows.rows.map((row) => [row.status, Number(row.count)])),
        webhookEventsByType: Object.fromEntries(webhookEventsByTypeRows.rows.map((row) => [row.key, Number(row.count)])),
        recent: {
          users: recentUsers.rows.map(mapUser),
          customers: recentCustomers.rows.map(mapCustomer),
          withdrawals: recentWithdrawals.rows.map(mapWithdrawal),
          onrampOrders: recentOnrampOrders.rows.map(mapOnrampOrder),
          webhookEvents: recentWebhookEvents.rows.map(mapWebhookEvent)
        }
      };
    } finally { client.release(); }
  }

  async findUserById(userId: string) {
    const client = await this.pool.connect();
    try {
      const result = await client.query('select * from users where user_id=$1 limit 1', [userId]);
      return result.rows[0] ? mapUser(result.rows[0]) : undefined;
    } finally { client.release(); }
  }

  async findUserByEmail(email: string) {
    const client = await this.pool.connect();
    try {
      const result = await client.query('select * from users where lower(email)=lower($1) limit 1', [email]);
      return result.rows[0] ? mapUser(result.rows[0]) : undefined;
    } finally { client.release(); }
  }


  async findUserByUsername(username: string) {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from users where lower(username)=lower($1) limit 1', [username]);
      return result.rows[0] ? mapUser(result.rows[0]) : undefined;
    } finally { client.release(); }
  }

  async findUserByWhatsappNumber(whatsappNumber: string) {
    const client = await this.pool.connect();
    try {
      const result = await client.query('select * from users where whatsapp_number=$1 limit 1', [whatsappNumber]);
      return result.rows[0] ? mapUser(result.rows[0]) : undefined;
    } finally { client.release(); }
  }

  async listAdminUsersView({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const client = await this.pool.connect();
    try {
      const usersResult = await client.query('select * from users order by created_at asc limit $1 offset $2', [limit, offset]);
      const users = usersResult.rows.map(mapUser);
      const userIds = users.map((user) => user.id);
      if (!userIds.length) return [];
      const customers = (await client.query('select * from payments_customers where user_id = any($1)', [userIds])).rows.map(mapCustomer);
      const externalCounts = await client.query('select user_id, count(*)::int as count from payments_external_accounts where user_id = any($1) group by user_id', [userIds]);
      const withdrawalCounts = await client.query('select user_id, count(*)::int as count from payments_withdrawals where user_id = any($1) group by user_id', [userIds]);
      const onrampCounts = await optionalQuery(client, 'select user_id, count(*)::int as count from payments_onramp_orders group by user_id');
      const identityLinks = await optionalQuery(client, 'select payment_user_id from customer_identity_links where status = $1 and payment_user_id = any($2)', ['linked', userIds]);
      const linkedUserIds = new Set(identityLinks.rows.map((row) => row.payment_user_id));
      const countMap = (rows: any[]) => new Map(rows.filter((row) => userIds.includes(row.user_id)).map((row) => [row.user_id, Number(row.count)]));
      const externalMap = countMap(externalCounts.rows);
      const withdrawalMap = countMap(withdrawalCounts.rows);
      const onrampMap = countMap(onrampCounts.rows);
      return users.map((user) => ({
        ...user,
        customer: customers.find((customer) => customer.userId === user.id) ?? null,
        identityLink: { linked: linkedUserIds.has(user.id) },
        externalAccountCount: externalMap.get(user.id) ?? 0,
        withdrawalCount: withdrawalMap.get(user.id) ?? 0,
        onrampOrderCount: onrampMap.get(user.id) ?? 0
      }));
    } finally { client.release(); }
  }

  async listAdminWithdrawalsView({ limit = 100, offset = 0, status }: { limit?: number; offset?: number; status?: string } = {}) {
    const client = await this.pool.connect();
    try {
      const params: any[] = [];
      let where = '';
      if (status) { params.push(status); where = 'where status=$1'; }
      params.push(limit, offset);
      const result = await client.query(`select * from payments_withdrawals ${where} order by created_at desc limit $${params.length - 1} offset $${params.length}`, params);
      const withdrawals = result.rows.map(mapWithdrawal);
      const userIds = [...new Set(withdrawals.map((item) => item.userId))];
      const accountIds = [...new Set(withdrawals.map((item) => item.externalAccountId))];
      const addressIds = [...new Set(withdrawals.map((item) => item.liquidationAddressId))];
      const users = userIds.length ? (await client.query('select * from users where user_id = any($1)', [userIds])).rows.map(mapUser) : [];
      const accounts = accountIds.length ? (await client.query('select * from payments_external_accounts where id = any($1)', [accountIds])).rows.map(mapExternalAccount) : [];
      const addresses = addressIds.length ? (await client.query('select * from payments_liquidation_addresses where id = any($1)', [addressIds])).rows.map(mapLiquidationAddress) : [];
      return withdrawals.map((withdrawal) => ({
        ...withdrawal,
        user: users.find((user) => user.id === withdrawal.userId) ?? null,
        externalAccount: accounts.find((account) => account.id === withdrawal.externalAccountId) ?? null,
        liquidationAddress: addresses.find((address) => address.id === withdrawal.liquidationAddressId) ?? null
      }));
    } finally { client.release(); }
  }

  async listAdminOnrampOrdersView({ limit = 100, offset = 0, status }: { limit?: number; offset?: number; status?: string } = {}) {
    const client = await this.pool.connect();
    try {
      const params: any[] = [];
      let where = '';
      if (status) { params.push(status); where = 'where status=$1'; }
      params.push(limit, offset);
      const result = await optionalQuery(client, `select * from payments_onramp_orders ${where} order by created_at desc limit $${params.length - 1} offset $${params.length}`, params);
      const orders = result.rows.map(mapOnrampOrder);
      const userIds = [...new Set(orders.map((item) => item.userId))];
      const customerIds = [...new Set(orders.map((item) => item.customerId))];
      const users = userIds.length ? (await client.query('select * from users where user_id = any($1)', [userIds])).rows.map(mapUser) : [];
      const customers = customerIds.length ? (await client.query('select * from payments_customers where id = any($1)', [customerIds])).rows.map(mapCustomer) : [];
      return orders.map((order) => ({ ...order, user: users.find((user) => user.id === order.userId) ?? null, customer: customers.find((customer) => customer.id === order.customerId) ?? null }));
    } finally { client.release(); }
  }

  async listWebhookEventsView({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const client = await this.pool.connect();
    try { return (await client.query('select * from payments_webhook_events order by created_at desc limit $1 offset $2', [limit, offset])).rows.map(mapWebhookEvent); } finally { client.release(); }
  }

  async listAuditLogsView({ limit = 200, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const client = await this.pool.connect();
    try { return (await client.query('select * from payments_audit_logs order by created_at desc limit $1 offset $2', [limit, offset])).rows.map(mapAuditLog); } finally { client.release(); }
  }

  async listReconciliationRunsView({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const client = await this.pool.connect();
    try {
      const runs = (await client.query('select * from payments_reconciliation_runs order by started_at desc limit $1 offset $2', [limit, offset])).rows.map(mapReconciliationRun);
      const runIds = runs.map((run) => run.id);
      const findings = runIds.length ? (await client.query('select * from payments_reconciliation_findings where run_id = any($1) order by created_at asc', [runIds])).rows.map(mapReconciliationFinding) : [];
      return runs.map((run) => ({ ...run, findings: findings.filter((finding) => finding.runId === run.id) }));
    } finally { client.release(); }
  }


  async insertAceSupportRecords(input: { session: AceSupportSessionRecord; messages: AceSupportMessageRecord[]; toolCalls: AceToolCallRecord[]; resolution?: AceSupportResolutionRecord }) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await upsertAceSupportSession(client, input.session);
      for (const message of input.messages) await upsertAceSupportMessage(client, message);
      for (const call of input.toolCalls) await upsertAceToolCall(client, call);
      if (input.resolution) await upsertAceSupportResolution(client, input.resolution);
      await client.query('commit');
      return input.session;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }



  async listNgnControls(): Promise<NgnControlsRecord[]> {
    const client = await this.pool.connect();
    try { return (await optionalQuery(client, 'select * from payments_ngn_controls order by id asc')).rows.map(mapNgnControls); } finally { client.release(); }
  }

  async upsertNgnControlsRecord(record: NgnControlsRecord) {
    const client = await this.pool.connect();
    try { await upsertNgnControls(client, record); return record; } finally { client.release(); }
  }

  async listWalletControls(): Promise<WalletControlsRecord[]> {
    const client = await this.pool.connect();
    try {
      return (await optionalQuery(client, 'select * from payments_wallet_controls order by id asc')).rows.map(mapWalletControls);
    } finally { client.release(); }
  }

  async upsertWalletControlsRecord(record: WalletControlsRecord) {
    const client = await this.pool.connect();
    try {
      // Migration 035 may not have run yet - Render applies migrations at
      // build time, so a service can briefly be on new code with an old
      // schema. Reads already degrade to [] via optionalQuery; a write must
      // fail with something an operator can act on rather than a bare
      // "relation does not exist".
      await client.query(
        `insert into payments_wallet_controls (id, active_provider, reason, updated_by, updated_at)
         values ($1,$2,$3,$4,$5)
         on conflict (id) do update set
           active_provider = excluded.active_provider,
           reason = excluded.reason,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
        [record.id, record.activeProvider ?? null, record.reason ?? null, record.updatedBy, record.updatedAt]
      ).catch((error: any) => {
        if (error?.code === '42P01') {
          throw new Error(
            'Wallet controls are unavailable: migration 035 has not been applied yet. ' +
            'The WALLET_PROVIDER environment variable remains in effect until it is.'
          );
        }
        throw error;
      });
      return record;
    } finally { client.release(); }
  }

  async listVerificationLimitOverrides(): Promise<VerificationLimitOverrideRecord[]> {
    const client = await this.pool.connect();
    try {
      return (await optionalQuery(client, 'select * from payments_verification_limit_overrides order by flow asc, rail asc, level asc')).rows.map(mapVerificationLimitOverride);
    } finally { client.release(); }
  }

  async upsertVerificationLimitOverride(record: Omit<VerificationLimitOverrideRecord, 'id'>) {
    const client = await this.pool.connect();
    const full: VerificationLimitOverrideRecord = { id: `vlo_${record.flow}_${record.rail}_${record.level}`, ...record };
    try {
      // Conflict target is the COMBINATION, not the id. Two rows for one
      // (flow, rail, level) would make the effective ceiling depend on row
      // order, which is not a property a compliance limit may have.
      await client.query(
        `insert into payments_verification_limit_overrides (id, flow, rail, level, cumulative_ngn, reason, updated_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (flow, rail, level) do update set
           cumulative_ngn = excluded.cumulative_ngn,
           reason = excluded.reason,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
        [full.id, full.flow, full.rail, full.level, full.cumulativeNgn, full.reason ?? null, full.updatedBy, full.updatedAt]
      );
      return full;
    } finally { client.release(); }
  }

  async deleteVerificationLimitOverride(flow: string, rail: string, level: number) {
    const client = await this.pool.connect();
    try {
      await client.query('delete from payments_verification_limit_overrides where flow = $1 and rail = $2 and level = $3', [flow, rail, level]);
      return true;
    } finally { client.release(); }
  }

  async listNgnQuotes(): Promise<NgnQuoteRecord[]> {
    const client = await this.pool.connect();
    try { return (await optionalQuery(client, 'select * from payments_ngn_quotes order by created_at asc')).rows.map(mapNgnQuote); } finally { client.release(); }
  }

  async upsertNgnQuoteRecord(record: NgnQuoteRecord) {
    const client = await this.pool.connect();
    try { await upsertNgnQuote(client, record); return record; } finally { client.release(); }
  }

  async listNgnTransfers(): Promise<NgnTransferRecord[]> {
    const client = await this.pool.connect();
    try { return (await optionalQuery(client, 'select * from payments_ngn_transfers order by created_at asc')).rows.map(mapNgnTransfer); } finally { client.release(); }
  }

  async upsertNgnTransferRecord(record: NgnTransferRecord) {
    const client = await this.pool.connect();
    try { await upsertNgnTransfer(client, record); return record; } finally { client.release(); }
  }

  async listNgnWebhooks(): Promise<NgnWebhookRecord[]> {
    const client = await this.pool.connect();
    try { return (await optionalQuery(client, 'select * from payments_ngn_webhook_events order by created_at asc')).rows.map(mapNgnWebhook); } finally { client.release(); }
  }

  async upsertNgnWebhookRecord(record: NgnWebhookRecord) {
    const client = await this.pool.connect();
    try { await upsertNgnWebhook(client, record); return record; } finally { client.release(); }
  }
  async insertSupportTicketRecord(record: SupportTicketRecord) {
    const client = await this.pool.connect();
    try { await upsertSupportTicket(client, record); return record; } finally { client.release(); }
  }

  async updateSupportTicketRecord(record: SupportTicketRecord) {
    const client = await this.pool.connect();
    try { await upsertSupportTicket(client, record); return record; } finally { client.release(); }
  }

  async insertSupportTicketMessageRecord(record: SupportTicketMessageRecord) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await upsertSupportTicketMessage(client, record);
      await client.query('update payments_support_tickets set last_message_at=$1, updated_at=$1 where id=$2', [record.createdAt, record.ticketId]);
      await client.query('commit');
      return record;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async getSupportTicketView(ticketId: string) {
    const client = await this.pool.connect();
    try {
      const ticketResult = await optionalQuery(client, 'select * from payments_support_tickets where id=$1 limit 1', [ticketId]);
      const ticket = ticketResult.rows[0] ? mapSupportTicket(ticketResult.rows[0]) : undefined;
      if (!ticket) return undefined;
      const messages = (await optionalQuery(client, 'select * from payments_support_ticket_messages where ticket_id=$1 order by created_at asc', [ticket.id])).rows.map(mapSupportTicketMessage);
      const userResult = await client.query('select * from users where user_id=$1 limit 1', [ticket.userId]);
      return { ...ticket, messages, user: userResult.rows[0] ? mapUser(userResult.rows[0]) : null };
    } finally { client.release(); }
  }

  async listUserSupportTicketsView(userId: string, { limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const client = await this.pool.connect();
    try { return (await optionalQuery(client, 'select * from payments_support_tickets where user_id=$1 order by created_at desc limit $2 offset $3', [userId, limit, offset])).rows.map(mapSupportTicket); } finally { client.release(); }
  }

  async listAdminSupportTicketsView({ limit = 100, offset = 0, status, priority, type, assignedTo, search, dateFrom, dateTo }: { limit?: number; offset?: number; status?: string; priority?: string; type?: string; assignedTo?: string; search?: string; dateFrom?: string; dateTo?: string } = {}) {
    const client = await this.pool.connect();
    try {
      const clauses: string[] = [];
      const params: any[] = [];
      if (status) { params.push(status); clauses.push(`status=$${params.length}`); }
      if (priority) { params.push(priority); clauses.push(`priority=$${params.length}`); }
      if (type) { params.push(type); clauses.push(`ticket_type=$${params.length}`); }
      if (assignedTo) { params.push(assignedTo); clauses.push(`assigned_to=$${params.length}`); }
      if (dateFrom) { params.push(dateFrom); clauses.push(`created_at >= $${params.length}`); }
      if (dateTo) { params.push(dateTo); clauses.push(`created_at <= $${params.length}`); }
      if (search) { params.push(`%${search}%`); clauses.push(`(id ilike $${params.length} or user_id ilike $${params.length} or subject ilike $${params.length} or resource_id ilike $${params.length})`); }
      params.push(limit, offset);
      const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
      const tickets = (await optionalQuery(client, `select * from payments_support_tickets ${where} order by created_at desc limit $${params.length - 1} offset $${params.length}`, params)).rows.map(mapSupportTicket);
      const userIds = [...new Set(tickets.map((ticket) => ticket.userId))];
      const ticketIds = tickets.map((ticket) => ticket.id);
      const users = userIds.length ? (await client.query('select * from users where user_id = any($1)', [userIds])).rows.map(mapUser) : [];
      const messageCounts = ticketIds.length ? (await optionalQuery(client, 'select ticket_id, count(*)::int as count from payments_support_ticket_messages where ticket_id = any($1) group by ticket_id', [ticketIds])).rows : [];
      const countMap = new Map(messageCounts.map((row) => [row.ticket_id, Number(row.count)]));
      return tickets.map((ticket) => ({ ...ticket, user: users.find((user) => user.id === ticket.userId) ?? null, messageCount: countMap.get(ticket.id) ?? 0 }));
    } finally { client.release(); }
  }

  async insertAuditLogRecord(record: AuditLogRecord) {
    const client = await this.pool.connect();
    try { await upsertAuditLog(client, record); return record; } finally { client.release(); }
  }

  async insertAuthChallengeRecord(record: AuthChallengeRecord) {
    const client = await this.pool.connect();
    try { await upsertAuthChallenge(client, record); return record; } finally { client.release(); }
  }

  async consumeAuthChallengeAndMarkUserEmail(challengeId: string, userId: string, now: string) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const challenge = await client.query('update payments_auth_challenges set consumed_at=$1 where id=$2 returning *', [now, challengeId]);
      await client.query('update users set email_verified_at=coalesce(email_verified_at,$1), updated_at=$1 where user_id=$2', [now, userId]);
      await client.query('commit');
      return challenge.rows[0] ? mapAuthChallenge(challenge.rows[0]) : null;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async insertUserRecord(record: UserRecord) {
    const client = await this.pool.connect();
    try { await upsertUser(client, record); return record; } finally { client.release(); }
  }

  async updateUserRecord(record: UserRecord) {
    const client = await this.pool.connect();
    try { await upsertUser(client, record); return record; } finally { client.release(); }
  }

  async listCustomerIdentityLinks(): Promise<CustomerIdentityLinkRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from customer_identity_links order by created_at asc');
      return result.rows.map(mapCustomerIdentityLink);
    } finally { client.release(); }
  }

  async upsertCustomerIdentityLinkRecord(record: CustomerIdentityLinkRecord) {
    const client = await this.pool.connect();
    try { await upsertCustomerIdentityLink(client, record); return record; } finally { client.release(); }
  }

  async listIdentityPairingTokens(): Promise<IdentityPairingTokenRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from identity_pairing_tokens order by created_at asc');
      return result.rows.map(mapIdentityPairingToken);
    } finally { client.release(); }
  }

  async upsertIdentityPairingTokenRecord(record: IdentityPairingTokenRecord) {
    const client = await this.pool.connect();
    try { await upsertIdentityPairingToken(client, record); return record; } finally { client.release(); }
  }

  async listVirtualAccountRequests(): Promise<VirtualAccountRequestRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_virtual_account_requests order by created_at asc');
      return result.rows.map(mapVirtualAccountRequest);
    } finally { client.release(); }
  }

  async upsertVirtualAccountRequestRecord(record: VirtualAccountRequestRecord) {
    const client = await this.pool.connect();
    try { await upsertVirtualAccountRequest(client, record); return record; } finally { client.release(); }
  }

  async listVirtualAccounts(): Promise<VirtualAccountRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_virtual_accounts order by created_at asc');
      return result.rows.map(mapVirtualAccount);
    } finally { client.release(); }
  }

  async upsertVirtualAccountRecord(record: VirtualAccountRecord) {
    const client = await this.pool.connect();
    try { await upsertVirtualAccount(client, record); return record; } finally { client.release(); }
  }

  async listVirtualAccountEvents(): Promise<VirtualAccountEventRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_virtual_account_events order by created_at asc');
      return result.rows.map(mapVirtualAccountEvent);
    } finally { client.release(); }
  }

  async upsertVirtualAccountEventRecord(record: VirtualAccountEventRecord) {
    const client = await this.pool.connect();
    try { await upsertVirtualAccountEvent(client, record); return record; } finally { client.release(); }
  }

  async listVirtualAccountTransactions(): Promise<VirtualAccountTransactionRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_virtual_account_transactions order by created_at asc');
      return result.rows.map(mapVirtualAccountTransaction);
    } finally { client.release(); }
  }

  async upsertVirtualAccountTransactionRecord(record: VirtualAccountTransactionRecord) {
    const client = await this.pool.connect();
    try { await upsertVirtualAccountTransaction(client, record); return record; } finally { client.release(); }
  }

  async insertCustomerRecord(record: CustomerRecord) {
    const client = await this.pool.connect();
    try { await upsertCustomer(client, record); return record; } finally { client.release(); }
  }

  async updateCustomerRecord(record: CustomerRecord) {
    const client = await this.pool.connect();
    try { await upsertCustomer(client, record); return record; } finally { client.release(); }
  }

  async insertExternalAccountRecord(record: ExternalAccountRecord) {
    const client = await this.pool.connect();
    try { await upsertExternalAccount(client, record); return record; } finally { client.release(); }
  }

  async updateExternalAccountRecord(record: ExternalAccountRecord) {
    const client = await this.pool.connect();
    try { await upsertExternalAccount(client, record); return record; } finally { client.release(); }
  }

  async insertUserWallet(record: UserWalletRecord): Promise<UserWalletRecord> {
    const client = await this.pool.connect();
    try {
      // Unique index on (user_id, chain) where status <> 'closed' makes this
      // idempotent: a retry returns the existing wallet rather than issuing a
      // second address the UI would not be showing.
      const result = await client.query(
        `insert into payments_user_wallets
           (id, user_id, payments_customer_id, provider, provider_wallet_id, chain, address, status, custodial, delegated_signing_enabled, delegated_signer_id, raw, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), now())
         on conflict (user_id, chain) where status <> 'closed'
         do update set updated_at = now()
         returning *`,
        [record.id, record.userId, record.customerId, record.provider, record.providerWalletId,
         record.chain, record.address, record.status, record.custodial,
         record.delegatedSigningEnabled ?? false, record.delegatedSignerId ?? null, record.raw ?? null]
      );
      return mapUserWallet(result.rows[0]);
    } finally { client.release(); }
  }

  async listUserWallets(userId: string): Promise<UserWalletRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from payments_user_wallets where user_id = $1 order by created_at asc', [userId]);
      return result.rows.map(mapUserWallet);
    } finally { client.release(); }
  }

  async findUserWallet(userId: string, chain: UserWalletRecord['chain']): Promise<UserWalletRecord | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, `select * from payments_user_wallets where user_id = $1 and chain = $2 and status <> 'closed' limit 1`, [userId, chain]);
      return result.rows[0] ? mapUserWallet(result.rows[0]) : undefined;
    } finally { client.release(); }
  }

  async createWithdrawalRecords(liquidationAddress: LiquidationAddressRecord, withdrawal: WithdrawalRecord) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await upsertLiquidationAddress(client, liquidationAddress);
      await upsertWithdrawal(client, withdrawal);
      await client.query('commit');
      return { liquidationAddress, withdrawal };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async insertOnrampOrderRecord(record: OnrampOrderRecord) {
    const client = await this.pool.connect();
    try { await upsertOnrampOrder(client, record); return record; } finally { client.release(); }
  }

  async updateOnrampOrderRecord(record: OnrampOrderRecord) {
    const client = await this.pool.connect();
    try { await upsertOnrampOrder(client, record); return record; } finally { client.release(); }
  }

  async insertSupplierRecord(record: SupplierRecord) {
    const client = await this.pool.connect();
    try { await upsertSupplier(client, record); return record; } finally { client.release(); }
  }

  async updateSupplierRecord(record: SupplierRecord) {
    const client = await this.pool.connect();
    try { await upsertSupplier(client, record); return record; } finally { client.release(); }
  }

  async insertSupplierPaymentRecord(record: SupplierPaymentRecord) {
    const client = await this.pool.connect();
    try { await upsertSupplierPayment(client, record); return record; } finally { client.release(); }
  }

  async updateSupplierPaymentRecord(record: SupplierPaymentRecord) {
    const client = await this.pool.connect();
    try { await upsertSupplierPayment(client, record); return record; } finally { client.release(); }
  }

  async upsertSupplierControlsRecord(record: SupplierControlsRecord) {
    const client = await this.pool.connect();
    try { await upsertSupplierControls(client, record); return record; } finally { client.release(); }
  }


  async updatePaymentControlsSnapshot(input: { customerTypes: CustomerTypeControlRecord[]; payoutCurrencies: PaymentControlRecord[]; virtualAccounts: VirtualAccountControlRecord[]; sourceAssets: AssetControlRecord[]; sourceNetworks: NetworkControlRecord[] }) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const control of input.customerTypes) await upsertCustomerTypeControl(client, control);
      for (const control of input.payoutCurrencies) await upsertPaymentControl(client, control);
      for (const control of input.virtualAccounts) await upsertVirtualAccountControl(client, control);
      for (const control of input.sourceAssets) await upsertAssetControl(client, control);
      for (const control of input.sourceNetworks) await upsertNetworkControl(client, control);
      await client.query('commit');
      return input;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async updateSystemStatusRecord(record: SystemStatusRecord) {
    const client = await this.pool.connect();
    try { await upsertSystemStatus(client, record); return record; } finally { client.release(); }
  }

  async listSystemIncidentRecords(): Promise<SystemIncidentRecord[]> {
    const client = await this.pool.connect();
    try { return (await optionalQuery(client, 'select * from payments_system_incidents order by started_at desc, created_at desc')).rows.map(mapSystemIncident); } finally { client.release(); }
  }

  async upsertSystemIncidentRecord(record: SystemIncidentRecord) {
    const client = await this.pool.connect();
    try { await upsertSystemIncident(client, record); return record; } finally { client.release(); }
  }

  async insertReconciliationRecords(run: ReconciliationRunRecord, findings: ReconciliationFindingRecord[]) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await upsertReconciliationRun(client, run);
      for (const finding of findings) await upsertReconciliationFinding(client, finding);
      await client.query('commit');
      return run;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async updateWithdrawalRecord(record: WithdrawalRecord) {
    const client = await this.pool.connect();
    try { await upsertWithdrawal(client, record); return record; } finally { client.release(); }
  }


  async insertWebhookEventRecord(record: WebhookEventRecord) {
    const client = await this.pool.connect();
    try { await upsertWebhookEvent(client, record); return record; } finally { client.release(); }
  }

  async listTransactionReferences(): Promise<TransactionReferenceRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await optionalQuery(client, 'select * from transaction_references order by created_at asc');
      return result.rows.map(mapTransactionReference);
    } finally { client.release(); }
  }

  async upsertTransactionReferenceRecord(record: TransactionReferenceRecord) {
    const client = await this.pool.connect();
    try { await upsertTransactionReference(client, record); return record; } finally { client.release(); }
  }

  async insertUnifiedWebhookLogRecord(record: UnifiedWebhookLogRecord) {
    const client = await this.pool.connect();
    try { await upsertUnifiedWebhookLog(client, record); return record; } finally { client.release(); }
  }

  async updateWebhookEventRecord(record: WebhookEventRecord) {
    const client = await this.pool.connect();
    try { await upsertWebhookEvent(client, record); return record; } finally { client.release(); }
  }

  private async persist(data: DatabaseShape): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const user of data.users) await upsertUser(client, user);
      for (const preferences of data.userPreferences ?? []) await upsertUserPreferences(client, preferences);
      for (const twoFactor of data.userTwoFactor ?? []) await upsertUserTwoFactor(client, twoFactor);
      for (const question of data.userTwoFactorRecoveryQuestions ?? []) await upsertUserTwoFactorRecoveryQuestion(client, question);
      for (const acceptance of data.legalAcceptances ?? []) await upsertLegalAcceptance(client, acceptance);
      for (const customer of data.customers) await upsertCustomer(client, customer);
      for (const account of data.externalAccounts) await upsertExternalAccount(client, account);
      for (const address of data.liquidationAddresses) await upsertLiquidationAddress(client, address);
      for (const withdrawal of data.withdrawals) await upsertWithdrawal(client, withdrawal);
      for (const order of data.onrampOrders ?? []) await upsertOnrampOrder(client, order);
      for (const supplier of data.suppliers ?? []) await upsertSupplier(client, supplier);
      for (const payment of data.supplierPayments ?? []) await upsertSupplierPayment(client, payment);
      for (const control of data.supplierControls ?? []) await upsertSupplierControls(client, control);
      for (const event of data.webhookEvents) await upsertWebhookEvent(client, event);
      for (const challenge of data.authChallenges ?? []) await upsertAuthChallenge(client, challenge);
      for (const auditLog of data.auditLogs ?? []) await upsertAuditLog(client, auditLog);
      for (const run of data.reconciliationRuns ?? []) await upsertReconciliationRun(client, run);
      for (const finding of data.reconciliationFindings ?? []) await upsertReconciliationFinding(client, finding);
      for (const control of data.paymentControls ?? []) await upsertPaymentControl(client, control);
      for (const control of data.assetControls ?? []) await upsertAssetControl(client, control);
      for (const control of data.networkControls ?? []) await upsertNetworkControl(client, control);
      for (const status of data.systemStatus ?? []) await upsertSystemStatus(client, status);
      for (const incident of data.systemIncidents ?? []) await upsertSystemIncident(client, incident);
      for (const control of data.customerTypeControls ?? []) await upsertCustomerTypeControl(client, control);
      for (const log of data.unifiedWebhookLogs ?? []) await upsertUnifiedWebhookLog(client, log);
      for (const reference of data.transactionReferences ?? []) await upsertTransactionReference(client, reference);
      for (const session of data.aceSupportSessions ?? []) await upsertAceSupportSession(client, session);
      for (const message of data.aceSupportMessages ?? []) await upsertAceSupportMessage(client, message);
      for (const call of data.aceToolCalls ?? []) await upsertAceToolCall(client, call);
      for (const resolution of data.aceSupportResolutions ?? []) await upsertAceSupportResolution(client, resolution);
      for (const ticket of data.supportTickets ?? []) await upsertSupportTicket(client, ticket);
      for (const message of data.supportTicketMessages ?? []) await upsertSupportTicketMessage(client, message);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}



function mapLegalAcceptance(row: any): LegalAcceptanceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    termsVersion: row.terms_version,
    privacyVersion: row.privacy_version,
    riskDisclosureVersion: row.risk_disclosure_version,
    acceptedAt: iso(row.accepted_at),
    ipAddress: str(row.ip_address),
    userAgent: str(row.user_agent),
    source: row.source,
    createdAt: iso(row.created_at)
  };
}

async function upsertLegalAcceptance(client: pg.PoolClient, item: LegalAcceptanceRecord) {
  await client.query(
    `insert into payments_legal_acceptances (id, user_id, email, terms_version, privacy_version, risk_disclosure_version, accepted_at, ip_address, user_agent, source, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do nothing`,
    [item.id, item.userId, item.email, item.termsVersion, item.privacyVersion, item.riskDisclosureVersion, item.acceptedAt, item.ipAddress, item.userAgent, item.source, item.createdAt]
  );
}

function mapUserPreferences(row: any): UserPreferencesRecord {
  return {
    userId: row.user_id,
    defaultFiatCurrency: row.default_fiat_currency,
    language: row.language,
    transactionUpdates: row.transaction_updates,
    marketingEmails: row.marketing_emails,
    securityAlerts: row.security_alerts,
    emailConfirmationsForHighValue: row.email_confirmations_for_high_value,
    updatedAt: iso(row.updated_at)
  };
}

async function upsertUserPreferences(client: pg.PoolClient, item: UserPreferencesRecord) {
  await client.query(
    `insert into payments_user_preferences (user_id, default_fiat_currency, language, transaction_updates, marketing_emails, security_alerts, email_confirmations_for_high_value, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (user_id) do update set
       default_fiat_currency=excluded.default_fiat_currency,
       language=excluded.language,
       transaction_updates=excluded.transaction_updates,
       marketing_emails=excluded.marketing_emails,
       security_alerts=excluded.security_alerts,
       email_confirmations_for_high_value=excluded.email_confirmations_for_high_value,
       updated_at=excluded.updated_at`,
    [item.userId, item.defaultFiatCurrency, item.language, item.transactionUpdates, item.marketingEmails, item.securityAlerts, item.emailConfirmationsForHighValue, item.updatedAt]
  );
}


function mapUserTwoFactor(row: any): UserTwoFactorRecord {
  return {
    userId: row.user_id,
    enabled: Boolean(row.enabled),
    secretEncrypted: row.secret_encrypted,
    recoveryCodeHashes: row.recovery_code_hashes ?? [],
    enabledAt: optionalIso(row.enabled_at),
    lastVerifiedAt: optionalIso(row.last_verified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertUserTwoFactor(client: pg.PoolClient, item: UserTwoFactorRecord) {
  await client.query(
    `insert into payments_user_two_factor (user_id, enabled, secret_encrypted, recovery_code_hashes, enabled_at, last_verified_at, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (user_id) do update set
       enabled=excluded.enabled,
       secret_encrypted=excluded.secret_encrypted,
       recovery_code_hashes=excluded.recovery_code_hashes,
       enabled_at=excluded.enabled_at,
       last_verified_at=excluded.last_verified_at,
       updated_at=excluded.updated_at`,
    [item.userId, item.enabled, item.secretEncrypted, item.recoveryCodeHashes, item.enabledAt ?? null, item.lastVerifiedAt ?? null, item.createdAt, item.updatedAt]
  );
}

function mapUserTwoFactorRecoveryQuestion(row: any): UserTwoFactorRecoveryQuestionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    questionId: row.question_id,
    questionText: row.question_text,
    answerHash: row.answer_hash,
    answerSalt: row.answer_salt,
    algorithm: row.algorithm || 'scrypt-sha256-v1',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertUserTwoFactorRecoveryQuestion(client: pg.PoolClient, item: UserTwoFactorRecoveryQuestionRecord) {
  await client.query(
    `insert into payments_user_two_factor_recovery_questions (id, user_id, question_id, question_text, answer_hash, answer_salt, algorithm, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do update set
       question_id=excluded.question_id,
       question_text=excluded.question_text,
       answer_hash=excluded.answer_hash,
       answer_salt=excluded.answer_salt,
       algorithm=excluded.algorithm,
       updated_at=excluded.updated_at`,
    [item.id, item.userId, item.questionId, item.questionText, item.answerHash, item.answerSalt, item.algorithm, item.createdAt, item.updatedAt]
  );
}

function mapUser(row: any): UserRecord {
  const first = row.first_name ?? '';
  const last = row.last_name ?? '';
  const displayIdentity = row.email ?? row.whatsapp_number ?? row.user_id;
  return {
    id: row.user_id,
    email: row.email ?? '',
    whatsappNumber: str(row.whatsapp_number),
    fullName: [first, last].filter(Boolean).join(' ') || displayIdentity,
    username: str(row.username),
    usernameUpdatedAt: optionalIso(row.username_updated_at),
    primaryChannel: row.primary_channel,
    avatarUrl: str(row.avatar_url),
    avatarObjectKey: str(row.avatar_object_key),
    avatarUpdatedAt: optionalIso(row.avatar_updated_at),
    emailVerifiedAt: optionalIso(row.email_verified_at),
    whatsappVerifiedAt: optionalIso(row.whatsapp_verified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapCustomer(row: any): CustomerRecord {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerCustomerId: row.provider_customer_id,
    customerType: row.customer_type,
    kycLinkId: str(row.kyc_link_id),
    kycLink: str(row.kyc_link),
    tosLink: str(row.tos_link),
    kycStatus: row.kyc_status,
    tosStatus: row.tos_status,
    onboardingCostUsd: numberString(row.onboarding_cost_usd),
    onboardingCostType: row.onboarding_cost_type,
    onboardingCostRecordedAt: optionalIso(row.onboarding_cost_recorded_at),
    raw: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapExternalAccount(row: any): ExternalAccountRecord {
  return {
    id: row.id,
    userId: row.user_id,
    customerId: row.payments_customer_id,
    provider: row.provider,
    providerExternalAccountId: row.provider_external_account_id,
    currency: row.currency as Currency,
    accountType: row.account_type,
    bankName: str(row.bank_name),
    accountName: str(row.account_name),
    accountOwnerName: row.account_owner_name,
    accountLast4: str(row.account_last4),
    paymentRail: row.payment_rail,
    status: row.status,
    raw: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapUserWallet(row: any): UserWalletRecord {
  return {
    id: row.id,
    userId: row.user_id,
    customerId: row.payments_customer_id,
    provider: row.provider,
    providerWalletId: row.provider_wallet_id,
    chain: row.chain,
    address: row.address,
    status: row.status,
    custodial: row.custodial,
    delegatedSigningEnabled: row.delegated_signing_enabled ?? false,
    delegatedSignerId: row.delegated_signer_id ?? undefined,
    raw: row.raw ?? undefined,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

function mapLiquidationAddress(row: any): LiquidationAddressRecord {
  return {
    id: row.id,
    userId: row.user_id,
    customerId: row.payments_customer_id,
    externalAccountId: row.payments_external_account_id,
    provider: row.provider,
    providerLiquidationAddressId: row.provider_liquidation_address_id,
    address: row.address,
    memolessAddress: str(row.memoless_address),
    chain: row.chain as Chain,
    sourceCurrency: row.source_currency as SourceCurrency,
    destinationCurrency: row.destination_currency as Currency,
    destinationPaymentRail: row.destination_payment_rail,
    returnAddress: str(row.return_address),
    returnInstructions: row.return_instructions,
    customDeveloperFeePercent: numberString(row.custom_developer_fee_percent),
    status: row.status,
    raw: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapWithdrawal(row: any): WithdrawalRecord {
  return {
    id: row.id,
    userId: row.user_id,
    customerId: row.payments_customer_id,
    externalAccountId: row.payments_external_account_id,
    liquidationAddressId: row.payments_liquidation_address_id,
    provider: row.provider,
    providerDrainId: str(row.provider_drain_id),
    sourceCurrency: row.source_currency as SourceCurrency,
    destinationCurrency: row.destination_currency as Currency,
    sourceAmount: numberString(row.source_amount),
    destinationAmount: numberString(row.destination_amount),
    feePercent: numberString(row.fee_percent),
    feeAmount: numberString(row.fee_amount),
    depositTxHash: str(row.deposit_tx_hash),
    destinationReference: str(row.destination_reference),
    destinationTxHash: str(row.destination_tx_hash),
    status: row.status,
    statusReason: str(row.status_reason),
    raw: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: optionalIso(row.completed_at)
  };
}


function mapOnrampOrder(row: any): OnrampOrderRecord {
  return {
    id: row.id,
    userId: row.user_id,
    customerId: row.payments_customer_id,
    provider: row.provider,
    providerTransferId: str(row.provider_transfer_id),
    sourceCurrency: row.source_currency,
    sourcePaymentRail: row.source_payment_rail,
    destinationCurrency: row.destination_currency,
    destinationChain: row.destination_chain,
    destinationAddress: row.destination_address,
    amount: numberString(row.amount) ?? '0',
    feePercent: numberString(row.fee_percent),
    feeAmount: numberString(row.fee_amount),
    netAmount: numberString(row.net_amount),
    providerReference: str(row.provider_reference),
    sourceDepositInstructions: row.source_deposit_instructions,
    destinationTxHash: str(row.destination_tx_hash),
    status: row.status,
    statusReason: str(row.status_reason),
    receipt: row.receipt,
    raw: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: optionalIso(row.completed_at)
  };
}

function mapSupplier(row: any): SupplierRecord {
  return {
    id: row.id,
    userId: row.user_id,
    customerId: row.payments_customer_id,
    supplierName: row.supplier_name,
    supplierType: row.supplier_type,
    supplierCountry: row.supplier_country,
    currency: row.currency as SupplierPayoutCurrency,
    bankName: row.bank_name,
    accountOwnerName: row.account_owner_name,
    accountType: row.account_type,
    accountLast4: str(row.account_last4),
    provider: str(row.provider) ?? 'bridge',
    providerExternalAccountId: str(row.provider_external_account_id) ?? str(row.bridge_external_account_id),
    providerRail: str(row.provider_rail),
    bridgeExternalAccountId: str(row.bridge_external_account_id),
    status: row.status,
    riskLevel: row.risk_level,
    riskScore: Number(row.risk_score ?? 0),
    reviewReason: str(row.review_reason),
    raw: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapSupplierPayment(row: any): SupplierPaymentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    supplierId: row.supplier_id,
    amount: numberString(row.amount) ?? '0',
    sourceAsset: row.source_asset,
    destinationCurrency: row.destination_currency as SupplierPayoutCurrency,
    paymentPurpose: row.payment_purpose,
    invoiceUrl: str(row.invoice_url),
    status: row.status,
    provider: str(row.provider),
    providerTransferId: str(row.provider_transfer_id) ?? str(row.bridge_transfer_id),
    providerRail: str(row.provider_rail),
    executionMode: row.execution_mode,
    bridgeTransferId: str(row.bridge_transfer_id),
    riskLevel: row.risk_level,
    riskScore: Number(row.risk_score ?? 0),
    adminDecision: row.admin_decision,
    adminDecisionBy: str(row.admin_decision_by),
    adminDecisionAt: optionalIso(row.admin_decision_at),
    reviewReason: str(row.review_reason),
    aceRiskReview: row.ace_risk_review,
    raw: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapSupplierControls(row: any): SupplierControlsRecord {
  return {
    id: 'global',
    supplierPaymentsEnabled: Boolean(row.supplier_payments_enabled),
    thirdPartySupplierPayoutsEnabled: Boolean(row.third_party_supplier_payouts_enabled),
    autoApproveApprovedSuppliers: Boolean(row.auto_approve_approved_suppliers),
    requireInvoiceForSupplierPayouts: Boolean(row.require_invoice_for_supplier_payouts),
    manualReviewThreshold: Number(row.manual_review_threshold ?? 1000),
    newSupplierFirstPaymentReview: Boolean(row.new_supplier_first_payment_review),
    newCustomerReviewWindowDays: Number(row.new_customer_review_window_days ?? 7),
    newCustomerReviewThreshold: Number(row.new_customer_review_threshold ?? 250),
    highRiskCountries: row.high_risk_countries ?? [],
    blockedCountries: row.blocked_countries ?? [],
    dailySupplierPayoutLimit: Number(row.daily_supplier_payout_limit ?? 5000),
    monthlySupplierPayoutLimit: Number(row.monthly_supplier_payout_limit ?? 25000),
    updatedBy: str(row.updated_by),
    reason: str(row.reason),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertOnrampOrder(client: pg.PoolClient, item: OnrampOrderRecord) {
  await client.query(
    `insert into payments_onramp_orders (id, user_id, payments_customer_id, provider, provider_transfer_id, source_currency, source_payment_rail, destination_currency, destination_chain, destination_address, amount, fee_percent, fee_amount, net_amount, provider_reference, source_deposit_instructions, destination_tx_hash, status, status_reason, receipt, raw_payload, created_at, updated_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     on conflict (id) do update set
       provider_transfer_id=excluded.provider_transfer_id,
       source_currency=excluded.source_currency,
       source_payment_rail=excluded.source_payment_rail,
       destination_currency=excluded.destination_currency,
       destination_chain=excluded.destination_chain,
       destination_address=excluded.destination_address,
       amount=excluded.amount,
       fee_percent=excluded.fee_percent,
       fee_amount=excluded.fee_amount,
       net_amount=excluded.net_amount,
       provider_reference=excluded.provider_reference,
       source_deposit_instructions=excluded.source_deposit_instructions,
       destination_tx_hash=excluded.destination_tx_hash,
       status=excluded.status,
       status_reason=excluded.status_reason,
       receipt=excluded.receipt,
       raw_payload=excluded.raw_payload,
       updated_at=excluded.updated_at,
       completed_at=excluded.completed_at`,
    [item.id, item.userId, item.customerId, item.provider, item.providerTransferId, item.sourceCurrency, item.sourcePaymentRail, item.destinationCurrency, item.destinationChain, item.destinationAddress, item.amount, item.feePercent, item.feeAmount, item.netAmount, item.providerReference, item.sourceDepositInstructions ?? null, item.destinationTxHash, item.status, item.statusReason, item.receipt ?? null, item.raw ?? null, item.createdAt, item.updatedAt, item.completedAt]
  );
}


async function upsertSupplier(client: pg.PoolClient, item: SupplierRecord) {
  await client.query(
    `insert into payments_suppliers (id,user_id,payments_customer_id,supplier_name,supplier_type,supplier_country,currency,bank_name,account_owner_name,account_type,account_last4,provider,provider_external_account_id,provider_rail,bridge_external_account_id,status,risk_level,risk_score,review_reason,raw_payload,created_at,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     on conflict (id) do update set supplier_name=excluded.supplier_name,supplier_type=excluded.supplier_type,supplier_country=excluded.supplier_country,currency=excluded.currency,bank_name=excluded.bank_name,account_owner_name=excluded.account_owner_name,account_type=excluded.account_type,account_last4=excluded.account_last4,provider=excluded.provider,provider_external_account_id=excluded.provider_external_account_id,provider_rail=excluded.provider_rail,bridge_external_account_id=excluded.bridge_external_account_id,status=excluded.status,risk_level=excluded.risk_level,risk_score=excluded.risk_score,review_reason=excluded.review_reason,raw_payload=excluded.raw_payload,updated_at=excluded.updated_at`,
    [item.id,item.userId,item.customerId,item.supplierName,item.supplierType,item.supplierCountry,item.currency,item.bankName,item.accountOwnerName,item.accountType,item.accountLast4,item.provider ?? 'bridge',item.providerExternalAccountId ?? item.bridgeExternalAccountId,item.providerRail,item.bridgeExternalAccountId,item.status,item.riskLevel,item.riskScore,item.reviewReason,item.raw ?? null,item.createdAt,item.updatedAt]
  );
}

async function upsertSupplierPayment(client: pg.PoolClient, item: SupplierPaymentRecord) {
  await client.query(
    `insert into payments_supplier_payments (id,user_id,supplier_id,amount,source_asset,destination_currency,payment_purpose,invoice_url,status,provider,provider_transfer_id,provider_rail,execution_mode,bridge_transfer_id,risk_level,risk_score,admin_decision,admin_decision_by,admin_decision_at,review_reason,ace_risk_review,raw_payload,created_at,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     on conflict (id) do update set amount=excluded.amount,source_asset=excluded.source_asset,destination_currency=excluded.destination_currency,payment_purpose=excluded.payment_purpose,invoice_url=excluded.invoice_url,status=excluded.status,provider=excluded.provider,provider_transfer_id=excluded.provider_transfer_id,provider_rail=excluded.provider_rail,execution_mode=excluded.execution_mode,bridge_transfer_id=excluded.bridge_transfer_id,risk_level=excluded.risk_level,risk_score=excluded.risk_score,admin_decision=excluded.admin_decision,admin_decision_by=excluded.admin_decision_by,admin_decision_at=excluded.admin_decision_at,review_reason=excluded.review_reason,ace_risk_review=excluded.ace_risk_review,raw_payload=excluded.raw_payload,updated_at=excluded.updated_at`,
    [item.id,item.userId,item.supplierId,item.amount,item.sourceAsset,item.destinationCurrency,item.paymentPurpose,item.invoiceUrl,item.status,item.provider,item.providerTransferId ?? item.bridgeTransferId,item.providerRail,item.executionMode,item.bridgeTransferId,item.riskLevel,item.riskScore,item.adminDecision,item.adminDecisionBy,item.adminDecisionAt,item.reviewReason,item.aceRiskReview ?? null,item.raw ?? null,item.createdAt,item.updatedAt]
  );
}

async function upsertSupplierControls(client: pg.PoolClient, item: SupplierControlsRecord) {
  await client.query(
    `insert into payments_supplier_controls (id,supplier_payments_enabled,third_party_supplier_payouts_enabled,auto_approve_approved_suppliers,require_invoice_for_supplier_payouts,manual_review_threshold,new_supplier_first_payment_review,new_customer_review_window_days,new_customer_review_threshold,high_risk_countries,blocked_countries,daily_supplier_payout_limit,monthly_supplier_payout_limit,updated_by,reason,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (id) do update set supplier_payments_enabled=excluded.supplier_payments_enabled,third_party_supplier_payouts_enabled=excluded.third_party_supplier_payouts_enabled,auto_approve_approved_suppliers=excluded.auto_approve_approved_suppliers,require_invoice_for_supplier_payouts=excluded.require_invoice_for_supplier_payouts,manual_review_threshold=excluded.manual_review_threshold,new_supplier_first_payment_review=excluded.new_supplier_first_payment_review,new_customer_review_window_days=excluded.new_customer_review_window_days,new_customer_review_threshold=excluded.new_customer_review_threshold,high_risk_countries=excluded.high_risk_countries,blocked_countries=excluded.blocked_countries,daily_supplier_payout_limit=excluded.daily_supplier_payout_limit,monthly_supplier_payout_limit=excluded.monthly_supplier_payout_limit,updated_by=excluded.updated_by,reason=excluded.reason,updated_at=excluded.updated_at`,
    [item.id,item.supplierPaymentsEnabled,item.thirdPartySupplierPayoutsEnabled,item.autoApproveApprovedSuppliers,item.requireInvoiceForSupplierPayouts,item.manualReviewThreshold,item.newSupplierFirstPaymentReview,item.newCustomerReviewWindowDays,item.newCustomerReviewThreshold,item.highRiskCountries,item.blockedCountries,item.dailySupplierPayoutLimit,item.monthlySupplierPayoutLimit,item.updatedBy,item.reason,item.updatedAt]
  );
}


function mapAceSupportSession(row: any): AceSupportSessionRecord {
  return {
    id: row.id,
    userId: str(row.user_id),
    channel: row.channel,
    resourceType: str(row.resource_type),
    resourceId: str(row.resource_id),
    confidence: row.confidence,
    needsHuman: row.needs_human,
    toolsUsed: row.tools_used ?? [],
    evidenceSnapshot: row.evidence_snapshot,
    createdAt: iso(row.created_at)
  };
}

function mapAceSupportMessage(row: any): AceSupportMessageRecord {
  return { id: row.id, sessionId: row.session_id, role: row.role, message: row.message, createdAt: iso(row.created_at) };
}

function mapAceToolCall(row: any): AceToolCallRecord {
  return { id: row.id, sessionId: row.session_id, toolName: row.tool_name, status: row.status, summary: str(row.summary), createdAt: iso(row.created_at) };
}

function mapAceSupportResolution(row: any): AceSupportResolutionRecord {
  return { id: row.id, sessionId: row.session_id, resolutionType: row.resolution_type, summary: row.summary, createdAt: iso(row.created_at) };
}

async function upsertAceSupportSession(client: pg.PoolClient, item: AceSupportSessionRecord) {
  await client.query(`insert into ace_support_sessions (id, user_id, channel, resource_type, resource_id, confidence, needs_human, tools_used, evidence_snapshot, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing`, [item.id, item.userId, item.channel, item.resourceType, item.resourceId, item.confidence, item.needsHuman, item.toolsUsed, item.evidenceSnapshot ?? null, item.createdAt]);
}

async function upsertAceSupportMessage(client: pg.PoolClient, item: AceSupportMessageRecord) {
  await client.query(`insert into ace_support_messages (id, session_id, role, message, created_at) values ($1,$2,$3,$4,$5) on conflict (id) do nothing`, [item.id, item.sessionId, item.role, item.message, item.createdAt]);
}

async function upsertAceToolCall(client: pg.PoolClient, item: AceToolCallRecord) {
  await client.query(`insert into ace_tool_calls (id, session_id, tool_name, status, summary, created_at) values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`, [item.id, item.sessionId, item.toolName, item.status, item.summary, item.createdAt]);
}

async function upsertAceSupportResolution(client: pg.PoolClient, item: AceSupportResolutionRecord) {
  await client.query(`insert into ace_support_resolutions (id, session_id, resolution_type, summary, created_at) values ($1,$2,$3,$4,$5) on conflict (id) do nothing`, [item.id, item.sessionId, item.resolutionType, item.summary, item.createdAt]);
}


function mapNgnControls(row: any): NgnControlsRecord {
  return {
    id: 'global',
    onrampEnabled: Boolean(row.onramp_enabled),
    offrampEnabled: Boolean(row.offramp_enabled),
    mockProviderEnabled: Boolean(row.mock_provider_enabled),
    bankSettlementEnabled: Boolean(row.bank_settlement_enabled),
    virtualAccountEnabled: Boolean(row.virtual_account_enabled),
    identityVerificationEnabled: Boolean(row.identity_verification_enabled),
    activeProvider: row.active_provider,
    backupProvider: str(row.backup_provider) as any,
    maxTransactionNgn: row.max_transaction_ngn,
    dailyLimitNgn: row.daily_limit_ngn,
    highValueReviewThresholdNgn: row.high_value_review_threshold_ngn,
    updatedBy: str(row.updated_by),
    updatedAt: iso(row.updated_at)
  };
}

function mapNgnQuote(row: any): NgnQuoteRecord {
  return { id: row.id, userId: row.user_id, customerId: str(row.customer_id), direction: row.direction, provider: row.provider, sourceCurrency: row.source_currency, destinationCurrency: row.destination_currency, sourceAmount: row.source_amount, destinationAmount: row.destination_amount, rate: row.rate, feeAmount: row.fee_amount, status: row.status, providerQuoteId: str(row.provider_quote_id), expiresAt: iso(row.expires_at), metadata: row.metadata, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapNgnTransfer(row: any): NgnTransferRecord {
  return { id: row.id, quoteId: row.quote_id, userId: row.user_id, customerId: str(row.customer_id), direction: row.direction, provider: row.provider, sourceCurrency: row.source_currency, destinationCurrency: row.destination_currency, sourceAmount: row.source_amount, destinationAmount: row.destination_amount, rate: row.rate, feeAmount: row.fee_amount, status: row.status, providerQuoteId: str(row.provider_quote_id), providerTransferId: str(row.provider_transfer_id), bankReference: str(row.bank_reference), depositAddress: str(row.deposit_address), virtualAccount: row.virtual_account, settlementReference: str(row.settlement_reference), destinationTxHash: str(row.destination_tx_hash), metadata: row.metadata, timeline: row.timeline, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), completedAt: optionalIso(row.completed_at) };
}

function mapNgnWebhook(row: any): NgnWebhookRecord {
  return { id: row.id, provider: row.provider, providerEventId: row.provider_event_id, eventType: row.event_type, transferId: str(row.transfer_id), payload: row.payload, processedAt: optionalIso(row.processed_at), createdAt: iso(row.created_at) };
}

function mapWalletControls(row: any): WalletControlsRecord {
  return {
    id: row.id,
    // null stays undefined, which is what "fall back to the environment"
    // means. Coercing it to a string would pin the provider permanently.
    activeProvider: row.active_provider ?? undefined,
    reason: row.reason ?? undefined,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

function mapVerificationLimitOverride(row: any): VerificationLimitOverrideRecord {
  return {
    id: row.id,
    flow: row.flow,
    rail: row.rail,
    level: Number(row.level),
    // null must survive as null. Coercing it to 0 would turn "unlimited" into
    // "closed", which is the most damaging possible misreading of this value.
    cumulativeNgn: row.cumulative_ngn === null || row.cumulative_ngn === undefined ? null : Number(row.cumulative_ngn),
    reason: row.reason ?? undefined,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

async function upsertNgnControls(client: pg.PoolClient, item: NgnControlsRecord) {
  await client.query(`insert into payments_ngn_controls (id,onramp_enabled,offramp_enabled,mock_provider_enabled,bank_settlement_enabled,virtual_account_enabled,identity_verification_enabled,active_provider,backup_provider,max_transaction_ngn,daily_limit_ngn,high_value_review_threshold_ngn,updated_by,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (id) do update set onramp_enabled=excluded.onramp_enabled,offramp_enabled=excluded.offramp_enabled,mock_provider_enabled=excluded.mock_provider_enabled,bank_settlement_enabled=excluded.bank_settlement_enabled,virtual_account_enabled=excluded.virtual_account_enabled,identity_verification_enabled=excluded.identity_verification_enabled,active_provider=excluded.active_provider,backup_provider=excluded.backup_provider,max_transaction_ngn=excluded.max_transaction_ngn,daily_limit_ngn=excluded.daily_limit_ngn,high_value_review_threshold_ngn=excluded.high_value_review_threshold_ngn,updated_by=excluded.updated_by,updated_at=excluded.updated_at`, [item.id, item.onrampEnabled, item.offrampEnabled, item.mockProviderEnabled, item.bankSettlementEnabled, item.virtualAccountEnabled, item.identityVerificationEnabled ?? false, item.activeProvider, item.backupProvider, item.maxTransactionNgn, item.dailyLimitNgn, item.highValueReviewThresholdNgn, item.updatedBy, item.updatedAt]);
}
async function upsertNgnQuote(client: pg.PoolClient, item: NgnQuoteRecord) {
  await client.query(`insert into payments_ngn_quotes (id,user_id,customer_id,direction,provider,source_currency,destination_currency,source_amount,destination_amount,rate,fee_amount,status,provider_quote_id,expires_at,metadata,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict (id) do update set status=excluded.status,updated_at=excluded.updated_at,metadata=excluded.metadata`, [item.id,item.userId,item.customerId,item.direction,item.provider,item.sourceCurrency,item.destinationCurrency,item.sourceAmount,item.destinationAmount,item.rate,item.feeAmount,item.status,item.providerQuoteId,item.expiresAt,item.metadata ?? null,item.createdAt,item.updatedAt]);
}
async function upsertNgnTransfer(client: pg.PoolClient, item: NgnTransferRecord) {
  await client.query(`insert into payments_ngn_transfers (id,quote_id,user_id,customer_id,direction,provider,source_currency,destination_currency,source_amount,destination_amount,rate,fee_amount,status,provider_quote_id,provider_transfer_id,bank_reference,deposit_address,virtual_account,settlement_reference,destination_tx_hash,metadata,timeline,created_at,updated_at,completed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) on conflict (id) do update set status=excluded.status,provider_transfer_id=excluded.provider_transfer_id,bank_reference=excluded.bank_reference,deposit_address=excluded.deposit_address,virtual_account=excluded.virtual_account,settlement_reference=excluded.settlement_reference,destination_tx_hash=excluded.destination_tx_hash,metadata=excluded.metadata,timeline=excluded.timeline,updated_at=excluded.updated_at,completed_at=excluded.completed_at`, [item.id,item.quoteId,item.userId,item.customerId,item.direction,item.provider,item.sourceCurrency,item.destinationCurrency,item.sourceAmount,item.destinationAmount,item.rate,item.feeAmount,item.status,item.providerQuoteId,item.providerTransferId,item.bankReference,item.depositAddress,item.virtualAccount ?? null,item.settlementReference,item.destinationTxHash,item.metadata ?? null,item.timeline ?? null,item.createdAt,item.updatedAt,item.completedAt]);
}
async function upsertNgnWebhook(client: pg.PoolClient, item: NgnWebhookRecord) {
  await client.query(`insert into payments_ngn_webhook_events (id,provider,provider_event_id,event_type,transfer_id,payload,processed_at,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (provider, provider_event_id) do update set event_type=excluded.event_type,transfer_id=excluded.transfer_id,payload=excluded.payload,processed_at=excluded.processed_at`, [item.id,item.provider,item.providerEventId,item.eventType,item.transferId,item.payload ?? null,item.processedAt,item.createdAt]);
}

function mapSupportTicket(row: any): SupportTicketRecord {
  return {
    id: row.id,
    userId: row.user_id,
    customerId: str(row.payments_customer_id),
    type: row.ticket_type,
    priority: row.priority,
    status: row.status,
    subject: row.subject,
    description: row.description,
    resourceType: row.resource_type,
    resourceId: str(row.resource_id),
    assignedTo: str(row.assigned_to),
    lastMessageAt: optionalIso(row.last_message_at),
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    closedAt: optionalIso(row.closed_at)
  };
}

function mapSupportTicketMessage(row: any): SupportTicketMessageRecord {
  const internalNote = Boolean(row.internal_note);
  return {
    id: row.id,
    ticketId: row.ticket_id,
    senderType: row.sender_type,
    senderId: str(row.sender_id),
    message: row.message,
    attachments: row.attachments,
    internalNote,
    messageType: row.message_type ?? (internalNote ? 'internal_note' : 'conversation'),
    noteType: str(row.note_type) as any,
    title: str(row.title),
    statusAfter: str(row.status_after) as any,
    visibleToCustomer: row.visible_to_customer ?? !internalNote,
    metadata: row.metadata,
    createdAt: iso(row.created_at)
  };
}

async function upsertSupportTicket(client: pg.PoolClient, item: SupportTicketRecord) {
  await client.query(
    `insert into payments_support_tickets (id, user_id, payments_customer_id, ticket_type, priority, status, subject, description, resource_type, resource_id, assigned_to, last_message_at, metadata, created_at, updated_at, closed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (id) do update set
       ticket_type=excluded.ticket_type,
       priority=excluded.priority,
       status=excluded.status,
       subject=excluded.subject,
       description=excluded.description,
       resource_type=excluded.resource_type,
       resource_id=excluded.resource_id,
       assigned_to=excluded.assigned_to,
       last_message_at=excluded.last_message_at,
       metadata=excluded.metadata,
       updated_at=excluded.updated_at,
       closed_at=excluded.closed_at`,
    [item.id, item.userId, item.customerId, item.type, item.priority, item.status, item.subject, item.description, item.resourceType, item.resourceId, item.assignedTo, item.lastMessageAt, item.metadata ?? null, item.createdAt, item.updatedAt, item.closedAt]
  );
}

async function upsertSupportTicketMessage(client: pg.PoolClient, item: SupportTicketMessageRecord) {
  await client.query(
    `insert into payments_support_ticket_messages (id, ticket_id, sender_type, sender_id, message, attachments, internal_note, message_type, note_type, title, status_after, visible_to_customer, metadata, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (id) do update set
       sender_type=excluded.sender_type,
       sender_id=excluded.sender_id,
       message=excluded.message,
       attachments=excluded.attachments,
       internal_note=excluded.internal_note,
       message_type=excluded.message_type,
       note_type=excluded.note_type,
       title=excluded.title,
       status_after=excluded.status_after,
       visible_to_customer=excluded.visible_to_customer,
       metadata=excluded.metadata`,
    [item.id, item.ticketId, item.senderType, item.senderId, item.message, item.attachments ?? null, item.internalNote ?? false, item.messageType ?? (item.internalNote ? 'internal_note' : 'conversation'), item.noteType, item.title, item.statusAfter, item.visibleToCustomer ?? !item.internalNote, item.metadata ?? null, item.createdAt]
  );
}

function mapWebhookEvent(row: any): WebhookEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    eventCategory: str(row.event_category),
    eventType: str(row.event_type),
    eventObjectId: str(row.event_object_id),
    payload: row.payload,
    processedAt: optionalIso(row.processed_at),
    createdAt: iso(row.created_at)
  };
}





function mapTransactionReference(row: any): TransactionReferenceRecord {
  return {
    id: row.id,
    sivanTransactionId: row.sivan_transaction_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    provider: row.provider,
    referenceType: row.reference_type,
    referenceValue: row.reference_value,
    direction: row.direction,
    status: str(row.status),
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertTransactionReference(client: pg.PoolClient, item: TransactionReferenceRecord) {
  await client.query(
    `insert into transaction_references (id, sivan_transaction_id, resource_type, resource_id, provider, reference_type, reference_value, direction, status, metadata, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (provider, reference_type, reference_value, resource_type, resource_id) do update set
       sivan_transaction_id=excluded.sivan_transaction_id,
       direction=excluded.direction,
       status=excluded.status,
       metadata=excluded.metadata,
       updated_at=excluded.updated_at`,
    [item.id, item.sivanTransactionId, item.resourceType, item.resourceId, item.provider, item.referenceType, item.referenceValue, item.direction, item.status ?? null, item.metadata ?? null, item.createdAt, item.updatedAt]
  );
}

function mapVirtualAccountEvent(row: any): VirtualAccountEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    virtualAccountId: str(row.virtual_account_id),
    providerAccountId: str(row.provider_account_id),
    depositId: str(row.deposit_id),
    eventType: row.event_type,
    sourceCurrency: str(row.source_currency) as any,
    destinationCurrency: str(row.destination_currency),
    sourceAmount: row.source_amount === null || row.source_amount === undefined ? undefined : String(row.source_amount),
    destinationAmount: row.destination_amount === null || row.destination_amount === undefined ? undefined : String(row.destination_amount),
    paymentRail: str(row.payment_rail),
    status: row.status,
    depositReference: str(row.deposit_reference),
    destinationTxHash: str(row.destination_tx_hash),
    rawPayload: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapVirtualAccountTransaction(row: any): VirtualAccountTransactionRecord {
  return {
    id: row.id,
    provider: row.provider,
    virtualAccountId: str(row.virtual_account_id),
    providerAccountId: str(row.provider_account_id),
    depositId: row.deposit_id,
    userId: str(row.user_id),
    customerId: str(row.payments_customer_id),
    sourceCurrency: str(row.source_currency) as any,
    destinationCurrency: str(row.destination_currency),
    sourceAmount: row.source_amount === null || row.source_amount === undefined ? undefined : String(row.source_amount),
    destinationAmount: row.destination_amount === null || row.destination_amount === undefined ? undefined : String(row.destination_amount),
    paymentRail: str(row.payment_rail),
    status: row.status,
    depositReference: str(row.deposit_reference),
    destinationTxHash: str(row.destination_tx_hash),
    lastProviderEventId: str(row.last_provider_event_id),
    rawPayload: row.raw_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: optionalIso(row.completed_at)
  };
}

async function upsertVirtualAccountEvent(client: pg.PoolClient, item: VirtualAccountEventRecord) {
  await client.query(
    `insert into payments_virtual_account_events (id, provider, provider_event_id, virtual_account_id, provider_account_id, deposit_id, event_type, source_currency, destination_currency, source_amount, destination_amount, payment_rail, status, deposit_reference, destination_tx_hash, raw_payload, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     on conflict (provider, provider_event_id) do update set
       virtual_account_id=excluded.virtual_account_id,
       provider_account_id=excluded.provider_account_id,
       deposit_id=excluded.deposit_id,
       event_type=excluded.event_type,
       source_currency=excluded.source_currency,
       destination_currency=excluded.destination_currency,
       source_amount=excluded.source_amount,
       destination_amount=excluded.destination_amount,
       payment_rail=excluded.payment_rail,
       status=excluded.status,
       deposit_reference=excluded.deposit_reference,
       destination_tx_hash=excluded.destination_tx_hash,
       raw_payload=excluded.raw_payload,
       updated_at=excluded.updated_at`,
    [item.id, item.provider, item.providerEventId, item.virtualAccountId ?? null, item.providerAccountId ?? null, item.depositId ?? null, item.eventType, item.sourceCurrency ?? null, item.destinationCurrency ?? null, item.sourceAmount ?? null, item.destinationAmount ?? null, item.paymentRail ?? null, item.status, item.depositReference ?? null, item.destinationTxHash ?? null, item.rawPayload ?? null, item.createdAt, item.updatedAt]
  );
}

async function upsertVirtualAccountTransaction(client: pg.PoolClient, item: VirtualAccountTransactionRecord) {
  await client.query(
    `insert into payments_virtual_account_transactions (id, provider, virtual_account_id, provider_account_id, deposit_id, user_id, payments_customer_id, source_currency, destination_currency, source_amount, destination_amount, payment_rail, status, deposit_reference, destination_tx_hash, last_provider_event_id, raw_payload, created_at, updated_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     on conflict (provider, deposit_id) do update set
       virtual_account_id=excluded.virtual_account_id,
       provider_account_id=excluded.provider_account_id,
       user_id=excluded.user_id,
       payments_customer_id=excluded.payments_customer_id,
       source_currency=excluded.source_currency,
       destination_currency=excluded.destination_currency,
       source_amount=excluded.source_amount,
       destination_amount=excluded.destination_amount,
       payment_rail=excluded.payment_rail,
       status=excluded.status,
       deposit_reference=excluded.deposit_reference,
       destination_tx_hash=excluded.destination_tx_hash,
       last_provider_event_id=excluded.last_provider_event_id,
       raw_payload=excluded.raw_payload,
       updated_at=excluded.updated_at,
       completed_at=excluded.completed_at`,
    [item.id, item.provider, item.virtualAccountId ?? null, item.providerAccountId ?? null, item.depositId, item.userId ?? null, item.customerId ?? null, item.sourceCurrency ?? null, item.destinationCurrency ?? null, item.sourceAmount ?? null, item.destinationAmount ?? null, item.paymentRail ?? null, item.status, item.depositReference ?? null, item.destinationTxHash ?? null, item.lastProviderEventId ?? null, item.rawPayload ?? null, item.createdAt, item.updatedAt, item.completedAt ?? null]
  );
}

function mapVirtualAccountRequest(row: any): VirtualAccountRequestRecord {
  return {
    id: row.id,
    userId: row.user_id,
    customerId: str(row.payments_customer_id),
    currency: row.currency,
    country: str(row.country),
    useCase: str(row.use_case),
    status: row.status,
    reviewedBy: str(row.reviewed_by),
    reviewedAt: optionalIso(row.reviewed_at),
    rejectionReason: str(row.rejection_reason),
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapVirtualAccount(row: any): VirtualAccountRecord {
  return {
    id: row.id,
    requestId: str(row.request_id),
    userId: row.user_id,
    customerId: str(row.payments_customer_id),
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    currency: row.currency,
    country: str(row.country),
    bankName: str(row.bank_name),
    accountName: str(row.account_name),
    accountNumberMasked: str(row.account_number_masked),
    routingNumberMasked: str(row.routing_number_masked),
    ibanMasked: str(row.iban_masked),
    status: row.status,
    rawProviderPayload: row.raw_provider_payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertVirtualAccountRequest(client: pg.PoolClient, item: VirtualAccountRequestRecord) {
  await client.query(
    `insert into payments_virtual_account_requests (id, user_id, payments_customer_id, currency, country, use_case, status, reviewed_by, reviewed_at, rejection_reason, metadata, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (id) do update set
       user_id=excluded.user_id,
       payments_customer_id=excluded.payments_customer_id,
       currency=excluded.currency,
       country=excluded.country,
       use_case=excluded.use_case,
       status=excluded.status,
       reviewed_by=excluded.reviewed_by,
       reviewed_at=excluded.reviewed_at,
       rejection_reason=excluded.rejection_reason,
       metadata=excluded.metadata,
       updated_at=excluded.updated_at`,
    [item.id, item.userId, item.customerId ?? null, item.currency, item.country ?? null, item.useCase ?? null, item.status, item.reviewedBy ?? null, item.reviewedAt ?? null, item.rejectionReason ?? null, item.metadata ?? null, item.createdAt, item.updatedAt]
  );
}

async function upsertVirtualAccount(client: pg.PoolClient, item: VirtualAccountRecord) {
  await client.query(
    `insert into payments_virtual_accounts (id, request_id, user_id, payments_customer_id, provider, provider_account_id, currency, country, bank_name, account_name, account_number_masked, routing_number_masked, iban_masked, status, raw_provider_payload, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (id) do update set
       request_id=excluded.request_id,
       user_id=excluded.user_id,
       payments_customer_id=excluded.payments_customer_id,
       provider=excluded.provider,
       provider_account_id=excluded.provider_account_id,
       currency=excluded.currency,
       country=excluded.country,
       bank_name=excluded.bank_name,
       account_name=excluded.account_name,
       account_number_masked=excluded.account_number_masked,
       routing_number_masked=excluded.routing_number_masked,
       iban_masked=excluded.iban_masked,
       status=excluded.status,
       raw_provider_payload=excluded.raw_provider_payload,
       updated_at=excluded.updated_at`,
    [item.id, item.requestId ?? null, item.userId, item.customerId ?? null, item.provider, item.providerAccountId, item.currency, item.country ?? null, item.bankName ?? null, item.accountName ?? null, item.accountNumberMasked ?? null, item.routingNumberMasked ?? null, item.ibanMasked ?? null, item.status, item.rawProviderPayload ?? null, item.createdAt, item.updatedAt]
  );
}

function mapCustomerIdentityLink(row: any): CustomerIdentityLinkRecord {
  return {
    id: row.id,
    paymentUserId: row.payment_user_id,
    escrowUserId: str(row.escrow_user_id),
    email: row.email,
    whatsappNumber: row.whatsapp_number,
    status: row.status,
    linkedAt: optionalIso(row.linked_at),
    unlinkedAt: optionalIso(row.unlinked_at),
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapIdentityPairingToken(row: any): IdentityPairingTokenRecord {
  return {
    id: row.id,
    paymentUserId: row.payment_user_id,
    tokenHash: row.token_hash,
    status: row.status,
    expiresAt: iso(row.expires_at),
    redeemedAt: optionalIso(row.redeemed_at),
    canceledAt: optionalIso(row.canceled_at),
    whatsappNumber: str(row.whatsapp_number),
    escrowUserId: str(row.escrow_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertCustomerIdentityLink(client: pg.PoolClient, item: CustomerIdentityLinkRecord) {
  await client.query(
    `insert into customer_identity_links (id, payment_user_id, escrow_user_id, email, whatsapp_number, status, linked_at, unlinked_at, metadata, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do update set
       payment_user_id=excluded.payment_user_id,
       escrow_user_id=excluded.escrow_user_id,
       email=excluded.email,
       whatsapp_number=excluded.whatsapp_number,
       status=excluded.status,
       linked_at=excluded.linked_at,
       unlinked_at=excluded.unlinked_at,
       metadata=excluded.metadata,
       updated_at=excluded.updated_at`,
    [item.id, item.paymentUserId, item.escrowUserId ?? null, item.email, item.whatsappNumber, item.status, item.linkedAt ?? null, item.unlinkedAt ?? null, item.metadata ?? null, item.createdAt, item.updatedAt]
  );
}

async function upsertIdentityPairingToken(client: pg.PoolClient, item: IdentityPairingTokenRecord) {
  await client.query(
    `insert into identity_pairing_tokens (id, payment_user_id, token_hash, status, expires_at, redeemed_at, canceled_at, whatsapp_number, escrow_user_id, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do update set
       payment_user_id=excluded.payment_user_id,
       token_hash=excluded.token_hash,
       status=excluded.status,
       expires_at=excluded.expires_at,
       redeemed_at=excluded.redeemed_at,
       canceled_at=excluded.canceled_at,
       whatsapp_number=excluded.whatsapp_number,
       escrow_user_id=excluded.escrow_user_id,
       updated_at=excluded.updated_at`,
    [item.id, item.paymentUserId, item.tokenHash, item.status, item.expiresAt, item.redeemedAt ?? null, item.canceledAt ?? null, item.whatsappNumber ?? null, item.escrowUserId ?? null, item.createdAt, item.updatedAt]
  );
}

async function upsertUser(client: pg.PoolClient, user: UserRecord) {
  const { firstName, lastName } = splitName(user.fullName);
  const primaryChannel = user.primaryChannel ?? inferPrimaryChannel(user.email, user.whatsappNumber);
  await client.query(
    `insert into users (user_id, whatsapp_number, email, first_name, last_name, role_history, primary_channel, username, username_updated_at, avatar_url, avatar_object_key, avatar_updated_at, email_verified_at, whatsapp_verified_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict (user_id) do update set
       whatsapp_number = excluded.whatsapp_number,
       email = excluded.email,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       primary_channel = excluded.primary_channel,
       username = excluded.username,
       username_updated_at = excluded.username_updated_at,
       avatar_url = excluded.avatar_url,
       avatar_object_key = excluded.avatar_object_key,
       avatar_updated_at = excluded.avatar_updated_at,
       email_verified_at = excluded.email_verified_at,
       whatsapp_verified_at = excluded.whatsapp_verified_at,
       updated_at = excluded.updated_at`,
    [user.id, user.whatsappNumber ?? null, user.email || null, firstName, lastName, JSON.stringify(['payments_user']), primaryChannel, user.username ?? null, user.usernameUpdatedAt ?? null, user.avatarUrl ?? null, user.avatarObjectKey ?? null, user.avatarUpdatedAt ?? null, user.emailVerifiedAt ?? null, user.whatsappVerifiedAt ?? null, user.createdAt, user.updatedAt]
  );
}

async function upsertCustomer(client: pg.PoolClient, item: CustomerRecord) {
  await client.query(
    `insert into payments_customers (id, user_id, provider, provider_customer_id, customer_type, kyc_link_id, kyc_link, tos_link, kyc_status, tos_status, onboarding_cost_usd, onboarding_cost_type, onboarding_cost_recorded_at, raw_payload, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (id) do update set
       provider_customer_id=excluded.provider_customer_id, customer_type=excluded.customer_type, kyc_link_id=excluded.kyc_link_id, kyc_link=excluded.kyc_link, tos_link=excluded.tos_link, kyc_status=excluded.kyc_status, tos_status=excluded.tos_status, onboarding_cost_usd=excluded.onboarding_cost_usd, onboarding_cost_type=excluded.onboarding_cost_type, onboarding_cost_recorded_at=excluded.onboarding_cost_recorded_at, raw_payload=excluded.raw_payload, updated_at=excluded.updated_at`,
    [item.id, item.userId, item.provider, item.providerCustomerId, item.customerType, item.kycLinkId, item.kycLink, item.tosLink, item.kycStatus, item.tosStatus, item.onboardingCostUsd, item.onboardingCostType, item.onboardingCostRecordedAt, item.raw ?? null, item.createdAt, item.updatedAt]
  );
}

async function upsertExternalAccount(client: pg.PoolClient, item: ExternalAccountRecord) {
  await client.query(
    `insert into payments_external_accounts (id, user_id, payments_customer_id, provider, provider_external_account_id, currency, account_type, bank_name, account_name, account_owner_name, account_last4, payment_rail, status, raw_payload, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (id) do update set
       provider_external_account_id=excluded.provider_external_account_id, currency=excluded.currency, account_type=excluded.account_type, bank_name=excluded.bank_name, account_name=excluded.account_name, account_owner_name=excluded.account_owner_name, account_last4=excluded.account_last4, payment_rail=excluded.payment_rail, status=excluded.status, raw_payload=excluded.raw_payload, updated_at=excluded.updated_at`,
    [item.id, item.userId, item.customerId, item.provider, item.providerExternalAccountId, item.currency, item.accountType, item.bankName, item.accountName, item.accountOwnerName, item.accountLast4, item.paymentRail, item.status, item.raw ?? null, item.createdAt, item.updatedAt]
  );
}

async function upsertLiquidationAddress(client: pg.PoolClient, item: LiquidationAddressRecord) {
  await client.query(
    `insert into payments_liquidation_addresses (id, user_id, payments_customer_id, payments_external_account_id, provider, provider_liquidation_address_id, address, memoless_address, chain, source_currency, destination_currency, destination_payment_rail, return_address, return_instructions, custom_developer_fee_percent, status, raw_payload, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     on conflict (id) do update set
       provider_liquidation_address_id=excluded.provider_liquidation_address_id, address=excluded.address, memoless_address=excluded.memoless_address, chain=excluded.chain, source_currency=excluded.source_currency, destination_currency=excluded.destination_currency, destination_payment_rail=excluded.destination_payment_rail, return_address=excluded.return_address, return_instructions=excluded.return_instructions, custom_developer_fee_percent=excluded.custom_developer_fee_percent, status=excluded.status, raw_payload=excluded.raw_payload, updated_at=excluded.updated_at`,
    [item.id, item.userId, item.customerId, item.externalAccountId, item.provider, item.providerLiquidationAddressId, item.address, item.memolessAddress, item.chain, item.sourceCurrency, item.destinationCurrency, item.destinationPaymentRail, item.returnAddress, item.returnInstructions ?? null, item.customDeveloperFeePercent, item.status, item.raw ?? null, item.createdAt, item.updatedAt]
  );
}

async function upsertWithdrawal(client: pg.PoolClient, item: WithdrawalRecord) {
  await client.query(
    `insert into payments_withdrawals (id, user_id, payments_customer_id, payments_external_account_id, payments_liquidation_address_id, provider, provider_drain_id, source_currency, destination_currency, source_amount, destination_amount, fee_percent, fee_amount, deposit_tx_hash, destination_reference, destination_tx_hash, status, status_reason, raw_payload, created_at, updated_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     on conflict (id) do update set
       provider_drain_id=excluded.provider_drain_id, source_amount=excluded.source_amount, destination_amount=excluded.destination_amount, fee_percent=excluded.fee_percent, fee_amount=excluded.fee_amount, deposit_tx_hash=excluded.deposit_tx_hash, destination_reference=excluded.destination_reference, destination_tx_hash=excluded.destination_tx_hash, status=excluded.status, status_reason=excluded.status_reason, raw_payload=excluded.raw_payload, updated_at=excluded.updated_at, completed_at=excluded.completed_at`,
    [item.id, item.userId, item.customerId, item.externalAccountId, item.liquidationAddressId, item.provider, item.providerDrainId, item.sourceCurrency, item.destinationCurrency, item.sourceAmount, item.destinationAmount, item.feePercent, item.feeAmount, item.depositTxHash, item.destinationReference, item.destinationTxHash, item.status, item.statusReason, item.raw ?? null, item.createdAt, item.updatedAt, item.completedAt]
  );
}

async function upsertWebhookEvent(client: pg.PoolClient, item: WebhookEventRecord) {
  await client.query(
    `insert into payments_webhook_events (id, provider, provider_event_id, event_category, event_type, event_object_id, payload, processed_at, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (provider, provider_event_id) do update set
       event_category=excluded.event_category, event_type=excluded.event_type, event_object_id=excluded.event_object_id, payload=excluded.payload, processed_at=excluded.processed_at`,
    [item.id, item.provider, item.providerEventId, item.eventCategory, item.eventType, item.eventObjectId, item.payload, item.processedAt, item.createdAt]
  );
}


function mapCustomerTypeControl(row: any): CustomerTypeControlRecord {
  return {
    customerType: row.customer_type,
    enabled: row.enabled,
    label: row.label,
    updatedBy: str(row.updated_by),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertCustomerTypeControl(client: pg.PoolClient, item: CustomerTypeControlRecord) {
  await client.query(
    `insert into payments_customer_type_controls (customer_type, enabled, label, updated_by, updated_at)
     values ($1,$2,$3,$4,$5)
     on conflict (customer_type) do update set
       enabled=excluded.enabled,
       label=excluded.label,
       updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [item.customerType, item.enabled, item.label, item.updatedBy, item.updatedAt]
  );
}

function mapSystemStatus(row: any): SystemStatusRecord {
  return {
    id: 'global',
    mode: row.mode,
    message: str(row.message),
    estimatedResumeAt: optionalIso(row.estimated_resume_at),
    updatedBy: str(row.updated_by),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertSystemStatus(client: pg.PoolClient, item: SystemStatusRecord) {
  await client.query(
    `insert into payments_system_status (id, mode, message, estimated_resume_at, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (id) do update set
       mode=excluded.mode,
       message=excluded.message,
       estimated_resume_at=excluded.estimated_resume_at,
       updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [item.id, item.mode, item.message, item.estimatedResumeAt, item.updatedBy, item.updatedAt]
  );
}

function mapSystemIncident(row: any): SystemIncidentRecord {
  return {
    id: row.id,
    provider: row.provider,
    affectedService: row.affected_service,
    severity: row.severity,
    status: row.status,
    message: row.message,
    startedAt: iso(row.started_at),
    eta: str(row.eta),
    resolvedAt: optionalIso(row.resolved_at),
    resolutionSummary: str(row.resolution_summary),
    createdBy: str(row.created_by),
    resolvedBy: str(row.resolved_by),
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertSystemIncident(client: pg.PoolClient, item: SystemIncidentRecord) {
  await client.query(
    `insert into payments_system_incidents (id, provider, affected_service, severity, status, message, started_at, eta, resolved_at, resolution_summary, created_by, resolved_by, metadata, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (id) do update set provider=excluded.provider, affected_service=excluded.affected_service, severity=excluded.severity, status=excluded.status, message=excluded.message, started_at=excluded.started_at, eta=excluded.eta, resolved_at=excluded.resolved_at, resolution_summary=excluded.resolution_summary, created_by=excluded.created_by, resolved_by=excluded.resolved_by, metadata=excluded.metadata, updated_at=excluded.updated_at`,
    [item.id, item.provider, item.affectedService, item.severity, item.status, item.message, item.startedAt, item.eta, item.resolvedAt, item.resolutionSummary, item.createdBy, item.resolvedBy, item.metadata ?? null, item.createdAt, item.updatedAt]
  );
}

function mapAssetControl(row: any): AssetControlRecord {
  return {
    asset: row.asset,
    enabled: row.enabled,
    label: row.label,
    updatedBy: str(row.updated_by),
    updatedAt: iso(row.updated_at)
  };
}

function mapNetworkControl(row: any): NetworkControlRecord {
  return {
    network: row.network,
    enabled: row.enabled,
    label: row.label,
    sortOrder: Number(row.sort_order ?? 100),
    updatedBy: str(row.updated_by),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertAssetControl(client: pg.PoolClient, item: AssetControlRecord) {
  await client.query(
    `insert into payments_asset_controls (asset, enabled, label, updated_by, updated_at)
     values ($1,$2,$3,$4,$5)
     on conflict (asset) do update set
       enabled=excluded.enabled,
       label=excluded.label,
       updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [item.asset, item.enabled, item.label, item.updatedBy, item.updatedAt]
  );
}

async function upsertNetworkControl(client: pg.PoolClient, item: NetworkControlRecord) {
  await client.query(
    `insert into payments_network_controls (network, enabled, label, sort_order, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (network) do update set
       enabled=excluded.enabled,
       label=excluded.label,
       sort_order=excluded.sort_order,
       updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [item.network, item.enabled, item.label, item.sortOrder, item.updatedBy, item.updatedAt]
  );
}


function mapVirtualAccountControl(row: any): VirtualAccountControlRecord {
  return {
    currency: row.currency,
    enabled: Boolean(row.enabled),
    label: row.label,
    provider: row.provider,
    accountType: row.account_type,
    paymentRails: Array.isArray(row.payment_rails) ? row.payment_rails : String(row.payment_rails ?? '').split(',').filter(Boolean),
    updatedBy: str(row.updated_by),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertVirtualAccountControl(client: pg.PoolClient, item: VirtualAccountControlRecord) {
  await client.query(
    `insert into payments_virtual_account_controls (currency, enabled, label, provider, account_type, payment_rails, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (currency) do update set
       enabled=excluded.enabled,
       label=excluded.label,
       provider=excluded.provider,
       account_type=excluded.account_type,
       payment_rails=excluded.payment_rails,
       updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [item.currency, item.enabled, item.label, item.provider, item.accountType, item.paymentRails, item.updatedBy ?? null, item.updatedAt]
  );
}

function mapPaymentControl(row: any): PaymentControlRecord {
  return {
    currency: row.currency,
    enabled: row.enabled,
    label: row.label,
    accountType: row.account_type,
    defaultPaymentRail: row.default_payment_rail,
    updatedBy: str(row.updated_by),
    updatedAt: iso(row.updated_at)
  };
}

async function upsertPaymentControl(client: pg.PoolClient, item: PaymentControlRecord) {
  await client.query(
    `insert into payments_control_settings (currency, enabled, label, account_type, default_payment_rail, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (currency) do update set
       enabled=excluded.enabled,
       label=excluded.label,
       account_type=excluded.account_type,
       default_payment_rail=excluded.default_payment_rail,
       updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [item.currency, item.enabled, item.label, item.accountType, item.defaultPaymentRail, item.updatedBy, item.updatedAt]
  );
}

function mapAuditLog(row: any): AuditLogRecord {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: str(row.actor_id),
    action: row.action,
    resourceType: str(row.resource_type),
    resourceId: str(row.resource_id),
    severity: row.severity,
    ipAddress: str(row.ip_address),
    userAgent: str(row.user_agent),
    metadata: row.metadata,
    createdAt: iso(row.created_at)
  };
}

function mapReconciliationRun(row: any): ReconciliationRunRecord {
  return {
    id: row.id,
    provider: str(row.provider),
    dryRun: row.dry_run,
    status: row.status,
    summary: row.summary,
    error: str(row.error),
    startedAt: iso(row.started_at),
    completedAt: optionalIso(row.completed_at)
  };
}

function mapReconciliationFinding(row: any): ReconciliationFindingRecord {
  return {
    id: row.id,
    runId: row.run_id,
    provider: str(row.provider),
    severity: row.severity,
    findingType: row.finding_type,
    withdrawalId: str(row.withdrawal_id),
    liquidationAddressId: str(row.liquidation_address_id),
    providerDrainId: str(row.provider_drain_id),
    resourceType: str(row.resource_type),
    resourceId: str(row.resource_id),
    referenceId: str(row.reference_id),
    webhookEventId: str(row.webhook_event_id),
    sivanTransactionId: str(row.sivan_transaction_id),
    message: row.message,
    expected: row.expected,
    actual: row.actual,
    status: row.status,
    createdAt: iso(row.created_at)
  };
}

async function upsertAuditLog(client: pg.PoolClient, item: AuditLogRecord) {
  await client.query(
    `insert into payments_audit_logs (id, actor_type, actor_id, action, resource_type, resource_id, severity, ip_address, user_agent, metadata, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do nothing`,
    [item.id, item.actorType, item.actorId, item.action, item.resourceType, item.resourceId, item.severity, item.ipAddress, item.userAgent, item.metadata ?? null, item.createdAt]
  );
}

async function upsertReconciliationRun(client: pg.PoolClient, item: ReconciliationRunRecord) {
  await client.query(
    `insert into payments_reconciliation_runs (id, provider, dry_run, status, summary, error, started_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set
       provider=excluded.provider, dry_run=excluded.dry_run, status=excluded.status, summary=excluded.summary, error=excluded.error, completed_at=excluded.completed_at`,
    [item.id, item.provider, item.dryRun, item.status, item.summary ?? null, item.error, item.startedAt, item.completedAt]
  );
}

async function upsertReconciliationFinding(client: pg.PoolClient, item: ReconciliationFindingRecord) {
  await client.query(
    `insert into payments_reconciliation_findings (id, run_id, provider, severity, finding_type, withdrawal_id, liquidation_address_id, provider_drain_id, resource_type, resource_id, reference_id, webhook_event_id, sivan_transaction_id, message, expected, actual, status, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     on conflict (id) do update set
       status=excluded.status,
       resource_type=excluded.resource_type,
       resource_id=excluded.resource_id,
       reference_id=excluded.reference_id,
       webhook_event_id=excluded.webhook_event_id,
       sivan_transaction_id=excluded.sivan_transaction_id`,
    [item.id, item.runId, item.provider, item.severity, item.findingType, item.withdrawalId, item.liquidationAddressId, item.providerDrainId, item.resourceType, item.resourceId, item.referenceId, item.webhookEventId, item.sivanTransactionId, item.message, item.expected ?? null, item.actual ?? null, item.status, item.createdAt]
  );
}

function mapAuthChallenge(row: any): AuthChallengeRecord {
  return {
    id: row.id,
    email: row.email,
    codeHash: row.code_hash,
    intent: row.intent,
    fullName: str(row.full_name),
    expiresAt: iso(row.expires_at),
    consumedAt: optionalIso(row.consumed_at),
    createdAt: iso(row.created_at),
    legalTermsVersion: str(row.legal_terms_version),
    legalPrivacyVersion: str(row.legal_privacy_version),
    legalRiskDisclosureVersion: str(row.legal_risk_disclosure_version),
    legalAcceptedAt: optionalIso(row.legal_accepted_at),
    legalAcceptanceIpAddress: str(row.legal_acceptance_ip_address),
    legalAcceptanceUserAgent: str(row.legal_acceptance_user_agent)
  };
}

async function upsertAuthChallenge(client: pg.PoolClient, item: AuthChallengeRecord) {
  await client.query(
    `insert into payments_auth_challenges (id, email, code_hash, intent, full_name, expires_at, consumed_at, created_at, legal_terms_version, legal_privacy_version, legal_risk_disclosure_version, legal_accepted_at, legal_acceptance_ip_address, legal_acceptance_user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (id) do update set
       code_hash=excluded.code_hash, intent=excluded.intent, full_name=excluded.full_name, expires_at=excluded.expires_at, consumed_at=excluded.consumed_at, legal_terms_version=excluded.legal_terms_version, legal_privacy_version=excluded.legal_privacy_version, legal_risk_disclosure_version=excluded.legal_risk_disclosure_version, legal_accepted_at=excluded.legal_accepted_at, legal_acceptance_ip_address=excluded.legal_acceptance_ip_address, legal_acceptance_user_agent=excluded.legal_acceptance_user_agent`,
    [item.id, item.email, item.codeHash, item.intent, item.fullName, item.expiresAt, item.consumedAt, item.createdAt, item.legalTermsVersion, item.legalPrivacyVersion, item.legalRiskDisclosureVersion, item.legalAcceptedAt, item.legalAcceptanceIpAddress, item.legalAcceptanceUserAgent]
  );
}

function inferPrimaryChannel(email?: string, whatsappNumber?: string): 'email' | 'whatsapp' | 'both' {
  if (email && whatsappNumber) return 'both';
  if (email) return 'email';
  return 'whatsapp';
}

function mapUnifiedWebhookLog(row: any): UnifiedWebhookLogRecord {
  return {
    id: row.id,
    serviceName: row.service_name,
    provider: row.provider,
    providerEventId: str(row.provider_event_id),
    paymentReference: str(row.payment_reference),
    eventCategory: str(row.event_category),
    eventType: str(row.event_type),
    payload: row.payload,
    createdAt: iso(row.created_at)
  };
}

async function upsertUnifiedWebhookLog(client: pg.PoolClient, item: UnifiedWebhookLogRecord) {
  await client.query(
    `insert into sivan_unified_webhook_logs (id, service_name, provider, provider_event_id, payment_reference, event_category, event_type, payload, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do nothing`,
    [item.id, item.serviceName, item.provider, item.providerEventId ?? null, item.paymentReference ?? null, item.eventCategory ?? null, item.eventType ?? null, item.payload, item.createdAt]
  );
}
