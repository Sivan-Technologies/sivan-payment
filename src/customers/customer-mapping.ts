import type { CustomerStatus } from '../database/types.js';

export function mapBridgeKycStatus(status?: string): CustomerStatus {
  switch (status) {
    case 'approved':
      return 'kyc_approved';
    case 'under_review':
      return 'kyc_under_review';
    case 'rejected':
      return 'kyc_rejected';
    case 'paused':
      return 'paused';
    case 'offboarded':
      return 'offboarded';
    case 'not_started':
      return 'kyc_not_started';
    case 'incomplete':
    case 'awaiting_questionnaire':
    case 'awaiting_ubo':
    default:
      return 'kyc_incomplete';
  }
}
