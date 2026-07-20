import { BridgeClient } from '../src/providers/bridge/bridge.client.js';
import { BridgeVirtualAccountProvider } from '../src/virtual-accounts/provider/bridge-virtual-account.provider.js';
import { env } from '../src/config/env.js';

const client = new BridgeClient();

function hasApprovedBase(customer: any) {
  return customer?.endorsements?.some((endorsement: any) => endorsement?.name === 'base' && endorsement?.status === 'approved');
}

function safeCustomer(customer: any) {
  return customer ? {
    id: customer.id,
    type: customer.type,
    status: customer.status,
    email: customer.email,
    endorsements: customer.endorsements?.map((endorsement: any) => ({ name: endorsement.name, status: endorsement.status })),
  } : null;
}

async function main() {
  const customers: any = await client.request('/customers');
  const all = customers?.data ?? [];
  const requestedCustomerId = process.env.BRIDGE_VIRTUAL_ACCOUNT_SMOKE_CUSTOMER_ID?.trim();
  const customer = requestedCustomerId
    ? all.find((item: any) => item.id === requestedCustomerId)
    : all.find((item: any) => item.status === 'active' && hasApprovedBase(item)) ?? all.find((item: any) => item.status === 'active');

  const destinationConfigured = Boolean(env.BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_ADDRESS || env.BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID);
  const createEnabled = process.env.BRIDGE_VIRTUAL_ACCOUNT_CREATE_SMOKE === 'true';

  const readiness = {
    bridgeApiReachable: true,
    customerCount: all.length,
    selectedCustomer: safeCustomer(customer),
    destinationConfigured,
    createSmokeEnabled: createEnabled,
    bridgeVirtualAccountsEnabled: env.BRIDGE_VIRTUAL_ACCOUNTS_ENABLED,
    virtualAccountProvider: env.VIRTUAL_ACCOUNT_PROVIDER,
  };

  if (!customer) {
    console.log(JSON.stringify({ ok: false, phase: 'preflight', readiness, error: 'No active Bridge customer was found. Create/approve a Bridge customer first.' }, null, 2));
    process.exit(2);
  }

  if (!destinationConfigured) {
    console.log(JSON.stringify({
      ok: false,
      phase: 'preflight',
      readiness,
      error: 'Bridge virtual account destination is missing. Set BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_ADDRESS or BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID before creating a real virtual account.',
      note: 'The API key and approved customer were verified. No provider-side virtual account was created.',
    }, null, 2));
    process.exit(2);
  }

  if (!createEnabled || !env.BRIDGE_VIRTUAL_ACCOUNTS_ENABLED || env.VIRTUAL_ACCOUNT_PROVIDER !== 'bridge') {
    console.log(JSON.stringify({
      ok: true,
      phase: 'preflight',
      readiness,
      note: 'Ready for create smoke, but creation is intentionally disabled. Set BRIDGE_VIRTUAL_ACCOUNT_CREATE_SMOKE=true, VIRTUAL_ACCOUNTS_ENABLED=true, VIRTUAL_ACCOUNT_PROVIDER=bridge, and BRIDGE_VIRTUAL_ACCOUNTS_ENABLED=true to create one Bridge virtual account.',
    }, null, 2));
    return;
  }

  const provider = new BridgeVirtualAccountProvider(client);
  const account = await provider.createVirtualAccount({
    userId: `smoke_${Date.now()}`,
    providerCustomerId: customer.id,
    email: customer.email,
    fullName: customer.full_name ?? customer.business_name ?? customer.email ?? 'Sivan Smoke Customer',
    currency: (process.env.BRIDGE_VIRTUAL_ACCOUNT_SMOKE_CURRENCY as any) || 'usd',
    country: 'US',
    useCase: 'Bridge virtual account smoke test',
  });

  console.log(JSON.stringify({
    ok: true,
    phase: 'created',
    selectedCustomer: safeCustomer(customer),
    account: {
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      currency: account.currency,
      bankName: account.bankName,
      accountName: account.accountName,
      accountNumberMasked: account.accountNumberMasked,
      routingNumberMasked: account.routingNumberMasked,
      ibanMasked: account.ibanMasked,
      status: account.status,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
