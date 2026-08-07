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

/**
 * What the provider's CUSTOMER object says about a user, as opposed to what
 * their hosted verification link says.
 *
 * `tosAccepted` is deliberately a tri-state. `undefined` means "the provider
 * did not tell us", which is NOT the same as `false` - and conflating them is
 * exactly how a terms gate locks out a user who has accepted. Callers must
 * treat undefined as "no new information" and leave the stored value alone.
 */
export interface ProviderCustomerSnapshot {
  id: string;
  status?: string;
  kycStatus?: string;
  tosAccepted?: boolean;
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
  /**
   * Read the CUSTOMER object's own terms-of-service acceptance.
   *
   * Separate from getKycLink() because the two carry the fact on different
   * objects and only one of them is always present. `tos_status` lives on the
   * kyc_link; `has_accepted_terms_of_service` lives on the customer. A user
   * imported by an admin, or one whose hosted link has been consumed, has a
   * customer and NO kycLinkId - so the kyc_link route cannot answer for them
   * at all, and refreshKycStatus() returned early leaving tosStatus 'pending'
   * forever.
   *
   * Verified against the real sandbox on customer
   * 1245c57f-9bc2-4942-8776-3bfa6998dcae: `has_accepted_terms_of_service` is
   * `true` and both endorsements list `terms_of_service_v1`/`_v2` under
   * `requirements.complete`, agreeing with the kyc_link's `tos_status:
   * 'approved'`. The two sources do not disagree; one is just always there.
   *
   * OPTIONAL, so a provider with no such concept is not made to invent one.
   */
  getCustomer?(customerId: string): Promise<ProviderCustomerSnapshot>;
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
