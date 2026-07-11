import type { WithdrawalStatus } from '../../database/types.js';

export function mapBridgeDrainState(state?: string): WithdrawalStatus {
  switch (state) {
    case 'in_review':
      return 'requires_action';
    case 'funds_received':
      return 'deposit_received';
    case 'payment_submitted':
      return 'payout_processing';
    case 'payment_processed':
      return 'completed';
    case 'undeliverable':
    case 'returned':
    case 'error':
      return 'failed';
    case 'canceled':
      return 'cancelled';
    case 'refunded':
      return 'failed';
    default:
      return 'pending_deposit';
  }
}
