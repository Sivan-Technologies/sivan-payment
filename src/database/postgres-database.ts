import pg from 'pg';
import { env } from '../config/env.js';
import type {
  Chain,
  Currency,
  CustomerRecord,
  DatabaseShape,
  ExternalAccountRecord,
  LiquidationAddressRecord,
  SourceCurrency,
  UserRecord,
  UserPreferencesRecord,
  WebhookEventRecord,
  WithdrawalRecord,
  AuthChallengeRecord,
  AuditLogRecord,
  ReconciliationRunRecord,
  ReconciliationFindingRecord,
  PaymentControlRecord,
  AssetControlRecord,
  NetworkControlRecord,
  SystemStatusRecord,
  CustomerTypeControlRecord,
  OnrampOrderRecord,
  SupportTicketRecord,
  SupportTicketMessageRecord,
  UnifiedWebhookLogRecord
} from './types.js';

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
      const customers = await client.query('select * from payments_customers order by created_at asc');
      const externalAccounts = await client.query('select * from payments_external_accounts order by created_at asc');
      const liquidationAddresses = await client.query('select * from payments_liquidation_addresses order by created_at asc');
      const withdrawals = await client.query('select * from payments_withdrawals order by created_at asc');
      const onrampOrders = await optionalQuery(client, 'select * from payments_onramp_orders order by created_at asc');
      const webhookEvents = await client.query('select * from payments_webhook_events order by created_at asc');
      const authChallenges = await client.query('select * from payments_auth_challenges order by created_at asc');
      const auditLogs = await client.query('select * from payments_audit_logs order by created_at asc');
      const reconciliationRuns = await client.query('select * from payments_reconciliation_runs order by started_at asc');
      const reconciliationFindings = await client.query('select * from payments_reconciliation_findings order by created_at asc');
      const paymentControls = await client.query('select * from payments_control_settings order by currency asc');
      const assetControls = await client.query('select * from payments_asset_controls order by asset asc');
      const networkControls = await client.query('select * from payments_network_controls order by sort_order asc');
      const systemStatus = await client.query('select * from payments_system_status order by id asc');
      const customerTypeControls = await client.query('select * from payments_customer_type_controls order by customer_type asc');
      const supportTickets = await optionalQuery(client, 'select * from payments_support_tickets order by created_at asc');
      const supportTicketMessages = await optionalQuery(client, 'select * from payments_support_ticket_messages order by created_at asc');
      const unifiedWebhookLogs = await client.query('select * from sivan_unified_webhook_logs order by created_at asc');

      return {
        users: users.rows.map(mapUser),
        userPreferences: userPreferences.rows.map(mapUserPreferences),
        customers: customers.rows.map(mapCustomer),
        externalAccounts: externalAccounts.rows.map(mapExternalAccount),
        liquidationAddresses: liquidationAddresses.rows.map(mapLiquidationAddress),
        withdrawals: withdrawals.rows.map(mapWithdrawal),
        onrampOrders: onrampOrders.rows.map(mapOnrampOrder),
        webhookEvents: webhookEvents.rows.map(mapWebhookEvent),
        authChallenges: authChallenges.rows.map(mapAuthChallenge),
        auditLogs: auditLogs.rows.map(mapAuditLog),
        reconciliationRuns: reconciliationRuns.rows.map(mapReconciliationRun),
        reconciliationFindings: reconciliationFindings.rows.map(mapReconciliationFinding),
        paymentControls: paymentControls.rows.map(mapPaymentControl),
        assetControls: assetControls.rows.map(mapAssetControl),
        networkControls: networkControls.rows.map(mapNetworkControl),
        systemStatus: systemStatus.rows.map(mapSystemStatus),
        customerTypeControls: customerTypeControls.rows.map(mapCustomerTypeControl),
        unifiedWebhookLogs: unifiedWebhookLogs.rows.map(mapUnifiedWebhookLog),
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
      const countMap = (rows: any[]) => new Map(rows.filter((row) => userIds.includes(row.user_id)).map((row) => [row.user_id, Number(row.count)]));
      const externalMap = countMap(externalCounts.rows);
      const withdrawalMap = countMap(withdrawalCounts.rows);
      const onrampMap = countMap(onrampCounts.rows);
      return users.map((user) => ({
        ...user,
        customer: customers.find((customer) => customer.userId === user.id) ?? null,
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


  async updatePaymentControlsSnapshot(input: { customerTypes: CustomerTypeControlRecord[]; payoutCurrencies: PaymentControlRecord[]; sourceAssets: AssetControlRecord[]; sourceNetworks: NetworkControlRecord[] }) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const control of input.customerTypes) await upsertCustomerTypeControl(client, control);
      for (const control of input.payoutCurrencies) await upsertPaymentControl(client, control);
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
      for (const customer of data.customers) await upsertCustomer(client, customer);
      for (const account of data.externalAccounts) await upsertExternalAccount(client, account);
      for (const address of data.liquidationAddresses) await upsertLiquidationAddress(client, address);
      for (const withdrawal of data.withdrawals) await upsertWithdrawal(client, withdrawal);
      for (const order of data.onrampOrders ?? []) await upsertOnrampOrder(client, order);
      for (const event of data.webhookEvents) await upsertWebhookEvent(client, event);
      for (const challenge of data.authChallenges ?? []) await upsertAuthChallenge(client, challenge);
      for (const auditLog of data.auditLogs ?? []) await upsertAuditLog(client, auditLog);
      for (const run of data.reconciliationRuns ?? []) await upsertReconciliationRun(client, run);
      for (const finding of data.reconciliationFindings ?? []) await upsertReconciliationFinding(client, finding);
      for (const control of data.paymentControls ?? []) await upsertPaymentControl(client, control);
      for (const control of data.assetControls ?? []) await upsertAssetControl(client, control);
      for (const control of data.networkControls ?? []) await upsertNetworkControl(client, control);
      for (const status of data.systemStatus ?? []) await upsertSystemStatus(client, status);
      for (const control of data.customerTypeControls ?? []) await upsertCustomerTypeControl(client, control);
      for (const log of data.unifiedWebhookLogs ?? []) await upsertUnifiedWebhookLog(client, log);
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

function mapUser(row: any): UserRecord {
  const first = row.first_name ?? '';
  const last = row.last_name ?? '';
  const displayIdentity = row.email ?? row.whatsapp_number ?? row.user_id;
  return {
    id: row.user_id,
    email: row.email ?? '',
    whatsappNumber: str(row.whatsapp_number),
    fullName: [first, last].filter(Boolean).join(' ') || displayIdentity,
    primaryChannel: row.primary_channel,
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
  return {
    id: row.id,
    ticketId: row.ticket_id,
    senderType: row.sender_type,
    senderId: str(row.sender_id),
    message: row.message,
    attachments: row.attachments,
    internalNote: row.internal_note,
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
    `insert into payments_support_ticket_messages (id, ticket_id, sender_type, sender_id, message, attachments, internal_note, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set
       sender_type=excluded.sender_type,
       sender_id=excluded.sender_id,
       message=excluded.message,
       attachments=excluded.attachments,
       internal_note=excluded.internal_note`,
    [item.id, item.ticketId, item.senderType, item.senderId, item.message, item.attachments ?? null, item.internalNote ?? false, item.createdAt]
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

async function upsertUser(client: pg.PoolClient, user: UserRecord) {
  const { firstName, lastName } = splitName(user.fullName);
  const primaryChannel = user.primaryChannel ?? inferPrimaryChannel(user.email, user.whatsappNumber);
  await client.query(
    `insert into users (user_id, whatsapp_number, email, first_name, last_name, role_history, primary_channel, email_verified_at, whatsapp_verified_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (user_id) do update set
       whatsapp_number = excluded.whatsapp_number,
       email = excluded.email,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       primary_channel = excluded.primary_channel,
       email_verified_at = excluded.email_verified_at,
       whatsapp_verified_at = excluded.whatsapp_verified_at,
       updated_at = excluded.updated_at`,
    [user.id, user.whatsappNumber ?? null, user.email || null, firstName, lastName, JSON.stringify(['payments_user']), primaryChannel, user.emailVerifiedAt ?? null, user.whatsappVerifiedAt ?? null, user.createdAt, user.updatedAt]
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
    `insert into payments_reconciliation_findings (id, run_id, provider, severity, finding_type, withdrawal_id, liquidation_address_id, provider_drain_id, message, expected, actual, status, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (id) do update set status=excluded.status`,
    [item.id, item.runId, item.provider, item.severity, item.findingType, item.withdrawalId, item.liquidationAddressId, item.providerDrainId, item.message, item.expected ?? null, item.actual ?? null, item.status, item.createdAt]
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
    createdAt: iso(row.created_at)
  };
}

async function upsertAuthChallenge(client: pg.PoolClient, item: AuthChallengeRecord) {
  await client.query(
    `insert into payments_auth_challenges (id, email, code_hash, intent, full_name, expires_at, consumed_at, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set
       code_hash=excluded.code_hash, intent=excluded.intent, full_name=excluded.full_name, expires_at=excluded.expires_at, consumed_at=excluded.consumed_at`,
    [item.id, item.email, item.codeHash, item.intent, item.fullName, item.expiresAt, item.consumedAt, item.createdAt]
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
