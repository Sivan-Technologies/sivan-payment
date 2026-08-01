/**
 * Delegated signing, against real Privy.
 *
 * The last piece of a one-tap NGN off-ramp. Everything up to the Breet deposit
 * address existed; nothing moved the user's USDC to it, so the user had to
 * copy an address and send manually.
 *
 * The property being proved is narrow and matters: Sivan can move funds from a
 * wallet the USER OWNS, without owning it. That is an additional signer, not
 * custody - the owner is still the user, the grant is scopeable by policy and
 * revocable, and Sivan must present a fresh signature on every request.
 *
 * Wallets here are EMPTY, so a transfer cannot succeed on-chain. That is fine
 * and is the point of the assertion: reaching "transfer amount exceeds
 * balance" means authorization passed and the transaction was broadcast-ready.
 * A 401 would mean it never got that far.
 *
 * Run: npm run privy:delegated
 */

import 'dotenv/config';
import {
  authorizationSignature,
  canonicalJson,
  generateAuthorizationKeyPair,
  loadAuthorizationPrivateKey,
} from '../src/wallets/provider/privy-authorization.js';
import {
  encodeErc20Transfer,
  toBaseUnits,
  erc20TokenAddress,
  decimalsFor,
} from '../src/wallets/provider/privy-wallet.provider.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const APP_ID = process.env.PRIVY_APP_ID ?? '';
const APP_SECRET = process.env.PRIVY_APP_SECRET ?? '';
const BASE = 'https://api.privy.io/v1';

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64')}`,
  'privy-app-id': APP_ID,
});

async function main() {
  console.log('\nPURE ENCODING - NO NETWORK NEEDED');
  {
    // These run without credentials because a mistake here sends real funds
    // somewhere unintended, and that must be catchable in CI.
    const data = encodeErc20Transfer('0x0000000000000000000000000000000000000001', '1.5', 6);
    check('selector is transfer(address,uint256)', data.startsWith('0xa9059cbb'), data.slice(0, 10));
    check('calldata is 4 + 32 + 32 bytes', data.length === 2 + 8 + 64 + 64, String(data.length));
    check('1.5 USDC encodes as 1500000',
      data.endsWith((1_500_000).toString(16).padStart(64, '0')), data.slice(-64));

    // The float bug this avoids: 1.1 * 1e6 === 1100000.0000000001 in IEEE 754,
    // so the user would move a different sum than the one they approved.
    check('1.1 USDC is exactly 1100000 base units', toBaseUnits('1.1', 6) === 1_100_000n,
      String(toBaseUnits('1.1', 6)));
    check('0.000001 is the smallest unit', toBaseUnits('0.000001', 6) === 1n);
    check('a whole number works', toBaseUnits('20', 6) === 20_000_000n);

    let threw = '';
    try { toBaseUnits('1.1234567', 6); } catch (e: any) { threw = e.message; }
    check('excess precision is refused rather than truncated', Boolean(threw), 'it was accepted');

    threw = '';
    try { encodeErc20Transfer('not-an-address', '1', 6); } catch (e: any) { threw = e.message; }
    check('a malformed recipient is refused', Boolean(threw));

    threw = '';
    try { encodeErc20Transfer('0x0000000000000000000000000000000000000001', '0', 6); } catch (e: any) { threw = e.message; }
    check('a zero amount is refused', Boolean(threw));
  }

  console.log('\nCANONICAL JSON SORTS AT EVERY DEPTH');
  {
    // Sorting only the top level produces a signature Privy rejects as 401,
    // which reads like a permissions problem and is not one.
    check('nested keys are sorted',
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === '{"a":{"c":3,"d":2},"b":1}',
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }));
    check('arrays keep their order',
      canonicalJson({ a: [3, 1, 2] }) === '{"a":[3,1,2]}');
    check('undefined is dropped, matching JSON.stringify',
      canonicalJson({ a: 1, b: undefined }) === '{"a":1}');
  }

  console.log('\nTOKEN ADDRESSES ARE KNOWN, OR ABSENT');
  {
    check('base usdc mainnet is Circle\'s deployment',
      erc20TokenAddress('base' as any, 'usdc', true) === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    check('base usdc testnet is Circle\'s test token',
      erc20TokenAddress('base' as any, 'usdc', false) === '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    check('ethereum usdt mainnet is Tether\'s',
      erc20TokenAddress('ethereum' as any, 'usdt', true) === '0xdAC17F958D2ee523a2206206994597C13D831ec7');
    // Consistent with Breet, which publishes no Base USDT asset either.
    check('base usdt is absent rather than guessed',
      erc20TokenAddress('base' as any, 'usdt', true) === undefined);
    check('usdc is a 6-decimal token', decimalsFor('usdc') === 6);
  }

  console.log('\nKEY LOADING SURVIVES REAL ENVIRONMENTS');
  {
    const { privateKeyPem } = generateAuthorizationKeyPair();
    check('a real PEM loads', loadAuthorizationPrivateKey(privateKeyPem)?.includes('BEGIN') === true);
    // How a PEM usually arrives from a dashboard env var.
    check('escaped newlines are repaired',
      loadAuthorizationPrivateKey(privateKeyPem.replace(/\n/g, '\\n'))?.includes('\n') === true);
    check('base64-wrapped PEM is accepted',
      loadAuthorizationPrivateKey(Buffer.from(privateKeyPem).toString('base64'))?.includes('BEGIN') === true);
    check('empty is undefined, not a broken key', loadAuthorizationPrivateKey('') === undefined);
    check('garbage is undefined', loadAuthorizationPrivateKey('nonsense') === undefined);
  }

  if (!APP_ID || !APP_SECRET) {
    console.log('\n(no Privy credentials - skipping the live half)');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  }

  console.log('\nLIVE: SIVAN SIGNS FOR A WALLET THE USER OWNS');
  const stamp = Date.now();
  let userId = '';
  {
    const { publicKeySpki, privateKeyPem } = generateAuthorizationKeyPair();

    const quorum: any = await (await fetch(`${BASE}/key_quorums`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ display_name: `sivan-delegated-smoke-${stamp}`, public_keys: [publicKeySpki], authorization_threshold: 1 }),
    })).json();
    check('a key quorum is created', Boolean(quorum?.id), JSON.stringify(quorum).slice(0, 140));

    const user: any = await (await fetch(`${BASE}/users`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ linked_accounts: [{ type: 'custom_auth', custom_user_id: `sivan_delegated_${stamp}` }] }),
    })).json();
    userId = user?.id ?? '';

    const wallet: any = await (await fetch(`${BASE}/wallets`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ chain_type: 'ethereum', owner: { user_id: user.id }, additional_signers: [{ signer_id: quorum.id }] }),
    })).json();
    check('a wallet is created', Boolean(wallet?.address), JSON.stringify(wallet).slice(0, 140));

    // The property that makes this non-custodial: the OWNER is the user, and
    // Sivan appears only as an additional signer.
    check('the wallet is owned by the user, not by Sivan',
      wallet?.owner_id !== quorum?.id, `owner=${wallet?.owner_id} quorum=${quorum?.id}`);
    check('Sivan is listed as an additional signer',
      (wallet?.additional_signers ?? []).some((s: any) => s.signer_id === quorum.id),
      JSON.stringify(wallet?.additional_signers));
    console.log(`       ${wallet.address}`);

    const url = `${BASE}/wallets/${wallet.id}/rpc`;

    // WITHOUT the signature: must be refused.
    const unsigned = await fetch(url, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ method: 'personal_sign', params: { message: 'x', encoding: 'utf-8' } }),
    });
    check('app credentials alone cannot sign', unsigned.status === 401, `HTTP ${unsigned.status}`);

    // WITH the signature: must succeed.
    const body = { method: 'personal_sign', params: { message: 'sivan delegated smoke', encoding: 'utf-8' } };
    const signed = await fetch(url, {
      method: 'POST',
      headers: { ...headers(), 'privy-authorization-signature': authorizationSignature({ method: 'POST', url, body, appId: APP_ID, privateKeyPem }) },
      body: JSON.stringify(body),
    });
    const signedBody: any = await signed.json();
    check('the delegated signer CAN sign', signed.status === 200, `HTTP ${signed.status} ${JSON.stringify(signedBody).slice(0, 140)}`);
    check('a real signature comes back', typeof signedBody?.data?.signature === 'string');

    console.log('\nLIVE: A REAL USDC TRANSFER REACHES THE CHAIN');
    {
      // The wallet is empty, so this cannot settle. Reaching a BALANCE error
      // rather than an AUTH error is the assertion: it means authorization
      // passed and the transaction was broadcast-ready.
      const token = erc20TokenAddress('base' as any, 'usdc', false)!;
      const txBody = {
        method: 'eth_sendTransaction',
        caip2: 'eip155:84532',
        sponsor: false,
        params: { transaction: { to: token, data: encodeErc20Transfer('0x0000000000000000000000000000000000000001', '1', 6), value: '0x0' } },
      };
      const tx = await fetch(url, {
        method: 'POST',
        headers: { ...headers(), 'privy-authorization-signature': authorizationSignature({ method: 'POST', url, body: txBody, appId: APP_ID, privateKeyPem }) },
        body: JSON.stringify(txBody),
      });
      const txResult: any = await tx.json();
      const message = String(txResult?.error ?? '');

      check('the transfer is NOT rejected for authorization', tx.status !== 401,
        `HTTP ${tx.status} ${message.slice(0, 120)}`);
      check('it reached on-chain execution',
        tx.status === 200 || /exceeds balance|insufficient/i.test(message),
        `HTTP ${tx.status} ${message.slice(0, 160)}`);
      console.log(`       ${tx.status === 200 ? 'submitted' : message.slice(0, 90)}`);
    }

    console.log('\nLIVE: GAS SPONSORSHIP STATE IS REPORTED HONESTLY');
    {
      const sponsoredBody = {
        method: 'eth_sendTransaction',
        caip2: 'eip155:84532',
        sponsor: true,
        params: { transaction: { to: erc20TokenAddress('base' as any, 'usdc', false)!, data: encodeErc20Transfer('0x0000000000000000000000000000000000000001', '1', 6), value: '0x0' } },
      };
      const sponsored = await fetch(url, {
        method: 'POST',
        headers: { ...headers(), 'privy-authorization-signature': authorizationSignature({ method: 'POST', url, body: sponsoredBody, appId: APP_ID, privateKeyPem }) },
        body: JSON.stringify(sponsoredBody),
      });
      const sponsoredResult: any = await sponsored.json();
      const sponsorMessage = String(sponsoredResult?.error ?? '');
      // Two wordings, both meaning "a dashboard setting is missing": "not
      // enabled" (no sponsorship on the app) and "not configured for chain"
      // (sponsorship on, this network not covered).
      const disabled = /gas sponsorship is not (enabled|configured)/i.test(sponsorMessage);

      check('sponsorship either works or says it is disabled',
        sponsored.status === 200 || disabled || /exceeds balance|insufficient/i.test(sponsorMessage),
        `HTTP ${sponsored.status} ${sponsorMessage.slice(0, 160)}`);
      if (disabled) console.log(`       NOT AVAILABLE - ${sponsorMessage}`);
    }
  }

  if (userId) {
    await fetch(`${BASE}/users/${userId}`, { method: 'DELETE', headers: headers() }).catch(() => undefined);
  }

console.log('\nSPONSORED TRANSFERS HAVE A USABLE IDENTIFIER');
{
  // A sponsored EVM transfer is an ERC-4337 user operation. Privy returns
  // `hash: ""` - an EMPTY STRING, not null - because the real transaction hash
  // does not exist until a bundler includes it on chain.
  //
  // The provider used `result?.transaction_id ?? result?.data?.hash`, and `??`
  // only falls through on null/undefined. So the empty string passed straight
  // through and EVERY sponsored transfer was stored with an empty id, leaving
  // nothing to reconcile or look up. Caught live through the service path.
  // Asserted through the REAL provider, not a local copy of the logic. An
  // earlier version of this test reimplemented the selection inline, so
  // breaking the provider left it green - it was testing itself.
  const { PrivyWalletProvider } = await import('../src/wallets/provider/privy-wallet.provider.js');
  const liveProvider = new PrivyWalletProvider();

  // The funded e2e wallet, because an empty one cannot produce a sponsored
  // response to inspect. Skipped cleanly when it has not been provisioned.
  const e2eWallet = await liveProvider
    .createWallet({ userId: 'sivan_base_e2e_wallet', chain: 'base' } as any)
    .catch(() => undefined);

  const sponsoredTransfer = !e2eWallet ? ({ error: 'no e2e wallet provisioned' } as any) : await liveProvider.createTransfer({
    providerWalletId: e2eWallet.providerWalletId,
    chain: 'base',
    asset: 'usdc',
    amount: '0.01',
    toAddress: '0x000000000000000000000000000000000000dEaD',
    idempotencyKey: `idcheck_${stamp}`,
    reference: 'id-shape',
  } as any).catch((error: any) => ({ error: String(error?.message ?? error) } as any));

  if ((sponsoredTransfer as any).error) {
    // An unfunded or unprovisioned wallet cannot transfer, and neither is what
    // is under test here. An AUTH failure, however, would be a real problem.
    check('the failure is not an authorization one',
      !/authorization|not configured/i.test((sponsoredTransfer as any).error),
      (sponsoredTransfer as any).error);
  } else {
    check('the transfer id is never an empty string',
      typeof sponsoredTransfer.providerTransferId === 'string' &&
      sponsoredTransfer.providerTransferId.length > 0,
      JSON.stringify(sponsoredTransfer.providerTransferId));
    check('a sponsored transfer is flagged as sponsored',
      sponsoredTransfer.sponsored === true, String(sponsoredTransfer.sponsored));
    check('it carries a user operation hash',
      typeof sponsoredTransfer.userOperationHash === 'string' &&
      sponsoredTransfer.userOperationHash.length > 0,
      String(sponsoredTransfer.userOperationHash));
    // '' would read as "we have a hash" to every downstream caller.
    check('txHash is undefined rather than an empty string',
      sponsoredTransfer.txHash === undefined || sponsoredTransfer.txHash.length > 0,
      JSON.stringify(sponsoredTransfer.txHash));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error('\nsmoke run threw:', error); process.exit(1); });
