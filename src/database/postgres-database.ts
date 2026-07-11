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
  WebhookEventRecord,
  WithdrawalRecord,
  AuthChallengeRecord,
  AuditLogRecord,
  ReconciliationRunRecord,
  ReconciliationFindingRecord
} from './types.js';

const { Pool } = pg;

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
  }

  async read(): Promise<DatabaseShape> {
    const client = await this.pool.connect();
    try {
      const users = await client.query('select * from users order by created_at asc');
      const customers = await client.query('select * from payments_customers order by created_at asc');
      const externalAccounts = await client.query('select * from payments_external_accounts order by created_at asc');
      const liquidationAddresses = await client.query('select * from payments_liquidation_addresses order by created_at asc');
      const withdrawals = await client.query('select * from payments_withdrawals order by created_at asc');
      const webhookEvents = await client.query('select * from payments_webhook_events order by created_at asc');
      const authChallenges = await client.query('select * from payments_auth_challenges order by created_at asc');
      const auditLogs = await client.query('select * from payments_audit_logs order by created_at asc');
      const reconciliationRuns = await client.query('select * from payments_reconciliation_runs order by started_at asc');
      const reconciliationFindings = await client.query('select * from payments_reconciliation_findings order by created_at asc');

      return {
        users: users.rows.map(mapUser),
        customers: customers.rows.map(mapCustomer),
        externalAccounts: externalAccounts.rows.map(mapExternalAccount),
        liquidationAddresses: liquidationAddresses.rows.map(mapLiquidationAddress),
        withdrawals: withdrawals.rows.map(mapWithdrawal),
        webhookEvents: webhookEvents.rows.map(mapWebhookEvent),
        authChallenges: authChallenges.rows.map(mapAuthChallenge),
        auditLogs: auditLogs.rows.map(mapAuditLog),
        reconciliationRuns: reconciliationRuns.rows.map(mapReconciliationRun),
        reconciliationFindings: reconciliationFindings.rows.map(mapReconciliationFinding)
      };
    } finally {
      client.release();
    }
  }

  async mutate<T>(fn: (db: DatabaseShape) => T | Promise<T>): Promise<T> {
    const data = await this.read();
    const result = await fn(data);
    await this.persist(data);
    return result;
  }

  private async persist(data: DatabaseShape): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const user of data.users) await upsertUser(client, user);
      for (const customer of data.customers) await upsertCustomer(client, customer);
      for (const account of data.externalAccounts) await upsertExternalAccount(client, account);
      for (const address of data.liquidationAddresses) await upsertLiquidationAddress(client, address);
      for (const withdrawal of data.withdrawals) await upsertWithdrawal(client, withdrawal);
      for (const event of data.webhookEvents) await upsertWebhookEvent(client, event);
      for (const challenge of data.authChallenges ?? []) await upsertAuthChallenge(client, challenge);
      for (const auditLog of data.auditLogs ?? []) await upsertAuditLog(client, auditLog);
      for (const run of data.reconciliationRuns ?? []) await upsertReconciliationRun(client, run);
      for (const finding of data.reconciliationFindings ?? []) await upsertReconciliationFinding(client, finding);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
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
