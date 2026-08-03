import { useEffect, useRef } from 'react';

/**
 * How long a user may sit completely idle before being signed out.
 *
 * Raised from 30 minutes to 8 hours, and it now means something different.
 *
 * Before, this was 30 minutes of idle on top of a token that hard-expired
 * after 60 minutes whatever you were doing - so an active user was thrown out
 * mid-session at the hour mark regardless. With the sliding refresh below, an
 * ACTIVE session no longer ends at all; this is purely the "walked away"
 * timer. Eight hours is a working day: come back from lunch and you are still
 * signed in, leave it overnight and you are not.
 */
const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/**
 * How often to renew the token while the user is active.
 *
 * The token lives 60 minutes (USER_JWT_EXPIRES_MINUTES). Renewing every 15
 * leaves three chances to succeed before it lapses, which matters because
 * api-live sleeps on Render's free tier and a cold start can fail the first
 * attempt outright.
 */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const ACTIVITY_KEY = 'sivan.lastActivityAt';

/**
 * KEEP AN ACTIVE SESSION ALIVE; ONLY END AN IDLE ONE.
 *
 * The reported problem was being signed out "every few minutes". The token was
 * never the cause - measured against the deployed API, iat to exp is exactly
 * 3600 seconds. Two other things were:
 *
 *   1. api-live sleeps (Render free plan). A cold start answers 503, and a
 *      proxied call took 34 seconds to fail with UPSTREAM_UNAVAILABLE. Any
 *      401-shaped response in that window signed the user out of a session
 *      that was perfectly valid.
 *   2. Even a flawless 60 minutes ended abruptly, mid-task, with "Session
 *      expired" and whatever was on screen lost.
 *
 * So the session is now SLIDING: while the tab is being used the token is
 * renewed in the background and the user never sees an expiry. This is safer
 * than simply making USER_JWT_EXPIRES_MINUTES enormous - a long-lived token
 * cannot be cut short if it leaks, whereas a short one that is only refreshed
 * while in use stops being refreshed the moment the tab is closed.
 */
export function useSessionActivity(
  authToken: string,
  logout: (message?: string) => void,
  onTokenRefreshed?: (token: string) => void
) {
  // Held in a ref so changing the callback identity does not tear down and
  // restart the timers - which, with a callback defined inline in a component,
  // would otherwise happen on every render and reset the refresh clock so it
  // never actually fired.
  const refreshedRef = useRef(onTokenRefreshed);
  refreshedRef.current = onTokenRefreshed;

  const tokenRef = useRef(authToken);
  tokenRef.current = authToken;

  useEffect(() => {
    if (!authToken) return;

    const updateActivity = () => localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
    const idleFor = () => Date.now() - Number(localStorage.getItem(ACTIVITY_KEY) || Date.now());

    const checkActivity = () => {
      if (idleFor() > IDLE_TIMEOUT_MS) logout('Signed out after 8 hours of inactivity.');
    };

    const refresh = async () => {
      // Pointless while the user is away: it would keep a walked-away session
      // alive forever, which is the opposite of what the idle timer is for.
      if (idleFor() > IDLE_TIMEOUT_MS) return;
      if (document.visibilityState === 'hidden') return;

      try {
        const base = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
        const response = await fetch(`${base}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenRef.current}` },
        });
        // A FAILED REFRESH IS NOT A LOGOUT.
        //
        // This is the exact bug being fixed: a sleeping backend answers 503 or
        // times out, and treating that as "your session ended" is what threw
        // people out. The existing token is still valid, so leave it alone and
        // try again on the next tick.
        if (!response.ok) return;
        const body = await response.json().catch(() => null);
        const next = body?.data?.token;
        if (typeof next === 'string' && next.length > 0) refreshedRef.current?.(next);
      } catch {
        // Network blip. Same reasoning: keep the session, retry later.
      }
    };

    updateActivity();
    const events = ['click', 'keydown', 'mousemove', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, updateActivity, { passive: true }));

    const idleInterval = window.setInterval(checkActivity, 60_000);
    const refreshInterval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

    // Refresh on return to the tab too. A laptop that slept through the
    // interval wakes with a token that may be minutes from expiry, and waiting
    // up to another 15 minutes to notice is how the session dies anyway.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      updateActivity();
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      events.forEach((event) => window.removeEventListener(event, updateActivity));
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(idleInterval);
      window.clearInterval(refreshInterval);
    };
  }, [authToken, logout]);
}
