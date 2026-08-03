/**
 * PROVE THE SETTLEMENT PATH AGAINST REAL BREET, NOT A STUB.
 *
 * Every unit test above this uses a stubbed provider, and a stub agrees with
 * whatever I believed when I wrote it. That is exactly how the bug being fixed
 * here survived: verifyWebhook confirmed trades against /transactions/:id,
 * which 404s for a trade, and no test noticed because no test called Breet.
 *
 * Run: npm run breet:settlement-check
 */
import 'dotenv/config';
import { BreetNgnProvider } from '../src/ngn/provider/breet.provider.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${detail ? ` -> ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  const provider = new BreetNgnProvider() as any;

  console.log('\nlistSettlements() ASKS BREET WHAT IT ACTUALLY DID');
  const settlements = await provider.listSettlements();
  check('Breet answered', Array.isArray(settlements), `${settlements.length} settlement(s)`);
  for (const s of settlements) {
    console.log(`       addr=${s.depositAddress} trade=${s.tradeId} tradeStatus=${s.tradeStatus} withdrawal=${s.withdrawalStatus} ngn=${s.fiatAmount}`);
    check('  the settlement resolves to a deposit address', Boolean(s.depositAddress));
    check('  and carries both statuses', Boolean(s.tradeStatus && s.withdrawalStatus));
  }

  const tradeId = settlements[0]?.tradeId;
  if (!tradeId) {
    console.log('\nno trade on this account yet - skipping the confirmation check');
  } else {
    console.log('\nverifyWebhook() CONFIRMS A REAL TRADE INSTEAD OF CALLING IT FORGED');
    // The secret is whatever this environment has; set a known one so the
    // header check passes and the CONFIRMATION path is what is under test.
    process.env.BREET_WEBHOOK_SECRET = process.env.BREET_WEBHOOK_SECRET || 'x';
    const secret = process.env.BREET_WEBHOOK_SECRET;
    try {
      const event = await provider.verifyWebhook(
        { event: 'trade.completed', id: tradeId, status: 'completed' },
        { 'x-webhook-secret': secret }
      );
      const payload = event.payload as any;
      check('a genuine trade.completed is NOT rejected as forged', true);
      check('and it was confirmed against Breet', payload.breetConfirmed === true, String(payload.breetConfirmed));
      check('with Breet\'s own amount, not the callers', Number(payload.amount) > 0, String(payload.amount));
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (/secret/i.test(message)) {
        console.log(`  skip  BREET_WEBHOOK_SECRET here does not match the local value (${message})`);
      } else {
        check('a genuine trade.completed is NOT rejected as forged', false, message);
      }
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
