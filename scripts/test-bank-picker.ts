/**
 * THE BANK PICKER, AGAINST THE REAL 169-BANK DIRECTORY.
 *
 * Reported from a phone: the sell screen opens on a wall of banks -
 *
 *   Abbey Mortgage Bank
 *   Access Bank
 *   ASO Savings and Loans
 *   Bowen Microfinance Bank
 *   Carbon
 *   CEMCS Microfinance Bank
 *   ...
 *
 * That is the provider's list, alphabetical, all 169 of them. Verified live
 * against Breet: OPay is #26, PalmPay #27, Zenith #43. So the first thing
 * every Nigerian user sees is a bank almost none of them hold, and nothing on
 * screen suggests that typing narrows it.
 *
 * Two separate defects, and the fix has to hold both:
 *
 *   ORDER    what you see before you type
 *   RANKING  what you see after you type
 *
 * Fixtures are the REAL bank names pulled from Breet's live directory, not
 * invented ones - a picker that ranks make-believe banks correctly proves
 * nothing about the list users actually face.
 *
 * Run: npm run test:bank-picker
 */

import { filterBanks, orderBanksForDisplay, popularBankCount } from '../frontend/src/ngnBank.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

/**
 * A faithful slice of Breet's live NGN directory, in the order it arrives.
 *
 * Includes the awkward real cases deliberately: ASTRAPOLARIS (contains
 * "polaris"), Paystack-Titan (contains "titan"), ACCESS Yello (contains
 * "access"), and the four "First ..." banks that all match "first".
 */
const BANKS = [
  'Abbey Mortgage Bank', 'Access Bank', 'ACCESS Yello & Beta', 'ASO Savings and Loans',
  'ASTRAPOLARIS MFB', 'Bankly Microfinance Bank', 'Bowen Microfinance Bank', 'Carbon',
  'CEMCS Microfinance Bank', 'Citibank Nigeria', 'Coronation Merchant Bank',
  'Ecobank Nigeria', 'Ekondo Microfinance Bank', 'Eyowo', 'Fidelity Bank',
  'FIRST ALLY MICROFINANCE BANK', 'First Bank of Nigeria', 'First City Monument Bank',
  'First Generation Mortgage Bank', 'GLOBUS BANK', 'Guaranty Trust Bank', 'Jaiz Bank',
  'Keystone Bank', 'KongaPay', 'Kuda Bank', 'LOTUS BANK', 'Moniepoint MFB',
  'OPay - Paycom', 'OPTIMUS BANK', 'PalmPay', 'PayAttitude Online', 'Paystack-Titan',
  'Polaris Bank', 'Providus Bank', 'Stanbic IBTC Bank', 'Stanbic IBTC @ease wallet',
  'Sterling Bank', 'TITAN TRUST BANK', 'Union Bank of Nigeria', 'United Bank For Africa',
  'Wema Bank', 'Zenith Bank', 'ZENITH EASY WALLET',
].map((name, index) => ({ id: String(index + 1), name, slug: name.toLowerCase().replace(/\s+/g, '-') }));

const names = (list: Array<{ name: string }>) => list.map((bank) => bank.name);
const positionOf = (list: Array<{ name: string }>, name: string) =>
  list.findIndex((bank) => bank.name === name);

function main() {
  console.log('\nWHAT YOU SEE BEFORE YOU TYPE');
  {
    const ordered = orderBanksForDisplay(BANKS);

    check('nothing is lost from the directory',
      ordered.length === BANKS.length, `${ordered.length} vs ${BANKS.length}`);

    /**
     * THE ACTUAL COMPLAINT. The first screen must be banks people hold.
     */
    const firstEight = names(ordered).slice(0, 8);
    console.log(`       first 8: ${firstEight.join(', ')}`);

    check('OPay is first', firstEight[0] === 'OPay - Paycom', firstEight[0]);
    check('PalmPay is second', firstEight[1] === 'PalmPay', firstEight[1]);
    check('and Abbey Mortgage Bank is NOT on the first screen',
      !firstEight.includes('Abbey Mortgage Bank'), firstEight.join(', '));
    check('nor ASO Savings and Loans',
      !firstEight.includes('ASO Savings and Loans'));
    check('nor any microfinance bank',
      !firstEight.some((name) => /microfinance|mortgage/i.test(name)), firstEight.join(', '));

    for (const expected of ['Guaranty Trust Bank', 'Access Bank', 'Zenith Bank', 'Kuda Bank', 'Moniepoint MFB']) {
      check(`${expected} is near the top`,
        positionOf(ordered, expected) < 12, String(positionOf(ordered, expected) + 1));
    }

    /**
     * AND EVERYTHING ELSE IS STILL THERE, ALPHABETICALLY.
     *
     * A shortlist that DROPS banks would strand anyone holding a microfinance
     * account. Deferring is fine; hiding is not.
     */
    const tail = names(ordered).slice(popularBankCount(BANKS));
    check('the rest of the directory follows', tail.length > 0);
    check('and it is alphabetical',
      tail.every((name, i) => i === 0 || tail[i - 1].localeCompare(name) <= 0),
      tail.slice(0, 4).join(', '));
    check('every bank is still reachable',
      BANKS.every((bank) => positionOf(ordered, bank.name) >= 0));
  }

  console.log('\nWHAT YOU SEE AFTER YOU TYPE');
  {
    /**
     * Abbreviations first: Nigerians say GTB and UBA, never the full names.
     */
    check('"gtb" finds Guaranty Trust Bank',
      names(filterBanks(BANKS, 'gtb'))[0] === 'Guaranty Trust Bank',
      names(filterBanks(BANKS, 'gtb'))[0]);
    check('"uba" finds United Bank For Africa',
      names(filterBanks(BANKS, 'uba'))[0] === 'United Bank For Africa',
      names(filterBanks(BANKS, 'uba'))[0]);
    check('"gt" still finds it, mid-abbreviation',
      names(filterBanks(BANKS, 'gt'))[0] === 'Guaranty Trust Bank');

    /**
     * THE RANKING BUGS, FOUND BY RUNNING THE OLD FILTER OVER THE REAL LIST.
     *
     * A plain substring filter returns PROVIDER ORDER, which put the wrong
     * bank first in three real cases.
     */
    const titan = names(filterBanks(BANKS, 'titan'));
    check('"titan" puts TITAN TRUST BANK before Paystack-Titan',
      titan[0] === 'TITAN TRUST BANK', titan.join(' | '));

    const polaris = names(filterBanks(BANKS, 'polaris'));
    check('"polaris" puts Polaris Bank before ASTRAPOLARIS MFB',
      polaris[0] === 'Polaris Bank', polaris.join(' | '));

    /**
     * THE WORD-BOUNDARY TIER, ISOLATED.
     *
     * The two cases above are settled EARLIER, by the startsWith tier - so
     * deleting the word-boundary rule left the whole suite green. Mutation
     * caught it. This pair is decided by that rule and nothing else: neither
     * name starts with the term and neither bank is on the shortlist, so the
     * only thing separating them is that one matches at a word boundary and
     * the other has it buried inside ASTRAPOLARIS.
     */
    const boundary = names(filterBanks(
      [{ id: 'a', name: 'ASTRAPOLARIS MFB' }, { id: 'b', name: 'Zenith Polaris Trust' }] as any,
      'polaris'
    ));
    check('a word-boundary match outranks one buried inside a word',
      boundary[0] === 'Zenith Polaris Trust', boundary.join(' | '));

    /**
     * "pay" is the case where popularity must beat match position: nobody on a
     * Nigerian payments app means PayAttitude Online before OPay.
     */
    const pay = names(filterBanks(BANKS, 'pay'));
    check('"pay" puts OPay first', pay[0] === 'OPay - Paycom', pay.join(' | '));
    check('and PalmPay second', pay[1] === 'PalmPay', pay.join(' | '));
    check('with PayAttitude behind them',
      pay.indexOf('PayAttitude Online') > 1, pay.join(' | '));

    const zenith = names(filterBanks(BANKS, 'zenith'));
    check('"zenith" puts Zenith Bank before ZENITH EASY WALLET',
      zenith[0] === 'Zenith Bank', zenith.join(' | '));

    const access = names(filterBanks(BANKS, 'access'));
    check('"access" puts Access Bank before ACCESS Yello',
      access[0] === 'Access Bank', access.join(' | '));

    const first = names(filterBanks(BANKS, 'first'));
    check('"first" puts First Bank of Nigeria first',
      first[0] === 'First Bank of Nigeria', first.slice(0, 3).join(' | '));

    check('a query matching nothing returns nothing',
      filterBanks(BANKS, 'zzzzz').length === 0);
    check('and case does not matter',
      names(filterBanks(BANKS, 'OPAY'))[0] === 'OPay - Paycom');
    check('nor surrounding spaces',
      names(filterBanks(BANKS, '  opay  '))[0] === 'OPay - Paycom');
  }

  console.log('\nSEARCHING NEVER HIDES A MATCH');
  {
    /**
     * The picker caps the IDLE list, not the results. A user who typed
     * something specific wants all of it - and the widest real query is small.
     */
    const bankQuery = filterBanks(BANKS, 'bank');
    check('"bank" returns every bank whose name contains it',
      bankQuery.length === BANKS.filter((b) => /bank/i.test(b.name)).length,
      `${bankQuery.length}`);
    check('and a popular one leads',
      ['Kuda Bank', 'Guaranty Trust Bank', 'Access Bank', 'Zenith Bank'].includes(names(bankQuery)[0]),
      names(bankQuery)[0]);

    // Every bank must be findable by typing its own name, or the picker is
    // unusable for whoever holds it.
    const unfindable = BANKS.filter((bank) => {
      const results = filterBanks(BANKS, bank.name);
      return results[0]?.name !== bank.name;
    });
    check('every bank is findable by its exact name',
      unfindable.length === 0, unfindable.map((b) => b.name).slice(0, 4).join(', '));
  }

  console.log('\nEDGE CASES THAT WOULD CRASH A PICKER');
  {
    check('an empty directory does not throw',
      orderBanksForDisplay([]).length === 0 && filterBanks([], 'gtb').length === 0);
    check('a bank with no slug is handled',
      filterBanks([{ id: '1', name: 'Kuda Bank' } as any], 'kuda').length === 1);
    /**
     * A REGEX-SPECIAL QUERY MUST NOT CRASH THE PICKER.
     *
     * The term is interpolated into a RegExp for the word-boundary tier, so an
     * unescaped "(" throws "Invalid regular expression: Unterminated group" -
     * confirmed by constructing one directly. That would take the whole sell
     * screen down as the user typed.
     *
     * "a+b(c" alone does NOT prove it: no bank contains those letters, so
     * every candidate is rejected by the earlier `includes` check and the
     * regex is never built. Mutation caught that - removing the escaping left
     * the suite green. These queries DO reach it, because real Breet bank
     * names contain "@", "&" and "-".
     */
    const special = [
      { id: '1', name: 'Stanbic IBTC @ease wallet' },
      { id: '2', name: 'ACCESS Yello & Beta' },
      { id: '3', name: 'OPay - Paycom' },
    ] as any;

    for (const query of ['@ease', '&', '-', '- pay', 'a+b(c', '(', '[', '*']) {
      let threw = '';
      try {
        filterBanks(special, query);
      } catch (error) {
        threw = String((error as Error).message);
      }
      check(`a query of ${JSON.stringify(query)} does not throw`, !threw, threw);
    }

    check('and a special-char query still matches the right bank',
      names(filterBanks(special, '@ease'))[0] === 'Stanbic IBTC @ease wallet');
    check('while a term in no bank returns nothing',
      filterBanks(BANKS, 'a+b(c').length === 0);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
