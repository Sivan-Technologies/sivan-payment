import type {
  CreateCustomerInput,
  CreateExternalAccountInput,
  CreateKycLinkInput,
  CreateLiquidationAddressInput,
  OfframpProvider,
  ProviderCustomer,
  ProviderExternalAccount,
  ProviderKycLink,
  ProviderLiquidationAddress
} from '../offramp-provider.interface.js';
import { BridgeClient } from './bridge.client.js';
import { verifyBridgeWebhookSignature } from './bridge.webhooks.js';
import type { Currency, SourceCurrency, Chain } from '../../database/types.js';

export class BridgeProvider implements OfframpProvider {
  name = 'bridge';

  constructor(private client = new BridgeClient()) {}

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    const raw: any = await this.client.request('/customers', {
      method: 'POST',
      body: input.payload,
      idempotencyKey: input.idempotencyKey
    });
    return { id: raw.id, status: raw.status, raw };
  }

  async createKycLink(input: CreateKycLinkInput): Promise<ProviderKycLink> {
    const raw: any = await this.client.request('/kyc_links', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        email: input.email,
        full_name: input.fullName,
        type: input.type,
        redirect_uri: input.redirectUri,
        endorsements: input.endorsements
      }
    });
    return mapKycLink(raw);
  }

  async getKycLink(kycLinkId: string): Promise<ProviderKycLink> {
    const raw: any = await this.client.request(`/kyc_links/${kycLinkId}`);
    return mapKycLink(raw);
  }

  async getHostedKycLink(customerId: string, redirectUri?: string, endorsement?: string): Promise<{ url: string; raw: unknown }> {
    const raw: any = await this.client.request(`/customers/${customerId}/kyc_link`, {
      query: { redirect_uri: redirectUri, endorsement }
    });
    return { url: raw.url, raw };
  }

  async simulateSandboxKycApproval(customerId: string, idempotencyKey: string): Promise<unknown> {
    return this.client.request(`/customers/${customerId}/simulate_kyc_approval`, {
      method: 'POST',
      idempotencyKey
    });
  }

  async createExternalAccount(input: CreateExternalAccountInput): Promise<ProviderExternalAccount> {
    const raw: any = await this.client.request(`/customers/${input.customerId}/external_accounts`, {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: input.payload
    });
    return {
      id: raw.id,
      customerId: raw.customer_id,
      currency: raw.currency,
      accountType: raw.account_type,
      active: raw.active,
      bankName: raw.bank_name,
      accountName: raw.account_name,
      accountOwnerName: raw.account_owner_name,
      last4: raw.last_4 ?? raw.account?.last_4 ?? raw.iban?.last_4,
      verificationStatus: raw.account_verification ? 'verification_pending' : undefined,
      raw
    };
  }

  async verifyExternalAccount(customerId: string, externalAccountId: string): Promise<unknown> {
    return this.client.request(`/customers/${customerId}/external_accounts/${externalAccountId}/verify`, {
      method: 'POST'
    });
  }

  async createLiquidationAddress(input: CreateLiquidationAddressInput): Promise<ProviderLiquidationAddress> {
    const raw: any = await this.client.request(`/customers/${input.customerId}/liquidation_addresses`, {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        currency: input.sourceCurrency,
        chain: input.sourceChain,
        external_account_id: input.externalAccountId,
        destination_currency: input.destinationCurrency,
        destination_payment_rail: input.destinationPaymentRail,
        destination_reference: input.destinationReference,
        return_address: input.returnAddress,
        return_instructions: input.returnInstructions,
        custom_developer_fee_percent: input.customDeveloperFeePercent
      }
    });
    return {
      id: raw.id,
      customerId: raw.customer_id,
      address: raw.address,
      memolessAddress: raw.memoless_address,
      chain: raw.chain as Chain,
      currency: raw.currency as SourceCurrency,
      destinationCurrency: raw.destination_currency as Currency,
      destinationPaymentRail: raw.destination_payment_rail,
      state: raw.state,
      raw
    };
  }

  async getLiquidationAddressDrains(customerId: string, liquidationAddressId: string): Promise<unknown[]> {
    const raw: any = await this.client.request(`/customers/${customerId}/liquidation_addresses/${liquidationAddressId}/drains`);
    return Array.isArray(raw) ? raw : raw.data ?? [];
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean {
    return verifyBridgeWebhookSignature(rawBody, signatureHeader);
  }
}

function mapKycLink(raw: any): ProviderKycLink {
  return {
    id: raw.id,
    customerId: raw.customer_id,
    fullName: raw.full_name,
    email: raw.email,
    kycLink: raw.kyc_link,
    tosLink: raw.tos_link,
    kycStatus: raw.kyc_status,
    tosStatus: raw.tos_status,
    raw
  };
}
