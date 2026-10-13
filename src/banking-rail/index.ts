/**
 * Public surface of the banking-rail module.
 * Import from here, never from internal adapter files directly.
 */
export type {
  IBankingRailAdapter,
  BankingRailEvent,
  BankingRailName,
  CreateCustomerInput,
  CustomerRecord,
  IdentityInput,
  VirtualAccountRecord,
  CreateTransferInput,
  TransferRecord,
  TransferStatus,
} from './banking-rail.adapter.js';

export {
  getBankingRailAdapter,
  registerBankingRailAdapter,
  listRegisteredRails,
  getActiveBankingRailName,
} from './banking-rail-registry.js';
