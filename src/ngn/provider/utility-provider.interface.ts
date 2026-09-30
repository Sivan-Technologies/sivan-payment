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
} from '../types/paystackUtilityTypes.js';

export type UtilityProviderName = 'paystack' | 'nomba' | 'flutterwave' | 'vtu_ng';

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

export interface IUtilityProvider {
  readonly name: UtilityProviderName;

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
}
