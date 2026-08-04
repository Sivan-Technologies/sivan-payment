/**
 * THE HANDOFF TO BRIDGE'S HOSTED VERIFICATION PAGE.
 *
 * Reported: "the start verification is not opening the bridge verification
 * page". Measured against api-test, POST /api/customers/kyc-link answers in
 * 12.055825 seconds. For all of it the user had a blank about:blank tab in
 * front of them and a button reading "Opening…". That is indistinguishable
 * from a dead button, and the natural response is to close the tab or press
 * again - which starts a SECOND Bridge session.
 *
 * Underneath the slow call sat a second, harder defect: the popup-blocker
 * fallback was `window.open(url)` called AFTER the await. That is the exact
 * call browsers refuse - the user gesture is spent by then - so a blocked
 * popup produced the message "Verification opened in a new tab" and no tab at
 * all. The user was told a lie and given nothing to click.
 *
 * These tests cover the rules, the copy, and the wiring:
 *
 *   HANDOFF   what happens to the tab, in every ending
 *   SAFETY    what we are willing to navigate a tab to
 *   COPY      that we never claim a tab opened when one did not
 *   WIRING    that App.tsx and the modal actually use all of it
 *
 * Run: npm run test:kyc-handoff
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDOFF_SLOW_SECONDS,
  closeHandoffTab,
  deliverHandoff,
  handoffDocumentHtml,
  handoffMessage,
  isSafeHandoffUrl,
  paintHandoffTab,
  type HandoffWindow,
} from '../frontend/src/kycHandoff.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** A window stub that records what was done to it. */
function fakeWindow(overrides: Partial<HandoffWindow> = {}) {
  const written: string[] = [];
  const assigned: string[] = [];
  let closedFlag = false;
  const win: HandoffWindow & { written: string[]; assigned: string[] } = {
    get closed() { return closedFlag; },
    opener: {},
    location: { assign: (url: string) => { assigned.push(url); } },
    document: {
      open: () => {},
      write: (html: string) => { written.push(html); },
      close: () => {},
    },
    close: () => { closedFlag = true; },
    written,
    assigned,
    ...overrides,
  } as HandoffWindow & { written: string[]; assigned: string[] };
  return win;
}

const BRIDGE_URL = 'https://bridge.withpersona.com/verify?inquiry-template-id=itmpl_abc&fields[developer-id]=xyz';

function main() {
  console.log('\nTHE HOLDING PAGE — the tab must not sit blank for twelve seconds\n');
  {
    const html = handoffDocumentHtml();
    check('it says what is happening, in words', /Opening secure verification/i.test(html));
    check('it tells the user how long, honestly',
      html.includes(String(HANDOFF_SLOW_SECONDS)) && /seconds/i.test(html), `slow=${HANDOFF_SLOW_SECONDS}`);
    check('and tells them not to close the tab', /keep this tab open/i.test(html));
    /**
     * The tab is on about:blank and is replaced within seconds. Anything it
     * had to FETCH would still be in flight when it is navigated away, so the
     * holding page would render unstyled - which is how it looked broken in
     * the first place.
     */
    check('nothing is fetched: no external stylesheet',
      !/<link[^>]+rel=["']?stylesheet/i.test(html));
    check('nothing is fetched: no script tag', !/<script/i.test(html));
    check('nothing is fetched: no remote src or url()',
      !/https?:\/\//i.test(html.replace(/lang="en"/g, '')));
    check('it is dark, matching the app it was opened from', html.includes('#07090d'));

    const win = fakeWindow();
    check('painting returns true and writes the document', paintHandoffTab(win) === true && win.written.length === 1);
    check('and what it wrote is the holding page', win.written[0] === html);
  }

  console.log('\n  …and painting must never take the verification start down with it\n');
  {
    check('a null window is simply not painted', paintHandoffTab(null) === false);
    check('an already-closed window is not painted',
      paintHandoffTab(fakeWindow({ closed: true })) === false);
    /**
     * Accessing .document on a cross-origin or torn-down window throws in
     * several browsers. Losing the whole handoff over a cosmetic message
     * would be a worse bug than the blank tab we are fixing.
     */
    const hostile = {
      closed: false,
      location: { assign: () => {} },
      get document(): never { throw new Error('cross-origin'); },
    } as unknown as HandoffWindow;
    let threw = false;
    let result: boolean | undefined;
    try { result = paintHandoffTab(hostile); } catch { threw = true; }
    check('a window that throws on .document does not throw out of paint', !threw);
    check('and reports honestly that it did not paint', result === false);
    check('a window with no document.write is handled',
      paintHandoffTab({ closed: false, location: { assign: () => {} }, document: {} }) === false);
  }

  console.log('\nWHAT WE ARE WILLING TO NAVIGATE A TAB TO\n');
  {
    check('an https Bridge link is fine', isSafeHandoffUrl(BRIDGE_URL) === true);
    /**
     * kycLink is server-supplied, but it still ends up in location.assign, and
     * a javascript: value there executes in a tab we opened with our origin as
     * opener. Checked by shape rather than trusted by provenance.
     */
    check('javascript: is refused', isSafeHandoffUrl('javascript:alert(document.cookie)') === false);
    check('data: is refused', isSafeHandoffUrl('data:text/html,<script>1</script>') === false);
    check('plain http is refused — this carries an identity session',
      isSafeHandoffUrl('http://bridge.withpersona.com/verify') === false);
    check('empty is refused', isSafeHandoffUrl('') === false);
    check('null is refused', isSafeHandoffUrl(null) === false);
    check('garbage is refused, not thrown on', isSafeHandoffUrl('not a url at all') === false);
  }

  console.log('\nDELIVERY — every ending, and no lying about any of them\n');
  {
    const win = fakeWindow();
    const outcome = deliverHandoff(win, BRIDGE_URL);
    check('the happy path navigates the tab we already had', outcome.status === 'opened', outcome.status);
    check('to exactly the URL we were given', win.assigned[0] === BRIDGE_URL);
    /**
     * The hosted identity flow must not hold a handle back into the app that
     * opened it.
     */
    check('with opener severed before navigating', win.opener === null);
  }
  {
    /**
     * THE BUG. A blocked popup gives null, and the old code answered by
     * calling window.open again after the await - the one call browsers
     * refuse. The rule now: nothing is ever opened programmatically here.
     */
    const outcome = deliverHandoff(null, BRIDGE_URL);
    check('a blocked popup is reported as manual, not as opened', outcome.status === 'manual', outcome.status);
    check('and hands back the URL so the UI can render a real link',
      outcome.status === 'manual' && outcome.url === BRIDGE_URL);
  }
  {
    const outcome = deliverHandoff(fakeWindow({ closed: true }), BRIDGE_URL);
    check('a tab the user already closed is manual too', outcome.status === 'manual', outcome.status);
  }
  {
    const hostile = fakeWindow({ location: { assign: () => { throw new Error('blocked'); } } });
    const outcome = deliverHandoff(hostile, BRIDGE_URL);
    check('a navigation that throws degrades to manual, not to a crash', outcome.status === 'manual', outcome.status);
  }
  {
    const win = fakeWindow();
    const outcome = deliverHandoff(win, undefined);
    check('no link back from the server is its own outcome', outcome.status === 'no-link', outcome.status);
    check('and nothing was navigated', win.assigned.length === 0);
  }
  {
    const win = fakeWindow();
    const outcome = deliverHandoff(win, 'javascript:alert(1)');
    check('an unsafe URL never reaches location.assign',
      outcome.status === 'no-link' && win.assigned.length === 0, outcome.status);
  }

  console.log('\nTHE MESSAGES — a blocked tab must not be reported as an opened one\n');
  {
    const opened = handoffMessage({ status: 'opened' });
    check('success says the tab opened', /new tab/i.test(opened.message) && opened.tone === 'success');

    const manual = handoffMessage({ status: 'manual', url: BRIDGE_URL });
    check('blocked says BLOCKED', /blocked/i.test(manual.message), manual.message);
    check('blocked never claims a tab opened',
      !/opened in a new tab/i.test(manual.message), manual.message);
    check('blocked is not toned as success', manual.tone === 'error');
    check('and points at the thing to press', /open verification/i.test(manual.message), manual.message);

    const none = handoffMessage({ status: 'no-link' });
    check('no-link is honest that no link came back', /no secure link/i.test(none.message), none.message);
    check('and is an error', none.tone === 'error');
  }

  console.log('\nCLOSING AN ABANDONED TAB — no orphan blank tabs left behind\n');
  {
    const win = fakeWindow();
    closeHandoffTab(win);
    check('a live holding tab gets closed', win.closed === true);
    let threw = false;
    try {
      closeHandoffTab(null);
      closeHandoffTab(fakeWindow({ closed: true }));
      closeHandoffTab({ closed: false, location: { assign: () => {} } });
      closeHandoffTab({ closed: false, location: { assign: () => {} }, close: () => { throw new Error('nope'); } });
    } catch { threw = true; }
    check('and every unclosable case is survived quietly', !threw);
  }

  console.log('\nWIRING — App.tsx must actually use this, on BOTH paths\n');
  {
    const app = read('frontend/src/App.tsx');

    check('the handoff module is imported', /from '\.\/kycHandoff'/.test(app));
    /**
     * THE REGRESSION GUARD. If either path ever calls window.open again after
     * the await, the blocked-popup bug is back verbatim.
     */
    const opensAfterAwait = /await api<CustomerRecord>[\s\S]{0,1400}?window\.open\(/.test(app);
    check('neither path calls window.open after the await', !opensAfterAwait);
    check('the pre-flight open still happens before it',
      /window\.open\('', '_blank'\)/.test(app));

    const bridgeFn = app.slice(app.indexOf('const startBridgeVerification'), app.indexOf('const handleCountryChange'));
    check('the modal path paints the tab immediately', /paintHandoffTab\(verificationWindow\)/.test(bridgeFn));
    check('the modal path delivers through deliverHandoff', /deliverHandoff\(verificationWindow/.test(bridgeFn));
    check('the modal path raises its own starting flag', /setStartingBridge\(true\)/.test(bridgeFn));
    check('and lowers it in finally', /finally \{[\s\S]{0,120}setStartingBridge\(false\)/.test(bridgeFn));
    /**
     * A twelve-second call with no re-entry guard means two Bridge sessions
     * and two tabs from an impatient double-click.
     */
    check('a second click during the twelve seconds is refused',
      /if \(startingBridge\) return;/.test(bridgeFn));
    check('a blocked popup keeps the modal OPEN so the link is reachable',
      /outcome\.status === 'manual'[\s\S]{0,240}setManualKycUrl\(outcome\.url\)/.test(bridgeFn));
    const manualBlock = bridgeFn.slice(bridgeFn.indexOf("outcome.status === 'manual'"), bridgeFn.indexOf('} catch'));
    check('and does not close it out from under them',
      !/setVerificationOpen\(false\)/.test(manualBlock.slice(0, manualBlock.indexOf('} else'))));

    const formFn = app.slice(app.indexOf('async function handleKyc'), app.indexOf('async function refreshKyc'));
    check('the verification-page form path paints too', /paintHandoffTab\(verificationWindow\)/.test(formFn));
    check('the form path delivers through deliverHandoff', /deliverHandoff\(verificationWindow/.test(formFn));
    check('the form path no longer hand-rolls innerHTML into the tab',
      !/verificationWindow\.document\.body\.innerHTML/.test(app));

    check('the manual URL is cleared when the modal closes',
      /onClose=\{\(\) => \{[^}]*setManualKycUrl\(undefined\)/.test(app));
    check('and it is passed down to the modal', /manualKycUrl=\{manualKycUrl\}/.test(app));
    check('as is the starting flag', /startingBridge=\{startingBridge\}/.test(app));
  }

  console.log('\nWIRING — the modal must SHOW it\n');
  {
    const modal = read('frontend/src/components/verification/VerificationModal.tsx');
    check('BridgeVerification takes the starting flag', /starting: boolean;/.test(modal));
    check('and the manual URL', /manualUrl\?: string;/.test(modal));
    check('both are handed to it', /starting=\{Boolean\(startingBridge\)\} manualUrl=\{manualKycUrl\}/.test(modal));

    const bridge = modal.slice(modal.indexOf('function BridgeVerification'));
    check('progress copy exists for the wait', /Opening secure verification…/.test(bridge));
    check('with a spinner, not just text', /sv-spinner/.test(bridge));
    /**
     * The user is about to wait twelve seconds. Saying so beforehand is the
     * difference between "slow" and "broken".
     *
     * Scoped to the IDLE branch specifically. The first version of this check
     * was decorative: it searched the whole component, and the in-progress
     * copy also says "up to 15 seconds" and sits ABOVE the button in source
     * order - so deleting the pre-click sentence entirely still passed. Caught
     * by mutating exactly that.
     */
    const idleBranch = bridge.slice(bridge.lastIndexOf(') : ('), bridge.indexOf('Start verification'));
    check('the wait is disclosed BEFORE the click too',
      /up to 15 seconds/.test(idleBranch), 'pre-click copy missing');
    check('and it is announced to screen readers', /aria-live="polite"/.test(bridge));

    /**
     * THE POINT OF THE MANUAL BRANCH: an anchor. A <button> that called
     * window.open would be the blocked call all over again.
     */
    check('the blocked case renders a real anchor', /<a[\s\S]{0,200}href=\{manualUrl\}/.test(bridge));
    check('opening in a new tab', /href=\{manualUrl\}[\s\S]{0,120}target="_blank"/.test(bridge));
    check('with the opener severed', /href=\{manualUrl\}[\s\S]{0,160}rel="noopener noreferrer"/.test(bridge));
    check('and it is styled as the primary action, not a bare link',
      /className="sv-primary sv-primary-link"/.test(bridge));
    check('the blocked case is flagged to assistive tech', /role="alert"/.test(bridge));
    /**
     * The old button said "Opening…" for twelve seconds while nothing on the
     * screen changed. The label is no longer the progress indicator.
     */
    check('the button no longer doubles as the progress indicator',
      !/loading \? 'Opening…'/.test(bridge));

    const css = read('frontend/src/styles.css');
    check('.sv-handoff is actually styled', /^\.sv-handoff \{/m.test(css));
    check('.sv-handoff-blocked reads as a warning, not as progress',
      /^\.sv-handoff-blocked \{[^}]*245, 158, 11/m.test(css));
    /**
     * .sv-primary is written for <button>, which is inline-block with its own
     * box. An <a> wearing that class collapses without this.
     */
    check('.sv-primary-link gives the anchor a button box',
      /^\.sv-primary-link \{[^}]*display: block/m.test(css));
    check('and centres its label', /^\.sv-primary-link \{[^}]*text-align: center/m.test(css));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
