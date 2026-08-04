/**
 * SCAFFOLDING COMES DOWN WHEN THE BUILDING IS FINISHED.
 *
 * Reported with a screenshot: a fully set-up account - email confirmed, bank
 * verified, payout bank added, "100%" - and the Account setup card still
 * occupying the best real estate on the dashboard, four green ticks and a
 * progress bar pinned at full, forever.
 *
 * A checklist with nothing left on it is not information. Its primary button
 * ("Manage payment methods") duplicates a sidebar link, and everything it
 * reports is already shown elsewhere: the verification KPI has the level, the
 * account-status banner has the headroom.
 *
 * Two things have to be true, and the second is the one that makes this
 * safe rather than just tidy:
 *
 *   it DISAPPEARS at 100%
 *   it STAYS while any required step is outstanding
 *
 * Also covers the escrow -> Service Agreement rename in the user frontend,
 * because both changes touch the same screens and a rename that misses a
 * string is invisible until a customer reads it.
 *
 * Run: npm run test:dashboard-setup-card
 */

import fs from 'node:fs/promises';
import path from 'node:path';

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
 * The percentage rule from App.tsx, mirrored.
 *
 * WhatsApp is deliberately NOT a term. It is optional, and counting it would
 * mean the card could never reach 100% for the many users who never link it -
 * which is exactly why the screenshot shows 100% with WhatsApp unlinked.
 */
function setupPercent(input: { hasUser: boolean; isVerified: boolean; hasBank: boolean }): number {
  return Math.round(
    ([input.hasUser, input.isVerified, input.hasBank].filter(Boolean).length / 3) * 100
  );
}

const cardShows = (input: { hasUser: boolean; isVerified: boolean; hasBank: boolean }) =>
  setupPercent(input) < 100;

async function main() {
  console.log('\nTHE CARD LEAVES WHEN THERE IS NOTHING LEFT TO DO');
  {
    const done = { hasUser: true, isVerified: true, hasBank: true };
    check('a fully set-up account reads 100%', setupPercent(done) === 100, String(setupPercent(done)));
    check('and the card is gone', cardShows(done) === false);
  }

  console.log('\nBUT IT STAYS WHILE ANY REQUIRED STEP IS OUTSTANDING');
  {
    /**
     * The dangerous direction. Hiding the card from someone who still has
     * work to do removes the only thing telling them what is missing, and
     * they would sit unable to transact with no explanation.
     */
    check('not verified, no bank - card shows',
      cardShows({ hasUser: true, isVerified: false, hasBank: false }) === true);
    check('verified but no payout bank - card shows',
      cardShows({ hasUser: true, isVerified: true, hasBank: false }) === true);
    check('bank added but not verified - card shows',
      cardShows({ hasUser: true, isVerified: false, hasBank: true }) === true);
    check('signed out entirely - card shows',
      cardShows({ hasUser: false, isVerified: false, hasBank: false }) === true);

    // 2 of 3 rounds to 67, not 100 - a rounding slip here would hide the card
    // from someone one step short.
    check('two of three steps is 67%, not 100',
      setupPercent({ hasUser: true, isVerified: true, hasBank: false }) === 67,
      String(setupPercent({ hasUser: true, isVerified: true, hasBank: false })));
    check('and the card still shows at 67%',
      cardShows({ hasUser: true, isVerified: true, hasBank: false }) === true);
  }

  console.log('\nWHATSAPP IS OPTIONAL AND MUST NOT BLOCK 100%');
  {
    /**
     * The screenshot shows 100% with WhatsApp UNLINKED, which is correct -
     * it is outside the maths. If it were ever counted, the card would become
     * permanent for every user who does not use WhatsApp, which is the
     * opposite of the fix.
     */
    const source = await fs.readFile(path.join(process.cwd(), 'frontend/src/App.tsx'), 'utf8');
    const formula = source.match(/const setupPercent = ([^;]+);/)?.[1] ?? '';
    check('the formula counts exactly three required steps',
      /\[hasUser, isVerified, hasBank\]/.test(formula) && /\/ 3\)/.test(formula), formula);
    check('and does not count WhatsApp', !/whatsapp/i.test(formula), formula);
  }

  console.log('\nTHE GATE IS WIRED TO THE SAME NUMBER THE CARD DISPLAYS');
  {
    /**
     * Gating on anything OTHER than setupPercent would let the two disagree -
     * a card that hides while still showing outstanding work, or one that
     * lingers at 100%. Tying both to one value makes that impossible.
     */
    const source = await fs.readFile(path.join(process.cwd(), 'frontend/src/App.tsx'), 'utf8');
    check('the dashboard gates the panel on setupPercent',
      /\{setupPercent < 100 && \(\s*\n\s*<DashboardSetupPanel/.test(source),
      'the setup panel is not gated');
    check('and the panel is still passed that same percentage',
      /<DashboardSetupPanel setupPercent=\{setupPercent\}/.test(source));
  }

  console.log('\nNOTHING THE CARD REPORTED IS LOST');
  {
    /**
     * Removing a surface is only safe if what it said is still reachable.
     * The level and the headroom both live in the account-status notice, and
     * Payment methods is a permanent sidebar entry.
     */
    const sections = await fs.readFile(
      path.join(process.cwd(), 'frontend/src/components/AppSections.tsx'), 'utf8'
    );
    check('the account-status notice still reports the level',
      /<h3>\{summary\.levelLabel\}<\/h3>/.test(sections));
    check('and the remaining headroom',
      /You can sell up to/.test(sections));

    const app = await fs.readFile(path.join(process.cwd(), 'frontend/src/App.tsx'), 'utf8');
    check('payment methods remains reachable from the sidebar',
      /Payment methods/.test(app));
  }

  console.log('\nREMOVING THE CARD MUST NOT LEAVE A HOLE');
  {
    /**
     * Caught in a browser screenshot immediately after the card was hidden.
     *
     * The side column held only the 2FA prompt, against a transactions panel
     * with min-height:500px, and the grid stretched it - so the fix traded a
     * redundant card for a large dead rectangle, which is not an improvement.
     *
     * Two CSS rules close it: the column starts at the top instead of
     * stretching, and the transactions floor drops when there is nothing to
     * list. Measured after: transactions 500 -> 387px, side column no longer
     * padded to match.
     */
    const css = await fs.readFile(path.join(process.cwd(), 'frontend/src/styles.css'), 'utf8');
    check('the side column does not stretch to fill',
      /\.dashboard-side-stack \{ align-content: start; \}/.test(css));
    check('and an empty transactions panel drops its min-height',
      /:has\(\.dashboard-empty\) \.dashboard-transactions \{ min-height: 0; \}/.test(css));
  }

  console.log('\nESCROW IS NOW "SERVICE AGREEMENT" IN EVERYTHING A USER READS');
  {
    const files = [
      'frontend/src/App.tsx',
      'frontend/src/components/settings/SettingsSection.tsx',
      'frontend/src/components/dashboard/DashboardSections.tsx',
      'frontend/src/components/AppSections.tsx',
    ];

    /**
     * Scanned as PROSE, not as a blanket ban on the substring.
     *
     * `escrowUserId` and `flow: 'escrow'` are wire-format identifiers shared
     * with the escrow-agent API and the limits table - renaming them would
     * break the contract for a cosmetic gain, so they stay and must not be
     * flagged. What matters is text a customer can read.
     */
    for (const file of files) {
      const source = await fs.readFile(path.join(process.cwd(), file), 'utf8');
      const prose = [
        ...source.matchAll(/>([^<>{}]*[Ee]scrow[^<>{}]*)</g),
        ...source.matchAll(/'([^']*[Ee]scrow[^']*)'/g),
        ...source.matchAll(/"([^"]*[Ee]scrow[^"]*)"/g),
      ]
        .map((match) => match[1])
        // Identifiers, not sentences: no spaces, or camelCase.
        .filter((text) => /\s/.test(text) && !/^[a-z]+[A-Z]/.test(text.trim()));

      check(`${path.basename(file)} shows no "escrow" prose`,
        prose.length === 0, prose.slice(0, 2).join(' | '));
    }

    const settings = await fs.readFile(
      path.join(process.cwd(), 'frontend/src/components/settings/SettingsSection.tsx'), 'utf8'
    );
    check('the identity card says Service Agreement',
      /Linked WhatsApp \/ Service Agreement account/.test(settings));
    check('the connect button says Service Agreements',
      /Connect WhatsApp Service Agreements/.test(settings));

    const dash = await fs.readFile(
      path.join(process.cwd(), 'frontend/src/components/dashboard/DashboardSections.tsx'), 'utf8'
    );
    check('the setup line says service agreements',
      /Optional for service agreements and alerts/.test(dash));

    const app = await fs.readFile(path.join(process.cwd(), 'frontend/src/App.tsx'), 'utf8');
    check('the unlink confirmation says Service Agreement',
      /WhatsApp \/ Service Agreement identity/.test(app));

    /**
     * AND THE WIRE FORMAT IS UNTOUCHED. A rename that changed these would
     * silently break identity linking and the limits table, which is a far
     * worse outcome than the wording it fixed.
     */
    const types = await fs.readFile(path.join(process.cwd(), 'frontend/src/types.ts'), 'utf8');
    check('escrowUserId is still escrowUserId', /escrowUserId\?: string;/.test(types));
    check("and flow still accepts 'escrow'", /flow: 'escrow' \| 'offramp' \| 'onramp';/.test(types));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
