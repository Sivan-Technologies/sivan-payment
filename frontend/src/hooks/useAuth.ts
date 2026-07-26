import { useEffect } from 'react';

export function useSessionActivity(authToken: string, logout: (message?: string) => void) {
  useEffect(() => {
    if (!authToken) return;
    const timeoutMs = 30 * 60 * 1000;
    const updateActivity = () => localStorage.setItem('sivan.lastActivityAt', String(Date.now()));
    const checkActivity = () => {
      const last = Number(localStorage.getItem('sivan.lastActivityAt') || Date.now());
      if (Date.now() - last > timeoutMs) logout('Signed out after 30 minutes of inactivity.');
    };
    updateActivity();
    const events = ['click', 'keydown', 'mousemove', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, updateActivity, { passive: true }));
    const interval = window.setInterval(checkActivity, 60_000);
    return () => {
      events.forEach((event) => window.removeEventListener(event, updateActivity));
      window.clearInterval(interval);
    };
  }, [authToken, logout]);
}
