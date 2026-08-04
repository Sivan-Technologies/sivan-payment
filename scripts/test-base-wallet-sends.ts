/**
 * THE REPORTED BUG, REPRODUCED AND THEN PROVEN FIXED, AGAINST A RUNNING SERVER.
 *
 * The static test (test:wallet-chain-family) proves the family rule and that
 * no money path matches a wallet by literal chain string. It cannot prove the
 * user's actual complaint: "I sent 10 USDC, well under the threshold, and it
 * came back held."
 *
 * This one boots the app, provisions a wallet stored as chain:'base' - which
 * is what every wallet.created event on api-test actually reads - funds it,
 * and sends. Before the fix executeBalanceTransfer looked up 'ethereum',
 * found nothing, and returned pending_review with "No ethereum wallet -
 * balance is in pooled custody". After it, the transfer must reach the
 * provider.
 *
 * The distinction that matters and that the static test cannot see:
 *
 *   pending_review  = a human must look. Correct for a >= threshold send, and
 *                     correct for a user with genuinely no wallet.
 *   processing      = it went to the provider.
 *
 * A 10 USDC send under a 1,000 threshold from a funded wallet must be the
 * second. If it is the first, the user's money is stuck exactly as reported.
 *
 * Run: npm run test:base-wallet-sends
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';
import { getWalletProvider } from '../src/wallets/provider/provider-registry.js';
import { nowIso } from '../src/shared/id.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let token = '';
  async function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    return { status: res.status, body: json, data: json.data ?? json };
  }

  try {
    const email = `base-wallet-${Date.now()}@sivan.test`;
    const started = await req('POST', '/api/auth/email/start', { email, fullName: 'Base Wallet User', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' } });
    const verified = await req('POST', '/api/auth/email/verify', { email, code: started.data.devCode });
    token = verified.data.token;
    const userId = verified.data.user.id;
    check('a user exists', Boolean(userId));

    await req('PUT', '/api/admin/balance/controls', {
      transfersEnabled: true, minimumSendAmount: 5, manualReviewThreshold: 1000,
      riskHoldsEnabled: true, supportedNetworks: ['base', 'solana', 'ethereum'],
      updatedBy: 'test', reason: 'Prove a base-filed wallet can send',
    }, { 'x-admin-api-key': 'base-wallet-admin-key' });

    /**
     * THE WHOLE POINT: the row is filed as 'base'.
     *
     * Not a contrivance - both wallet.created events on the live api-test
     * service read {"chain":"base"}, and the user in the screenshot is one of
     * them. Written directly rather than through ensureUserWallet so the test
     * states the precondition it is about instead of depending on whichever
     * chain the provisioning path happens to pick today.
     */
    const provider = getWalletProvider('mock') as any;
    const providerWallet = await provider.createWallet({ userId, chain: 'base', idempotencyKey: `base-wallet-${userId}` });
    await db.insertUserWallet({
      id: `uw_${userId}`,
      userId,
      provider: 'mock',
      providerWalletId: providerWallet.providerWalletId,
      chain: 'base',
      address: providerWallet.address,
      status: 'active',
      custodial: false,
      delegatedSigningEnabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } as any);

    const stored = await db.listUserWallets(userId);
    check("the stored wallet is filed as chain:'base'", stored[0]?.chain === 'base', stored[0]?.chain);
    check('there is no ethereum row at all', !stored.some((w) => w.chain === 'ethereum'),
      'the old code looked for exactly this and rightly found nothing');

    /**
     * The literal lookup the old code used. Kept as an assertion rather than
     * deleted, because it documents WHY the bug happened: findUserWallet is
     * not broken, it was simply the wrong question.
     */
    const literalLookup = await db.findUserWallet(userId, 'ethereum' as any);
    check('the OLD literal lookup still finds nothing (this was the bug)', literalLookup === undefined);

    const familyLookup = await db.findUserWalletForNetwork(userId, 'ethereum');
    check('the family lookup finds the base wallet for an ethereum send', familyLookup?.chain === 'base', String(familyLookup?.chain));
    const baseLookup = await db.findUserWalletForNetwork(userId, 'base');
    check('the family lookup finds it for a base send too', baseLookup?.chain === 'base');
    const solanaLookup = await db.findUserWalletForNetwork(userId, 'solana');
    check('the family lookup does NOT hand a base wallet to a solana send', solanaLookup === undefined,
      'signing ed25519 with a secp256k1 key would be a different, worse bug');

    /**
     * Fund it on BASE specifically. getSpendable reads the chain, so an unfunded
     * wallet refuses for a legitimate reason and would hide the bug behind a
     * correct-looking rejection.
     */
    await provider.__seedBalance(providerWallet.providerWalletId, { asset: 'usdc', chain: 'base', amount: '108' });

    const unified = await req('GET', `/api/users/${userId}/balance/unified`);
    const usdc = unified.data.balances.find((b: any) => b.asset === 'usdc');
    check('the unified balance sees the 108 USDC on Base', Number(usdc?.chain) === 108, JSON.stringify(usdc));
    check('spendable matches, nothing is held yet', Number(usdc?.spendable) === 108, String(usdc?.spendable));

    /** The exact send from the screenshot: 10 USDC to Base. */
    const send = await req('POST', `/api/users/${userId}/balance/transfers`, {
      asset: 'usdc', network: 'base', amount: 10,
      destinationAddress: '0x6d7D2Eb4667395437739634D3382A90Fff238295',
    });
    check('the send is accepted', send.status === 200, JSON.stringify(send.body).slice(0, 200));
    check('it is NOT stuck in pending_review', send.data.status !== 'pending_review',
      'this is the reported bug: 10 USDC under a 1,000 threshold came back held');
    check('it reached the provider', send.data.status === 'processing', String(send.data.status));
    check('a provider transfer id came back', Boolean(send.data.providerTransferId), JSON.stringify(send.data).slice(0, 200));

    /**
     * And the operator branch must NOT have fired. Checking the status alone
     * would miss a future change that reports 'processing' while still logging
     * a handoff nobody actions.
     */
    const logs = await db.read();
    const operatorLogs = (logs.auditLogs ?? []).filter((l) => l.action === 'balance.transfer_requires_operator');
    check('no "requires operator" handoff was logged', operatorLogs.length === 0,
      JSON.stringify(operatorLogs.map((l) => (l.metadata as any)?.reason)));
    const submitted = (logs.auditLogs ?? []).filter((l) => l.action === 'balance.transfer_submitted');
    check('a transfer_submitted audit log exists', submitted.length === 1);

    /** The hold must have become a debit, not lingered. */
    const ledger = await req('GET', `/api/users/${userId}/balance/ledger`);
    const kinds = (ledger.data as any[]).map((e) => e.kind);
    check('the ledger records a hold', kinds.includes('hold'));
    check('and the hold became a debit_transfer, not a stranded hold', kinds.includes('debit_transfer'), kinds.join(','));

    /**
     * ABOVE THE THRESHOLD MUST STILL BE REVIEWED.
     *
     * Without this the "fix" could simply be "never review anything", which
     * would pass every assertion above and remove the control the threshold
     * exists to provide.
     */
    await req('PUT', '/api/admin/balance/controls', {
      transfersEnabled: true, minimumSendAmount: 5, manualReviewThreshold: 50,
      riskHoldsEnabled: true, supportedNetworks: ['base', 'solana', 'ethereum'],
      updatedBy: 'test', reason: 'Lower the threshold to prove review still applies',
    }, { 'x-admin-api-key': 'base-wallet-admin-key' });

    // 60 of the 98 that remain - affordable, so a refusal here can only be the
    // review rule and not an insufficient-balance rejection wearing its coat.
    const big = await req('POST', `/api/users/${userId}/balance/transfers`, {
      asset: 'usdc', network: 'base', amount: 60,
      destinationAddress: '0x6d7D2Eb4667395437739634D3382A90Fff238295',
    });
    check('a send OVER the review threshold is still held for review', big.data.status === 'pending_review', JSON.stringify(big.body).slice(0, 200));

    await app.close();
  } catch (error) {
    await app.close();
    console.error(error);
    fail += 1;
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
