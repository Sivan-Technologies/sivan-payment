import React from 'react';
import type { ResolvedTheme } from '../hooks/useTheme';

type Props = {
  resolved: ResolvedTheme;
  onToggle: () => void;
  /** Rendered smaller in the public topbar, where space is tighter. */
  compact?: boolean;
};

/**
 * Sun/moon theme switch.
 *
 * Both icons are always in the DOM and cross-fade, so the control never
 * changes size mid-transition and the swap reads as one object rotating
 * rather than two icons popping.
 *
 * It is a real <button> with aria-pressed, so a screen reader announces the
 * state rather than just "button". The label says what a click WILL DO, which
 * is what a keyboard user needs; the icon shows the current state.
 */
export function ThemeToggle({ resolved, onToggle, compact }: Props) {
  const goingTo = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={`theme-toggle${compact ? ' compact' : ''}`}
      onClick={onToggle}
      aria-pressed={resolved === 'dark'}
      aria-label={`Switch to ${goingTo} mode`}
      title={`Switch to ${goingTo} mode`}
    >
      <span className="theme-toggle-icons" aria-hidden="true">
        <svg className="theme-icon sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M5.9 5.9 4.4 4.4M19.6 19.6l-1.5-1.5M18.1 5.9l1.5-1.5M4.4 19.6l1.5-1.5" />
        </svg>
        <svg className="theme-icon moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5a8.6 8.6 0 1 0 10.9 10.9Z" />
        </svg>
      </span>
    </button>
  );
}
