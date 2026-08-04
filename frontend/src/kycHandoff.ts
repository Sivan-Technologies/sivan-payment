/**
 * THE HANDOFF TO BRIDGE'S HOSTED VERIFICATION.
 *
 * Reported as "start verification is not opening the bridge verification
 * page". Measured, it does open it - eventually. `POST /api/customers/kyc-link`
 * took 12.055825 seconds against api-test. For those twelve seconds the user
 * stared at a blank `about:blank` tab with nothing in it and a button that
 * said "Opening…", which is indistinguishable from broken. Most people close
 * the tab or click again.
 *
 * Two real defects behind that:
 *
 *   1. THE BLANK TAB SAID NOTHING. handleKyc painted a holding message into
 *      it; startBridgeVerification - the modal path, the one the user is
 *      actually on - did not. Same twelve seconds, zero feedback.
 *
 *   2. THE POPUP FALLBACK CANNOT WORK. When the pre-flight
 *      `window.open('', '_blank')` is blocked it returns null, and the old
 *      code's answer was to call `window.open(url)` again AFTER the await.
 *      That is precisely the call browsers refuse: it is no longer
 *      attributable to a user gesture. So a blocked popup produced
 *      "Verification opened in a new tab" and no tab.
 *
 * The rule this module encodes: a window is only ever navigated inside the
 * gesture-opened tab, and every other outcome hands back a URL for the UI to
 * render as something the user can CLICK - a second, real gesture. We never
 * pretend a tab opened.
 *
 * Pure and DOM-free apart from the narrow structural types below, so the rules
 * are testable without a browser. See scripts/test-kyc-handoff.ts.
 */

/** How long the link call is honestly allowed to take, in the copy and in the tab. */
export const HANDOFF_SLOW_SECONDS = 15;

/** The minimum a Window has to offer for us to hand a user to it. */
export interface HandoffWindow {
  closed?: boolean;
  opener?: unknown;
  location: { assign: (url: string) => void };
  document?: {
    open?: () => void;
    write?: (html: string) => void;
    close?: () => void;
  };
  close?: () => void;
}

/**
 * The holding page painted into the tab the instant it opens.
 *
 * Self-contained: no stylesheet, no script, no network. The tab is on
 * about:blank and will be navigated away within seconds; anything it had to
 * fetch would still be in flight when it is replaced.
 */
export function handoffDocumentHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Opening Sivan verification</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07090d;color:#eef3f7;font-family:Inter,system-ui,-apple-system,sans-serif;padding:32px;text-align:center">
<div style="max-width:360px">
  <div style="width:34px;height:34px;margin:0 auto 20px;border-radius:50%;border:3px solid rgba(52,211,153,0.25);border-top-color:#34d399;animation:sv-spin 900ms linear infinite"></div>
  <h1 style="font-size:17px;font-weight:600;margin:0 0 8px">Opening secure verification…</h1>
  <p style="font-size:13.5px;line-height:1.55;color:#8b98a6;margin:0">Setting up your session with our verification partner. This can take up to ${HANDOFF_SLOW_SECONDS} seconds. Please keep this tab open.</p>
</div>
<style>@keyframes sv-spin{to{transform:rotate(360deg)}}</style>
</body></html>`;
}

/**
 * Paint the holding page. Returns whether it actually landed.
 *
 * Never throws: a cross-origin or already-closed tab makes `document` throw on
 * access in some browsers, and losing the whole verification start over a
 * cosmetic message would be a worse bug than the blank tab.
 */
export function paintHandoffTab(win: HandoffWindow | null | undefined): boolean {
  if (!win || win.closed) return false;
  try {
    const doc = win.document;
    if (!doc?.write) return false;
    doc.open?.();
    doc.write(handoffDocumentHtml());
    doc.close?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Only ever hand a user to an https URL we were given by our own API.
 *
 * `kycLink` is server-supplied, but it is still a value that ends up in
 * `location.assign`. `javascript:` and `data:` there would execute in the tab
 * we opened, so the shape is checked rather than assumed.
 */
export function isSafeHandoffUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export type HandoffOutcome =
  /** The tab we opened on the click is now on Bridge. Nothing more to do. */
  | { status: 'opened' }
  /** We have a URL but no usable tab. The UI MUST render it as a link. */
  | { status: 'manual'; url: string }
  /** No link came back at all. */
  | { status: 'no-link' };

/**
 * Deliver the verification URL into the tab opened by the click, or say so.
 *
 * The one thing this deliberately does NOT do is call `window.open`. By the
 * time we are here an await has happened, the gesture is spent, and a second
 * open is the call that gets blocked. Anything other than "the tab we already
 * have is alive" is reported as `manual` so a human can click.
 */
export function deliverHandoff(win: HandoffWindow | null | undefined, url: string | null | undefined): HandoffOutcome {
  if (!isSafeHandoffUrl(url)) return { status: 'no-link' };
  const safeUrl = url as string;
  if (!win || win.closed) return { status: 'manual', url: safeUrl };
  try {
    // Severed before navigating: the hosted flow must not be able to reach
    // back into the app that opened it.
    win.opener = null;
    win.location.assign(safeUrl);
    return { status: 'opened' };
  } catch {
    return { status: 'manual', url: safeUrl };
  }
}

/** Close a holding tab we are about to abandon, so no orphan blank tab is left. */
export function closeHandoffTab(win: HandoffWindow | null | undefined): void {
  if (!win || win.closed) return;
  try { win.close?.(); } catch { /* already gone */ }
}

/**
 * What to tell the user, keyed to what actually happened.
 *
 * `manual` is not an error and must not be dressed as success either - the
 * user has one more thing to do and has to be told what.
 */
export function handoffMessage(outcome: HandoffOutcome): { message: string; tone: 'success' | 'error' } {
  switch (outcome.status) {
    case 'opened':
      return { message: 'Verification opened in a new tab. Come back here when you finish.', tone: 'success' };
    case 'manual':
      return { message: 'Your browser blocked the verification tab. Use the “Open verification” button below.', tone: 'error' };
    case 'no-link':
      return { message: 'Verification started, but no secure link came back. Try again, or contact support.', tone: 'error' };
  }
}
