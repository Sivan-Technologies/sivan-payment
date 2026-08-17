/**
 * Breet off-ramp safety: the wallet must be bank-linked and auto-settlement
 * must be explicitly enabled before Sivan may sweep user funds into it.
 *
 * This test stubs Breet's HTTP API. It makes no live provider calls and moves
 * no money.
 *
 * Run: npm run test:breet-autosettlement-wallet
 */

// No imports of its own, so TypeScript would treat this file as a global
// script and collide with every other script that declares `pass`/`fail`.
export {};

process.env.BREET_APP_ID = 'test_app_id';
process.env.BREET_APP_SECRET = 'test_app_secret';
process.env.BREET_ENV = 'development';
process.env.BREET_DEFAULT_ASSET_ID = '';

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

type SeenRequest = { method: string; path: string; body: any };

function installBreetStub(mode: 'new-wallet' | 'existing-wallet' | 'auto-settlement-fails' | 'auto-settlement-reports-off') {
  const seen: SeenRequest[] = [];
  const wallet = {
    id: 'wallet_123',
    address: '4JStqvP44RT6zVSXjxhjMcTFNahsFCG4vF4WcaoXRzgv',
    label: 'sivan_usr_breet_asset_usdt_sol_dev',
  };

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = String(init?.method ?? 'GET').toUpperCase();
    const text = typeof init?.body === 'string' ? init.body : '';
    const body = text ? JSON.parse(text) : undefined;
    seen.push({ method, path: parsed.pathname, body });

    function json(status: number, payload: unknown) {
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'GET' && parsed.pathname === '/v1/trades/assets') {
      return json(200, {
        success: true,
        data: [{ id: 'asset_usdt_sol_dev', identifier: 'USDT_B7ZDHS8D_TOR7', minimum: 1 }],
      });
    }

    if (method === 'POST' && parsed.pathname === '/v1/trades/sell/assets/asset_usdt_sol_dev/generate-address') {
      if (mode === 'existing-wallet') {
        return json(400, { success: false, message: 'USDT_B7ZDHS8D_TOR7 for sivan_usr_breet_asset_usdt_sol_dev already exists in your wallets' });
      }
      return json(200, { success: true, data: wallet });
    }

    if (method === 'GET' && parsed.pathname === '/v1/trades/wallets') {
      // The read-back. In 'auto-settlement-reports-off' both writes succeed
      // and Breet still reports the flag off - the production case.
      return json(200, {
        success: true,
        data: [{ ...wallet, autoSettlement: mode !== 'auto-settlement-reports-off' }],
      });
    }

    if (method === 'PUT' && parsed.pathname === '/v1/trades/wallets/wallet_123/bank') {
      if (body?.bankId !== undefined) {
        return json(422, { success: false, message: 'validation errors', errors: { bankId: ['unknown fields detected'], id: ['required'] } });
      }
      if (mode === 'auto-settlement-fails') {
        return json(422, { success: false, message: 'wallet does not have a valid bank', errors: { id: ['bank cannot be linked'] } });
      }
      return json(200, { success: true, data: { ...wallet, bankId: body?.id, accountNumber: body?.accountNumber } });
    }

    if (method === 'PUT' && parsed.pathname === '/v1/trades/wallets/wallet_123/auto-settlement') {
      if (mode === 'auto-settlement-fails') {
        return json(422, { success: false, message: 'wallet does not have a bank' });
      }
      return json(200, { success: true, data: { ...wallet, autoSettlement: true } });
    }

    return json(404, { success: false, message: `unexpected ${method} ${parsed.pathname}` });
  }) as typeof fetch;

  return seen;
}

function quote() {
  return {
    id: 'ngnq_test',
    userId: 'usr_breet',
    direction: 'offramp',
    provider: 'breet',
    sourceCurrency: 'usdt',
    destinationCurrency: 'ngn',
    sourceAmount: '18.2',
    destinationAmount: '24990.24',
    rate: '1394',
    feeAmount: '303.28',
    status: 'quote_accepted',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    metadata: {
      network: 'solana',
      estimatedGasUsd: 0.01,
      bankId: '25',
      accountNumber: '1111111111',
      bankName: 'OPay - Paycom',
      accountName: 'Samuel',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const { BreetNgnProvider } = await import('../src/ngn/provider/breet.provider.js');

console.log('\nNEW BREET WALLET IS EXPLICITLY MADE AUTO-SETTLEMENT SAFE');
{
  const seen = installBreetStub('new-wallet');
  const created = await new BreetNgnProvider().createOfframpTransfer(quote() as any);
  const meta = created.metadata as any;

  check('a deposit address is returned', created.depositAddress === '4JStqvP44RT6zVSXjxhjMcTFNahsFCG4vF4WcaoXRzgv');
  check('the Breet wallet id is the provider transfer id', created.providerTransferId === 'wallet_123', String(created.providerTransferId));
  check('bank details are sent when generating the address',
    seen.some((item) => item.method === 'POST'
      && item.path.endsWith('/generate-address')
      && item.body?.bankId === '25'
      && item.body?.accountNumber === '1111111111'
      && item.body?.autoSettlement === true),
    JSON.stringify(seen));
  check('the wallet bank is explicitly updated after creation',
    seen.some((item) => item.method === 'PUT'
      && item.path === '/v1/trades/wallets/wallet_123/bank'
      && item.body?.id === '25'
      && item.body?.bankId === undefined
      && item.body?.accountNumber === '1111111111'),
    JSON.stringify(seen));
  check('auto-settlement is explicitly enabled in the bank update',
    seen.some((item) => item.method === 'PUT'
      && item.path === '/v1/trades/wallets/wallet_123/bank'
      && item.body?.autoSettlement === true),
    JSON.stringify(seen));
  /**
   * THIS ASSERTION WAS INVERTED, AND PRODUCTION PROVED IT WRONG.
   *
   * It demanded that NO second call be made, on the reasoning that passing
   * `autoSettlement: true` to PUT /bank was sufficient and the extra round
   * trip risked a timeout. A real payout webhook came back carrying
   * `meta.autoSettlement: false` - the flag was never on. Breet's docs are
   * explicit that enabling it is a separate endpoint, and /bank returns an
   * empty `data: {}` that confirms nothing.
   *
   * So the call is required, and the state is read back from
   * GET /trades/wallets rather than assumed from a 200.
   */
  check('auto-settlement is enabled with its own call',
    seen.some((item) => item.method === 'PUT'
      && item.path === '/v1/trades/wallets/wallet_123/auto-settlement'
      && item.body?.autoSettlement === true),
    JSON.stringify(seen));
  check('and the resulting state is read back from the provider',
    seen.some((item) => item.method === 'GET' && item.path === '/v1/trades/wallets'),
    'a 200 on a write is not proof the flag is on - that assumption is the bug');
  check('the metadata stores positive proof for the sweep guard',
    meta.autoSettlementProof?.bankLinked === true && meta.autoSettlementProof?.autoSettlementEnabled === true,
    JSON.stringify(meta.autoSettlementProof));
}

console.log('\nEXISTING BREET WALLET IS RE-LINKED BEFORE REUSE');
{
  const seen = installBreetStub('existing-wallet');
  const created = await new BreetNgnProvider().createOfframpTransfer(quote() as any);
  const meta = created.metadata as any;

  check('the existing wallet is reused', created.providerTransferId === 'wallet_123', String(created.providerTransferId));
  check('the existing wallet bank is updated',
    seen.some((item) => item.method === 'PUT'
      && item.path === '/v1/trades/wallets/wallet_123/bank'
      && item.body?.id === '25'
      && item.body?.bankId === undefined
      && item.body?.accountNumber === '1111111111'),
    JSON.stringify(seen));
  check('the existing wallet auto-settlement is enabled in the bank update',
    seen.some((item) => item.method === 'PUT'
      && item.path === '/v1/trades/wallets/wallet_123/bank'
      && item.body?.autoSettlement === true),
    JSON.stringify(seen));
  // A REUSED wallet needs this most: it may have been created before we sent
  // bank details at all, or linked to a payout account the user has since
  // replaced.
  check('a reused wallet also gets an explicit auto-settlement call',
    seen.some((item) => item.method === 'PUT'
      && item.path === '/v1/trades/wallets/wallet_123/auto-settlement'
      && item.body?.autoSettlement === true),
    JSON.stringify(seen));
  check('the reused wallet still carries sweep proof',
    meta.autoSettlementProof?.bankLinked === true && meta.autoSettlementProof?.autoSettlementEnabled === true,
    JSON.stringify(meta.autoSettlementProof));
}

console.log('\nA PROVIDER THAT REPORTS THE FLAG STILL OFF IS BELIEVED');
{
  /**
   * THE EXACT PRODUCTION FAILURE, REPRODUCED.
   *
   * Both writes return 200 and GET /trades/wallets then reports
   * `autoSettlement: false` - which is what a real payout webhook revealed
   * (`meta.autoSettlement: false`) after this code had recorded the proof as
   * true. The read-back is the only thing that can catch this, so it gets its
   * own case: the provider must be believed over our own optimism, and order
   * creation must refuse rather than hand out an address that cannot pay out.
   */
  installBreetStub('auto-settlement-reports-off');
  let message = '';
  try {
    await new BreetNgnProvider().createOfframpTransfer(quote() as any);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check('a wallet the provider says is NOT auto-settling is refused',
    /auto-settlement/i.test(message),
    message || 'order was created against a wallet that will never pay the customer');
}

console.log('\nAUTO-SETTLEMENT FAILURE STOPS ORDER CREATION');
{
  installBreetStub('auto-settlement-fails');
  let message = '';
  try {
    await new BreetNgnProvider().createOfframpTransfer(quote() as any);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check('the provider refuses instead of issuing an unsafe address',
    /wallet does not have a bank|breet/i.test(message),
    message);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
