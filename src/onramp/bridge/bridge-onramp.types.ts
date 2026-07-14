import type { Chain, Currency, SourceCurrency } from '../../database/types.js';

export interface CreateOnrampTransferInput {
  amount: string;
  developerFee?: string;
  customerId: string;
  sourceCurrency: Currency;
  sourcePaymentRail: string;
  destinationCurrency: SourceCurrency;
  destinationChain: Chain;
  destinationAddress: string;
  clientReferenceId: string;
  idempotencyKey: string;
}

export interface BridgeOnrampTransfer {
  id?: string;
  client_reference_id?: string;
  state?: string;
  status?: string;
  amount?: string;
  developer_fee?: string;
  source?: unknown;
  destination?: unknown;
  source_deposit_instructions?: any;
  deposit_instructions?: any;
  receipt?: any;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}
