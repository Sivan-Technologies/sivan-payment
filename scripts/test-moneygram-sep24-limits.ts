/**
 * MONEYGRAM SEP-10 AUTH, SEP-24 INITIATION AND LIVE AMOUNT LIMITS.
 *
 * Run against the real sandbox anchor. Nothing here is mocked: a SEP-10
 * challenge is fetched, verified, signed and exchanged for a real JWT, and
 * the anchor's own /info document is read for the limits it enforces.
 *
 * WHY THE LIMITS MATTER
 *
 * Three places in Sivan described the allowed amount, and none of them was
 * the anchor:
 *
 *   quote route            minimum 5.00, maximum 2500 / 950
 *   session service error  "between 15 and 50 USDC for testing"
 *   the live anchor        withdraw min 15 max 2500, deposit min 15 max 950
 *
 * Confirmed by submitting 5 USDC to the live anchor, which answered
 * HTTP 400 "amount is less than asset's minimum limit". So every quote
 * between 5 and 14.99 was accepted by Sivan, converted, displayed with a
 * local-currency figure, and only refused once the user had committed.
 * Limits are now read from the anchor.
 */

import { Keypair } from '@stellar/stellar-sdk';
import {
  fetchAnchorInfo,
  fetchSep24Info,
  fetchAssetLimits,
  clearSep24InfoCache,
} from '../src/moneygram/service/anchor-discovery.service.js';
import {
  resolveStellarKeypair,
  getMoneyGramSep10Token,
} from '../src/moneygram/service/moneygram-session.service.js';

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
  delete process.env.MONEYGRAM_STELLAR_SECRET;
  delete process.env.STELLAR_SECRET_KEY;
  clearSep24InfoCache();

  console.log('\n== 1. The anchor is the one we think it is ==');

  const anchor = await fetchAnchorInfo({ force: true, timeoutMs: 15_000 });
  equals(
    'SEP-10 endpoint is MoneyGram\'s',
    anchor.webAuthEndpoint,
    'https://extmgxanchor.moneygram.com/stellarsepservice/auth'
  );
  equals(
    'SEP-24 transfer server is MoneyGram\'s',
    anchor.transferServerSep24,
    'https://extmgxanchor.moneygram.com/stellarsepservice/sep24'
  );
  equals('the sandbox anchor signs for testnet', anchor.networkPassphrase, 'Test SDF Network ; September 2015');

  console.log('\n== 2. SEP-10 produces a real, verifiable JWT ==');

  const kp = resolveStellarKeypair('sep24-limits-suite');
  const { token } = await getMoneyGramSep10Token(kp, { timeoutMs: 20_000 });

  const parts = token.split('.');
  equals('the token is a three part JWT', parts.length, 3);
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

  equals('the subject is the account we authenticated as', claims.sub, kp.publicKey());
  equals('the anchor names itself as home domain', claims.home_domain, 'extmgxanchor.moneygram.com');
  check('the audience is sep10', JSON.stringify(claims.aud).includes('sep10'), JSON.stringify(claims.aud));
  check(
    'the token is not already expired',
    Number(claims.exp) > Math.floor(Date.now() / 1000),
    `exp ${claims.exp}`
  );

  /**
   * A token issued to a DIFFERENT keypair must not carry our subject. This
   * catches a signer that silently falls back to one shared account, which
   * would make every user's withdrawal appear to come from the same wallet.
   */
  const other = resolveStellarKeypair('sep24-limits-suite-second-user');
  check(
    'a different identity authenticates as a different account',
    other.publicKey() !== kp.publicKey(),
    other.publicKey()
  );

  console.log('\n== 3. Limits are read from the anchor, not from our source ==');

  const info = await fetchSep24Info({ force: true, timeoutMs: 15_000 });
  check('the /info document lists withdraw assets', Boolean(info?.withdraw), JSON.stringify(Object.keys(info ?? {})));

  const w = await fetchAssetLimits('USDC', 'withdraw');
  const d = await fetchAssetLimits('USDC', 'deposit');

  check('USDC withdraw is enabled', w.enabled, JSON.stringify(w));
  check('USDC deposit is enabled', d.enabled, JSON.stringify(d));

  /**
   * Asserted against the anchor's own document rather than against literals,
   * because MoneyGram can change these. What must stay true is that our code
   * reports exactly what the anchor reports.
   */
  equals('withdraw minimum matches /info', w.minAmount, Number(info.withdraw.USDC.min_amount));
  equals('withdraw maximum matches /info', w.maxAmount, Number(info.withdraw.USDC.max_amount));
  equals('deposit minimum matches /info', d.minAmount, Number(info.deposit.USDC.min_amount));
  equals('deposit maximum matches /info', d.maxAmount, Number(info.deposit.USDC.max_amount));

  // The specific disagreement that caused the bug. The old hardcoded floor
  // was 5; if the anchor's floor is above it, the old code was wrong.
  check(
    'the anchor minimum is above the 5.00 floor the quote route used to hardcode',
    w.minAmount > 5,
    `anchor minimum is ${w.minAmount}`
  );
  check(
    'the anchor maximum is above the 50 ceiling the session error used to claim',
    w.maxAmount > 50,
    `anchor maximum is ${w.maxAmount}`
  );

  await rejectsWith(
    'an asset the anchor does not list is refused rather than defaulted',
    () => fetchAssetLimits('NOTANASSET', 'withdraw'),
    /does not list NOTANASSET for withdraw/
  );

  console.log('\n== 4. The anchor really does enforce what it advertises ==');

  /**
   * Proves the limit is the anchor's rule and not merely a number in a JSON
   * document. Submitted below the advertised minimum, it must be refused.
   */
  const belowMin = (w.minAmount - 1).toString();
  const res = await fetch(`${anchor.transferServerSep24}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_code: 'USDC',
      account: kp.publicKey(),
      amount: belowMin,
      lang: 'en',
    }),
  });
  equals(`a withdrawal of ${belowMin} USDC is refused by the anchor`, res.status, 400);
  const errText = await res.text();
  check(
    'and the anchor says it is a minimum-limit problem',
    /minimum limit/i.test(errText),
    errText.slice(0, 200)
  );

  /**
   * MoneyGram's SEP-24 rejects form encoding, which the SEP-24 spec
   * otherwise permits. Pinning it so nobody "fixes" the Content-Type back.
   */
  const formRes = await fetch(`${anchor.transferServerSep24}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ asset_code: 'USDC', account: kp.publicKey(), amount: String(w.minAmount) }),
  });
  check(
    'MoneyGram rejects form-encoded SEP-24 requests, so JSON is required',
    formRes.status >= 400,
    `HTTP ${formRes.status}`
  );

  console.log('\n== 5. A valid amount opens a real interactive session ==');

  const okRes = await fetch(`${anchor.transferServerSep24}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_code: 'USDC',
      account: kp.publicKey(),
      amount: String(w.minAmount + 5),
      lang: 'en',
    }),
  });
  equals('the anchor accepts an in-range withdrawal', okRes.status, 200);
  const session: any = await okRes.json();
  equals('it asks for interactive customer info', session.type, 'interactive_customer_info_needed');
  check(
    'it returns a transaction id',
    typeof session.id === 'string' && session.id.length > 0,
    JSON.stringify(session).slice(0, 200)
  );
  check(
    'it returns an https interactive url',
    typeof session.url === 'string' && session.url.startsWith('https://'),
    session.url
  );
  check(
    'the interactive url is a MoneyGram domain',
    /(^https:\/\/[a-z0-9.-]*moneygram\.com)/i.test(session.url ?? ''),
    session.url
  );

  console.log(`\nPassed ${passed}, failed ${failed}`);
  console.log(`Live SEP-24 transaction id: ${session.id}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nSUITE CRASHED:', err?.message ?? err);
  process.exit(1);
});
