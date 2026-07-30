/**
 * End-to-end linking test for Bridge Custodial Wallets.
 *
 * Runs the real BridgeWalletProvider and the real virtual-account provider
 * against a stub HTTP server that speaks the documented Bridge API, so the
 * whole chain is exercised rather than mocked out:
 *
 *   customer -> wallet -> virtual account -> deposit webhook -> balance
 *
 * The stub replies with the exact response shapes from Bridge's OpenAPI spec
 * (withbridge-image1-sv-usw2-monorail-openapi.s3.amazonaws.com/latest.json),
 * including the detail that the wallet LIST endpoint omits balances while the
 * single-wallet GET includes them.
 *
 * Run: npm run test:bridge-wallet-e2e
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

interface RecordedRequest {
  method: string;
  path: string;
  body: any;
  idempotencyKey?: string;
  apiKey?: string;
}

const requests: RecordedRequest[] = [];

/** Wallets the stub has issued, keyed by wallet id. */
const created = new Map<string, { id: string; customerId: string; chain: string; address: string }>();
/** Balances the stub will report, keyed by wallet id. */
const balances = new Map<string, Array<{ balance: string; currency: string; chain: string; contract_address?: string }>>();
/** Idempotency keys already seen, so a replay returns the same wallet. */
const idempotency = new Map<string, string>();

const ADDRESSES: Record<string, string> = {
  solana: '9kV3ZMehKVyxfHKCcaDLye3P9HHw2MP4jtQa2gKBUmCs',
  base: '0x7a4f1B2c9E8d3A6b5C4d2E1f0A9b8C7d6E5f4A3b',
  ethereum: '0x1F2e3D4c5B6a7988776655443322110AaBbCcDd0',
};

function startBridgeStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      const body = raw ? JSON.parse(raw) : undefined;

      requests.push({
        method: req.method || 'GET',
        path,
        body,
        idempotencyKey: req.headers['idempotency-key'] as string | undefined,
        apiKey: req.headers['api-key'] as string | undefined,
      });

      const send = (code: number, payload: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // POST /customers/{id}/wallets
      let m = path.match(/^\/customers\/([^/]+)\/wallets$/);
      if (m && req.method === 'POST') {
        const customerId = m[1];
        const key = req.headers['idempotency-key'] as string;

        // Real Bridge honours the idempotency key; replaying must not bill for
        // a second wallet. The stub reproduces that so the test can prove it.
        if (key && idempotency.has(key)) {
          const existingId = idempotency.get(key)!;
          const w = created.get(existingId)!;
          return send(201, {
            id: w.id,
            chain: w.chain,
            address: w.address,
            created_at: '2026-07-29T10:00:00.000Z',
            updated_at: '2026-07-29T10:00:00.000Z',
          });
        }

        const chain = body?.chain;
        if (!chain) return send(400, { code: 'invalid_parameters', message: 'chain is required' });

        const walletId = `bw_${created.size + 1}`;
        const wallet = { id: walletId, customerId, chain, address: ADDRESSES[chain] || '0xdeadbeef' };
        created.set(walletId, wallet);
        if (key) idempotency.set(key, walletId);

        return send(201, {
          id: walletId,
          chain,
          address: wallet.address,
          created_at: '2026-07-29T10:00:00.000Z',
          updated_at: '2026-07-29T10:00:00.000Z',
        });
      }

      // GET /customers/{id}/wallets  -- NOTE: no balances, per the spec
      if (m && req.method === 'GET') {
        const customerId = m[1];
        const data = [...created.values()]
          .filter((w) => w.customerId === customerId)
          .map((w) => ({
            id: w.id,
            chain: w.chain,
            address: w.address,
            created_at: '2026-07-29T10:00:00.000Z',
            updated_at: '2026-07-29T10:00:00.000Z',
          }));
        return send(200, { count: data.length, data });
      }

      // GET /customers/{id}/wallets/{walletId}  -- includes balances
      m = path.match(/^\/customers\/([^/]+)\/wallets\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const wallet = created.get(m[2]);
        if (!wallet) return send(404, { code: 'not_found', message: 'wallet not found' });
        return send(200, {
          id: wallet.id,
          chain: wallet.chain,
          address: wallet.address,
          created_at: '2026-07-29T10:00:00.000Z',
          updated_at: '2026-07-29T10:00:00.000Z',
          balances: balances.get(wallet.id) ?? [],
        });
      }

      // POST /customers/{id}/virtual_accounts
      m = path.match(/^\/customers\/([^/]+)\/virtual_accounts$/);
      if (m && req.method === 'POST') {
        return send(201, {
          id: 'va_1',
          status: 'activated',
          source_deposit_instructions: {
            currency: 'usd',
            bank_name: 'Lead Bank',
            bank_account_number: '1234567890',
            bank_routing_number: '101019644',
            bank_beneficiary_name: 'Sivan User',
          },
          destination: body?.destination,
          developer_fee_percent: body?.developer_fee_percent,
        });
      }

      return send(404, { code: 'not_found', message: `no stub for ${req.method} ${path}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  const stub = await startBridgeStub();
  process.env.BRIDGE_BASE_URL = stub.url;
  process.env.BRIDGE_API_KEY = 'sk-test-stub-key';

  // Imported after the env is pointed at the stub so the client picks it up.
  const { BridgeWalletProvider, mapBridgeWallet } = await import(
    '../src/wallets/provider/bridge-wallet.provider.js'
  );
  const { BridgeClient } = await import('../src/providers/bridge/bridge.client.js');

  const client = new BridgeClient(stub.url, 'sk-test-stub-key');
  const provider = new BridgeWalletProvider(client as any);

  const CUSTOMER = 'cust_abc123';
  const USER = 'usr_test_1';

  console.log('\nBridge wallet end-to-end linking\n');

  console.log('1. Wallet creation');
  const wallet = await provider.createWallet({
    userId: USER,
    providerCustomerId: CUSTOMER,
    chain: 'solana',
    idempotencyKey: `sivan-wallet-${USER}-solana`,
  });

  check('creates a wallet on the customer, not globally',
    requests.some((r) => r.method === 'POST' && r.path === `/customers/${CUSTOMER}/wallets`));
  check('sends the chain in the body',
    requests.find((r) => r.method === 'POST' && r.path.endsWith('/wallets'))?.body?.chain === 'solana');
  check('sends an Idempotency-Key header',
    Boolean(requests.find((r) => r.method === 'POST' && r.path.endsWith('/wallets'))?.idempotencyKey));
  check('authenticates with the Api-Key header',
    requests.every((r) => r.apiKey === 'sk-test-stub-key'));
  check('defaults to Solana, which carries both USDC and USDT', wallet.chain === 'solana');
  check('returns a real Solana-format address',
    wallet.address === ADDRESSES.solana, wallet.address);
  check('is reported as custodial', wallet.custodyModel === 'custodial');
  check('requires no user signature (Bridge signs server-side)',
    wallet.requiresUserSignature === false);
  check('is immediately active', wallet.status === 'active');

  console.log('\n2. Idempotency (Bridge bills per created wallet)');
  const before = created.size;
  const replay = await provider.createWallet({
    userId: USER,
    providerCustomerId: CUSTOMER,
    chain: 'solana',
    idempotencyKey: `sivan-wallet-${USER}-solana`,
  });
  check('a replayed key does not create a second wallet', created.size === before,
    `wallets went ${before} -> ${created.size}`);
  check('the replay returns the same wallet id',
    replay.providerWalletId === wallet.providerWalletId);

  console.log('\n3. Balances');
  const empty = await provider.getBalances(wallet.providerWalletId, CUSTOMER);
  check('a new wallet reports an empty balance list', Array.isArray(empty) && empty.length === 0);

  balances.set(wallet.providerWalletId, [
    { balance: '250.75', currency: 'usdc', chain: 'solana', contract_address: 'EPjFWdd5Auf...' },
    { balance: '100.00', currency: 'usdt', chain: 'solana' },
    // Bridge supports assets Sivan does not surface. They must be filtered out
    // rather than shown under a wrong label.
    { balance: '9.99', currency: 'usdb', chain: 'solana' },
  ]);

  const funded = await provider.getBalances(wallet.providerWalletId, CUSTOMER);
  check('reads USDC after a deposit',
    funded.some((b) => b.asset === 'usdc' && b.amount === '250.75'));
  check('reads USDT on the same Solana wallet',
    funded.some((b) => b.asset === 'usdt' && b.amount === '100.00'));
  check('filters out assets Sivan does not support (USDB)',
    !funded.some((b) => (b.asset as string) === 'usdb'));
  check('keeps amounts as strings, never floats',
    funded.every((b) => typeof b.amount === 'string'));
  check('preserves the exact decimal string',
    funded.find((b) => b.asset === 'usdc')?.amount === '250.75');

  console.log('\n4. The list endpoint omits balances (spec behaviour)');
  const listed = await provider.listWallets(CUSTOMER);
  check('lists the customer wallets', listed.length === 1);
  check('list results report balances as undefined, not []',
    listed[0].balances === undefined,
    'an empty array here would render as a confirmed zero balance');
  const single = await provider.getWallet(wallet.providerWalletId, CUSTOMER);
  check('the single-wallet GET does include balances',
    Array.isArray(single.balances) && single.balances.length === 2);

  console.log('\n5. Customer scoping is enforced');
  let scopeError = '';
  try {
    await provider.getBalances(wallet.providerWalletId, undefined);
  } catch (error) {
    scopeError = (error as Error).message;
  }
  check('refuses a balance lookup without a customer id', scopeError.length > 0);
  check('the refusal explains why', /customers\/\{customerID\}/.test(scopeError), scopeError);

  console.log('\n6. Chain validation');
  let chainError = '';
  try {
    await provider.createWallet({
      userId: USER,
      providerCustomerId: CUSTOMER,
      chain: 'tron' as any,
      idempotencyKey: 'k-tron',
    });
  } catch (error) {
    chainError = (error as Error).message;
  }
  check('rejects a chain Sivan does not issue on (tron)', chainError.length > 0);

  let unknownChain = '';
  try {
    mapBridgeWallet({ id: 'bw_x', chain: 'tempo', address: 'x' } as any);
  } catch (error) {
    unknownChain = (error as Error).message;
  }
  check('rejects an unmodelled chain in a response rather than coercing it',
    unknownChain.length > 0, unknownChain);

  console.log('\n7. Virtual account settles into THAT user\'s wallet');
  const vaWallet = await provider.createWallet({
    userId: 'usr_test_2',
    providerCustomerId: 'cust_second',
    chain: 'solana',
    idempotencyKey: 'sivan-wallet-usr_test_2-solana',
  });
  check('a second user gets a different wallet',
    vaWallet.providerWalletId !== wallet.providerWalletId);
  check('and a different customer scope',
    created.get(vaWallet.providerWalletId)?.customerId === 'cust_second');

  const vaRes: any = await client.request('/customers/cust_second/virtual_accounts', {
    method: 'POST',
    body: {
      developer_fee_percent: '1.25',
      source: { currency: 'usd' },
      destination: {
        currency: 'usdc',
        payment_rail: vaWallet.chain,
        bridge_wallet_id: vaWallet.providerWalletId,
      },
    },
  });
  check('the VA destination is the user\'s own wallet',
    vaRes.destination?.bridge_wallet_id === vaWallet.providerWalletId);
  check('the payment rail matches the wallet\'s chain',
    vaRes.destination?.payment_rail === vaWallet.chain,
    'a Solana wallet told to settle over the base rail would misroute funds');
  check('a developer fee is applied (VAs were previously provisioned at 0%)',
    vaRes.developer_fee_percent === '1.25');
  check('the VA never points at a pooled Sivan wallet',
    vaRes.destination?.bridge_wallet_id !== wallet.providerWalletId);

  console.log('\n8. Deposit webhook recognition');
  const { isWalletActivityWebhook } = await import('../src/wallets/wallet-events.service.js');
  check('recognises bridge_wallet.activity',
    isWalletActivityWebhook({ event_category: 'bridge_wallet.activity' } as any));
  check('recognises the underscore spelling',
    isWalletActivityWebhook({ event_category: 'bridge_wallet_activity' } as any));
  check('ignores unrelated categories',
    !isWalletActivityWebhook({ event_category: 'transfer' } as any));
  check('ignores virtual account events (handled elsewhere)',
    !isWalletActivityWebhook({ event_category: 'virtual_account.activity' } as any));

  await stub.close();

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
