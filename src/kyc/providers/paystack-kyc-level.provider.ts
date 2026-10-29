import { isPaystackConfigured, paystackMode } from '../../config/paystackConfig.js';
import {
  createCustomer,
  validateCustomerBvnNin,
  PaystackApiError,
} from '../../virtual-accounts/provider/paystackDvaProvider.js';
import type {
  BvnAccountMatchInput,
  BvnInfoMatchInput,
  KycLevelMatchResult,
  KycLevelProvider,
  KycLevelProviderHealth,
  NinInfoMatchInput,
} from './kyc-level-provider.js';
import { bvnLast4 } from './kyc-level-provider.js';

export const PROVIDER_NAME = 'paystack';

/**
 * PAYSTACK KYC LEVEL PROVIDER.
 *
 * Implements BVN verification through Paystack's direct NIBSS integration.
 *
 * ADVANTAGES:
 * 1. Low cost: ~NGN 50 per check vs NGN 100 with standalone KYC SaaS vendors.
 * 2. Pre-qualifies customer for instant Dedicated Virtual Account (DVA) issuance.
 * 3. Failover enabled: If Paystack has an upstream NIBSS transport outage, the
 *    failover chain automatically falls through to IdentifyOrg.
 */
export class PaystackKycLevelProvider implements KycLevelProvider {
  readonly name = PROVIDER_NAME;

  capabilities() {
    return {
      bvnIdentity: true,
      bvnBankAccount: false,
      ninIdentity: false, // Paystack does not accept NIN on customer identification for DVAs
    };
  }

  async verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult> {
    const last4 = bvnLast4(input.bvn);
    const cleanBvn = String(input.bvn || '').replace(/\D/g, '');
    const phoneDigits = String(input.mobileNo || '').replace(/\D/g, '');
    const email = phoneDigits.length >= 7
      ? `sivan_user_${phoneDigits}@sivantech.online`
      : `sivan_bvn_${cleanBvn.slice(0, 4)}_${last4}@sivantech.online`;

    const firstName = String(input.firstName || '').trim();
    const lastName = String(input.lastName || '').trim();

    let customerCode = '';
    try {
      const customer = await createCustomer({
        email,
        first_name: firstName,
        last_name: lastName,
        phone: phoneDigits || '08000000000',
      });
      customerCode = customer.customer_code;
    } catch (error) {
      // Re-throw so the failover chain can attempt the next provider on connection error
      throw error;
    }

    try {
      await validateCustomerBvnNin(customerCode, {
        country: 'NG',
        type: 'bvn',
        value: cleanBvn,
        first_name: firstName,
        last_name: lastName,
      });

      return {
        provider: PROVIDER_NAME,
        status: 'review',
        message: 'BVN submitted to NIBSS for verification. Your status will update shortly.',
        bvnLast4: last4,
        providerReference: customerCode,
      };
    } catch (error) {
      const reason = error instanceof PaystackApiError
        ? (error.paystackMessage ?? error.message)
        : String((error as Error)?.message ?? error);

      // Customer already validated is an authoritative pass
      if (/already|has been verified|identified/i.test(reason)) {
        return {
          provider: PROVIDER_NAME,
          status: 'matched',
          message: 'Your Nigerian identity check was successful.',
          bvnLast4: last4,
          providerReference: customerCode,
        };
      }

      // Authoritative failure from NIBSS (e.g. name or DOB mismatch)
      if (/does not match|invalid bvn|could not verify|identity mismatch/i.test(reason)) {
        return {
          provider: PROVIDER_NAME,
          status: 'failed',
          message: reason || 'Your verification could not be matched. Check your details or contact Sivan Support.',
          bvnLast4: last4,
          providerReference: customerCode,
        };
      }

      // Network, timeout, or 503 server error: throw so the failover chain falls through to IdentifyOrg
      throw error;
    }
  }

  async verifyBvnBankAccount(_input: BvnAccountMatchInput): Promise<KycLevelMatchResult> {
    throw new Error('Paystack KYC provider does not support verifyBvnBankAccount directly.');
  }

  async verifyNinIdentity?(_input: NinInfoMatchInput): Promise<KycLevelMatchResult> {
    throw new Error('Paystack KYC provider does not support verifyNinIdentity. Route to IdentifyOrg.');
  }

  async health(): Promise<KycLevelProviderHealth> {
    const configured = isPaystackConfigured();
    return {
      provider: PROVIDER_NAME,
      available: configured,
      mode: configured && paystackMode() === 'live' ? 'live' : 'mock',
      checkedAt: new Date().toISOString(),
    };
  }
}
