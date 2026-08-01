/**
 * Delegated signing is a property of the WALLET, not of the provider.
 *
 * Privy attaches additional signers AT CREATION and refuses to add one later:
 * the PATCH must be signed by the wallet's OWNER, which is the user, and Sivan
 * cannot produce that signature. Verified live - an app-credentialled PATCH
 * and one signed by the very key being added BOTH return 401, and the signer
 * list stays empty.
 *
 * The consequence is permanent and easy to get wrong: a wallet provisioned
 * before delegated signing existed can never gain it. Holding a signing key
 * says nothing about any particular wallet, so the capability must be read
 * from the wallet itself, stored, and checked before Sivan promises a one-tap
 * withdrawal it cannot deliver.
 *
 * Run: npm run test:delegated-capability
 */

import 'dotenv/config';
import { PrivyWalletProvider } from '../src/wallets/provider/privy-wallet.provider.js';

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
  if (!APP_ID || !APP_SECRET) {
    console.error('\nPRIVY credentials are not set. Nothing was tested.\n');
    process.exit(1);
  }

  const provider = new PrivyWalletProvider();
  const stamp = Date.now();
  const cleanup: string[] = [];

  console.log('\nA WALLET WITHOUT A SIGNER CANNOT BE GIVEN ONE');
  {
    // The whole reason the capability is stored rather than inferred.
    const { generateAuthorizationKeyPair, authorizationSignature } =
      await import('../src/wallets/provider/privy-authorization.js');
    const keyPair = generateAuthorizationKeyPair();

    const quorum: any = await (await fetch(`${BASE}/key_quorums`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ display_name: `cap-${stamp}`, public_keys: [keyPair.publicKeySpki], authorization_threshold: 1 }),
    })).json();

    const user: any = await (await fetch(`${BASE}/users`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ linked_accounts: [{ type: 'custom_auth', custom_user_id: `cap_legacy_${stamp}` }] }),
    })).json();
    cleanup.push(user.id);

    // A legacy wallet: no additional_signers at creation.
    const legacy: any = await (await fetch(`${BASE}/wallets`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ chain_type: 'ethereum', owner: { user_id: user.id } }),
    })).json();
    check('a wallet can be created with no signer', Boolean(legacy?.address));
    check('and it reports no signers', (legacy.additional_signers ?? []).length === 0);

    const url = `${BASE}/wallets/${legacy.id}`;
    const body = { additional_signers: [{ signer_id: quorum.id }] };

    const withCreds = await fetch(url, { method: 'PATCH', headers: headers(), body: JSON.stringify(body) });
    check('PATCH with app credentials is refused', withCreds.status === 401, `HTTP ${withCreds.status}`);

    // Signing the PATCH with the key being ADDED - the chicken-and-egg case.
    const signed = await fetch(url, {
      method: 'PATCH',
      headers: { ...headers(), 'privy-authorization-signature': authorizationSignature({ method: 'PATCH', url, body, appId: APP_ID, privateKeyPem: keyPair.privateKeyPem }) },
      body: JSON.stringify(body),
    });
    check('PATCH signed by the key being added is also refused', signed.status === 401, `HTTP ${signed.status}`);

    const after: any = await (await fetch(url, { headers: headers() })).json();
    check('the wallet still has no signer', (after.additional_signers ?? []).length === 0,
      JSON.stringify(after.additional_signers));
  }

  console.log('\nTHE CAPABILITY IS READ FROM THE WALLET');
  {
    // A quorum IS configured while this wallet is created WITHOUT one, which
    // is the only arrangement that distinguishes reading the wallet from
    // inferring capability off config. With config and reality agreeing, a
    // naive `Boolean(QUORUM_ID)` implementation passes and the test proves
    // nothing - so the two are deliberately put in conflict here.
    const { env: envModule } = await import('../src/config/env.js');
    const savedQuorumId = process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
    const savedEnvQuorumId = (envModule as any).PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
    process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = 'quorum_that_is_configured_but_not_on_this_wallet';
    (envModule as any).PRIVY_AUTHORIZATION_KEY_QUORUM_ID = 'quorum_that_is_configured_but_not_on_this_wallet';

    const legacyUser: any = await (await fetch(`${BASE}/users`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ linked_accounts: [{ type: 'custom_auth', custom_user_id: `cap_none_${stamp}` }] }),
    })).json();
    cleanup.push(legacyUser.id);
    const rawLegacy: any = await (await fetch(`${BASE}/wallets`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ chain_type: 'ethereum', owner: { user_id: legacyUser.id } }),
    })).json();

    const withoutSigner = await provider.getWallet(rawLegacy.id);
    check('a wallet created without a signer reports false EVEN WHEN a quorum is configured',
      withoutSigner.delegatedSigningEnabled === false,
      'capability was inferred from config rather than read from the wallet');
    check('and carries no signer id', withoutSigner.delegatedSignerId === undefined);

    if (savedQuorumId) process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = savedQuorumId;
    else delete process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
    (envModule as any).PRIVY_AUTHORIZATION_KEY_QUORUM_ID = savedEnvQuorumId;

    // getWallet is the path createTransfer uses to decide.
    const reread = await provider.getWallet(withoutSigner.providerWalletId);
    check('re-reading it still reports false', reread.delegatedSigningEnabled === false);
  }

  console.log('\nA REUSED WALLET IS NOT MISREPORTED');
  {
    // The trap: user.linked_accounts has NO additional_signers field at all -
    // verified live, absent rather than empty. Trusting that projection would
    // report every reused wallet as non-delegated, which is almost all of them
    // after the first call.
    const quorumId = (process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || '').trim();
    if (!quorumId) {
      console.log('       (no PRIVY_AUTHORIZATION_KEY_QUORUM_ID configured - creating one for the test)');
      const { generateAuthorizationKeyPair } = await import('../src/wallets/provider/privy-authorization.js');
      const keyPair = generateAuthorizationKeyPair();
      const quorum: any = await (await fetch(`${BASE}/key_quorums`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ display_name: `cap-reuse-${stamp}`, public_keys: [keyPair.publicKeySpki], authorization_threshold: 1 }),
      })).json();
      process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = quorum.id;
    }

    const userId = `cap_reuse_${stamp}`;
    const first = await provider.createWallet({ userId, chain: 'ethereum' } as any);
    check('a wallet created WITH a signer reports true',
      first.delegatedSigningEnabled === true, String(first.delegatedSigningEnabled));
    check('and names the signer', typeof first.delegatedSignerId === 'string', String(first.delegatedSignerId));

    // Second call goes through findWallet - the linked_accounts path.
    const reused = await provider.createWallet({ userId, chain: 'ethereum' } as any);
    check('the same address comes back', reused.address === first.address);
    check('the REUSED wallet still reports true',
      reused.delegatedSigningEnabled === true,
      'the linked_accounts projection has no additional_signers, so this must re-read the wallet');
  }

  console.log('\nA LEGACY WALLET DEGRADES HONESTLY, IT DOES NOT FAIL');
  {
    // With a signing key configured but a wallet that has no signer, the right
    // answer is pending_user_signature - not a 401 the caller cannot read.
    const { generateAuthorizationKeyPair } = await import('../src/wallets/provider/privy-authorization.js');
    // Blanking process.env is NOT enough: the provider falls back to the
    // PARSED env object, so once a quorum is configured in .env the wallet
    // gets a signer and this scenario stops being a legacy wallet at all.
    // Both sources have to be cleared for "no signer" to mean anything.
    const { env } = await import('../src/config/env.js');
    const saved = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    const savedQuorum = process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
    const savedEnvQuorum = (env as any).PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
    process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY = generateAuthorizationKeyPair().privateKeyPem;
    delete process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
    (env as any).PRIVY_AUTHORIZATION_KEY_QUORUM_ID = '';

    const legacy = await provider.createWallet({ userId: `cap_degrade_${stamp}`, chain: 'base' } as any);
    check('the wallet has no signer', legacy.delegatedSigningEnabled === false);

    // Caught rather than allowed to propagate: without the guard this THROWS
    // (observed: "Gas sponsorship is not configured for chain eip155:84532"),
    // and a thrown provider error is exactly the outcome being prevented - the
    // caller cannot tell "this wallet can never be delegated" from "the
    // network hiccuped", so it cannot decide whether to ask the user to sign.
    let transfer: any;
    let threw: string | undefined;
    try {
      transfer = await provider.createTransfer({
        providerWalletId: legacy.providerWalletId,
        chain: 'base',
        asset: 'usdc',
        amount: '1',
        toAddress: '0x0000000000000000000000000000000000000001',
        reference: 'cap-test',
        idempotencyKey: `cap_${stamp}`,
      } as any);
    } catch (error: any) {
      threw = String(error?.message ?? error);
    }

    check('it does not throw - a legacy wallet is a known state, not an error',
      threw === undefined, threw);
    check('the transfer is not attempted', transfer?.status === 'pending_user_signature', String(transfer?.status));
    check('a signature payload is returned for the user',
      Boolean(transfer?.userSignaturePayload));
    check('the payload explains WHY',
      /without a Sivan signer/i.test(String((transfer?.userSignaturePayload as any)?.reason ?? '')),
      String((transfer?.userSignaturePayload as any)?.reason));

    if (saved) process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY = saved;
    else delete process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    if (savedQuorum) process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = savedQuorum;
    (env as any).PRIVY_AUTHORIZATION_KEY_QUORUM_ID = savedEnvQuorum;
  }

  // Tidy up: Privy bills per monthly-active wallet and wallets cannot be
  // deleted, so at least remove the users.
  for (const id of cleanup) {
    await fetch(`${BASE}/users/${id}`, { method: 'DELETE', headers: headers() }).catch(() => undefined);
  }
  for (const suffix of ['cap_none', 'cap_reuse', 'cap_degrade']) {
    const list: any = await (await fetch(`${BASE}/users?limit=100`, { headers: headers() })).json();
    for (const user of list.data ?? []) {
      const custom = (user.linked_accounts ?? []).find((a: any) => a.type === 'custom_auth')?.custom_user_id ?? '';
      if (custom.startsWith(suffix)) {
        await fetch(`${BASE}/users/${user.id}`, { method: 'DELETE', headers: headers() }).catch(() => undefined);
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error('\nthrew:', error); process.exit(1); });
