import type {
  AuditLogRecord,
  AuthChallengeRecord,
  CustomerRecord,
  ExternalAccountRecord,
  LiquidationAddressRecord,
  OnrampOrderRecord,
  ReconciliationFindingRecord,
  ReconciliationRunRecord,
  UserRecord,
  WebhookEventRecord,
  WithdrawalRecord,
  PaymentControlRecord,
  AssetControlRecord,
  NetworkControlRecord,
  CustomerTypeControlRecord,
  SystemStatusRecord
} from './types.js';

export interface UserRepository {
  findUserById(userId: string): Promise<UserRecord | undefined>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserByWhatsappNumber(whatsappNumber: string): Promise<UserRecord | undefined>;
  insertUserRecord(record: UserRecord): Promise<UserRecord>;
}

export interface AuthRepository {
  insertAuthChallengeRecord(record: AuthChallengeRecord): Promise<AuthChallengeRecord>;
  consumeAuthChallengeAndMarkUserEmail(challengeId: string, userId: string, now: string): Promise<AuthChallengeRecord | null>;
}

export interface PaymentsWriteRepository {
  insertCustomerRecord(record: CustomerRecord): Promise<CustomerRecord>;
  updateCustomerRecord(record: CustomerRecord): Promise<CustomerRecord>;
  insertExternalAccountRecord(record: ExternalAccountRecord): Promise<ExternalAccountRecord>;
  updateExternalAccountRecord(record: ExternalAccountRecord): Promise<ExternalAccountRecord>;
  createWithdrawalRecords(liquidationAddress: LiquidationAddressRecord, withdrawal: WithdrawalRecord): Promise<{ liquidationAddress: LiquidationAddressRecord; withdrawal: WithdrawalRecord }>;
  updateWithdrawalRecord(record: WithdrawalRecord): Promise<WithdrawalRecord>;
  insertOnrampOrderRecord(record: OnrampOrderRecord): Promise<OnrampOrderRecord>;
  updateOnrampOrderRecord(record: OnrampOrderRecord): Promise<OnrampOrderRecord>;
}

export interface EventRepository {
  insertWebhookEventRecord(record: WebhookEventRecord): Promise<WebhookEventRecord>;
  updateWebhookEventRecord(record: WebhookEventRecord): Promise<WebhookEventRecord>;
  insertAuditLogRecord(record: AuditLogRecord): Promise<AuditLogRecord>;
}

export interface ControlsRepository {
  updatePaymentControlsSnapshot(input: {
    customerTypes: CustomerTypeControlRecord[];
    payoutCurrencies: PaymentControlRecord[];
    sourceAssets: AssetControlRecord[];
    sourceNetworks: NetworkControlRecord[];
  }): Promise<unknown>;
  updateSystemStatusRecord(record: SystemStatusRecord): Promise<SystemStatusRecord>;
}

export interface ReconciliationRepository {
  insertReconciliationRecords(run: ReconciliationRunRecord, findings: ReconciliationFindingRecord[]): Promise<ReconciliationRunRecord>;
}

export interface AdminReadRepository {
  getAdminOverviewView(): Promise<unknown>;
  listAdminUsersView(options?: { limit?: number; offset?: number }): Promise<unknown[]>;
  listAdminWithdrawalsView(options?: { limit?: number; offset?: number; status?: string }): Promise<unknown[]>;
  listAdminOnrampOrdersView(options?: { limit?: number; offset?: number; status?: string }): Promise<unknown[]>;
  listWebhookEventsView(options?: { limit?: number; offset?: number }): Promise<WebhookEventRecord[]>;
  listAuditLogsView(options?: { limit?: number; offset?: number }): Promise<AuditLogRecord[]>;
  listReconciliationRunsView(options?: { limit?: number; offset?: number }): Promise<unknown[]>;
}

export type PaymentsRepository =
  UserRepository &
  AuthRepository &
  PaymentsWriteRepository &
  EventRepository &
  ControlsRepository &
  ReconciliationRepository &
  AdminReadRepository;
