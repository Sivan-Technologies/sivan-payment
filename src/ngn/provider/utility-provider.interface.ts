/**
 * SIVAN UTILITY PROVIDER INTERFACE
 *
 * Pluggable abstraction contract for all daily digital service fulfillment rails.
 * Sivan payment Ai is not hardcoded to any single aggregator.
 * Providers (Paystack, Nomba, Flutterwave, VTU engines) implement this contract.
 */

import type {
  TelcoOperator,
  DiscoCode,
  MeterType,
  ElectricityInquiryResponse,
  DataPlanOption,
  AirtimeCashRate,
} from '../types/paystackUtilityTypes.js';

export type UtilityProviderName = 'paystack' | 'nomba' | 'flutterwave' | 'vtu_ng' | string;

export interface ProviderAirtimeResult {
  reference: string;
  amountNgn: number;
  phone: string;
  operator: TelcoOperator;
  status: 'success' | 'failed';
  message: string;
  rawPayload: unknown;
}

export interface ProviderDataResult {
  reference: string;
  amountNgn: number;
  phone: string;
  operator: TelcoOperator;
  planCode: string;
  status: 'success' | 'failed';
  message: string;
  rawPayload: unknown;
}

export interface ProviderElectricityResult {
  reference: string;
  amountNgn: number;
  meterNumber: string;
  disco: DiscoCode;
  meterType: MeterType;
  customerName: string;
  token?: string; // 20-digit token for prepaid meters
  units?: string; // e.g. "45.2 kWh"
  status: 'success' | 'failed';
  message: string;
  rawPayload: unknown;
}

export interface AirtimeCashInitiateInput {
  phone: string;
  operator: TelcoOperator;
  amountNgn: number;
}

export interface AirtimeCashInitiateResult {
  sessionId: string;
  rate: number;
  payoutAmountNgn: number;
  message: string;
  rawPayload?: unknown;
}

export interface AirtimeCashConfirmInput {
  sessionId: string;
  otp: string;
  sharePin: string;
}

export interface AirtimeCashConfirmResult {
  reference: string;
  creditedAmountNgn: number;
  status: 'success' | 'failed';
  message: string;
  rawPayload?: unknown;
}

/** The three fulfilment rails a provider can serve. Routing is per service. */
export type UtilityServiceType = 'airtime' | 'data' | 'electricity';

export const UTILITY_SERVICE_TYPES: readonly UtilityServiceType[] = ['airtime', 'data', 'electricity'];

export interface IUtilityProvider {
  readonly name: UtilityProviderName;
  /** Higher priority numbers are tried first when a routing chain is not configured (default 10) */
  readonly priority?: number;

  /**
   * The services this provider can actually fulfil.
   *
   * Declaring a service is a promise that the matching method is implemented
   * and talks to a real upstream. The registry refuses to route a service to
   * a provider that does not declare it, which is what stops an airtime-only
   * aggregator from being handed an electricity meter and answering with a
   * placeholder.
   */
  readonly supports: readonly UtilityServiceType[];

  /**
   * Whether this adapter holds the credentials it needs to do real work.
   *
   * An adapter can be registered and still be unusable. Without this the admin
   * UI offered every registered name as an equal choice, including one with no
   * API key and a placeholder base URL, so an operator could route live
   * traffic to something guaranteed to fail. Omit it and the provider is
   * assumed configured, so existing adapters are unaffected.
   */
  isConfigured?(): boolean;

  /**
   * Every method is optional. A provider implements only the rails it serves
   * and omits the rest, instead of stubbing them out with invented data.
   *
   * idempotencyKey is generated once per purchase and reused for every
   * attempt in a failover chain, so a provider that already vended on a
   * timed-out request can recognise the retry rather than vend twice.
   */
  listDataPlans?(operator: TelcoOperator): Promise<DataPlanOption[]>;

  purchaseAirtime?(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderAirtimeResult>;

  purchaseDataBundle?(
    phone: string,
    planCode: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderDataResult>;

  inquireElectricityMeter?(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType
  ): Promise<ElectricityInquiryResponse>;

  payElectricityBill?(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType,
    amountNgn: number,
    customerName: string | undefined,
    idempotencyKey: string
  ): Promise<ProviderElectricityResult>;

  getAirtimeCashRate?(operator: TelcoOperator): Promise<AirtimeCashRate>;
  initiateAirtimeToCash?(input: AirtimeCashInitiateInput): Promise<AirtimeCashInitiateResult>;
  confirmAirtimeToCash?(input: AirtimeCashConfirmInput): Promise<AirtimeCashConfirmResult>;
}
