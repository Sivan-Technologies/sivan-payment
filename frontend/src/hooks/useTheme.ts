import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'sivan.theme';

/**
 * Sivan is a LIGHT product. Light is the brand, so it is the default for a
 * visitor who has never expressed a preference.
 *
 * This used to be 'system', which meant anyone whose laptop was set to dark
 * -- most people, at night -- got the dark theme on first load and never saw
 * the brand as designed. Dark is now strictly opt-in via the topbar switch;
 * once chosen it is remembered and still follows the OS if the user
 * explicitly picks "system".
 */
const DEFAULT_PREFERENCE: ThemePreference = 'light';

/**
 * Read the stored preference.
 *
 * Anything unrecognised (a stale value, a hand-edited key, a half-written
 * string from a killed tab) resolves to 'system' rather than throwing, because
 * a broken preference must never stop the app from rendering.
 */
export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Private mode / disabled storage. Fall through to the default.
  }
  return DEFAULT_PREFERENCE;
}

export function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref;
}

/**
 * Paint the theme onto <html>.
 *
 * Exported and called from the pre-hydration inline script too, so the
 * attribute is set before first paint. Doing it only in an effect gives every
 * dark-mode user a white flash on load.
 *
 * `color-scheme` is set alongside so that form controls, scrollbars and the
 * browser's own UA widgets follow the theme instead of staying light.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#07090d' : '#f4f7fb');
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemePreference()));

  useEffect(() => {
    const next = resolveTheme(preference);
    setResolved(next);
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Non-fatal: the theme still applies for this session.
    }
  }, [preference]);

  /**
   * Follow the OS while the preference is 'system'.
   *
   * Without this a user who flips their laptop to dark at sunset keeps the
   * light app until a reload. The listener is only meaningful in 'system'
   * mode, so it is torn down otherwise.
   */
  useEffect(() => {
    if (preference !== 'system') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = () => {
      const next = systemTheme();
      setResolved(next);
      applyTheme(next);
    };
    // Safari < 14 has no addEventListener on MediaQueryList.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [preference]);

  /**
   * Mirror the choice across open tabs.
   *
   * `storage` only fires in OTHER tabs, so this cannot loop back on itself.
   */
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setPreferenceState(readThemePreference());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
  }, []);

  /** Toggle the VISIBLE theme. From 'system' this pins the opposite of what is on screen. */
  const toggle = useCallback(() => {
    setPreferenceState((current) => (resolveTheme(current) === 'dark' ? 'light' : 'dark'));
  }, []);

  return { preference, resolved, setPreference, toggle };
}
