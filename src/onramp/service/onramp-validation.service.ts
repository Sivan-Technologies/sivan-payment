import { db } from '../../database/json-database.js';
import type { Chain } from '../../database/types.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { requireCurrencyEnabled, requireSourceAssetEnabled, requireSourceNetworkEnabled } from '../../controls/payment-controls.service.js';
import type { CreateOnrampOrderInput } from '../types/onramp.schemas.js';

export async function validateOnrampOrderInput(input: CreateOnrampOrderInput) {
  await requireCurrencyEnabled(input.sourceCurrency);
  await requireSourceAssetEnabled(input.destinationCurrency);
  await requireSourceNetworkEnabled(input.destinationChain as Chain);

  const data = await db.read();
  const user = data.users.find((item) => item.id === input.userId);
  if (!user) throw notFound('User');

  const customer = data.customers.find((item) => item.userId === input.userId);
  if (!customer) throw badRequest('Complete verification before buying stablecoins');
  if (customer.kycStatus !== 'kyc_approved') throw badRequest('KYC must be approved before buying stablecoins');

  return { user, customer };
}
