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

export interface IUtilityProvider {
  readonly name: UtilityProviderName;
  /** Higher priority numbers are tried first in the failover chain (default 10) */
  readonly priority?: number;

  listDataPlans(operator: TelcoOperator): Promise<DataPlanOption[]>;

  purchaseAirtime(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator
  ): Promise<ProviderAirtimeResult>;

  purchaseDataBundle(
    phone: string,
    planCode: string,
    amountNgn: number,
    operator: TelcoOperator
  ): Promise<ProviderDataResult>;

  inquireElectricityMeter(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType
  ): Promise<ElectricityInquiryResponse>;

  payElectricityBill(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType,
    amountNgn: number,
    customerName?: string
  ): Promise<ProviderElectricityResult>;

  getAirtimeCashRate?(operator: TelcoOperator): Promise<AirtimeCashRate>;
  initiateAirtimeToCash?(input: AirtimeCashInitiateInput): Promise<AirtimeCashInitiateResult>;
  confirmAirtimeToCash?(input: AirtimeCashConfirmInput): Promise<AirtimeCashConfirmResult>;
}
