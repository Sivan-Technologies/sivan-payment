/**
 * Privy live smoke test - talks to REAL Privy, not a mock.
 *
 * This exists because the Privy adapter was written entirely from the docs and
 * had never made a single real request. Four defects surfaced within minutes of
 * pointing it at the actual API, three of which returned HTTP 200 while being
 * wrong. Reading the docs would not have found them.
 *
 * What is asserted here is the stuff that silently corrupts state:
 *
 *   - the user lookup actually distinguishes one user from another
 *   - asking twice for a wallet returns the SAME address
 *   - a user-owned wallet cannot be signed by Sivan's backend
 *
 * Requires PRIVY_APP_ID and PRIVY_APP_SECRET. Creates real (empty) wallets on
 * the Privy side, which is why the user ids are timestamped rather than fixed.
 *
 * Run: npm run privy:smoke
 */

import 'dotenv/config';
import { PrivyWalletProvider } from '../src/wallets/provider/privy-wallet.provider.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const APP_ID = process.env.PRIVY_APP_ID ?? '';
const APP_SECRET = process.env.PRIVY_APP_SECRET ?? '';

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64')}`,
    'privy-app-id': APP_ID,
  };
}

async function main() {
  if (!APP_ID || !APP_SECRET) {
    console.error('\nPRIVY_APP_ID / PRIVY_APP_SECRET are not set. Nothing was tested.\n');
    process.exit(1);
  }

  console.log(`\nPrivy live smoke  app=${APP_ID}`);

  const provider = new PrivyWalletProvider();
  const stamp = Date.now();
  const userA = `sivan_smoke_a_${stamp}`;
  const userB = `sivan_smoke_b_${stamp}`;

  console.log('\nCREDENTIALS REACH A REAL APP');
  {
    const response = await fetch(`https://api.privy.io/v1/apps/${APP_ID}`, { headers: authHeaders() });
    const body: any = await response.json().catch(() => ({}));
    check('GET /v1/apps/{id} authenticates', response.ok, `HTTP ${response.status}`);
    check('app has a name', Boolean(body?.name), JSON.stringify(body).slice(0, 120));
    if (body?.name) console.log(`       app name: ${body.name}`);
  }

  console.log('\nWALLET CREATION');
  let walletA: any;
  {
    walletA = await provider.createWallet({ userId: userA, chain: 'ethereum' } as any);
    check('ethereum wallet created', Boolean(walletA?.address), JSON.stringify(walletA).slice(0, 160));
    check('address is 0x + 40 hex', /^0x[0-9a-fA-F]{40}$/.test(walletA?.address ?? ''), walletA?.address);
    check('custody reported non_custodial', walletA?.custodyModel === 'non_custodial', walletA?.custodyModel);
    check('requiresUserSignature is true', walletA?.requiresUserSignature === true);
    console.log(`       ${walletA?.address}`);
  }

  console.log('\nCREATED-AT IS NOT 1970');
  {
    // Two different bugs live here, and only the second is interesting.
    //
    // POST /wallets returns `created_at` in MILLISECONDS. A wallet read back
    // from user.linked_accounts has no `created_at` key at all - it carries
    // `verified_at`, in SECONDS. So the freshly created object and the reused
    // object disagree on both field name and unit, and the reuse path is the
    // one that runs for every call after the first.
    const fresh = walletA?.createdAt ? new Date(walletA.createdAt) : undefined;
    check('createdAt present on a freshly created wallet', Boolean(fresh), String(walletA?.createdAt));
    check(
      'createdAt is within a day of now (create path, milliseconds)',
      Boolean(fresh) && Math.abs(Date.now() - fresh!.getTime()) < 86_400_000,
      String(walletA?.createdAt)
    );

    const reused = (await provider.listWallets(userA))[0];
    const reusedDate = reused?.createdAt ? new Date(reused.createdAt) : undefined;
    check('createdAt present on a REUSED wallet', Boolean(reusedDate), String(reused?.createdAt));
    check(
      'createdAt is within a day of now (reuse path, seconds)',
      Boolean(reusedDate) && Math.abs(Date.now() - reusedDate!.getTime()) < 86_400_000,
      `${reused?.createdAt} - a 1970 date here means seconds were read as milliseconds`
    );
  }

  console.log('\nIDEMPOTENCE - THE EXPENSIVE ONE');
  {
    // Privy does NOT dedupe: posting the same {chain_type, owner} twice
    // without an idempotency key yields a second address. If this regresses,
    // users get a second deposit address that nothing reconciles.
    const again = await provider.createWallet({ userId: userA, chain: 'ethereum' } as any);
    check('second call returns the SAME address', again?.address === walletA?.address,
      `${walletA?.address} vs ${again?.address}`);

    const base = await provider.createWallet({ userId: userA, chain: 'base' } as any);
    check('base reuses the ethereum address (one EVM key)', base?.address === walletA?.address,
      `${walletA?.address} vs ${base?.address}`);
  }

  console.log('\nUSERS ARE NOT CONFUSED WITH ONE ANOTHER');
  {
    // Privy ignores ?custom_user_id= and returns everybody, so a lookup that
    // trusts data[0] hands user B's wallet to user A. This is the assertion
    // that catches a regression back to that.
    const walletB = await provider.createWallet({ userId: userB, chain: 'ethereum' } as any);
    check('second user gets a DIFFERENT address', walletB?.address !== walletA?.address,
      `both ${walletA?.address}`);

    const listA = await provider.listWallets(userA);
    const listB = await provider.listWallets(userB);
    const addressesA = listA.map((w) => w.address);
    const addressesB = listB.map((w) => w.address);

    check('user A listing contains A', addressesA.includes(walletA?.address));
    check('user A listing does NOT contain B', !addressesA.includes(walletB?.address), addressesA.join(','));
    check('user B listing does NOT contain A', !addressesB.includes(walletA?.address), addressesB.join(','));
  }

  console.log('\nSOLANA IS A SEPARATE KEY');
  {
    const solana = await provider.createWallet({ userId: userA, chain: 'solana' } as any);
    check('solana wallet created', Boolean(solana?.address));
    check('solana address is base58, not 0x', !String(solana?.address ?? '').startsWith('0x'), solana?.address);
    check('solana differs from evm', solana?.address !== walletA?.address);
    console.log(`       ${solana?.address}`);
  }

  console.log('\nCUSTODY IS REAL, NOT A COMMENT');
  {
    // The whole non-custodial claim rests on this. If Sivan's backend can sign
    // a user-owned wallet, the architecture doc is fiction and the regulatory
    // posture is wrong.
    const response = await fetch(
      `https://api.privy.io/v1/wallets/${encodeURIComponent(walletA.providerWalletId)}/rpc`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          method: 'personal_sign',
          params: { message: 'sivan custody assertion', encoding: 'utf-8' },
        }),
      }
    );
    const body: any = await response.json().catch(() => ({}));

    check('backend CANNOT sign a user-owned wallet', response.status === 401,
      `HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`);
    check('no signature was returned', !body?.data?.signature,
      String(body?.data?.signature ?? ''));
  }

  console.log('\nTRANSFERS ADMIT THEY NEED THE USER');
  {
    const transfer = await provider.createTransfer({
      providerWalletId: walletA.providerWalletId,
      chain: 'ethereum',
      asset: 'USDC',
      amount: '1.00',
      toAddress: '0x0000000000000000000000000000000000000001',
      reference: 'smoke',
      idempotencyKey: `smoke_${stamp}`,
    } as any);

    check('status is pending_user_signature', transfer?.status === 'pending_user_signature', transfer?.status);
    check('a signature payload is handed back', Boolean(transfer?.userSignaturePayload));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 1 - 1 : 1);
}

main().catch((error) => {
  console.error('\nsmoke run threw:', error);
  process.exit(1);
});
