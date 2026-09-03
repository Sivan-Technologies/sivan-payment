import React from 'react';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  isDestructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div className="sv-modal-backdrop" onClick={onCancel} role="presentation" style={{ zIndex: 9999 }}>
      <div
        className="sv-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '440px', padding: '24px' }}
      >
        <div className="sv-modal-head" style={{ marginBottom: '16px' }}>
          <span className="sv-modal-eyebrow" style={{ color: isDestructive ? '#ef4444' : '#38bdf8' }}>
            {isDestructive ? '⚠️ Confirmation Required' : 'Action Confirmation'}
          </span>
          <h3 style={{ margin: '6px 0 8px', fontSize: '18px', fontWeight: 600 }}>{title}</h3>
          <p className="sv-modal-sub" style={{ margin: 0, fontSize: '14px', lineHeight: '1.5', color: '#94a3b8' }}>
            {description}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button
            type="button"
            className="ghost-btn"
            onClick={onCancel}
            disabled={loading}
            style={{ flex: 1 }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={isDestructive ? 'primary-btn danger-btn' : 'primary-btn'}
            onClick={onConfirm}
            disabled={loading}
            style={{
              flex: 1,
              background: isDestructive ? '#dc2626' : undefined,
              borderColor: isDestructive ? '#ef4444' : undefined,
            }}
          >
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
