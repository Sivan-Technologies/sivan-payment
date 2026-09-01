/**
 * AgreementCountdownBadge
 *
 * Renders a live countdown badge for a service agreement, suitable for
 * embedding in chat cards, activity feeds, and the agreement detail view.
 *
 * Colour semantics (matching the Sivan "Obsidian Cyan" design system):
 *   - green  (> 24 hours remaining) — safe, no action needed
 *   - amber  (6–24 hours remaining) — seller should be aware
 *   - red    (< 6 hours, or overdue) — urgent
 *   - muted  (no deadline / terminal status) — neutral info
 *
 * The label string itself comes from the backend (countdownLabel), so this
 * component never duplicates the computation — it is purely a renderer.
 */

import React from 'react';
import type { ServiceAgreement, ServiceAgreementStatus } from '../../types';

interface AgreementCountdownBadgeProps {
  agreement: ServiceAgreement;
  className?: string;
}

type Urgency = 'safe' | 'warn' | 'urgent' | 'muted';

function getUrgency(agreement: ServiceAgreement): Urgency {
  const terminalStatuses: ServiceAgreementStatus[] = ['released', 'cancelled', 'disputed', 'delivered'];
  if (terminalStatuses.includes(agreement.status)) return 'muted';
  if (!agreement.deliveryDueAt) return 'muted';

  const diffMs = new Date(agreement.deliveryDueAt).getTime() - Date.now();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours <= 0) return 'urgent';
  if (diffHours <= 6) return 'urgent';
  if (diffHours <= 24) return 'warn';
  return 'safe';
}

const URGENCY_STYLES: Record<Urgency, React.CSSProperties> = {
  safe: {
    backgroundColor: 'rgba(0, 255, 163, 0.12)',
    color: '#00FFA3',
    border: '1px solid rgba(0, 255, 163, 0.25)',
  },
  warn: {
    backgroundColor: 'rgba(255, 183, 0, 0.12)',
    color: '#FFB700',
    border: '1px solid rgba(255, 183, 0, 0.28)',
  },
  urgent: {
    backgroundColor: 'rgba(255, 65, 65, 0.12)',
    color: '#FF4141',
    border: '1px solid rgba(255, 65, 65, 0.28)',
  },
  muted: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    color: 'rgba(255, 255, 255, 0.5)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
  },
};

const BADGE_BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  padding: '4px 10px',
  borderRadius: '20px',
  fontSize: '12px',
  fontWeight: 600,
  fontFamily: 'Inter, system-ui, sans-serif',
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
  backdropFilter: 'blur(8px)',
  transition: 'all 0.2s ease',
};

/**
 * AgreementCountdownBadge renders the live countdown label returned by the
 * backend with appropriate colour coding.
 *
 * Example usage:
 *   <AgreementCountdownBadge agreement={agreement} />
 */
export function AgreementCountdownBadge({ agreement, className }: AgreementCountdownBadgeProps) {
  const urgency = getUrgency(agreement);
  const style = { ...BADGE_BASE, ...URGENCY_STYLES[urgency] };

  return (
    <span
      id={`countdown-badge-${agreement.id}`}
      className={className}
      style={style}
      title={agreement.deliveryDueAt ? `Due: ${new Date(agreement.deliveryDueAt).toLocaleString()}` : undefined}
      role="status"
      aria-label={`Agreement ${agreement.id}: ${agreement.countdownLabel}`}
    >
      {agreement.countdownLabel}
    </span>
  );
}

export default AgreementCountdownBadge;
