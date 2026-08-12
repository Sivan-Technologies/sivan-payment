import { useEffect, useRef } from 'react';
import { buildApiUrl } from '../appUtils';

/**
 * How long a session may sit untouched before it is ended.
 *
 * Separate from the token's own lifetime on purpose. The token is a security
 * boundary - short, renewable, and stolen-token exposure is capped by it. This
 * is a UX boundary: how long an unattended browser stays signed in.
 */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * How often to renew the token while the user is actually here.
 *
 * Must be comfortably under USER_JWT_EXPIRES_MINUTES (60) so a renewal always
 * happens with a valid token in hand - /api/auth/session/refresh deliberately
 * refuses an already-expired one, because renewing a dead token would make
 * expiry meaningless.
 */
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;

/**
 * KEEP AN ACTIVE SESSION ALIVE; END AN ABANDONED ONE.
 *
 * The user's complaint was being signed out constantly. The cause was not the
 * idle timer - it was that the JWT had a HARD 60-minute expiry and the service
 * had no refresh endpoint at all. Every session, active or not, died at the
 * hour mark on whatever screen the user was on, and the first sign of it was a
 * click that failed. Losing a half-filled form to "Session expired" feels far
 * more frequent than once an hour.
 *
 * Two independent mechanisms now, which is the point:
 *
 *   - While you are USING Sivan, the token silently renews every 20 minutes,
 *     so the session never interrupts you.
 *   - If you WALK AWAY, the idle timer still signs you out after 60 minutes.
 *
 * Deliberately not solved by issuing a longer token. A 12-hour JWT would fix
 * the same complaint by making a stolen token valid for 12 hours; a sliding
 * 60-minute window does not.
 */
export function useSessionActivity(
  authToken: string,
  logout: (message?: string) => void,
  // Passed in rather than read from localStorage. A first draft looked up a
  // 'sivan.apiBase' key that nothing in the app has ever written, so every
  // refresh would have posted to a relative path on the frontend origin and
  // silently 404'd - a refresh mechanism that never refreshed, and no error to
  // show for it.
  apiBase = '',
  onTokenRefreshed?: (token: string) => void
) {
  // Held in a ref so changing the callback identity does not tear down and
  // restart the timers - which would reset the idle clock on every render and
  // silently disable the timeout.
  const refreshedRef = useRef(onTokenRefreshed);
  refreshedRef.current = onTokenRefreshed;

  useEffect(() => {
    if (!authToken) return;

    const updateActivity = () => localStorage.setItem('sivan.lastActivityAt', String(Date.now()));
    const lastActivity = () => Number(localStorage.getItem('sivan.lastActivityAt') || Date.now());

    const checkActivity = () => {
      if (Date.now() - lastActivity() > IDLE_TIMEOUT_MS) {
        logout('Signed out after 60 minutes of inactivity.');
      }
    };

    /**
     * Renew, but only for someone who is still here.
     *
     * Guarded on recent activity so a tab left open overnight does not renew
     * itself indefinitely - that would turn the idle timeout into a fiction,
     * since the token would still be alive every time the check ran.
     */
    const refreshToken = async () => {
      if (Date.now() - lastActivity() > IDLE_TIMEOUT_MS) return;
      if (document.visibilityState === 'hidden') return;
      try {
        const response = await fetch(buildApiUrl(apiBase, '/api/auth/session/refresh'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!response.ok) return;
        const json = await response.json().catch(() => null);
        const next = json?.data?.token;
        // Never log the user out on a failed refresh. A flaky network must not
        // end a session that is otherwise perfectly valid - the token still
        // has 40 minutes on it, and the next attempt can succeed.
        if (typeof next === 'string' && next) refreshedRef.current?.(next);
      } catch {
        /* keep the existing token; see above */
      }
    };

    updateActivity();
    const events = ['click', 'keydown', 'mousemove', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, updateActivity, { passive: true }));
    const idleInterval = window.setInterval(checkActivity, 60_000);
    const refreshInterval = window.setInterval(refreshToken, REFRESH_INTERVAL_MS);

    /**
     * ALSO RENEW ON RETURN TO THE TAB.
     *
     * setInterval does not run reliably in a backgrounded tab, and does not
     * run at all while a laptop is asleep. Without this, a machine that slept
     * through the 20-minute tick wakes holding a token that may be minutes
     * from expiring, and waits up to another 20 minutes before trying - by
     * which time it has expired and the user is signed out. Which is exactly
     * the "logged out again" experience being fixed.
     */
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      updateActivity();
      void refreshToken();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      events.forEach((event) => window.removeEventListener(event, updateActivity));
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(idleInterval);
      window.clearInterval(refreshInterval);
    };
  }, [apiBase, authToken, logout]);
}
