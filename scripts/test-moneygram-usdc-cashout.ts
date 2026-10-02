/**
 * MONEYGRAM USDC CASHOUT: THE ON-CHAIN HALF, END TO END, AGAINST LIVE TESTNET.
 *
 * This suite exists because the cashout failed in production with the two
 * words "Not Found", and because fixing that message alone left the flow
 * still unable to complete. Three separate defects stood between a user and
 * a finished withdrawal:
 *
 *   1. The signer was not idempotent. The browser sent an empty identity on
 *      the first attempt and the resulting G address on the retry. Hashing an
 *      address yields a DIFFERENT account, so "Retry Signing" moved to a
 *      second, never-provisioned account and failed again, permanently.
 *
 *   2. The signer was not the user's wallet. MoneyGram derived from the seed
 *      prefix "sivan_stellar_sandbox_" while the rest of Sivan derives user
 *      wallets from "sivan_stellar_". A withdrawal could never debit the
 *      balance the app shows.
 *
 *   3. There was no USDC to send. Friendbot funds XLM only and nobody but
 *      Circle mints testnet USDC, so every provisioned account arrived at the
 *      payment holding zero of the asset being withdrawn.
 *
 * Nothing here is stubbed. The payment is submitted to Horizon and the
 * resulting hash is read back from the ledger.
 */

import crypto from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import {
  resolveStellarKeypair,
  stellarWalletSeedFor,
  MONEYGRAM_DEFAULT_IDENTITY,
  sendStellarUsdcPayment,
} from '../src/moneygram/service/moneygram-session.service.js';
import {
  preflightStellarPayment,
  provisionSandboxAccount,
  acquireTestnetUsdc,
  horizonUrlFor,
} from '../src/moneygram/service/stellar-preflight.service.js';
import { generateStellarKeypair } from '../src/wallets/stellar/stellar-keypair.js';
import { getStellarUsdcIssuer } from '../src/wallets/stellar/trustline.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function equals(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

/**
 * Asserts a call throws AND that it throws for the stated reason.
 *
 * Asserting only that something rejected is a decorative assertion: delete
 * the guard and the call still throws, just from somewhere else, and the test
 * stays green while the protection is gone. The pattern must match the
 * guard's own words.
 */
function throwsWith(name: string, fn: () => unknown, pattern: RegExp) {
  try {
    fn();
    check(name, false, 'did not throw at all');
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    check(name, pattern.test(msg), `message did not match ${pattern}: ${msg}`);
  }
}

async function rejectsWith(name: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    check(name, false, 'did not reject at all');
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    check(name, pattern.test(msg), `message did not match ${pattern}: ${msg}`);
  }
}

async function main() {
  // The institutional secret short circuits derivation by design. These tests
  // exercise the derivation path, so it must be absent.
  delete process.env.MONEYGRAM_STELLAR_SECRET;
  delete process.env.STELLAR_SECRET_KEY;

  const issuer = getStellarUsdcIssuer({ production: false });
  const horizon = horizonUrlFor('testnet');

  console.log('\n== 1. Identity resolution is stable and is the user\'s real wallet ==');

  /**
   * Exact expected strings, not a comparison of two consecutive calls. A test
   * that calls the function twice and compares passes trivially for anything
   * deterministic within one process, including a wrong derivation.
   */
  equals(
    'user-123 resolves to the platform Stellar wallet address',
    resolveStellarKeypair('user-123').publicKey(),
    'GCSBNOSY4TUNDRVJLZNQ4X4G4343LG7RXBCNUB3G2DTQQQZEONZPSW26'
  );

  equals(
    'MoneyGram derives the identical account to user-wallet.service',
    resolveStellarKeypair('user-123').publicKey(),
    generateStellarKeypair(stellarWalletSeedFor('user-123')).publicKey
  );

  equals(
    'the seed helper matches the platform-wide seed format verbatim',
    stellarWalletSeedFor('user-123'),
    'sivan_stellar_user-123'
  );

  /**
   * The regression that caused the retry loop. The old implementation hashed
   * "sivan_stellar_sandbox_" + identifier, which for user-123 produced
   * GBWV3PRVKG6IHLCDXYQFADZXYNWIYT3YX2J6OTW7TVR62SK2IFKKH6GL. If that address
   * ever reappears, MoneyGram has drifted away from the user's wallet again.
   */
  check(
    'the abandoned sandbox derivation is not resurrected',
    resolveStellarKeypair('user-123').publicKey() !==
      'GBWV3PRVKG6IHLCDXYQFADZXYNWIYT3YX2J6OTW7TVR62SK2IFKKH6GL',
    'resolveStellarKeypair is back on the sandbox-prefixed seed'
  );

  equals(
    'an empty identity resolves to the single documented default',
    resolveStellarKeypair('').publicKey(),
    generateStellarKeypair(stellarWalletSeedFor(MONEYGRAM_DEFAULT_IDENTITY)).publicKey
  );

  equals(
    'an absent identity resolves to that same default account',
    resolveStellarKeypair(undefined).publicKey(),
    resolveStellarKeypair('').publicKey()
  );

  // IDEMPOTENCE: feeding the function its own output must not move the account.
  const first = resolveStellarKeypair('retry-user').publicKey();
  throwsWith(
    'feeding back the derived G address is refused, not silently re-hashed',
    () => resolveStellarKeypair(first),
    /G address identifies an\s+account, not a user/
  );

  throwsWith(
    'a Stellar secret seed is refused as an identity',
    () => resolveStellarKeypair(Keypair.random().secret()),
    /Refusing to accept a Stellar secret seed as a user identity/
  );

  console.log('\n== 2. Mainnet guards refuse to spend real funds ==');

  await rejectsWith(
    'provisionSandboxAccount refuses mainnet',
    () =>
      provisionSandboxAccount({
        secret: Keypair.random().secret(),
        issuer,
        network: 'mainnet',
      }),
    /refuses to run on mainnet/
  );

  await rejectsWith(
    'acquireTestnetUsdc refuses mainnet before touching any endpoint',
    () =>
      acquireTestnetUsdc({
        secret: Keypair.random().secret(),
        issuer,
        destAmount: '1',
        network: 'mainnet',
      }),
    /refuses to run on mainnet/
  );

  await rejectsWith(
    'acquireTestnetUsdc rejects a non-positive destAmount',
    () =>
      acquireTestnetUsdc({
        secret: Keypair.random().secret(),
        issuer,
        destAmount: '0',
        network: 'testnet',
      }),
    /needs a positive destAmount/
  );

  console.log('\n== 3. Preflight diagnoses each precondition by name (live Horizon) ==');

  const fresh = Keypair.random();
  const missing = await preflightStellarPayment({
    publicKey: fresh.publicKey(),
    amount: '5',
    issuer,
    network: 'testnet',
  });
  equals('an unfunded account is reported as ACCOUNT_NOT_FOUND', missing.code, 'ACCOUNT_NOT_FOUND');
  check(
    'the ACCOUNT_NOT_FOUND diagnosis names the account and the network',
    missing.diagnosis?.includes(fresh.publicKey()) === true &&
      /testnet/.test(missing.diagnosis ?? ''),
    missing.diagnosis
  );
  check('no "Not Found" reaches the caller', !/^Not Found$/i.test(missing.diagnosis ?? ''), missing.diagnosis);

  console.log('\n== 4. Sandbox provisioning, live Friendbot and changeTrust ==');

  const prov = await provisionSandboxAccount({
    secret: fresh.secret(),
    issuer,
    network: 'testnet',
  });
  check('Friendbot created the account', prov.funded, JSON.stringify(prov.notes));
  check('the USDC trustline was established', prov.trustlineCreated, JSON.stringify(prov.notes));

  const funded = await preflightStellarPayment({
    publicKey: fresh.publicKey(),
    amount: '5',
    issuer,
    network: 'testnet',
  });
  equals(
    'a funded but USDC-empty account is reported as INSUFFICIENT_USDC, not NO_TRUSTLINE',
    funded.code,
    'INSUFFICIENT_USDC'
  );
  check('the trustline is visible to preflight', funded.hasTrustline, JSON.stringify(funded));
  equals('the USDC balance really is zero', funded.usdcBalance, '0.0000000');

  console.log('\n== 5. Acquiring real testnet USDC on the Stellar DEX ==');

  const buy = await acquireTestnetUsdc({
    secret: fresh.secret(),
    issuer,
    destAmount: '6',
    network: 'testnet',
  });
  check('the path payment returned a transaction hash', /^[0-9a-f]{64}$/.test(buy.hash), buy.hash);
  check(
    'the XLM send maximum exceeds the quote but stays sane',
    Number(buy.xlmSendMax) > Number(buy.quotedXlm) && Number(buy.xlmSendMax) < 1000,
    `quoted ${buy.quotedXlm}, sendMax ${buy.xlmSendMax}`
  );

  const afterBuy = await preflightStellarPayment({
    publicKey: fresh.publicKey(),
    amount: '5',
    issuer,
    network: 'testnet',
  });
  check('preflight now passes', afterBuy.ok, JSON.stringify(afterBuy));
  check(
    'the acquired USDC is on the ledger',
    Number(afterBuy.usdcBalance) >= 6,
    `balance ${afterBuy.usdcBalance}`
  );

  console.log('\n== 6. The withdrawal payment itself, submitted to the ledger ==');

  // Stand in for MoneyGram's withdraw_anchor_account: a real account that
  // really trusts the real issuer. The anchor's own account is only handed
  // out after an interactive KYC session, which cannot be automated, but the
  // on-chain requirements it imposes are exactly these.
  const anchorStandIn = Keypair.random();
  await provisionSandboxAccount({
    secret: anchorStandIn.secret(),
    issuer,
    network: 'testnet',
  });

  // MoneyGram matches a deposit by numeric ID memo. A non-numeric memo must
  // be rejected locally rather than producing an unmatchable payment.
  await rejectsWith(
    'a non-numeric settlement memo is refused before submission',
    () =>
      sendStellarUsdcPayment({
        sourceSecret: fresh.secret(),
        to: anchorStandIn.publicKey(),
        amount: '1',
        memo: 'not-numeric',
        requiredNetwork: 'testnet',
      }),
    /Settlement memo must be a numeric Stellar ID memo/
  );

  const memo = String(Math.floor(Math.random() * 1e12));
  const hash = await sendStellarUsdcPayment({
    sourceSecret: fresh.secret(),
    to: anchorStandIn.publicKey(),
    amount: '5',
    memo,
    requiredNetwork: 'testnet',
  });
  check('the withdrawal payment returned a transaction hash', /^[0-9a-f]{64}$/.test(hash), hash);

  // Read it back from the ledger. A returned hash is a claim; the ledger is
  // the evidence.
  const txRes = await fetch(`${horizon}/transactions/${hash}`);
  check('Horizon knows the transaction', txRes.ok, `HTTP ${txRes.status}`);
  const tx: any = await txRes.json();
  equals('the transaction succeeded on-chain', tx.successful, true);
  equals('the source account is the resolved signer', tx.source_account, fresh.publicKey());
  equals('the memo survived as an ID memo', tx.memo_type, 'id');
  equals('the memo value is the one requested', String(tx.memo), memo);

  const opsRes = await fetch(`${horizon}/transactions/${hash}/operations`);
  const ops: any = await opsRes.json();
  const payment = (ops?._embedded?.records ?? []).find((o: any) => o.type === 'payment');
  check('the ledger records a payment operation', Boolean(payment), JSON.stringify(ops?._embedded?.records));
  equals('the recipient is the anchor account', payment?.to, anchorStandIn.publicKey());
  equals('the asset is USDC', payment?.asset_code, 'USDC');
  equals('the issuer is the configured Circle testnet issuer', payment?.asset_issuer, issuer);
  equals('the amount is exactly the withdrawal amount', payment?.amount, '5.0000000');

  console.log('\n== 7. The full auto-provisioning path from a cold account ==');

  /**
   * The real user journey: an identity that has never touched Stellar calls
   * the signer once. No account, no trustline, no USDC. Before this change
   * that produced "Not Found"; it must now simply complete.
   */
  const coldIdentity = `e2e-cold-${crypto.randomUUID()}`;
  const cold = resolveStellarKeypair(coldIdentity);
  const coldPre = await preflightStellarPayment({
    publicKey: cold.publicKey(),
    amount: '2',
    issuer,
    network: 'testnet',
  });
  equals('the cold account genuinely does not exist yet', coldPre.code, 'ACCOUNT_NOT_FOUND');

  /**
   * Caught deliberately. Letting this throw would abort the suite, and an
   * aborted suite reports zero failures for the grep that counts them: the
   * regression would be real but nameless. Every way this call can fail must
   * land on a specific assertion that says which stage broke.
   */
  let coldHash = '';
  let coldError = '';
  try {
    coldHash = await sendStellarUsdcPayment({
      sourceSecret: cold.secret(),
      to: anchorStandIn.publicKey(),
      amount: '2',
      memo: String(Math.floor(Math.random() * 1e12)),
      requiredNetwork: 'testnet',
    });
  } catch (err: any) {
    coldError = String(err?.message ?? err);
  }

  check(
    'auto-provisioning covers the USDC shortfall rather than reporting it',
    !/INSUFFICIENT_USDC|holds .* USDC but the withdrawal requires/.test(coldError),
    coldError || 'no error'
  );
  check(
    'auto-provisioning creates the account rather than reporting it missing',
    !/does not exist on testnet/.test(coldError),
    coldError || 'no error'
  );
  check(
    'a never-seen identity completes a withdrawal in one call',
    /^[0-9a-f]{64}$/.test(coldHash),
    coldError || coldHash
  );

  if (coldHash) {
    const coldTx: any = await fetch(`${horizon}/transactions/${coldHash}`).then((r) => r.json());
    equals('that withdrawal is on the ledger too', coldTx.successful, true);
    equals('and it was signed by the identity-derived account', coldTx.source_account, cold.publicKey());
  } else {
    check('that withdrawal is on the ledger too', false, 'no hash to verify');
    check('and it was signed by the identity-derived account', false, 'no hash to verify');
  }

  console.log(`\nPassed ${passed}, failed ${failed}`);
  console.log(`Evidence: ${horizon}/transactions/${hash}`);
  if (coldHash) console.log(`Evidence: ${horizon}/transactions/${coldHash}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nSUITE CRASHED:', err?.message ?? err);
  process.exit(1);
});
