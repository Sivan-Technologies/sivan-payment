import { createUser } from '../src/users/users.service.js';
import { startKyc } from '../src/customers/customers.service.js';
import { createExternalAccount } from '../src/offramp/service/external-accounts.service.js';
import { createWithdrawal } from '../src/offramp/service/withdrawals.service.js';

const user = await createUser({ email: `ada+${Date.now()}@example.com`, fullName: 'Ada Lovelace' });
const customer = await startKyc({ userId: user.id, type: 'individual' });
const account = await createExternalAccount({
  userId: user.id,
  currency: 'usd',
  accountType: 'us',
  paymentRail: 'ach',
  bankName: 'Lead Bank',
  accountName: 'Ada Checking',
  accountOwnerName: 'Ada Lovelace',
  accountOwnerType: 'individual',
  firstName: 'Ada',
  lastName: 'Lovelace',
  address: {
    street_line_1: '923 Folsom Street',
    country: 'USA',
    state: 'CA',
    city: 'San Francisco',
    postal_code: '94107'
  },
  account: {
    routing_number: '101019644',
    account_number: '215268129123',
    checking_or_savings: 'checking'
  }
});
const withdrawal = await createWithdrawal({
  userId: user.id,
  externalAccountId: account.id,
  sourceCurrency: 'usdc',
  sourceChain: 'ethereum',
  destinationCurrency: 'usd',
  returnAddress: '0x0000000000000000000000000000000000000000'
});

console.log(JSON.stringify({ user, customer, account, withdrawal }, null, 2));
