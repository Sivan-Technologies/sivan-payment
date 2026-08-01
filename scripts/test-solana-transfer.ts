/**
 * Solana SPL transfers, and the RPC layer they depend on.
 *
 * Privy signs and broadcasts; it does NOT read chain state. Whether a
 * recipient already holds a token account is a question only an RPC can
 * answer, and it decides whether the transfer works at all - which is why
 * Solana needed an RPC layer and EVM did not.
 *
 * The associated token account is where money is lost:
 *
 *   assume it exists   the transfer fails, sometimes stranding funds
 *   always create it   the instruction fails when it already exists, so every
 *                      repeat transfer breaks
 *   derive it wrongly  tokens go to an address nobody can spend from
 *
 * Run: npm run test:solana-transfer
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  buildSplTransfer,
  solanaMintFor,
  toBaseUnits,
  PRIVY_DUMMY_BLOCKHASH,
  SOLANA_USDC_MINTS,
} from '../src/wallets/solana/spl-transfer.js';
import { solanaRpc, solanaRpcEndpoints, accountExists, solanaRpcHealth } from '../src/wallets/solana/solana-rpc.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function threw(fn: () => Promise<unknown>) {
  try { await fn(); return undefined; } catch (e: any) { return String(e?.message ?? e); }
}

async function main() {
  console.log('\nAMOUNTS DO NOT GO THROUGH FLOATING POINT');
  {
    // 1.1 * 1e6 is 1100000.0000000001 in IEEE 754, so the naive version moves
    // a different sum than the one the user approved.
    check('1.1 USDC is exactly 1100000', toBaseUnits('1.1', 6) === 1_100_000n, String(toBaseUnits('1.1', 6)));
    check('0.000001 is the smallest unit', toBaseUnits('0.000001', 6) === 1n);
    check('20 encodes cleanly', toBaseUnits('20', 6) === 20_000_000n);
    check('excess precision is refused, not truncated',
      Boolean(await threw(async () => toBaseUnits('1.1234567', 6))));
    check('a non-numeric amount is refused',
      Boolean(await threw(async () => toBaseUnits('abc', 6))));
  }

  console.log('\nMINTS ARE KNOWN, OR ABSENT');
  {
    check('usdc mainnet is Circle\'s mint',
      solanaMintFor('usdc', true) === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    check('usdc devnet is the test mint',
      solanaMintFor('usdc', false) === '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    check('usdt mainnet is Tether\'s mint',
      solanaMintFor('usdt', true) === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
    // No canonical USDT devnet mint exists; inventing one would send test
    // funds to a token that is not USDT.
    check('usdt devnet is absent rather than guessed', solanaMintFor('usdt', false) === undefined);
    check('an unknown asset is absent', solanaMintFor('doge', true) === undefined);
  }

  console.log('\nENDPOINTS ARE ORDERED, AND DEDUPLICATED');
  {
    const endpoints = solanaRpcEndpoints({ production: true });
    check('at least the public endpoint is present', endpoints.length >= 1);

    // Ordering is only observable when a paid provider IS configured, so it is
    // injected here. Without this the assertion passes trivially on a machine
    // with no SOLANA_RPC_URL and proves nothing about precedence.
    const { env } = await import('../src/config/env.js');
    const savedPrimary = env.SOLANA_RPC_URL;
    const savedFallback = env.SOLANA_RPC_FALLBACK_URL;
    (env as any).SOLANA_RPC_URL = 'https://paid-primary.example/rpc';
    (env as any).SOLANA_RPC_FALLBACK_URL = 'https://paid-fallback.example/rpc';

    const ordered = solanaRpcEndpoints({ production: true });
    check('a paid primary is tried FIRST',
      ordered[0] === 'https://paid-primary.example/rpc', ordered.join(' | '));
    check('the fallback is second', ordered[1] === 'https://paid-fallback.example/rpc');
    // The public endpoint is rate-limited and explicitly not for production,
    // so it must never be preferred over a provider that was paid for.
    check('the public endpoint is LAST, never preferred',
      ordered[ordered.length - 1]?.includes('api.mainnet-beta.solana.com') === true,
      ordered.join(' | '));

    (env as any).SOLANA_RPC_URL = savedPrimary;
    (env as any).SOLANA_RPC_FALLBACK_URL = savedFallback;
    // Configuring the same URL twice is a plausible copy-paste error, and
    // retrying an identical endpoint doubles failure latency for no gain.
    check('duplicates are removed', new Set(endpoints).size === endpoints.length);
    check('devnet is used outside production',
      solanaRpcEndpoints({ production: false }).some((url) => url.includes('devnet')));
  }

  console.log('\nTHE RPC ANSWERS, LIVE');
  {
    const health = await solanaRpcHealth({ production: true });
    check('an endpoint is reachable', health.available, health.message);
    check('it reports which endpoint answered', Boolean(health.endpoint), String(health.endpoint));
    // Surfaced so an operator sees they are on the rate-limited public
    // endpoint BEFORE it fails under load, not after.
    check('it flags when the public endpoint is in use', typeof health.isPublicEndpoint === 'boolean');
    console.log(`       ${health.endpoint} in ${health.latencyMs}ms | public=${health.isPublicEndpoint}`);
  }

  console.log('\nTOKEN ACCOUNTS ARE DERIVED CORRECTLY');
  {
    // A known mainnet account that definitely holds USDC. If derivation were
    // wrong this would report false, and a real transfer would go somewhere
    // unspendable.
    const owner = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    const mint = new PublicKey(SOLANA_USDC_MINTS.mainnet);
    const ata = getAssociatedTokenAddressSync(mint, owner, true);

    check('derivation is deterministic',
      getAssociatedTokenAddressSync(mint, owner, true).toBase58() === ata.toBase58());
    check('the derived account exists on chain',
      await accountExists(ata.toBase58(), { production: true }),
      `${ata.toBase58()} was not found - derivation may be wrong`);

    // A FRESHLY GENERATED keypair, because it is the only address guaranteed
    // never to have been used. An earlier version of this test used
    // 11111111111111111111111111111112 as "obviously unused" - it is a
    // well-known system address that does hold a USDC account on mainnet, so
    // the test failed while the code was correct.
    const unused = Keypair.generate().publicKey;
    const unusedAta = getAssociatedTokenAddressSync(mint, unused, true);
    check('a never-used address has NO token account',
      !(await accountExists(unusedAta.toBase58(), { production: true })),
      unusedAta.toBase58());
  }

  console.log('\nA SENDER WITH NO TOKEN ACCOUNT IS REFUSED EARLY');
  {
    // Better than letting simulation fail with "found no record of a prior
    // credit", which tells the user nothing actionable.
    const message = await threw(() => buildSplTransfer({
      fromOwner: Keypair.generate().publicKey.toBase58(),
      toOwner: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      mint: SOLANA_USDC_MINTS.mainnet,
      amount: '1',
      production: true,
    }));
    check('it refuses before building anything', Boolean(message), 'a transfer was built for an empty sender');
    check('the message is plain', /holds no/i.test(message ?? ''), message);
  }

  console.log('\nA REAL TRANSFER IS BUILT, WITH THE RIGHT INSTRUCTIONS');
  {
    // Sender holds USDC, recipient also holds USDC -> ONE instruction, no
    // account creation. Adding a create instruction here would fail the whole
    // transaction, breaking every repeat transfer.
    const built = await buildSplTransfer({
      fromOwner: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      toOwner: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
      mint: SOLANA_USDC_MINTS.mainnet,
      amount: '1.5',
      production: true,
    });

    check('a transaction is produced', built.transactionBase64.length > 100);
    check('it is valid base64', /^[A-Za-z0-9+/]+=*$/.test(built.transactionBase64));
    check('the sender token account is resolved', built.fromTokenAccount.length > 30);
    check('the recipient token account is resolved', built.toTokenAccount.length > 30);
    check('no account creation for an existing recipient',
      built.createsRecipientAccount === false && built.instructionCount === 1,
      `creates=${built.createsRecipientAccount} instructions=${built.instructionCount}`);
    check('no rent is charged when nothing is created', built.estimatedRentSol === 0);
    console.log(`       ${built.instructionCount} instruction, ${built.transactionBase64.length} b64 chars`);
  }

  console.log('\nA RECIPIENT WITHOUT A TOKEN ACCOUNT GETS ONE');
  {
    // The opposite case, and the one that silently fails if unhandled.
    const built = await buildSplTransfer({
      fromOwner: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      // Freshly generated, so it certainly has no token account.
      toOwner: Keypair.generate().publicKey.toBase58(),
      mint: SOLANA_USDC_MINTS.mainnet,
      amount: '1',
      production: true,
    });

    check('the account creation instruction is added',
      built.createsRecipientAccount === true && built.instructionCount === 2,
      `creates=${built.createsRecipientAccount} instructions=${built.instructionCount}`);
    // A real cost the user did not ask for, so it is surfaced rather than
    // absorbed silently.
    check('the rent cost is reported', built.estimatedRentSol > 0, String(built.estimatedRentSol));
    console.log(`       ${built.instructionCount} instructions, rent ${built.estimatedRentSol} SOL`);
  }

  console.log('\nTHE BLOCKHASH IS PRIVY\'S SENTINEL');
  {
    // Privy substitutes a real blockhash server-side immediately before
    // broadcast, which removes the ~60s expiry race entirely. Using a real
    // blockhash here would reintroduce it.
    check('the dummy blockhash is all ones', PRIVY_DUMMY_BLOCKHASH === '11111111111111111111111111111111');

    const built = await buildSplTransfer({
      fromOwner: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      toOwner: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
      mint: SOLANA_USDC_MINTS.mainnet,
      amount: '1',
      production: true,
    });
    const raw = Buffer.from(built.transactionBase64, 'base64');
    check('the sentinel is embedded in the serialised transaction',
      raw.includes(Buffer.from(new PublicKey(PRIVY_DUMMY_BLOCKHASH).toBytes())));
  }

  console.log('\nA CHAIN ERROR IS NOT RETRIED ACROSS ENDPOINTS');
  {
    // "account not found" is a real answer. Asking a second provider the same
    // question wastes a round trip to get the same reply.
    const message = await threw(() => solanaRpc('getAccountInfo', ['not-a-valid-pubkey'], { production: true }));
    check('an invalid request surfaces the chain error', Boolean(message), 'no error surfaced');
    check('the error names the method', /getAccountInfo/.test(message ?? ''), message);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error('\nthrew:', error); process.exit(1); });
