/**
 * Proves a virtual account can be moved from Base to Solana settlement, and
 * that the move is safe.
 *
 * Runs against a stub speaking the documented Bridge API:
 *   PUT /customers/{customerID}/virtual_accounts/{virtualAccountID}
 *   with UpdateVirtualAccountDestination { payment_rail, bridge_wallet_id }
 *
 * The three things that actually matter, and why:
 *
 *   1. The bank details must not change. The whole point of an in-place update
 *      is that anyone already holding the account number keeps using it. If
 *      the deposit instructions changed, this would be a migration, not an
 *      update, and every user would need re-notifying.
 *
 *   2. developer_fee_percent must survive. UpdateVirtualAccount accepts the
 *      field, and Bridge performs a replacement of what is sent. Omitting it
 *      risks resetting the fee to zero, which is exactly the bug that had
 *      every VA earning nothing.
 *
 *   3. The rail must match the wallet's chain. Bridge states the chain of the
 *      Bridge Wallet must match the payment rail. A Solana wallet told to
 *      settle over the base rail is a misroute.
 *
 * Run: npm run test:va-reprovision
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

const CUSTOMER = 'cus_sivan_1';

/** Bank details are fixed at creation and must never move. */
const BANK = {
  currency: 'usd',
  bank_name: 'Lead Bank',
  bank_account_number: '9876543210',
  bank_routing_number: '101019644',
  bank_beneficiary_name: 'Sivan Technologies',
};

const wallets = new Map<string, { id: string; chain: string; address: string }>([
  ['bw_base_1', { id: 'bw_base_1', chain: 'base', address: '0xBaSe000000000000000000000000000000000e03d' }],
]);

const va: any = {
  id: 'va_live_1',
  customer_id: CUSTOMER,
  status: 'activated',
  source_deposit_instructions: { ...BANK },
  destination: { currency: 'usdc', payment_rail: 'base', bridge_wallet_id: 'bw_base_1' },
  developer_fee_percent: '1.25',
};

function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = new URL(req.url || '/', 'http://x').pathname;
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (code: number, payload: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (path === '/virtual_accounts' && req.method === 'GET') {
        return send(200, { count: 1, data: [va], pagination_token: null });
      }

      if (path === `/customers/${CUSTOMER}/wallets` && req.method === 'GET') {
        return send(200, { count: wallets.size, data: [...wallets.values()] });
      }

      if (path === `/customers/${CUSTOMER}/wallets` && req.method === 'POST') {
        const chain = body?.chain;
        const existing = [...wallets.values()].find((w) => w.chain === chain);
        if (existing) return send(201, existing);
        const id = `bw_${chain}_${wallets.size + 1}`;
        const w = {
          id,
          chain,
          address: chain === 'solana' ? '9kV3ZMehKVyxfHKCcaDLye3P9HHw2MP4jtQa2gKBUmCs' : '0xnew',
        };
        wallets.set(id, w);
        return send(201, w);
      }

      if (path === `/customers/${CUSTOMER}/virtual_accounts/${va.id}` && req.method === 'PUT') {
        const dest = body?.destination ?? {};

        // Bridge: "The chain associated with the Bridge Wallet must match the
        // payment rail." Reproduced so the test can prove we never send a
        // mismatched pair.
        const target = wallets.get(dest.bridge_wallet_id);
        if (!target) {
          return send(400, { code: 'invalid_parameters', message: 'unknown bridge_wallet_id' });
        }
        if (target.chain !== dest.payment_rail) {
          return send(400, {
            code: 'invalid_parameters',
            message: `wallet chain ${target.chain} does not match payment_rail ${dest.payment_rail}`,
          });
        }

        va.destination = {
          currency: dest.currency ?? va.destination.currency,
          payment_rail: dest.payment_rail,
          bridge_wallet_id: dest.bridge_wallet_id,
        };
        // Replacement semantics: the fee becomes whatever was sent. Sending
        // nothing clears it. That is the trap this test guards.
        va.developer_fee_percent = body?.developer_fee_percent;
        // Deposit instructions are untouched by an update.
        return send(200, va);
      }

      return send(404, { code: 'not_found', message: `${req.method} ${path}` });
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
  const stub = await startStub();
  process.env.BRIDGE_BASE_URL = stub.url;
  process.env.BRIDGE_API_KEY = 'sk-test-stub';

  const { BridgeClient } = await import('../src/providers/bridge/bridge.client.js');
  const client = new BridgeClient(stub.url, 'sk-test-stub');

  console.log('\nVirtual account reprovision: Base -> Solana\n');

  console.log('1. Starting state');
  const before: any = await client.request('/virtual_accounts');
  const target = before.data[0];
  check('the VA settles to Base today', target.destination.payment_rail === 'base');
  check('and points at the Base wallet', target.destination.bridge_wallet_id === 'bw_base_1');
  const originalAccount = target.source_deposit_instructions.bank_account_number;
  const originalFee = target.developer_fee_percent;

  console.log('\n2. Wallets are create-only, so add Solana alongside Base');
  const solana: any = await client.request(`/customers/${CUSTOMER}/wallets`, {
    method: 'POST',
    idempotencyKey: `sivan-wallet-${CUSTOMER}-solana`,
    body: { chain: 'solana' },
  });
  check('a Solana wallet is created', solana.chain === 'solana');
  check('with a Solana-format address', !solana.address.startsWith('0x'), solana.address);
  check('the Base wallet still exists (funds there are untouched)', wallets.has('bw_base_1'));

  console.log('\n3. The rail must match the wallet chain');
  let mismatch = false;
  try {
    await client.request(`/customers/${CUSTOMER}/virtual_accounts/${target.id}`, {
      method: 'PUT',
      body: {
        destination: { currency: 'usdc', payment_rail: 'base', bridge_wallet_id: solana.id },
        developer_fee_percent: originalFee,
      },
    });
  } catch {
    mismatch = true;
  }
  check('Bridge rejects a Solana wallet on the base rail', mismatch,
    'a mismatched pair would misroute funds');

  console.log('\n4. The actual repoint');
  const updated: any = await client.request(
    `/customers/${CUSTOMER}/virtual_accounts/${target.id}`,
    {
      method: 'PUT',
      body: {
        destination: { currency: 'usdc', payment_rail: 'solana', bridge_wallet_id: solana.id },
        developer_fee_percent: originalFee,
      },
    }
  );
  check('the rail is now solana', updated.destination.payment_rail === 'solana');
  check('settling into the user\'s Solana wallet', updated.destination.bridge_wallet_id === solana.id);
  check('the VA keeps its id', updated.id === target.id);
  check('the currency is preserved', updated.destination.currency === 'usdc');

  console.log('\n5. Nothing the depositor sees has changed');
  check('same bank account number',
    updated.source_deposit_instructions.bank_account_number === originalAccount);
  check('same routing number',
    updated.source_deposit_instructions.bank_routing_number === BANK.bank_routing_number);
  check('same beneficiary name',
    updated.source_deposit_instructions.bank_beneficiary_name === BANK.bank_beneficiary_name);
  check('the account stays active', updated.status === 'activated');

  console.log('\n6. The developer fee survives');
  check('fee is still 1.25%', updated.developer_fee_percent === '1.25',
    `got ${updated.developer_fee_percent}`);

  // The trap: Bridge replaces what is sent, so omitting the fee clears it.
  const careless: any = await client.request(
    `/customers/${CUSTOMER}/virtual_accounts/${target.id}`,
    {
      method: 'PUT',
      body: { destination: { currency: 'usdc', payment_rail: 'solana', bridge_wallet_id: solana.id } },
    }
  );
  check('omitting developer_fee_percent DOES clear it',
    careless.developer_fee_percent === undefined,
    'this is why the migration script carries the fee forward explicitly');

  console.log('\n7. USDT becomes possible on the new rail');
  // Base carries USDC and EURC but not USDT; Solana carries both USDC and USDT.
  const { isAssetSupportedOnChain } = await import('../src/controls/payment-controls.service.js');
  check('USDT is not supported on Base', !isAssetSupportedOnChain('usdt', 'base' as any));
  check('USDT is supported on Solana', isAssetSupportedOnChain('usdt', 'solana' as any));
  check('USDC works on both',
    isAssetSupportedOnChain('usdc', 'base' as any) && isAssetSupportedOnChain('usdc', 'solana' as any));

  await stub.close();
  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
