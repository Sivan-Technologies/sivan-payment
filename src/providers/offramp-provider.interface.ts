import type { Chain, Currency, SourceCurrency, SupplierPayoutCurrency } from '../database/types.js';

export interface ProviderCustomer {
  id: string;
  status?: string;
  raw: unknown;
}

export interface ProviderKycLink {
  id: string;
  customerId: string;
  fullName?: string;
  email: string;
  kycLink: string;
  tosLink?: string;
  kycStatus: string;
  tosStatus?: string;
  raw: unknown;
}

export interface ProviderExternalAccount {
  id: string;
  customerId: string;
  currency: SupplierPayoutCurrency;
  accountType: string;
  active?: boolean;
  bankName?: string;
  accountName?: string;
  accountOwnerName: string;
  last4?: string;
  verificationStatus?: string;
  raw: unknown;
}

export interface ProviderSupplierPayout {
  id: string;
  status?: string;
  raw: unknown;
}

export interface ProviderLiquidationAddress {
  id: string;
  customerId: string;
  address: string;
  memolessAddress?: string;
  chain: Chain;
  currency: SourceCurrency;
  destinationCurrency: Currency;
  destinationPaymentRail: string;
  state?: string;
  raw: unknown;
}

export interface CreateKycLinkInput {
  email: string;
  fullName: string;
  type: 'individual' | 'business';
  redirectUri?: string;
  endorsements?: string[];
  idempotencyKey: string;
}

export interface CreateCustomerInput {
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface CreateExternalAccountInput {
  customerId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface CreateSupplierPayoutInput {
  customerId: string;
  bridgeWalletId: string;
  amount: string;
  sourceCurrency: SourceCurrency;
  destinationCurrency: SupplierPayoutCurrency;
  destinationPaymentRail: string;
  externalAccountId: string;
  clientReferenceId: string;
  idempotencyKey: string;
  developerFee?: string;
}

export interface CreateLiquidationAddressInput {
  customerId: string;
  sourceCurrency: SourceCurrency;
  sourceChain: Chain;
  externalAccountId: string;
  destinationCurrency: Currency;
  destinationPaymentRail: string;
  destinationReference?: string;
  returnAddress?: string;
  returnInstructions?: unknown;
  customDeveloperFeePercent?: string;
  idempotencyKey: string;
}

export interface OfframpProvider {
  name: string;
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  createKycLink(input: CreateKycLinkInput): Promise<ProviderKycLink>;
  /**
   * Patch fields onto an existing provider customer.
   *
   * Exists because POST /kyc_links SILENTLY IGNORES birth_date - measured:
   * sent it, got 201, read the customer back and the field was null with
   * `date_of_birth` still in `missing`. The only way to set it is a follow-up
   * PUT, so the interface needs a way to express one.
   *
   * OPTIONAL, so providers that cannot patch a customer are not forced to
   * pretend they can.
   */
  updateCustomer?(customerId: string, patch: Record<string, unknown>): Promise<unknown>;
  getKycLink(kycLinkId: string): Promise<ProviderKycLink>;
  getHostedKycLink(customerId: string, redirectUri?: string, endorsement?: string): Promise<{ url: string; raw: unknown }>;
  createExternalAccount(input: CreateExternalAccountInput): Promise<ProviderExternalAccount>;
  createSupplierPayout?(input: CreateSupplierPayoutInput): Promise<ProviderSupplierPayout>;
  getTransfer?(transferId: string): Promise<unknown>;
  simulateSandboxKycApproval?(customerId: string, idempotencyKey: string): Promise<unknown>;
  verifyExternalAccount(customerId: string, externalAccountId: string): Promise<unknown>;
  createLiquidationAddress(input: CreateLiquidationAddressInput): Promise<ProviderLiquidationAddress>;
  getLiquidationAddressDrains(customerId: string, liquidationAddressId: string): Promise<unknown[]>;
  verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean;
}
