import type { OnrampStatus } from '../../database/types.js';

export function mapBridgeTransferState(state?: string): OnrampStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'created':
    case 'pending':
    case 'awaiting_funds':
    case 'awaiting_payment':
      return 'awaiting_payment';
    case 'funds_received':
    case 'payment_received':
      return 'payment_received';
    case 'processing':
    case 'in_review':
      return 'processing';
    case 'completed':
    case 'sent':
    case 'payment_processed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'requires_action':
      return 'requires_action';
    default:
      return 'processing';
  }
}
