import { useEffect, useRef } from 'react';

/**
 * How long a user may be IDLE before the session ends, in milliseconds.
 *
 * Raised from 30 to 60 minutes to match the server's token lifetime. The two
 * were different numbers for the same thing, so the client could sign a user
 * out at 30 minutes while their token was still valid for another 30 - and the
 * message told them it was inactivity when the token had not expired at all.
 *
 * One hour idle is the ceiling for a payments product. Longer means a session
 * left open on a shared or public machine stays usable for most of a working
 * day, and the balance and withdrawal screens are behind it.
 */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Renew the token when fewer than this many ms of its life remain. */
const REFRESH_WHEN_REMAINING_MS = 10 * 60 * 1000;

/** Read the exp claim without a JWT library. Returns 0 if unreadable. */
function tokenExpiryMs(token: string): number {
  try {
    const part = token.split('.')[1];
    if (!part) return 0;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
    return typeof claims?.exp === 'number' ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Keep an ACTIVE session alive, and end an IDLE one.
 *
 * Before this the session was a hard wall: the server stamped a 60-minute
 * token, nothing renewed it, and the user was signed out exactly an hour after
 * logging in regardless of what they were doing. Mid-withdrawal included.
 *
 * Now the hour is measured from LAST ACTIVITY rather than from login. While
 * the user is doing things the token is renewed shortly before it lapses, so
 * they are not interrupted; once they stop, the idle clock runs out and the
 * session ends as it should.
 *
 * The refresh call is what proves the session is still good server-side, so a
 * token revoked or invalidated upstream still ends the session promptly rather
 * than waiting for the next unrelated request to 401.
 */
export function useSessionActivity(
  authToken: string,
  logout: (message?: string) => void,
  onTokenRefreshed?: (token: string) => void,
  refresh?: () => Promise<string | null>
) {
  // Held in a ref so a changing callback identity does not tear down and
  // rebuild the listeners on every render.
  const refreshRef = useRef(refresh);
  const onRefreshedRef = useRef(onTokenRefreshed);
  refreshRef.current = refresh;
  onRefreshedRef.current = onTokenRefreshed;

  useEffect(() => {
    if (!authToken) return;
    let renewing = false;

    const updateActivity = () => localStorage.setItem('sivan.lastActivityAt', String(Date.now()));

    const tick = async () => {
      const last = Number(localStorage.getItem('sivan.lastActivityAt') || Date.now());
      const idleFor = Date.now() - last;

      if (idleFor > IDLE_TIMEOUT_MS) {
        logout('Signed out after an hour of inactivity.');
        return;
      }

      // Only an ACTIVE session is renewed. Renewing an idle one would defeat
      // the idle timeout entirely by keeping a forgotten tab logged in for as
      // long as the browser stayed open.
      const expiresAt = tokenExpiryMs(authToken);
      if (!expiresAt) return;
      const remaining = expiresAt - Date.now();
      if (remaining > REFRESH_WHEN_REMAINING_MS) return;
      if (renewing || !refreshRef.current) return;

      renewing = true;
      try {
        const next = await refreshRef.current();
        if (next) onRefreshedRef.current?.(next);
      } finally {
        renewing = false;
      }
    };

    updateActivity();
    const events = ['click', 'keydown', 'mousemove', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, updateActivity, { passive: true }));
    // Every 60s. The refresh window is ten minutes wide, so a minute of
    // granularity has plenty of room to act before the token lapses.
    const interval = window.setInterval(() => void tick(), 60_000);
    void tick();
    return () => {
      events.forEach((event) => window.removeEventListener(event, updateActivity));
      window.clearInterval(interval);
    };
  }, [authToken, logout]);
}
