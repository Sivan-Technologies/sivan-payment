import { BridgeClient } from '../src/providers/bridge/bridge.client.js';
import { env } from '../src/config/env.js';

const client = new BridgeClient();

try {
  const customers: any = await client.request('/customers');
  console.log(JSON.stringify({
    ok: true,
    bridgeBaseUrl: env.BRIDGE_BASE_URL,
    mockMode: env.BRIDGE_MOCK_MODE,
    customerCount: customers?.count ?? customers?.data?.length ?? null,
    firstCustomer: customers?.data?.[0]
      ? {
          id: customers.data[0].id,
          type: customers.data[0].type,
          status: customers.data[0].status,
          email: customers.data[0].email,
          endorsements: customers.data[0].endorsements?.map((e: any) => ({ name: e.name, status: e.status }))
        }
      : null
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
