/**
 * GAS SPONSORSHIP LIMITS, THE CIRCUIT BREAKER, AND SPEND TRACKING.
 *
 * Privy required confirmation that Sivan would follow their security guidance
 * before enabling Solana gas sponsorship. This is the enforcement half.
 *
 * THE THING BEING DEFENDED, stated once so the numbers make sense:
 *
 *     transaction fee   ~$0.0008   negligible
 *     ATA rent          ~$0.31     400x the fee, first send to an address only
 *
 * So a user making 500 transfers to ONE address costs about $0.40. The same
 * user making 500 transfers to 500 NEW addresses costs about $150, and can
 * later close those accounts and keep the rent. Every assertion here exists to
 * make that distinction enforceable.
 *
 * Run: npm run test:gas-limits
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkGasLimits,
  tierForAge,
  sponsoredCostUsd,
  solanaTransactionCostUsd,
  ataRentCostUsd,
  DEFAULT_GAS_CONTROLS,
  DEFAULT_GAS_LIMIT_TIERS,
  SOLANA_ATA_RENT_SOL,
  type GasControls,
} from '../src/balances/gas-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const enforcing: GasControls = { ...DEFAULT_GAS_CONTROLS, warnOnly: false };

const base = {
  accountAgeHours: 24 * 30,
  transfersToday: 0,
  newRecipientsToday: 0,
  createsRecipientAccount: false,
  spendTodayUsd: 0,
  controls: enforcing,
};

console.log('\n── the two costs, and their ratio ────────────────────────────');

check('a Solana transaction costs about a tenth of a cent',
  Math.abs(solanaTransactionCostUsd(150) - 0.00075) < 1e-6,
  String(solanaTransactionCostUsd(150)));
check('an ATA costs about 31 cents',
  Math.abs(ataRentCostUsd(150) - 0.3059) < 0.001,
  String(ataRentCostUsd(150)));
check('the ATA is ~400x the transaction fee',
  ataRentCostUsd(150) / solanaTransactionCostUsd(150) > 350,
  'this ratio is why the limit counts recipients, not transfers');
check('the rent constant matches the on-chain value',
  SOLANA_ATA_RENT_SOL === 0.00203928);

check('an ordinary transfer is costed at the fee only',
  Math.abs(sponsoredCostUsd({ network: 'solana' }) - solanaTransactionCostUsd()) < 1e-9);
check('a new-recipient transfer is costed at fee + rent',
  Math.abs(sponsoredCostUsd({ network: 'solana', createsRecipientAccount: true })
    - (solanaTransactionCostUsd() + ataRentCostUsd())) < 1e-9);
check('an EVM transfer is not counted against the Solana budget',
  sponsoredCostUsd({ network: 'base', createsRecipientAccount: true }) === 0,
  'Base gas is paid in ETH and has no ATA; mixing them makes the budget meaningless');

console.log('\n── tiers graduate by account age ─────────────────────────────');

check('a brand-new account gets the tightest tier',
  tierForAge(1).newRecipientsPerDay === 3, String(tierForAge(1).newRecipientsPerDay));
check('a two-day-old account moves up', tierForAge(48).newRecipientsPerDay === 5);
check('an established account gets the loosest', tierForAge(24 * 30).newRecipientsPerDay === 10);
check('the boundary is inclusive', tierForAge(24).label === 'First week', tierForAge(24).label);

/**
 * The tiers are deliberately generous. Every user is new in week one, and a
 * launch where genuine early adopters hit a wall costs more than the gas it
 * saves.
 */
check('even the tightest tier allows a real first day',
  DEFAULT_GAS_LIMIT_TIERS[0].transfersPerDay >= 10
  && DEFAULT_GAS_LIMIT_TIERS[0].newRecipientsPerDay >= 3,
  JSON.stringify(DEFAULT_GAS_LIMIT_TIERS[0]));
check('worst-case cost at the top tier stays small',
  tierForAge(24 * 30).newRecipientsPerDay * ataRentCostUsd(150) < 5,
  `$${(tierForAge(24 * 30).newRecipientsPerDay * ataRentCostUsd(150)).toFixed(2)} per user per day`);

console.log('\n── the limit that matters: new recipients ────────────────────');

check('a normal transfer is allowed', checkGasLimits(base).allowed === true);

const atNewLimit = { ...base, newRecipientsToday: 10, createsRecipientAccount: true };
check('an 11th new recipient is refused', checkGasLimits(atNewLimit).allowed === false);
check('and the rule is named', checkGasLimits(atNewLimit).rule === 'new_recipients_per_day');
check('the reason says known addresses still work',
  /already paid still works/i.test(checkGasLimits(atNewLimit).reason ?? ''),
  checkGasLimits(atNewLimit).reason);
check('and it says when the limit resets',
  /resets|Try again in/i.test(checkGasLimits(atNewLimit).reason ?? ''),
  '"limit reached" with no reset time is a dead end for the user');

check('a transfer to a KNOWN address is unaffected by the new-recipient limit',
  checkGasLimits({ ...atNewLimit, createsRecipientAccount: false }).allowed === true,
  'the expensive kind is capped; the free kind is not');

console.log('\n── the transfer count is a backstop, not the control ─────────');

check('the 51st transfer is refused',
  checkGasLimits({ ...base, transfersToday: 50 }).allowed === false);
check('and the rule is named',
  checkGasLimits({ ...base, transfersToday: 50 }).rule === 'transfers_per_day');
check('the new-recipient rule is checked FIRST',
  checkGasLimits({ ...base, transfersToday: 50, newRecipientsToday: 10, createsRecipientAccount: true }).rule
    === 'new_recipients_per_day',
  'the specific, expensive reason is more useful than the generic one');

console.log('\n── the circuit breaker ───────────────────────────────────────');

const overBudget = { ...base, spendTodayUsd: 25, createsRecipientAccount: true };
check('a new-recipient transfer is refused over budget',
  checkGasLimits(overBudget).allowed === false);
check('and the rule is the budget', checkGasLimits(overBudget).rule === 'daily_budget');

/**
 * THE ASSERTION THAT KEEPS THE BREAKER FROM BEING AN OUTAGE.
 *
 * Ordinary transfers cost $0.0008 and are not what drained the budget.
 * Halting them would turn a spending problem into a product outage.
 */
check('ORDINARY transfers still flow when the breaker has tripped',
  checkGasLimits({ ...overBudget, createsRecipientAccount: false }).allowed === true,
  'stopping $0.0008 transfers because of a cost limit is an outage, not a control');
check('the message tells the user known addresses still work',
  /addresses you have paid before are unaffected/i.test(checkGasLimits(overBudget).reason ?? ''),
  checkGasLimits(overBudget).reason);
check('the breaker fires before the per-user rules',
  checkGasLimits({ ...overBudget, newRecipientsToday: 99 }).rule === 'daily_budget');

check('the default budget is $25, not the $50 first proposed',
  DEFAULT_GAS_CONTROLS.dailyBudgetUsd === 25,
  '100 users x 3 new recipients x $0.31 is ~$93/day, so $50 would trip on real traffic at ~50 users');

console.log('\n── warn-only mode: the intended launch state ─────────────────');

const warn: GasControls = { ...DEFAULT_GAS_CONTROLS, warnOnly: true };
const warned = checkGasLimits({ ...base, newRecipientsToday: 99, createsRecipientAccount: true, controls: warn });
check('warn mode ALLOWS the transfer', warned.allowed === true);
check('but still reports that it would have refused', warned.wouldRefuse === true,
  'a fortnight of warn-mode logs must say exactly what enforcement would have done');
check('and still names the rule', warned.rule === 'new_recipients_per_day');
check('warnOnly is the default', DEFAULT_GAS_CONTROLS.warnOnly === true,
  'these thresholds are guesses until real traffic exists');

check('disabling limits allows everything',
  checkGasLimits({ ...base, newRecipientsToday: 999, createsRecipientAccount: true,
    controls: { ...enforcing, limitsEnabled: false } }).allowed === true);
check('and reports no rule', checkGasLimits({ ...base, newRecipientsToday: 999,
  controls: { ...enforcing, limitsEnabled: false } }).rule === 'none');

console.log('\n── wired into the transfer path and the health endpoint ──────');

const service = read('src/balances/balance.service.ts');
check('the transfer path evaluates gas limits',
  /await evaluateGasLimits\(\{ userId, createsRecipientAccount \}\)/.test(service));
check('it checks BEFORE placing a hold',
  service.indexOf('evaluateGasLimits') < service.indexOf("kind: 'hold'"),
  'refusing after a hold would strand the funds behind a transfer that cannot happen');
check('a warned decision is audited even when allowed',
  /gas\.limit_warned/.test(service),
  'warn mode is worthless if nothing records what it saw');
check('a refusal is audited too', /gas\.limit_refused/.test(service));

const health = read('src/monitoring/operational-health.service.ts');
check('spend is a health signal', /name: 'gas_sponsorship_spend_24h'/.test(health));
check('it warns at half the budget and goes critical at full',
  /budgetUsed >= 0\.5 \? 'warn'/.test(health) && /breakerTripped \? 'critical'/.test(health));
check('the critical detail says ordinary transfers still work',
  /transfers to known addresses still work/i.test(health),
  '"gas budget exceeded" reads as a total outage and is not one');

console.log('\n── Privy is the source of truth for BILLED spend ─────────────');

const privy = read('src/wallets/provider/privy-wallet.provider.ts');
check('the gas_spend endpoint is read', /\/apps\/gas_spend\?/.test(privy));
check('wallet ids are batched to Privy\'s 100 limit',
  /index \+= 100/.test(privy), 'the API caps wallet_ids at 100');
check('it never throws', /catch \(error\) \{[\s\S]{0,200}return \{ ok: false/.test(privy),
  'a Privy outage must not take down the admin panel or health');
check('an unknown figure is reported as unknown, not zero',
  /ok: false, message:/.test(privy),
  'a silent 0 would read as "we have spent nothing"');

const routes = read('src/ngn/api/ngn.routes.ts');
// The estimate reaches the response via `...usage`, which carries
// spendTodayUsd - checking for that literal here matched nothing while the
// endpoint was correct all along.
check('the admin endpoint reports BOTH estimate and billed',
  /privy: billed/.test(routes) && /\.\.\.usage,/.test(routes),
  'they answer different questions and a drift between them is worth seeing');
check('only Solana wallets are sent to gas_spend',
  /wallet\.chain === 'solana'/.test(routes),
  'EVM ids would inflate the billed figure against a budget that never counted them');

console.log('\n── the usage counter is honest ───────────────────────────────');

const usage = read('src/balances/gas-usage.service.ts');
check('new recipients are counted as DISTINCT addresses',
  /new Set\([\s\S]{0,160}destinationAddress\)/.test(usage),
  'two sends to one new address create ONE account and cost one rent');
check('transfers are de-duplicated by id',
  /seen\.set\(transfer\.transferId/.test(usage),
  'a gateway-timeout retry is one attempt, not two');
check('an undateable account is treated as brand new',
  /: 0;/.test(usage) && /accountAgeHours/.test(usage),
  'defaulting to the loosest tier would make the tiers optional');
check('a failure to read usage does NOT block the transfer',
  /catch \{[\s\S]{0,120}allowed: true/.test(usage),
  'being unable to count is not evidence of abuse');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
