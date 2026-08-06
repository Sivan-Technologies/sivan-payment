import type { BvnAccountMatchInput, BvnInfoMatchInput, KycLevelMatchResult, KycLevelProvider } from './kyc-level-provider.js';
import { bvnLast4 } from './kyc-level-provider.js';

export class MockKycLevelProvider implements KycLevelProvider {
  name = 'mock';

  async verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult> {
    const fail = input.bvn.endsWith('0000');
    return {
      provider: this.name,
      status: fail ? 'failed' : 'matched',
      message: fail ? 'Mock BVN identity did not match.' : 'Mock BVN identity matched.',
      bvnLast4: bvnLast4(input.bvn),
      matchedFields: { firstName: !fail, lastName: !fail, dateOfBirth: !fail, mobileNo: !fail },
      providerReference: `mock_bvn_${Date.now()}`,
      raw: { mock: true }
    };
  }

  async verifyBvnBankAccount(input: BvnAccountMatchInput): Promise<KycLevelMatchResult> {
    const fail = input.accountNumber.endsWith('0000');
    return {
      provider: this.name,
      status: fail ? 'failed' : 'matched',
      message: fail ? 'Mock BVN bank account did not match.' : 'Mock BVN bank account matched.',
      bvnLast4: bvnLast4(input.bvn),
      matchedFields: { bankCode: true, accountNumber: !fail, accountName: !fail },
      providerReference: `mock_bvn_bank_${Date.now()}`,
      raw: { mock: true }
    };
  }

  async health() {
    return { provider: this.name, available: true, mode: 'mock' as const, message: 'Mock KYC level provider ready.', checkedAt: new Date().toISOString() };
  }
}
