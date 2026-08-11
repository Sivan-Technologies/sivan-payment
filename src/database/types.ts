import type { NgnControlsRecord, NgnQuoteRecord, NgnTransferRecord, NgnWebhookRecord } from '../ngn/types/ngn.types.js';
import type { VirtualAccountEventRecord, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord } from '../virtual-accounts/types/virtual-account.types.js';
export type Currency = 'usd' | 'gbp' | 'eur';
export type SupplierPayoutCurrency = Currency | 'mxn' | 'brl';
export type SourceCurrency = 'usdc' | 'usdt';
export type Chain = 'ethereum' | 'polygon' | 'base' | 'solana' | 'arbitrum' | 'optimism' | 'avalanche_c_chain';
export type CustomerStatus = 'created' | 'kyc_not_started' | 'kyc_incomplete' | 'kyc_under_review' | 'kyc_approved' | 'kyc_rejected' | 'paused' | 'offboarded';
export type ExternalAccountStatus = 'created' | 'active' | 'verification_pending' | 'verified' | 'verification_failed' | 'deactivated';
export type OnrampStatus = 'created' | 'awaiting_payment' | 'payment_received' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'requires_action';

export type WithdrawalStatus =
  | 'created'
  | 'pending_deposit'
  | 'deposit_received'
  | 'converting'
  | 'payout_processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'requires_action';

/**
 * Withdrawal statuses that CONSUME foreign-rail headroom.
 *
 * The exact counterpart of NGN_LIMIT_CONSUMING_STATUSES, and deliberately
 * shaped the same way: typed to WithdrawalStatus so a status that does not
 * exist cannot be listed, and exported as one constant so the JSON driver and
 * the Postgres query cannot disagree about what counts. A hand-copied status
 * list in a limit predicate is how the NGN version silently matched nothing
 * for a while.
 *
 * IN-FLIGHT MONEY COUNTS. A withdrawal sitting at pending_deposit has a live
 * liquidation address and, on the balance-funded path, may already have had
 * the user's USDC swept to it. Treating that as zero is what lets someone hold
 * several withdrawals over a single ceiling - the same hole that was closed on
 * the naira side.
 *
 * failed and cancelled are absent on purpose: nothing moved, and charging a
 * user's ceiling for a provider outage or their own abandonment would be
 * punishing them for it. 'requires_action' IS counted - the money is with us
 * pending a human, exactly like the NGN 'requires_review' case.
 */
export const WITHDRAWAL_LIMIT_CONSUMING_STATUSES: ReadonlySet<WithdrawalStatus> = new Set([
  'created',
  'pending_deposit',
  'deposit_received',
  'converting',
  'payout_processing',
  'completed',
  'requires_action',
]);





export interface CustomerTypeControlRecord {
  customerType: 'individual' | 'business';
  enabled: boolean;
  label: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface AceSupportSessionRecord {
  id: string;
  userId?: string;
  channel: string;
  resourceType?: string;
  resourceId?: string;
  confidence: 'high' | 'medium' | 'low';
  needsHuman: boolean;
  toolsUsed: string[];
  evidenceSnapshot: unknown;
  createdAt: string;
}

export interface AceSupportMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'ace' | 'admin';
  message: string;
  createdAt: string;
}

export interface AceToolCallRecord {
  id: string;
  sessionId: string;
  toolName: string;
  status: 'success' | 'failed';
  summary?: string;
  createdAt: string;
}

export interface AceSupportResolutionRecord {
  id: string;
  sessionId: string;
  resolutionType: 'answered' | 'escalated' | 'ticket_recommended';
  summary: string;
  createdAt: string;
}

export interface SystemIncidentRecord {
  id: string;
  provider: string;
  affectedService: 'withdrawals' | 'onramp' | 'virtual_accounts' | 'webhooks' | 'all' | 'other';
  severity: 'info' | 'warning' | 'critical';
  status: 'active' | 'monitoring' | 'resolved';
  message: string;
  startedAt: string;
  eta?: string;
  resolvedAt?: string;
  resolutionSummary?: string;
  createdBy?: string;
  resolvedBy?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SystemStatusRecord {
  id: 'global';
  mode: 'active' | 'maintenance' | 'paused';
  message?: string;
  estimatedResumeAt?: string;
  activeIncidents?: SystemIncidentRecord[];
  updatedBy?: string;
  updatedAt: string;
}

export interface AssetControlRecord {
  asset: SourceCurrency;
  enabled: boolean;
  label: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface NetworkControlRecord {
  network: Chain;
  enabled: boolean;
  label: string;
  sortOrder: number;
  updatedBy?: string;
  updatedAt: string;
}


export interface VirtualAccountControlRecord {
  currency: 'usd' | 'gbp' | 'eur';
  enabled: boolean;
  label: string;
  provider: string;
  accountType: 'us' | 'gb' | 'iban';
  paymentRails: string[];
  updatedBy?: string;
  updatedAt: string;
}

/**
 * The currencies a user may be PAID OUT in.
 *
 * Deliberately a separate type from `Currency`. `Currency` means "a currency
 * Bridge settles", and it is used by external accounts, virtual accounts and
 * the on-ramp - none of which can carry naira. Naira is a payout rail
 * (Breet/NIP), so widening `Currency` itself would have made 'ngn' assignable
 * to every Bridge call site that cannot handle it, and TypeScript would have
 * stopped complaining about exactly the mistakes it should catch.
 */
export type PayoutCurrency = Currency | 'ngn';

export interface PaymentControlRecord {
  currency: PayoutCurrency;
  enabled: boolean;
  label: string;
  /** 'nuban' is the naira shape and is NOT part of the Bridge external-account union. */
  accountType: 'us' | 'gb' | 'iban' | 'nuban';
  defaultPaymentRail: string;
  updatedBy?: string;
  updatedAt: string;
}


export interface LegalAcceptanceRecord {
  id: string;
  userId: string;
  email: string;
  termsVersion: string;
  privacyVersion: string;
  riskDisclosureVersion: string;
  acceptedAt: string;
  ipAddress?: string;
  userAgent?: string;
  source: 'signup' | 'manual' | 'migration';
  createdAt: string;
}

/**
 * Mainnet is real money; testnet is faucet tokens with no value.
 *
 * `Chain` above deliberately does not encode this - a Base deposit is `base`
 * whichever network it arrived on - so the mode is carried separately and must
 * accompany any record that represents value. Two rows with the same chain,
 * asset and amount are not the same thing if their NetworkMode differs, and
 * summing across them would count faucet tokens as spendable balance.
 *
 * Fixed per deployment and NOT stored per user - see resolveNetworkMode() in
 * src/wallets/network-mode.ts.
 */
export type NetworkMode = 'mainnet' | 'testnet';

export interface UserPreferencesRecord {
  userId: string;
  defaultFiatCurrency: Currency | 'ngn';
  language: string;
  transactionUpdates: boolean;
  marketingEmails: boolean;
  securityAlerts: boolean;
  emailConfirmationsForHighValue: boolean;
  // No `network` here on purpose. The chain a user signs against is a property
  // of the deployment they are talking to, not something they choose, so there
  // is nothing to store. resolveNetworkMode() answers it.
  updatedAt: string;
}


export interface UserTwoFactorRecord {
  userId: string;
  enabled: boolean;
  secretEncrypted: string;
  recoveryCodeHashes: string[];
  enabledAt?: string;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserTwoFactorRecoveryQuestionRecord {
  id: string;
  userId: string;
  questionId: string;
  questionText: string;
  answerHash: string;
  answerSalt: string;
  algorithm: 'scrypt-sha256-v1';
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord {
  id: string;
  email: string;
  whatsappNumber?: string;
  fullName: string;
  /**
   * ISO 3166-1 alpha-2, uppercase. DECLARED, not proven.
   *
   * Decides which verification flow a user is shown - Nigeria verifies via
   * bank name resolution, everywhere else via Bridge. What a user is actually
   * PERMITTED to do is decided by verified evidence, never by this field.
   */
  country?: string;
  /**
   * Declared date of birth, ISO yyyy-MM-dd. DECLARED, not proven.
   *
   * Forwarded to Bridge as `birth_date` to satisfy the `date_of_birth` and
   * `min_age_18` endorsement requirements. Persona verifies it against a
   * government ID during the hosted flow; this field is what unblocks the
   * customer record so that flow can complete at all.
   */
  dateOfBirth?: string;
  username?: string;
  usernameUpdatedAt?: string;
  /** Numeric Telegram user id, as a string. Set once a Telegram link is redeemed. */
  telegramUserId?: string;
  telegramUsername?: string;
  telegramVerifiedAt?: string;
  primaryChannel?: 'email' | 'whatsapp' | 'telegram' | 'both';
  avatarUrl?: string;
  avatarObjectKey?: string;
  avatarUpdatedAt?: string;
  emailVerifiedAt?: string;
  whatsappVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}


/** The messaging channels a Sivan account can be reachable on. */
export type IdentityChannel = 'whatsapp' | 'telegram';

export interface CustomerIdentityLinkRecord {
  id: string;
  paymentUserId: string;
  escrowUserId?: string;
  email: string;
  /**
   * Which channel this link is for. Optional in the type because rows written
   * before migration 044 have no value; treat `undefined` as 'whatsapp', which
   * is what the column default backfills them to.
   */
  channel?: IdentityChannel;
  /** Set when channel is 'whatsapp'. A Telegram link has no phone number. */
  whatsappNumber?: string;
  /** Set when channel is 'telegram'. Authenticated by Telegram on every update. */
  telegramUserId?: string;
  /** Display only: Telegram usernames can be changed and re-registered. */
  telegramUsername?: string;
  status: 'linked' | 'unlinked';
  linkedAt?: string;
  unlinkedAt?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * The withdrawal PIN, keyed by payment user and by NOTHING ELSE.
 *
 * There is deliberately no `channel` field. One person has one PIN and it works
 * identically from WhatsApp, Telegram and any channel added later. A per-channel
 * field is exactly the shape that lets a second PIN come into existence, so the
 * type refuses to offer one.
 */
export interface WithdrawalPinRecord {
  userId: string;
  pinHash: string;
  pinSalt: string;
  algorithm: 'scrypt-sha256-v1';
  setAt: string;
  updatedAt: string;
  /** Chat withdrawals are refused until this time, set when the PIN changes. */
  withdrawalsHeldUntil?: string;
  failedAttempts: number;
  lockedUntil?: string;
}

/**
 * Single-use proof that the account owner presented their PIN for ONE specific
 * withdrawal. Required in addition to the bot's service secret, so that a
 * leaked secret cannot move money by itself.
 */
export interface WithdrawalStepUpTokenRecord {
  id: string;
  userId: string;
  /** Only the hash is stored; the plaintext is returned to the bot once. */
  tokenHash: string;
  /** sha256 over the canonical user/currency/amount/destination tuple. */
  bindingHash: string;
  channel: string;
  amountText?: string;
  currency?: string;
  destinationRef?: string;
  usedAt?: string;
  expiresAt: string;
  createdAt: string;
}

export interface IdentityPairingTokenRecord {
  id: string;
  paymentUserId: string;
  tokenHash: string;
  /**
   * Which channel this code was issued for. A code generated for Telegram must
   * not be redeemable by the WhatsApp bot, or either bot could claim any
   * pending code for a user. Undefined on pre-044 rows, which are all WhatsApp.
   */
  channel?: IdentityChannel;
  status: 'pending' | 'redeemed' | 'canceled' | 'expired';
  expiresAt: string;
  redeemedAt?: string;
  canceledAt?: string;
  whatsappNumber?: string;
  telegramUserId?: string;
  escrowUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerRecord {
  id: string;
  userId: string;
  provider: string;
  providerCustomerId: string;
  customerType?: 'individual' | 'business';
  kycLinkId?: string;
  kycLink?: string;
  tosLink?: string;
  kycStatus: CustomerStatus;
  tosStatus?: 'pending' | 'approved';
  onboardingCostUsd?: string;
  onboardingCostType?: 'kyc' | 'kyb';
  onboardingCostRecordedAt?: string;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * A Bridge wallet belonging to ONE customer.
 *
 * Per Bridge's documented pattern, each customer gets their own wallet and
 * their virtual account settles into it:
 *
 *   POST /customers/{id}/wallets              -> wallet for that customer
 *   POST /customers/{id}/virtual_accounts
 *        destination.bridge_wallet_id = that customer's wallet
 *
 * This matters beyond tidiness. If every user's virtual account settled into
 * one pooled Sivan wallet, Sivan would be holding user funds on its own books
 * and tracking ownership in its own database - which Bridge ToS 2.1(m)
 * prohibits. With per-customer wallets Bridge is the custodian and the source
 * of truth for balances, and Sivan is only an interface.
 */
export interface UserWalletRecord {
  id: string;
  userId: string;
  /**
   * Bridge customer id. OPTIONAL, because a wallet no longer implies one.
   *
   * Bridge's custodial wallets are customer-scoped, so a Bridge wallet always
   * has this. A Privy wallet does not: Privy wallets are user-owned and cost
   * Sivan no Bridge onboarding, so a user can hold one having never been
   * registered with Bridge at all.
   */
  customerId?: string;
  provider: string;
  /** Bridge wallet id, used as destination.bridge_wallet_id. */
  providerWalletId: string;
  chain: WalletChain;
  /** On-chain address the user can be shown and can deposit to. */
  address: string;
  status: 'provisioning' | 'active' | 'suspended' | 'closed' | 'failed';
  /** True when the provider holds the keys. Drives what the UI may claim. */
  custodial: boolean;
  /**
   * Whether Sivan holds a delegated signer on this wallet.
   *
   * Persisted because it is immutable at Privy and therefore permanent per
   * wallet: additional signers are set AT CREATION, and adding one later needs
   * the owner's signature, which Sivan does not have. A wallet provisioned
   * before delegated signing existed can never gain it, so the code must be
   * able to tell the two apart and degrade honestly rather than failing at
   * signing time.
   */
  delegatedSigningEnabled?: boolean;
  /** Key quorum id acting as signer, for audit and reconciliation. */
  delegatedSignerId?: string;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * Solana is the default because it is the only supported chain that carries
 * BOTH USDC and USDT, and it has the lowest fees. Base cannot hold USDT.
 */
export type WalletChain = 'solana' | 'base' | 'ethereum';

export const DEFAULT_WALLET_CHAIN: WalletChain = 'solana';

export interface ExternalAccountRecord {
  id: string;
  userId: string;
  customerId: string;
  provider: string;
  providerExternalAccountId: string;
  currency: Currency;
  accountType: 'us' | 'gb' | 'iban' | 'unknown';
  bankName?: string;
  accountName?: string;
  accountOwnerName: string;
  accountLast4?: string;
  paymentRail: string;
  status: ExternalAccountStatus;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * A Nigerian payout account and the name-match verdict attached to it.
 *
 * Separate from ExternalAccountRecord, which is Bridge-shaped ('us' | 'gb' |
 * 'iban') and cannot hold a NUBAN plus a provider-specific bank id. See
 * migration 037 for the full reasoning.
 */
export interface NgnPayoutAccountRecord {
  id: string;
  userId: string;
  /**
   * The provider whose directory this bankId came from. Bank ids are NOT
   * portable between providers, so a row without this is a payout waiting to
   * go to the wrong bank.
   */
  provider: string;
  bankId: string;
  bankName?: string;
  accountNumber: string;
  /** The name the bank returned. */
  accountName: string;
  /** The name on file when the match ran. Denormalised so the verdict stays auditable. */
  declaredName: string;
  matchVerdict: 'match' | 'review' | 'mismatch';
  matchScore: number;
  matchExplanation?: string;
  matchedTokens?: string[];
  unmatchedBankTokens?: string[];
  /** False in sandbox, where any account number resolves to a plausible name. */
  resolutionTrustworthy: boolean;
  status: 'pending_review' | 'verified' | 'rejected';
  /**
   * WHY this status, so the admin queue can separate the two very different
   * things that both read as 'pending_review':
   *
   *   name_needs_review        a person must compare two names
   *   resolution_untrustworthy the provider is a sandbox that resolves any
   *                            ten digits - no human judgement can fix it
   */
  reviewReason?: 'auto_verified' | 'name_needs_review' | 'name_mismatch' | 'resolution_untrustworthy';
  /** True only when an operator's judgement is what unblocks the user. */
  needsHumanReview?: boolean;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LiquidationAddressRecord {
  id: string;
  userId: string;
  customerId: string;
  externalAccountId: string;
  provider: string;
  providerLiquidationAddressId: string;
  address: string;
  memolessAddress?: string;
  chain: Chain;
  sourceCurrency: SourceCurrency;
  destinationCurrency: Currency;
  destinationPaymentRail: string;
  returnAddress?: string;
  returnInstructions?: unknown;
  customDeveloperFeePercent?: string;
  status: 'active' | 'inactive' | 'created';
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface WithdrawalRecord {
  id: string;
  userId: string;
  customerId: string;
  externalAccountId: string;
  liquidationAddressId: string;
  provider: string;
  providerDrainId?: string;
  sourceCurrency: SourceCurrency;
  destinationCurrency: Currency;
  sourceAmount?: string;
  destinationAmount?: string;
  feePercent?: string;
  feeAmount?: string;
  depositTxHash?: string;
  destinationReference?: string;
  destinationTxHash?: string;
  status: WithdrawalStatus;
  statusReason?: string;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}


export interface OnrampOrderRecord {
  id: string;
  userId: string;
  customerId: string;
  provider: string;
  providerTransferId?: string;
  sourceCurrency: Currency;
  sourcePaymentRail: string;
  destinationCurrency: SourceCurrency;
  destinationChain: Chain;
  destinationAddress: string;
  amount: string;
  feePercent?: string;
  feeAmount?: string;
  netAmount?: string;
  providerReference?: string;
  sourceDepositInstructions?: unknown;
  destinationTxHash?: string;
  status: OnrampStatus;
  statusReason?: string;
  receipt?: unknown;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type SupplierStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'disabled';
export type SupplierPaymentStatus = 'draft' | 'pending_review' | 'approved' | 'processing' | 'completed' | 'rejected' | 'failed';
export type SupplierRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type SupplierAccountType = 'us' | 'gb' | 'iban' | 'clabe' | 'pix' | 'unknown';

export interface SupplierRecord {
  id: string;
  userId: string;
  customerId: string;
  supplierName: string;
  supplierType: 'individual' | 'business';
  supplierCountry: string;
  currency: SupplierPayoutCurrency;
  bankName: string;
  accountOwnerName: string;
  accountType: SupplierAccountType;
  accountLast4?: string;
  provider: string;
  providerExternalAccountId?: string;
  providerRail?: string;
  bridgeExternalAccountId?: string;
  status: SupplierStatus;
  riskLevel: SupplierRiskLevel;
  riskScore: number;
  reviewReason?: string;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierPaymentRecord {
  id: string;
  userId: string;
  supplierId: string;
  /**
   * THE GROSS: what leaves the user's balance, and what is sent to Bridge as
   * the transfer `amount`.
   *
   * Equals netAmount + feeAmount. Bridge deducts developer_fee FROM the
   * transfer amount, so submitting the gross is what makes the supplier
   * receive the full invoice.
   *
   * Kept as `amount` rather than renamed: it is what the hold, the ledger and
   * the provider call all consume, and every one of those already means "the
   * sum debited". Renaming it would have been a wide, silent change to money
   * paths for a cosmetic gain.
   */
  amount: string;
  /**
   * What the supplier actually receives - the figure the user typed.
   *
   * Optional because payments created before supplier pricing existed have no
   * fee split. Readers must fall back to `amount` when it is absent, which is
   * correct for those records: they were charged no fee, so gross == net.
   */
  netAmount?: string;
  /** Sivan's fee, sent to Bridge as developer_fee. Two decimals. */
  feeAmount?: string;
  /** Effective rate against netAmount, for display and reporting. */
  feeEffectivePercent?: string;
  /** The 30-day volume discount applied, 0 when none. */
  feeVolumeDiscountPercent?: number;
  /** The rolling volume the discount was based on, for support questions. */
  feeVolumeUsd?: string;
  /** The one-time supplier-onboarding charge, when this was a first payment. */
  feeNewSupplierAmount?: string;
  sourceAsset: SourceCurrency;
  destinationCurrency: SupplierPayoutCurrency;
  paymentPurpose: string;
  invoiceUrl?: string;
  status: SupplierPaymentStatus;
  provider?: string;
  providerTransferId?: string;
  providerRail?: string;
  executionMode?: 'provider' | 'manual_review' | 'manual_treasury';
  bridgeTransferId?: string;
  riskLevel: SupplierRiskLevel;
  riskScore: number;
  adminDecision?: 'approved' | 'rejected';
  adminDecisionBy?: string;
  adminDecisionAt?: string;
  reviewReason?: string;
  aceRiskReview?: unknown;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * An admin-granted supplier volume floor.
 *
 * WHY THIS EXISTS: the volume discount can only measure what Sivan can see. A
 * customer who settles half their invoices through another provider is larger
 * than Sivan's records show, and inferring that would be inventing data. This
 * is the honest alternative - a human decision, recorded with who made it, why,
 * and when it lapses.
 */
export interface SupplierVolumeGrantRecord {
  id: string;
  userId: string;
  /** The 30-day volume to CREDIT this user with, in USD. Applied as a floor. */
  volumeUsd: string;
  /** Why sales/compliance agreed it. Required - a grant with no rationale is unauditable. */
  reason: string;
  grantedBy: string;
  /**
   * When it lapses. Grants expire by default so a forgotten discount cannot
   * run forever; the read path enforces this rather than a cleanup job.
   */
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierControlsRecord {
  id: 'global';
  supplierPaymentsEnabled: boolean;
  thirdPartySupplierPayoutsEnabled: boolean;
  autoApproveApprovedSuppliers: boolean;
  requireInvoiceForSupplierPayouts: boolean;
  manualReviewThreshold: number;
  newSupplierFirstPaymentReview: boolean;
  newCustomerReviewWindowDays: number;
  newCustomerReviewThreshold: number;
  highRiskCountries: string[];
  blockedCountries: string[];
  dailySupplierPayoutLimit: number;
  monthlySupplierPayoutLimit: number;
  updatedBy?: string;
  reason?: string;
  updatedAt: string;
}


export type SupportTicketStatus = 'open' | 'in_review' | 'waiting_on_user' | 'waiting_on_provider' | 'resolved' | 'closed';
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SupportTicketType = 'verification' | 'bank_account' | 'withdrawal' | 'deposit_not_detected' | 'wrong_token_or_network' | 'payout_delayed' | 'onramp_payment' | 'onramp_delivery' | 'account_access' | 'other';
export type SupportResourceType = 'withdrawal' | 'onramp_order' | 'external_account' | 'customer' | 'general';

export interface SupportTicketRecord {
  id: string;
  userId: string;
  customerId?: string;
  type: SupportTicketType;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  subject: string;
  description: string;
  resourceType: SupportResourceType;
  resourceId?: string;
  assignedTo?: string;
  lastMessageAt?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type SupportMessageType = 'conversation' | 'internal_note' | 'resolution' | 'system';
export type SupportNoteType = 'general' | 'investigation' | 'provider_update' | 'payout_instruction' | 'compliance' | 'risk' | 'handoff' | 'resolution';

export interface SupportTicketMessageRecord {
  id: string;
  ticketId: string;
  senderType: 'user' | 'admin' | 'system' | 'provider';
  senderId?: string;
  message: string;
  attachments?: unknown;
  internalNote?: boolean;
  messageType?: SupportMessageType;
  noteType?: SupportNoteType;
  title?: string;
  statusAfter?: SupportTicketStatus;
  visibleToCustomer?: boolean;
  metadata?: unknown;
  createdAt: string;
}

export interface AuditLogRecord {
  id: string;
  actorType: 'system' | 'user' | 'admin' | 'provider';
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  severity: 'info' | 'warning' | 'error';
  ipAddress?: string;
  userAgent?: string;
  metadata?: unknown;
  createdAt: string;
}

export interface ReconciliationRunRecord {
  id: string;
  provider?: string;
  dryRun: boolean;
  status: 'completed' | 'failed';
  summary?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ReconciliationFindingRecord {
  id: string;
  runId: string;
  provider?: string;
  severity: 'info' | 'warning' | 'error';
  findingType: string;
  withdrawalId?: string;
  liquidationAddressId?: string;
  providerDrainId?: string;
  resourceType?: string;
  resourceId?: string;
  referenceId?: string;
  webhookEventId?: string;
  sivanTransactionId?: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  status: 'open' | 'resolved' | 'ignored';
  createdAt: string;
}

export interface AuthChallengeRecord {
  id: string;
  email: string;
  codeHash: string;
  intent: 'signup' | 'signin';
  fullName?: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
  legalTermsVersion?: string;
  legalPrivacyVersion?: string;
  legalRiskDisclosureVersion?: string;
  legalAcceptedAt?: string;
  legalAcceptanceIpAddress?: string;
  legalAcceptanceUserAgent?: string;
}

export interface WebhookEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  eventCategory?: string;
  eventType?: string;
  eventObjectId?: string;
  payload: unknown;
  processedAt?: string;
  createdAt: string;
}


export interface TransactionReferenceRecord {
  id: string;
  sivanTransactionId: string;
  resourceType: string;
  resourceId: string;
  provider: string;
  referenceType: string;
  referenceValue: string;
  direction: 'inbound' | 'outbound' | 'internal' | 'provider' | 'settlement' | 'refund';
  status?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * How a deposit came to our attention.
 *
 * Stored per row rather than read from configuration, because the detector is
 * expected to change (balance polling now, RPC webhooks next) and the overlap
 * window - where both run at once - is exactly when you need to know which
 * one produced a given row.
 */
export type DepositDetectionSource = 'balance_poll' | 'rpc_webhook' | 'privy_webhook' | 'manual';

export type WalletDepositStatus = 'pending' | 'confirmed' | 'failed';

/**
 * MONEY ARRIVING FROM OUTSIDE SIVAN.
 *
 * An exchange withdrawal into a user's Sivan address is the most common way
 * money enters this product, and before this record existed the system did
 * nothing about it at all - no row, no feed entry, no notification. See
 * database/migrations/042_create_wallet_deposits.sql for the full account.
 *
 * AN OBSERVATION, NOT A BALANCE. Spendable funds are still computed by reading
 * the chain in unified-balance.service.ts. These rows record that something
 * was seen; they are never summed to decide what a user can spend.
 */
export interface WalletDepositRecord {
  id: string;
  userId: string;
  /** UserWalletRecord.id this landed in. */
  walletId: string;
  /**
   * Denormalised deliberately. The wallet row can be closed or re-filed under
   * a different chain string; this is the address the user actually pasted
   * into an exchange, and the one they will quote to support.
   */
  address: string;
  chain: string;
  asset: string;
  /** Human units, six decimals. Never wei or lamports - see the migration. */
  amount: string;
  /** Absent for the balance-poll detector, which sees a delta, not a tx. */
  txHash?: string;
  sender?: string;
  blockNumber?: number;
  blockTimestamp?: string;
  status: WalletDepositStatus;
  detectionSource: DepositDetectionSource;
  /** UNIQUE in Postgres. The whole defence against at-least-once delivery. */
  idempotencyKey: string;
  /** Null means a notification is still owed. Stamped to claim the row. */
  notifiedAt?: string;
  rawPayload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export type NgnIdentityCheckStatus = 'matched' | 'review' | 'failed';

/**
 * A Level 2 identity check against a Nigerian BVN.
 *
 * THE BVN ITSELF IS NEVER STORED - see migration 047. A BVN links every bank
 * account a Nigerian holds, so keeping the digits turns any future leak into
 * an identity-theft incident, and Sivan gains nothing: the provider has
 * already answered the only question we asked.
 */
export interface NgnIdentityVerificationRecord {
  id: string;
  userId: string;
  checkType: 'bvn_info' | 'bvn_bank';
  status: NgnIdentityCheckStatus;
  provider: string;
  providerReference?: string;
  /** Last four digits, so support can say "the one ending 4821". */
  bvnLast4?: string;
  /** SHA-256 + pepper. Detects one BVN across accounts; not reversible. */
  bvnHash?: string;
  matchedFields?: Record<string, boolean | string>;
  /**
   * Set ONLY on a matched row, and the single fact that grants Level 2.
   * Separate from createdAt because a failed attempt has one of those too.
   */
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UnifiedWebhookLogRecord {
  id: string;
  serviceName: string;
  provider: string;
  providerEventId?: string;
  paymentReference?: string;
  eventCategory?: string;
  eventType?: string;
  payload: unknown;
  createdAt: string;
}

/**
 * An admin-set verification ceiling, replacing the shipped FLOW_LIMITS value.
 *
 * `cumulativeNgn: null` means UNLIMITED and is deliberately distinct from 0,
 * which closes the flow entirely. The two must never be conflated.
 */
/**
 * Admin-controlled wallet provider.
 *
 * `activeProvider` undefined means "use the WALLET_PROVIDER environment
 * variable" - distinct from any provider name, so the table existing changes
 * nothing until an admin deliberately overrides it.
 */
export interface WalletControlsRecord {
  id: string;
  activeProvider?: string;
  autoSweepBridgeWallet?: boolean;
  reason?: string;
  updatedBy: string;
  updatedAt: string;
}

export interface VerificationLimitOverrideRecord {
  id: string;
  flow: string;
  rail: string;
  level: number;
  cumulativeNgn: number | null;
  reason?: string;
  updatedBy: string;
  updatedAt: string;
}

/**
 * A limit ceiling for ONE user, overriding whatever their tier allows.
 *
 * Keyed by (userId, flow, rail) and deliberately NOT by level: the exception
 * describes a person, and it must not stop applying because they completed
 * another verification step.
 */
export interface UserLimitOverrideRecord {
  id: string;
  userId: string;
  flow: string;
  rail: string;
  /** NULL is unlimited. 0 closes the flow. The two are not interchangeable. */
  cumulativeNgn: number | null;
  reason: string;
  updatedBy: string;
  /** NULL is permanent. The admin UI defaults to a date so it rarely is. */
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A forgiven slice of a user's rolling window.
 *
 * Records a watermark rather than deleting transactions: usage ignores volume
 * at or before `resetAt`, and the transactions themselves stay put so the
 * audit trail survives.
 */
export interface UserLimitResetRecord {
  id: string;
  userId: string;
  flow: string;
  rail: string;
  resetAt: string;
  /** What was cleared, captured at the time - it cannot be recomputed later. */
  forgivenNgn: number;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface DatabaseShape {
  users: UserRecord[];
  customerIdentityLinks: CustomerIdentityLinkRecord[];
  identityPairingTokens: IdentityPairingTokenRecord[];
  withdrawalPins: WithdrawalPinRecord[];
  withdrawalStepUpTokens: WithdrawalStepUpTokenRecord[];
  userPreferences: UserPreferencesRecord[];
  userTwoFactor: UserTwoFactorRecord[];
  userTwoFactorRecoveryQuestions: UserTwoFactorRecoveryQuestionRecord[];
  legalAcceptances: LegalAcceptanceRecord[];
  customers: CustomerRecord[];
  externalAccounts: ExternalAccountRecord[];
  ngnPayoutAccounts: NgnPayoutAccountRecord[];
  liquidationAddresses: LiquidationAddressRecord[];
  userWallets: UserWalletRecord[];
  withdrawals: WithdrawalRecord[];
  onrampOrders: OnrampOrderRecord[];
  suppliers: SupplierRecord[];
  supplierPayments: SupplierPaymentRecord[];
  supplierControls: SupplierControlsRecord[];
  supplierVolumeGrants: SupplierVolumeGrantRecord[];
  webhookEvents: WebhookEventRecord[];
  authChallenges: AuthChallengeRecord[];
  auditLogs: AuditLogRecord[];
  reconciliationRuns: ReconciliationRunRecord[];
  reconciliationFindings: ReconciliationFindingRecord[];
  paymentControls: PaymentControlRecord[];
  virtualAccountControls: VirtualAccountControlRecord[];
  assetControls: AssetControlRecord[];
  networkControls: NetworkControlRecord[];
  systemStatus: SystemStatusRecord[];
  systemIncidents: SystemIncidentRecord[];
  customerTypeControls: CustomerTypeControlRecord[];
  unifiedWebhookLogs: UnifiedWebhookLogRecord[];
  transactionReferences: TransactionReferenceRecord[];
  aceSupportSessions: AceSupportSessionRecord[];
  aceSupportMessages: AceSupportMessageRecord[];
  aceToolCalls: AceToolCallRecord[];
  aceSupportResolutions: AceSupportResolutionRecord[];
  supportTickets: SupportTicketRecord[];
  supportTicketMessages: SupportTicketMessageRecord[];
  virtualAccountRequests: VirtualAccountRequestRecord[];
  virtualAccounts: VirtualAccountRecord[];
  virtualAccountEvents: VirtualAccountEventRecord[];
  virtualAccountTransactions: VirtualAccountTransactionRecord[];
  ngnControls: NgnControlsRecord[];
  verificationLimitOverrides: VerificationLimitOverrideRecord[];
  userLimitOverrides: UserLimitOverrideRecord[];
  userLimitResets: UserLimitResetRecord[];
  walletControls: WalletControlsRecord[];
  ngnQuotes: NgnQuoteRecord[];
  ngnTransfers: NgnTransferRecord[];
  ngnWebhooks: NgnWebhookRecord[];
  walletDeposits: WalletDepositRecord[];
  ngnIdentityVerifications: NgnIdentityVerificationRecord[];
}
