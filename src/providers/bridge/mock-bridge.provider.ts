import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import type {
  CreateCustomerInput,
  CreateExternalAccountInput,
  CreateKycLinkInput,
  CreateLiquidationAddressInput,
  OfframpProvider,
  ProviderCustomer,
  ProviderExternalAccount,
  ProviderCustomerSnapshot,
  ProviderKycLink,
  ProviderLiquidationAddress,
  ProviderSupplierPayout
} from '../offramp-provider.interface.js';
import type { Chain, Currency, SourceCurrency } from '../../database/types.js';

export class MockBridgeProvider implements OfframpProvider {
  name = 'bridge';

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    const raw = { id: `mock_cust_${crypto.randomUUID()}`, status: 'active', ...input.payload };
    return { id: raw.id, status: raw.status, raw };
  }

  async createKycLink(input: CreateKycLinkInput): Promise<ProviderKycLink> {
    const customerId = `mock_cust_${crypto.randomUUID()}`;
    const raw = {
      id: `mock_kyc_${crypto.randomUUID()}`,
      customer_id: customerId,
      full_name: input.fullName,
      email: input.email,
      type: input.type,
      kyc_link: `https://mock.bridge.local/kyc/${customerId}`,
      tos_link: `https://mock.bridge.local/tos/${customerId}`,
      kyc_status: 'approved',
      tos_status: 'approved'
    };
    return {
      id: raw.id,
      customerId,
      fullName: raw.full_name,
      email: raw.email,
      kycLink: raw.kyc_link,
      tosLink: raw.tos_link,
      kycStatus: raw.kyc_status,
      tosStatus: raw.tos_status,
      raw
    };
  }

  /**
   * Mirrors the real provider's customer read. Approved, as everything in the
   * mock is - it exists so the sync path has something to call rather than
   * skipping silently and reporting a pass it never earned.
   */
  async getCustomer(customerId: string): Promise<ProviderCustomerSnapshot> {
    const raw = { id: customerId, status: 'active', has_accepted_terms_of_service: true };
    return { id: customerId, status: 'active', kycStatus: 'active', tosAccepted: true, raw };
  }

  async getKycLink(kycLinkId: string): Promise<ProviderKycLink> {
    const raw = {
      id: kycLinkId,
      customer_id: 'mock_customer_existing',
      full_name: 'Mock User',
      email: 'mock@example.com',
      kyc_link: `https://mock.bridge.local/kyc/${kycLinkId}`,
      tos_link: `https://mock.bridge.local/tos/${kycLinkId}`,
      kyc_status: 'approved',
      tos_status: 'approved'
    };
    return { id: raw.id, customerId: raw.customer_id, fullName: raw.full_name, email: raw.email, kycLink: raw.kyc_link, tosLink: raw.tos_link, kycStatus: raw.kyc_status, tosStatus: raw.tos_status, raw };
  }

  async getHostedKycLink(customerId: string): Promise<{ url: string; raw: unknown }> {
    const raw = { url: `https://mock.bridge.local/kyc/${customerId}` };
    return { url: raw.url, raw };
  }

  async simulateSandboxKycApproval(customerId: string): Promise<unknown> {
    return { success: true, customer_id: customerId, kyc_status: 'approved', message: 'Mock KYC approval simulated' };
  }

  async createOnrampTransfer(input: any): Promise<unknown> {
    const transferId = `mock_transfer_${crypto.randomUUID()}`;
    return {
      id: transferId,
      client_reference_id: input.clientReferenceId,
      state: 'awaiting_payment',
      amount: input.amount,
      developer_fee: input.developerFee,
      source: { payment_rail: input.sourcePaymentRail, currency: input.sourceCurrency },
      destination: { payment_rail: input.destinationChain, currency: input.destinationCurrency, to_address: input.destinationAddress },
      source_deposit_instructions: {
        payment_rail: input.sourcePaymentRail,
        currency: input.sourceCurrency,
        bank_name: 'Mock Bridge Bank',
        account_name: 'Bridge FBO Sivan',
        account_number: '000123456789',
        routing_number: '110000000',
        iban: input.sourceCurrency === 'eur' ? 'DE89370400440532013000' : undefined,
        reference: input.clientReferenceId
      },
      receipt: null,
      created_at: new Date().toISOString()
    };
  }

  async getTransfer(transferId: string): Promise<unknown> {
    return { id: transferId, state: 'completed', receipt: { destination_tx_hash: `0x${'ab'.repeat(32)}` }, updated_at: new Date().toISOString() };
  }

  async createSupplierPayout(input: any): Promise<ProviderSupplierPayout> {
    const raw = {
      id: `mock_supplier_transfer_${crypto.randomUUID()}`,
      state: 'completed',
      amount: input.amount,
      on_behalf_of: input.customerId,
      client_reference_id: input.clientReferenceId,
      source: { payment_rail: 'bridge_wallet', currency: input.sourceCurrency, bridge_wallet_id: input.bridgeWalletId },
      destination: { payment_rail: input.destinationPaymentRail, currency: input.destinationCurrency, external_account_id: input.externalAccountId },
      receipt: { destination_tx_hash: `mock_${crypto.randomBytes(12).toString('hex')}` },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    return { id: raw.id, status: raw.state, raw };
  }

  async createExternalAccount(input: CreateExternalAccountInput): Promise<ProviderExternalAccount> {
    const payload: any = input.payload;
    const last4 = payload.account?.account_number?.slice(-4) ?? payload.iban?.account_number?.slice(-4) ?? '0000';
    const raw = {
      id: `mock_ea_${crypto.randomUUID()}`,
      customer_id: input.customerId,
      active: true,
      currency: payload.currency,
      account_type: payload.account_type,
      bank_name: payload.bank_name,
      account_name: payload.account_name,
      account_owner_name: payload.account_owner_name,
      last_4: last4,
      account: { last_4: last4 }
    };
    return {
      id: raw.id,
      customerId: input.customerId,
      currency: payload.currency,
      accountType: payload.account_type,
      active: true,
      bankName: raw.bank_name,
      accountName: raw.account_name,
      accountOwnerName: raw.account_owner_name,
      last4,
      raw
    };
  }

  async verifyExternalAccount(): Promise<unknown> {
    return { account_verification: { completed_at: new Date().toISOString(), gb: { match_level: 'match' } } };
  }

  async createLiquidationAddress(input: CreateLiquidationAddressInput): Promise<ProviderLiquidationAddress> {
    /**
     * A Solana liquidation address must be REAL base58, for the same reason
     * the NGN mock provider had to be fixed: the sweep now feeds this straight
     * into `new PublicKey()`.
     *
     * The previous value was `'So' + 22 random BYTES as HEX`. Hex contains
     * 0-9a-f, and base58 deliberately excludes `0` - so roughly 95% of the
     * addresses this produced could never be parsed as a Solana public key,
     * measured at 284/300. While nothing swept to them that was invisible;
     * the address was only ever shown to a human to copy. It is now a send
     * target, so it has to decode.
     */
    const address = input.sourceChain === 'solana'
      ? Keypair.generate().publicKey.toBase58()
      : `0x${crypto.randomBytes(20).toString('hex')}`;
    const raw = {
      id: `mock_la_${crypto.randomUUID()}`,
      customer_id: input.customerId,
      chain: input.sourceChain,
      address,
      currency: input.sourceCurrency,
      external_account_id: input.externalAccountId,
      destination_payment_rail: input.destinationPaymentRail,
      destination_currency: input.destinationCurrency,
      custom_developer_fee_percent: input.customDeveloperFeePercent,
      state: 'active'
    };
    return {
      id: raw.id,
      customerId: input.customerId,
      address,
      chain: raw.chain as Chain,
      currency: raw.currency as SourceCurrency,
      destinationCurrency: raw.destination_currency as Currency,
      destinationPaymentRail: raw.destination_payment_rail,
      state: raw.state,
      raw
    };
  }

  async getLiquidationAddressDrains(): Promise<unknown[]> {
    return [];
  }

  verifyWebhookSignature(): boolean {
    return true;
  }
}
