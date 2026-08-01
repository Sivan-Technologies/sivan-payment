/**
 * Privy wallet provisioning and eligibility.
 *
 * The questions that matter:
 *
 *   - can a user with basic information get a wallet? (yes, and that is the
 *     design decision this file pins)
 *   - does wallet creation stay decoupled from KYC?
 *   - is the custody model honest - does Sivan admit it cannot sign?
 *   - two keys for three chains, not three?
 *
 * Run: npm run test:privy-wallets
 */

import {
  canProvisionWallet,
  walletsToProvision,
  WALLET_MINIMUM_LEVEL,
} from '../src/wallets/wallet-eligibility.js';
import { PrivyWalletProvider, chainsPerKey } from '../src/wallets/provider/privy-wallet.provider.js';
import { getWalletProvider } from '../src/wallets/provider/provider-registry.js';
import { env } from '../src/config/env.js';
import { CheckStatus, VerificationLevel } from '../src/kyc/types/verification.types.js';
import type { VerificationState } from '../src/kyc/types/verification.types.js';

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

function state(over: Partial<VerificationState> = {}): VerificationState {
  return {
    level: VerificationLevel.NONE,
    identityStatus: CheckStatus.NOT_STARTED,
    bankStatus: CheckStatus.NOT_STARTED,
    bvnStatus: CheckStatus.NOT_STARTED,
    ninStatus: CheckStatus.NOT_STARTED,
    livenessStatus: CheckStatus.NOT_STARTED,
    proofOfAddressStatus: CheckStatus.NOT_STARTED,
    sourceOfFundsStatus: CheckStatus.NOT_STARTED,
    riskLevel: 'low',
    enhancedDueDiligence: false,
    ...over,
  };
}

async function threwAsync(fn: () => Promise<unknown>) {
  try { await fn(); return undefined; } catch (e: any) { return String(e?.message ?? e); }
}

async function main() {
  console.log('\nBASIC INFORMATION IS ENOUGH - the design decision');
  {
    // A resolved payout account is real evidence: since March 2024 a Nigerian
    // bank account cannot transact without BVN/NIN linkage, so an account that
    // resolves is one a licensed bank already verified.
    const basic = state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.VERIFIED });
    const result = canProvisionWallet(basic);
    check('a user with name + verified payout bank CAN get a wallet', result.eligible,
      result.reason);
    check('the minimum is Level 1, not full KYC',
      WALLET_MINIMUM_LEVEL === VerificationLevel.BANK, String(WALLET_MINIMUM_LEVEL));
  }

  console.log('\nsignup alone is not enough');
  {
    const fresh = state();
    const result = canProvisionWallet(fresh);
    check('a brand new account cannot get a wallet', !result.eligible);
    check('and is told exactly what to do',
      /payout bank account/i.test(result.reason), result.reason);
  }

  console.log('\nwallet creation is DECOUPLED from KYC');
  {
    // The whole point: a wallet is somewhere to receive tokens, not a
    // permission to move money. Coupling the two is what left every existing
    // KYC-approved record carrying a mock_cust_* id with a 404 on Receive.
    const noIdentity = state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.VERIFIED });
    check('no NIN/BVN required to hold a wallet', canProvisionWallet(noIdentity).eligible);
    check('and no ID document either',
      noIdentity.proofOfAddressStatus === CheckStatus.NOT_STARTED &&
      canProvisionWallet(noIdentity).eligible);

    const fullKyc = state({
      level: VerificationLevel.ENHANCED,
      bankStatus: CheckStatus.VERIFIED,
      identityStatus: CheckStatus.VERIFIED,
      ninStatus: CheckStatus.VERIFIED,
      proofOfAddressStatus: CheckStatus.VERIFIED,
    });
    check('a fully verified user is eligible too', canProvisionWallet(fullKyc).eligible);
  }

  console.log('\na stale level does not survive a failed check');
  {
    // Level says BANK, but the underlying check expired. The evidence wins.
    const expired = state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.EXPIRED });
    const r = canProvisionWallet(expired);
    check('an expired bank check blocks provisioning', !r.eligible);
    check('and reports it as a check problem', r.code === 'blocked_check_failed', r.code);
  }

  console.log('\nhigh risk blocks provisioning outright');
  {
    // Unlike a transaction, an address cannot be declined after the fact - once
    // it is out, it is out.
    const risky = state({
      level: VerificationLevel.ENHANCED,
      bankStatus: CheckStatus.VERIFIED,
      riskLevel: 'high',
    });
    check('a high-risk account gets no wallet', !canProvisionWallet(risky).eligible);
    check('unless EDD is complete',
      canProvisionWallet({ ...risky, enhancedDueDiligence: true }).eligible);
  }

  console.log('\nTWO keys, THREE chains');
  {
    const plan = walletsToProvision();
    check('exactly two wallets are provisioned', plan.length === 2, String(plan.length));

    const evm = plan.find((p) => p.chain === 'ethereum');
    check('the EVM wallet also serves Base',
      Boolean(evm?.alsoServes.includes('base')), JSON.stringify(evm));
    check('Solana is separate - different curve, genuinely a different key',
      plan.some((p) => p.chain === 'solana' && p.alsoServes.length === 0));

    const keys = chainsPerKey();
    check('one secp256k1 key covers ethereum and base',
      keys.some((k) => k.keyType === 'evm_secp256k1' &&
        k.chains.includes('ethereum') && k.chains.includes('base')));
    check('one ed25519 key covers solana',
      keys.some((k) => k.keyType === 'solana_ed25519' && k.chains.join() === 'solana'));
  }

  console.log('\nthe custody model is stated, not hidden');
  {
    const privy = new PrivyWalletProvider();
    check('Privy reports itself non-custodial', privy.custodyModel === 'non_custodial',
      privy.custodyModel);
    check('all three chains are supported',
      ['solana', 'ethereum', 'base'].every((c) => privy.supportedChains.includes(c)),
      privy.supportedChains.join());

    // WITHOUT a delegated signer, Sivan cannot move a user-owned wallet and
    // says so. This asserted unconditionally before, which encoded the
    // signer-less state as permanent - so configuring a signer broke it by
    // making the provider correctly attempt a real transfer against a
    // fictional wallet id. Both env sources must be cleared, because the
    // provider falls back to the parsed env object.
    const savedKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    const savedEnvKey = (env as any).PRIVY_AUTHORIZATION_PRIVATE_KEY;
    delete process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    (env as any).PRIVY_AUTHORIZATION_PRIVATE_KEY = '';

    const transfer = await privy.createTransfer({
      providerWalletId: 'w1', asset: 'usdc', chain: 'solana',
      amount: '10', toAddress: 'Abc', idempotencyKey: 'k1',
    });
    check('with no signer, a transfer returns pending_user_signature',
      transfer.status === 'pending_user_signature', transfer.status);

    check('and carries a payload the client can sign',
      Boolean(transfer.userSignaturePayload));
    check('with the right RPC method for the chain',
      (transfer.userSignaturePayload as any)?.rpcMethod === 'signAndSendTransaction',
      String((transfer.userSignaturePayload as any)?.rpcMethod));

    const evmTransfer = await privy.createTransfer({
      providerWalletId: 'w2', asset: 'usdc', chain: 'base',
      amount: '10', toAddress: '0xabc', idempotencyKey: 'k2',
    });
    check('EVM chains use eth_sendTransaction',
      (evmTransfer.userSignaturePayload as any)?.rpcMethod === 'eth_sendTransaction');

    // Sending on the wrong network succeeds on a chain nobody is watching.
    check('a CAIP-2 chain id is included so the network cannot be guessed',
      typeof (evmTransfer.userSignaturePayload as any)?.caip2 === 'string' &&
      (evmTransfer.userSignaturePayload as any).caip2.startsWith('eip155:'),
      String((evmTransfer.userSignaturePayload as any)?.caip2));

    // Restored only now: every assertion above describes the NO-SIGNER path,
    // and restoring earlier made the provider attempt a real transfer against
    // a fictional wallet and a fake recipient address.
    if (savedKey) process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY = savedKey;
    (env as any).PRIVY_AUTHORIZATION_PRIVATE_KEY = savedEnvKey;

    // Polling something never submitted must not invent a status.
    const polled = await privy.getTransfer(transfer.providerTransferId);
    check('polling an unsigned transfer still reports pending_user_signature',
      polled.status === 'pending_user_signature', polled.status);
  }

  console.log('\nbalances come from the ledger, not from Privy');
  {
    // Privy is a key manager, not an indexer. And a chain balance is the wrong
    // number anyway: tokens can arrive that were never a Sivan deposit, and
    // escrow holds funds that exist on-chain but are not spendable.
    const balances = await new PrivyWalletProvider().getBalances();
    check('getBalances returns nothing rather than a misleading figure',
      Array.isArray(balances) && balances.length === 0);
  }

  console.log('\nthe provider is registered and requires credentials');
  {
    const resolved = getWalletProvider('privy');
    check('the registry returns the Privy adapter', resolved.name === 'privy', resolved.name);
    check('it is no longer the "not implemented" stub',
      resolved instanceof PrivyWalletProvider);

    // Blanking process.env is NOT enough, and the difference matters.
    //
    // `credentials()` falls back to the parsed `env` object, which is built
    // from .env at import time. Once real Privy keys landed in .env this test
    // stopped exercising the missing-credentials path and instead made a LIVE
    // network call to Privy - it failed with "Wallet not found", a real 404
    // for wallet 'w1', which is a unit test quietly hitting a vendor API.
    //
    // Both sources have to be neutralised for the assertion to mean anything.
    const savedId = process.env.PRIVY_APP_ID;
    const savedSecret = process.env.PRIVY_APP_SECRET;
    const savedEnvId = (env as any).PRIVY_APP_ID;
    const savedEnvSecret = (env as any).PRIVY_APP_SECRET;
    delete process.env.PRIVY_APP_ID;
    delete process.env.PRIVY_APP_SECRET;
    (env as any).PRIVY_APP_ID = '';
    (env as any).PRIVY_APP_SECRET = '';

    const err = await threwAsync(() => new PrivyWalletProvider().getWallet('w1'));
    check('a call without credentials fails clearly',
      /credentials are not configured/i.test(err ?? ''), err);

    if (savedId) process.env.PRIVY_APP_ID = savedId;
    if (savedSecret) process.env.PRIVY_APP_SECRET = savedSecret;
    (env as any).PRIVY_APP_ID = savedEnvId;
    (env as any).PRIVY_APP_SECRET = savedEnvSecret;
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
