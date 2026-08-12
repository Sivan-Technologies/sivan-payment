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
  CustomerIdentityLinkRecord,
  IdentityPairingTokenRecord,
  WithdrawalPinRecord,
  WithdrawalStepUpTokenRecord,
  LegalAcceptanceRecord,
  WebhookEventRecord,
  WithdrawalRecord,
  PaymentControlRecord,
  VirtualAccountControlRecord,
  AssetControlRecord,
  NetworkControlRecord,
  CustomerTypeControlRecord,
  SystemStatusRecord,
  TransactionReferenceRecord
} from './types.js';
import type { VirtualAccountEventRecord, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord } from '../virtual-accounts/types/virtual-account.types.js';

export interface UserRepository {
  findUserById(userId: string): Promise<UserRecord | undefined>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserByWhatsappNumber(whatsappNumber: string): Promise<UserRecord | undefined>;
  findUserByTelegramUserId(telegramUserId: string): Promise<UserRecord | undefined>;
  insertUserRecord(record: UserRecord): Promise<UserRecord>;
  updateUserRecord(record: UserRecord): Promise<UserRecord>;
  listCustomerIdentityLinks(): Promise<CustomerIdentityLinkRecord[]>;
  upsertCustomerIdentityLinkRecord(record: CustomerIdentityLinkRecord): Promise<CustomerIdentityLinkRecord>;
  listIdentityPairingTokens(): Promise<IdentityPairingTokenRecord[]>;
  upsertIdentityPairingTokenRecord(record: IdentityPairingTokenRecord): Promise<IdentityPairingTokenRecord>;

  listWithdrawalPins(): Promise<WithdrawalPinRecord[]>;
  upsertWithdrawalPinRecord(record: WithdrawalPinRecord): Promise<WithdrawalPinRecord>;
  listWithdrawalStepUpTokens(): Promise<WithdrawalStepUpTokenRecord[]>;
  upsertWithdrawalStepUpTokenRecord(record: WithdrawalStepUpTokenRecord): Promise<WithdrawalStepUpTokenRecord>;
  /**
   * Marks a step-up token spent, returning false if it was ALREADY spent.
   *
   * Separate from the upsert because it must be atomic: two withdrawal requests
   * carrying the same token must not both be told they may proceed. A
   * read-then-write in the caller would let both pass between the read and the
   * write.
   */
  consumeWithdrawalStepUpToken(id: string, usedAt: string): Promise<boolean>;
  listVirtualAccountRequests(): Promise<VirtualAccountRequestRecord[]>;
  upsertVirtualAccountRequestRecord(record: VirtualAccountRequestRecord): Promise<VirtualAccountRequestRecord>;
  listVirtualAccounts(): Promise<VirtualAccountRecord[]>;
  upsertVirtualAccountRecord(record: VirtualAccountRecord): Promise<VirtualAccountRecord>;
  listVirtualAccountEvents(): Promise<VirtualAccountEventRecord[]>;
  upsertVirtualAccountEventRecord(record: VirtualAccountEventRecord): Promise<VirtualAccountEventRecord>;
  listVirtualAccountTransactions(): Promise<VirtualAccountTransactionRecord[]>;
  upsertVirtualAccountTransactionRecord(record: VirtualAccountTransactionRecord): Promise<VirtualAccountTransactionRecord>;
  listTransactionReferences(): Promise<TransactionReferenceRecord[]>;
  upsertTransactionReferenceRecord(record: TransactionReferenceRecord): Promise<TransactionReferenceRecord>;
}

export interface AuthRepository {
  insertAuthChallengeRecord(record: AuthChallengeRecord): Promise<AuthChallengeRecord>;
  insertLegalAcceptanceRecord(record: LegalAcceptanceRecord): Promise<LegalAcceptanceRecord>;
  listLegalAcceptancesForUser(userId: string): Promise<LegalAcceptanceRecord[]>;
  consumeAuthChallengeAndMarkUserEmail(challengeId: string, userId: string, now: string): Promise<AuthChallengeRecord | null>;
}

export interface PaymentsWriteRepository {
  insertCustomerRecord(record: CustomerRecord): Promise<CustomerRecord>;
  updateCustomerRecord(record: CustomerRecord): Promise<CustomerRecord>;
  insertExternalAccountRecord(record: ExternalAccountRecord): Promise<ExternalAccountRecord>;
  updateExternalAccountRecord(record: ExternalAccountRecord): Promise<ExternalAccountRecord>;
  createWithdrawalRecords(liquidationAddress: LiquidationAddressRecord, withdrawal: WithdrawalRecord): Promise<{ liquidationAddress: LiquidationAddressRecord; withdrawal: WithdrawalRecord }>;
  updateWithdrawalRecord(record: WithdrawalRecord): Promise<WithdrawalRecord>;
  /** One user's limit-consuming withdrawals since an ISO timestamp. */
  listWithdrawalsByUserSince(userId: string, sinceIso: string): Promise<WithdrawalRecord[]>;
  listExternalAccountsByUser(userId: string): Promise<ExternalAccountRecord[]>;
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
    virtualAccounts: VirtualAccountControlRecord[];
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
