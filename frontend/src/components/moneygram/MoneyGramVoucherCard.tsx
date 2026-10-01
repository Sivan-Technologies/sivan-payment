import { useState } from 'react';
import {
  formatMoneyGramPin,
  MONEYGRAM_LOCATION_FINDER_URL,
  type MoneyGramVoucher,
} from '../../moneygram';

export interface MoneyGramVoucherCardProps {
  voucher: MoneyGramVoucher;
  onCancelOrRefund?: (voucher: MoneyGramVoucher) => void;
  compact?: boolean;
}

export function MoneyGramVoucherCard({
  voucher,
  onCancelOrRefund,
  compact = false,
}: MoneyGramVoucherCardProps) {
  const [copied, setCopied] = useState(false);

  const copyPin = async () => {
    try {
      await navigator.clipboard?.writeText(voucher.referencePin);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Fallback if clipboard API restricted
    }
  };

  const isPickupReady =
    voucher.status === 'ready_for_pickup' ||
    voucher.status === 'pending_user_transfer_complete';

  const statusColor =
    voucher.status === 'completed'
      ? '#16856d'
      : isPickupReady
      ? '#007ac7'
      : voucher.status === 'refunded' || voucher.status === 'cancelled'
      ? '#c4372b'
      : '#b26b00';

  return (
    <article
      className="panel-card moneygram-voucher-card"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border-strong)',
        borderRadius: '16px',
        padding: compact ? '16px' : '24px',
        position: 'relative',
        boxShadow: 'var(--shadow)',
        marginBottom: '16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '16px',
          paddingBottom: '14px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                background: '#e02424',
                color: '#fff',
                fontSize: '11px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '4px',
                letterSpacing: '0.04em',
              }}
            >
              MONEYGRAM
            </span>
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--muted)',
                letterSpacing: '0.02em',
              }}
            >
              STELLAR NATIVE USDC
            </span>
          </div>
          <h4
            style={{
              margin: '6px 0 2px',
              fontSize: compact ? '16px' : '18px',
              fontWeight: 700,
              color: 'var(--text)',
            }}
          >
            {voucher.mode === 'withdraw'
              ? 'Cash Pickup Voucher'
              : 'Cash In Deposit Receipt'}
          </h4>
          <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
            Created {new Date(voucher.createdAt).toLocaleString()}
          </span>
        </div>

        <div style={{ textAlign: 'right' }}>
          <span
            style={{
              display: 'inline-block',
              fontSize: '12px',
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: '20px',
              background: `${statusColor}18`,
              color: statusColor,
              border: `1px solid ${statusColor}33`,
            }}
          >
            {voucher.statusLabel || (isPickupReady ? 'Ready for Counter Pickup' : voucher.status)}
          </span>
          <div
            style={{
              fontSize: '16px',
              fontWeight: 700,
              marginTop: '4px',
              color: 'var(--text)',
            }}
          >
            {voucher.amount} {voucher.asset}{' '}
            <span style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 500 }}>
              (≈ {voucher.targetAmount} {voucher.targetCurrency})
            </span>
          </div>
        </div>
      </div>

      {/* 8-Digit Pickup Reference PIN Box */}
      <div
        style={{
          background: 'var(--surface-2)',
          border: '2px dashed var(--border-control)',
          borderRadius: '12px',
          padding: '16px 20px',
          textAlign: 'center',
          marginBottom: '16px',
        }}
      >
        <span
          style={{
            fontSize: '12px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontWeight: 700,
            color: 'var(--muted)',
            display: 'block',
            marginBottom: '6px',
          }}
        >
          8-Digit Counter Reference PIN
        </span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
          }}
        >
          <span
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: compact ? '22px' : '28px',
              fontWeight: 800,
              letterSpacing: '0.18em',
              color: 'var(--green-ink)',
            }}
          >
            {formatMoneyGramPin(voucher.referencePin)}
          </span>
          <button
            type="button"
            className="secondary-btn small"
            onClick={copyPin}
            style={{ padding: '6px 12px', fontSize: '12px' }}
            aria-label="Copy pickup reference PIN"
          >
            {copied ? '✓ Copied' : 'Copy PIN'}
          </button>
        </div>
        <small
          style={{
            display: 'block',
            marginTop: '8px',
            color: 'var(--muted)',
            fontSize: '12px',
          }}
        >
          Present this 8-digit PIN to the teller at any MoneyGram agent location.
        </small>
      </div>

      {/* Beneficiary & Details Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '12px',
          fontSize: '13px',
          marginBottom: '16px',
          padding: '12px 16px',
          background: 'var(--surface-3)',
          borderRadius: '10px',
        }}
      >
        <div>
          <span style={{ color: 'var(--muted)', display: 'block' }}>Beneficiary Legal Name</span>
          <strong style={{ color: 'var(--text)' }}>{voucher.recipientName}</strong>
        </div>
        {voucher.recipientPhone && (
          <div>
            <span style={{ color: 'var(--muted)', display: 'block' }}>Recipient Mobile</span>
            <strong style={{ color: 'var(--text)' }}>{voucher.recipientPhone}</strong>
          </div>
        )}
        <div>
          <span style={{ color: 'var(--muted)', display: 'block' }}>Settlement Network</span>
          <strong style={{ color: 'var(--text)' }}>Stellar Native USDC</strong>
        </div>
        <div>
          <span style={{ color: 'var(--muted)', display: 'block' }}>Transaction Reference</span>
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: '11px',
              color: 'var(--muted)',
            }}
          >
            {voucher.transactionId.slice(0, 16)}...
          </span>
        </div>
      </div>

      {/* 3-Step Physical Counter Collection Guidance */}
      {!compact && (
        <div
          style={{
            background: 'rgba(0, 122, 199, 0.05)',
            border: '1px solid rgba(0, 122, 199, 0.2)',
            borderRadius: '10px',
            padding: '14px 16px',
            marginBottom: '16px',
          }}
        >
          <strong
            style={{
              fontSize: '13px',
              color: 'var(--text)',
              display: 'block',
              marginBottom: '6px',
            }}
          >
            Counter Cash Collection Instructions:
          </strong>
          <ol
            style={{
              margin: 0,
              paddingLeft: '20px',
              fontSize: '12.5px',
              color: 'var(--muted)',
              lineHeight: '1.6',
            }}
          >
            <li>
              Visit any MoneyGram counter (over 400,000 physical agent locations worldwide).
            </li>
            <li>
              Present your <strong>8-digit Reference PIN</strong> and a valid government-issued photo ID (Name: <strong>{voucher.recipientName}</strong>).
            </li>
            <li>
              Receive physical cash payout of <strong>{voucher.targetAmount} {voucher.targetCurrency}</strong> instantly with zero bank delays.
            </li>
          </ol>
        </div>
      )}

      {/* Action Footer */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
          paddingTop: '12px',
          borderTop: '1px solid var(--border)',
        }}
      >
        <a
          href={MONEYGRAM_LOCATION_FINDER_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '13px',
            color: 'var(--green-ink)',
            textDecoration: 'none',
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          📍 Find Nearest MoneyGram Location ↗
        </a>

        <div style={{ display: 'flex', gap: '8px' }}>
          {voucher.moreInfoUrl && (
            <a
              href={voucher.moreInfoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ghost-btn"
              style={{
                fontSize: '12px',
                padding: '6px 12px',
                textDecoration: 'none',
              }}
            >
              Self-Service Status & Refund ↗
            </a>
          )}
          {onCancelOrRefund && isPickupReady && (
            <button
              type="button"
              className="secondary-btn small"
              onClick={() => onCancelOrRefund(voucher)}
              style={{ fontSize: '12px' }}
            >
              Cancel Voucher
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
