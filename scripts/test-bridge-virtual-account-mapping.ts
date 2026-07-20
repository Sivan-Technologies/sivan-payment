import { mapBridgeVirtualAccount } from '../src/virtual-accounts/provider/bridge-virtual-account.provider.js';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

const usd = mapBridgeVirtualAccount({
  id: 'va_usd_123',
  status: 'activated',
  source_deposit_instructions: {
    currency: 'usd',
    bank_name: 'Lead Bank',
    bank_beneficiary_name: 'Ada Lovelace',
    bank_account_number: '215268120000',
    bank_routing_number: '101019644',
    payment_rails: ['ach_push', 'wire'],
  },
}, 'usd');
assert(usd.provider === 'bridge', 'USD maps provider');
assert(usd.status === 'active', 'USD activated maps to active');
assert(usd.accountNumberMasked === '••••0000', 'USD account number is masked');
assert(usd.routingNumberMasked === '••••9644', 'USD routing number is masked');

const eur = mapBridgeVirtualAccount({
  id: 'va_eur_123',
  status: 'activated',
  source_deposit_instructions: {
    currency: 'eur',
    bank_name: 'Deutsche Bank',
    bank_beneficiary_name: 'Ada Lovelace',
    iban: 'DE89370400440532013000',
    bic: 'DEUTDEDBFRA',
  },
}, 'eur');
assert(eur.currency === 'eur', 'EUR maps currency');
assert(eur.ibanMasked === '••••3000', 'EUR IBAN is masked');
assert(eur.routingNumberMasked === '••••BFRA', 'EUR BIC is masked');

const gbp = mapBridgeVirtualAccount({
  id: 'va_gbp_123',
  status: 'deactivated',
  source_deposit_instructions: {
    currency: 'gbp',
    bank_name: 'Example UK Bank',
    bank_beneficiary_name: 'Ada Lovelace',
    account_number: '12345678',
    sort_code: '102030',
  },
}, 'gbp');
assert(gbp.currency === 'gbp', 'GBP maps currency');
assert(gbp.status === 'closed', 'GBP deactivated maps to closed');
assert(gbp.accountNumberMasked === '••••5678', 'GBP account number is masked');
assert(gbp.routingNumberMasked === '••••2030', 'GBP sort code is masked');

console.log('\n✅ Bridge virtual account mapping test passed');
