/**
 * WHICH ACCOUNT NOTICE THE DASHBOARD SHOWS.
 *
 * Reported with a screenshot. A Nigerian at Level 1 - bank verified, payout
 * bank added, account setup 100% - opened their dashboard to:
 *
 *   VERIFICATION STATUS
 *   Verification needs one more step
 *   Please complete your date of birth and age confirmation...
 *   [Continue verification]  [Contact support]
 *
 * With, two inches to the right, a KPI reading "Bank verified · Level 1 ·
 * Ready". One screen, two opposite claims about the same account.
 *
 * THE CAUSE was `customer ? <Bridge/> : <Summary/>`. The mere EXISTENCE of a
 * Bridge customer row decided the banner, regardless of what the user had
 * actually completed. A row is created the moment anyone taps "Verify with ID
 * instead" - or by any earlier experiment - so from then on the dashboard
 * described Bridge's opinion of a check the user never needed.
 *
 * This is the same class of defect as the /verification page fixes: a
 * Bridge-only field driving a screen for a user on the Nigerian path. Fixed
 * there, missed here, because nothing tested the dashboard's choice.
 *
 * Tests the DECISION, not the pixels - it is a pure predicate over the two
 * inputs, and the exhaustive table is worth more than a browser could give.
 *
 * Run: npm run test:dashboard-notice
 */

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
 * The rule from App.tsx, mirrored.
 *
 * A mirror is a liability - it can drift from the real thing - so the source
 * is asserted against this at the end of the run. That check is what keeps the
 * two honest.
 */
function bridgeNeedsAttention(input: {
  hasCustomer: boolean;
  kycStatus?: string;
  pathComplete?: boolean;
}): boolean {
  const kycUnderReview = input.kycStatus === 'kyc_under_review';
  const kycFailed = ['kyc_rejected', 'failed', 'cancelled'].includes(input.kycStatus ?? '');
  return Boolean(
    input.hasCustomer
    && !input.pathComplete
    && (kycUnderReview || kycFailed || input.kycStatus === 'kyc_incomplete')
  );
}

async function main() {
  console.log('\nTHE REPORTED BUG');
  {
    /**
     * The exact state in the screenshot: Level 1 on the Nigerian path, with a
     * Bridge row left at kyc_incomplete from a document check they started
     * and abandoned. They have everything Sivan asks of them.
     */
    check('a Level 1 Nigerian with an abandoned Bridge attempt is NOT nagged',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_incomplete', pathComplete: true }) === false);

    check('nor one whose Bridge attempt failed',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_rejected', pathComplete: true }) === false);

    check('nor one with a Bridge check under review',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_under_review', pathComplete: true }) === false);

    /**
     * THE ROW'S EXISTENCE IS NOT NEWS.
     *
     * kyc_not_started is the DEFAULT state of a freshly created customer -
     * confirmed live: POST /api/customers/kyc-link returns kycStatus
     * "kyc_not_started". Under the old condition that alone was enough to
     * show the Bridge card, which is the whole bug.
     */
    check('a bare customer row with nothing started shows nothing',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_not_started', pathComplete: false }) === false);
    check('even for a user who has not finished their own path',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_not_started', pathComplete: false }) === false);
    check('and a customer with no status at all shows nothing',
      bridgeNeedsAttention({ hasCustomer: true, pathComplete: false }) === false);
  }

  console.log('\nBUT A REAL BRIDGE PROBLEM IS STILL SURFACED');
  {
    /**
     * The other half. Suppressing too much would be the opposite bug: a user
     * mid-Bridge-check with nothing else done must be told, or their
     * verification stalls silently and they never find out why they cannot
     * transact.
     */
    check('an incomplete Bridge check on an unfinished path IS shown',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_incomplete', pathComplete: false }) === true);
    check('so is one under review',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_under_review', pathComplete: false }) === true);
    check('so is a rejection',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_rejected', pathComplete: false }) === true);
    check('and a cancelled check',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'cancelled', pathComplete: false }) === true);
    check('and a bare "failed"',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'failed', pathComplete: false }) === true);
  }

  console.log('\nAND A USER WITH NO BRIDGE RELATIONSHIP NEVER SEES IT');
  {
    check('no customer row, nothing verified',
      bridgeNeedsAttention({ hasCustomer: false, pathComplete: false }) === false);
    check('no customer row, path complete',
      bridgeNeedsAttention({ hasCustomer: false, pathComplete: true }) === false);
    // Defensive: a status without a row cannot happen, but the predicate must
    // not depend on that being true.
    check('a status with no row is still nothing',
      bridgeNeedsAttention({ hasCustomer: false, kycStatus: 'kyc_incomplete', pathComplete: false }) === false);
  }

  console.log('\nAPPROVED BRIDGE USERS ARE NOT NAGGED EITHER');
  {
    /**
     * kyc_approved is a finished state. It is deliberately NOT in the list -
     * the summary's own "verified" card is the right thing to show someone
     * who is done, on either path.
     */
    check('an approved Bridge user gets the summary card',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_approved', pathComplete: true }) === false);
    check('and still does before the summary catches up',
      bridgeNeedsAttention({ hasCustomer: true, kycStatus: 'kyc_approved', pathComplete: false }) === false);
  }

  console.log('\nTHE MIRROR MATCHES THE SOURCE');
  {
    /**
     * Everything above tests a COPY of the rule. That is only worth anything
     * if the copy still matches App.tsx, so the real condition is read off
     * disk and compared. Without this the suite could pass forever against a
     * rule the product no longer uses.
     */
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(path.join(process.cwd(), 'frontend/src/App.tsx'), 'utf8');

    check('App.tsx defines the predicate',
      /const bridgeNeedsAttention = Boolean\(/.test(source));
    check('it requires a customer row',
      /bridgeNeedsAttention = Boolean\(\s*\n\s*customer/.test(source));
    check('it defers to a completed path',
      /!verificationSummary\?\.pathComplete/.test(source));
    /**
     * PINNED EXACTLY, not merely "contains".
     *
     * A loose match passed when kyc_not_started was ADDED to the list -
     * mutation-proven - because the original three were still present in the
     * string. That mutation is the original bug in a different shape: a bare
     * customer row would once again decide the banner. The whole condition is
     * captured and compared, so widening it fails here.
     */
    const condition = source.match(/&& \((kyc[^)]*)\)\s*\n\s*\);/)?.[1]?.replace(/\s+/g, ' ').trim();
    check('the actionable list is exactly the three states',
      condition === "kycUnderReview || kycFailed || kycStatus === 'kyc_incomplete'",
      String(condition));

    // The old condition must be gone, or both could coexist.
    check('the old existence-only condition is gone',
      !/\{customer \? <KycOutcomeNotice/.test(source),
      'the dashboard still branches on the mere existence of a customer');

    check('the dashboard renders the summary card otherwise',
      /: <DashboardAccountNotice summary=\{verificationSummary\}/.test(source));
  }

  console.log('\nTHE VERIFIED CARD POINTS AT THE NEXT LEVEL');
  {
    /**
     * A ceiling with no stated route past it reads as the end of the road.
     * The dashboard is where someone notices they are near their limit.
     */
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const sections = await fs.readFile(
      path.join(process.cwd(), 'frontend/src/components/AppSections.tsx'), 'utf8'
    );

    check('the dashboard notice renders summary.nextStep',
      /const next = summary\.nextStep;/.test(sections));
    check('and only when the server says one exists',
      /\{next && summary\.hasPayoutAccount &&/.test(sections));
    check('it distinguishes available from coming soon',
      /next\.available \?/.test(sections) && /Higher limits are coming/.test(sections));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
