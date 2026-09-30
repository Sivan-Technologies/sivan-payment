/**
 * SIVAN MOCK / FALLBACK UTILITY PROVIDER
 *
 * Emulates instant airtime, data bundle, and electricity fulfillment
 * without external network roundtrips. Used for hermetic tests and sandbox dev.
 */

import type {
  TelcoOperator,
  DiscoCode,
  MeterType,
  ElectricityInquiryResponse,
} from '../types/paystackUtilityTypes.js';
import type {
  IUtilityProvider,
  UtilityProviderName,
  ProviderAirtimeResult,
  ProviderDataResult,
  ProviderElectricityResult,
} from './utility-provider.interface.js';

export class MockUtilityProvider implements IUtilityProvider {
  readonly name: UtilityProviderName = 'nomba'; // Or fallback aggregator

  async purchaseAirtime(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator
  ): Promise<ProviderAirtimeResult> {
    const reference = `mock_airtime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      reference,
      amountNgn,
      phone,
      operator,
      status: 'success',
      message: `[MOCK] ${operator.toUpperCase()} ${amountNgn} NGN airtime delivered to ${phone}`,
      rawPayload: { provider: 'mock', phone, operator, amountNgn, reference },
    };
  }

  async purchaseDataBundle(
    phone: string,
    planCode: string,
    amountNgn: number,
    operator: TelcoOperator
  ): Promise<ProviderDataResult> {
    const reference = `mock_data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      reference,
      amountNgn,
      phone,
      operator,
      planCode,
      status: 'success',
      message: `[MOCK] ${operator.toUpperCase()} data plan ${planCode} activated on ${phone}`,
      rawPayload: { provider: 'mock', phone, operator, planCode, amountNgn, reference },
    };
  }

  async inquireElectricityMeter(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType
  ): Promise<ElectricityInquiryResponse> {
    return {
      meterNumber,
      disco,
      discoName: `${disco.toUpperCase()} ELECTRIC (MOCK)`,
      meterType,
      customerName: 'SIVAN TEST CONSUMER',
      customerAddress: 'Plot 4, Commercial Avenue, Abuja',
      minimumAmountNgn: 1000,
    };
  }

  async payElectricityBill(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType,
    amountNgn: number,
    customerName?: string
  ): Promise<ProviderElectricityResult> {
    const reference = `mock_disco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      reference,
      amountNgn,
      meterNumber,
      disco,
      meterType,
      customerName: customerName || 'SIVAN TEST CONSUMER',
      token: meterType === 'prepaid' ? '9988-7766-5544-3322-1100' : undefined,
      units: meterType === 'prepaid' ? `${(amountNgn / 110).toFixed(1)} kWh` : undefined,
      status: 'success',
      message: `[MOCK] Electricity recharge of ${amountNgn} NGN successful`,
      rawPayload: { provider: 'mock', meterNumber, disco, amountNgn, reference },
    };
  }
}
