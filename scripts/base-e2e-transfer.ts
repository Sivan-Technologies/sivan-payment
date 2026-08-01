/**
 * The last mile: move real USDC out of a user-owned Privy wallet on Base.
 *
 * Every previous test stopped at "ERC20: transfer amount exceeds balance" -
 * the correct failure for an empty wallet, and proof that construction,
 * authorization and broadcast all work. What has never run is funds actually
 * moving, with gas sponsored, signed by Sivan rather than the user.
 *
 * Reads the balance first and refuses to guess: a transfer attempted against
 * an unfunded wallet produces the same error as a broken integration, and the
 * two must not be confused.
 *
 * Run: npm run base:e2e-transfer            (dry run - checks and reports)
 *      npm run base:e2e-transfer -- --send  (actually moves funds)
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { authorizationSignature } from '../src/wallets/provider/privy-authorization.js';
import { encodeErc20Transfer, erc20TokenAddress } from '../src/wallets/provider/privy-wallet.provider.js';

const APP_ID = process.env.PRIVY_APP_ID ?? '';
const APP_SECRET = process.env.PRIVY_APP_SECRET ?? '';
const BASE = 'https://api.privy.io/v1';
const E2E_USER_ID = 'sivan_base_e2e_wallet';
const CAIP2_BASE_SEPOLIA = 'eip155:84532';
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const USDC = erc20TokenAddress('base' as any, 'usdc', false)!;

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64')}`,
  'privy-app-id': APP_ID,
});

/** ERC-20 balanceOf, without pulling in a web3 library for one call. */
async function usdcBalance(address: string): Promise<bigint> {
  const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
  const response = await fetch(BASE_SEPOLIA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data }, 'latest'] }),
  });
  const body: any = await response.json();
  if (body?.error) throw new Error(`RPC: ${JSON.stringify(body.error)}`);
  return BigInt(body?.result ?? '0x0');
}

const usdc = (units: bigint) => `${(Number(units) / 1e6).toFixed(6)} USDC`;

function loadSigner(): { quorumId: string; privateKeyPem: string } {
  const file = path.join(process.cwd(), '.env.e2e');
  if (!fs.existsSync(file)) throw new Error('No .env.e2e - run: npm run base:e2e-setup');
  const contents = fs.readFileSync(file, 'utf8');
  const quorumId = /E2E_KEY_QUORUM_ID=(.+)/.exec(contents)?.[1]?.trim() ?? '';
  const b64 = /E2E_AUTHORIZATION_PRIVATE_KEY_B64=(.+)/.exec(contents)?.[1]?.trim() ?? '';
  if (!quorumId || !b64) throw new Error('.env.e2e is incomplete - re-run base:e2e-setup');
  return { quorumId, privateKeyPem: Buffer.from(b64, 'base64').toString('utf8') };
}

async function main() {
  const send = process.argv.includes('--send');
  const { quorumId, privateKeyPem } = loadSigner();

  const list: any = await (await fetch(`${BASE}/users?limit=100`, { headers: headers() })).json();
  const user = (list.data ?? []).find((candidate: any) =>
    (candidate.linked_accounts ?? []).some(
      (a: any) => a.type === 'custom_auth' && a.custom_user_id === E2E_USER_ID
    )
  );
  if (!user) throw new Error('No e2e user - run: npm run base:e2e-setup');

  const walletRef = (user.linked_accounts ?? []).find(
    (a: any) => a.type === 'wallet' && a.chain_type === 'ethereum'
  );
  const wallet: any = await (await fetch(`${BASE}/wallets/${walletRef.id}`, { headers: headers() })).json();

  console.log(`\nwallet    ${wallet.address}`);
  console.log(`delegated ${(wallet.additional_signers ?? []).some((s: any) => s.signer_id === quorumId)}`);

  const balance = await usdcBalance(wallet.address);
  console.log(`balance   ${usdc(balance)}`);

  if (balance === 0n) {
    // Refused rather than attempted. An unfunded wallet fails with exactly the
    // same error as a broken integration, and reporting "test failed" here
    // would be misleading.
    console.log('\n  NOT FUNDED YET.');
    console.log(`  Send test USDC on BASE SEPOLIA to ${wallet.address}`);
    console.log('  Faucet: https://faucet.circle.com  (select Base Sepolia)');
    console.log('  Gas is sponsored, so no ETH is needed.\n');
    process.exit(0);
  }

  // Deliberately small and fixed: this proves movement, and leaves the rest of
  // the balance for repeat runs.
  const amount = '0.10';
  const recipient = '0x000000000000000000000000000000000000dEaD';

  if (!send) {
    console.log(`\n  Funded. Ready to send ${amount} USDC to ${recipient}`);
    console.log('  Re-run with --send to actually move funds.\n');
    process.exit(0);
  }

  const url = `${BASE}/wallets/${wallet.id}/rpc`;
  const body = {
    method: 'eth_sendTransaction',
    caip2: CAIP2_BASE_SEPOLIA,
    // The property under test: Sivan pays gas, the user holds no ETH.
    sponsor: true,
    params: {
      transaction: { to: USDC, data: encodeErc20Transfer(recipient, amount, 6), value: '0x0' },
    },
  };

  console.log(`\nsending ${amount} USDC, gas sponsored...`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers(),
      'privy-authorization-signature': authorizationSignature({
        method: 'POST', url, body, appId: APP_ID, privateKeyPem,
      }),
    },
    body: JSON.stringify(body),
  });

  const result: any = await response.json().catch(() => ({}));
  console.log(`HTTP ${response.status}`, JSON.stringify(result).slice(0, 300));

  if (!response.ok) {
    console.log('\n  TRANSFER FAILED\n');
    process.exit(1);
  }

  const hash = result?.data?.hash ?? result?.hash;
  console.log(`\n  SENT. tx ${hash}`);
  console.log(`  https://sepolia.basescan.org/tx/${hash}`);

  // Confirm on chain rather than trusting the API response.
  console.log('\n  waiting for the balance to change...');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const after = await usdcBalance(wallet.address);
    if (after !== balance) {
      console.log(`  CONFIRMED. ${usdc(balance)} -> ${usdc(after)}`);
      console.log(`  moved ${usdc(balance - after)}, gas paid by Sivan\n`);
      return;
    }
  }
  console.log('  balance unchanged after 60s - check the explorer link above\n');
}

main().catch((error) => { console.error('\nthrew:', error?.message ?? error); process.exit(1); });
