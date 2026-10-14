import { useEffect, useState } from 'react';
import {
  getStoredMoneyGramVouchers,
  updateMoneyGramVoucherStatus,
  type MoneyGramVoucher,
} from '../../moneygram';
import { MoneyGramVoucherCard } from './MoneyGramVoucherCard';
import { MoneyGramModal } from './MoneyGramModal';
import { ConfirmModal } from '../ConfirmModal';

export interface MoneyGramCashoutViewProps {
  userId?: string;
  userFullName?: string;
  userPhone?: string;
  userSpendableUsdc?: number | null;
  onRefresh?: () => void;
  apiBase?: string;
}

export function MoneyGramCashoutView({
  userId,
  userFullName = '',
  userPhone = '',
  userSpendableUsdc,
  apiBase,
}: MoneyGramCashoutViewProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [vouchers, setVouchers] = useState<MoneyGramVoucher[]>(() => getStoredMoneyGramVouchers());
  const [voucherToCancel, setVoucherToCancel] = useState<MoneyGramVoucher | null>(null);

  const refreshVouchers = () => {
    setVouchers(getStoredMoneyGramVouchers());
  };

  useEffect(() => {
    refreshVouchers();
  }, [modalOpen]);

  const handleCancelVoucher = (voucher: MoneyGramVoucher) => {
    setVoucherToCancel(voucher);
  };

  const handleConfirmCancel = () => {
    if (!voucherToCancel) return;
    const updated = updateMoneyGramVoucherStatus(voucherToCancel.id, 'cancelled', 'Cancelled by User');
    setVouchers(updated);
    setVoucherToCancel(null);
  };

  return (
    <div className="moneygram-cashout-view" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Hero Announcement Banner */}
      <article
        className="panel"
        style={{
          background: 'linear-gradient(135deg, rgba(0, 122, 199, 0.08) 0%, rgba(22, 133, 109, 0.08) 100%)',
          border: '1px solid var(--border-strong)',
          borderRadius: '16px',
          padding: '24px',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
          <div style={{ maxWidth: '600px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span
                style={{
                  background: '#e02424',
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: 800,
                  padding: '3px 8px',
                  borderRadius: '4px',
                  letterSpacing: '0.04em',
                }}
              >
                MONEYGRAM RAMPS
              </span>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: 'var(--green-ink)',
                }}
              >
                400,000+ AGENT LOCATIONS
              </span>
            </div>
            <h3 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: 700, color: 'var(--text)' }}>
              Physical Cash Pickup via MoneyGram
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: '13.5px', color: 'var(--muted)', lineHeight: '1.5' }}>
              Turn your Stellar USDC into real paper cash at any MoneyGram branch, post office, or retail agent worldwide.
              No bank account required. Simply present your 8-digit Reference PIN and official photo ID at the counter.
            </p>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="primary-btn"
                onClick={() => setModalOpen(true)}
                style={{ padding: '10px 20px', fontSize: '14px' }}
              >
                💵 Start New Cash Pickup →
              </button>
            </div>
          </div>

          {/* Quick Metrics Badge */}
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '16px',
              minWidth: '200px',
            }}
          >
            <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
              Corridor Support
            </span>
            <div style={{ fontSize: '16px', fontWeight: 700, margin: '4px 0 10px', color: 'var(--text)' }}>
              USD · NGN · KES · GHS · EUR
            </div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', fontSize: '12px', color: 'var(--muted)' }}>
              ✓ Sub-second Stellar lock<br />
              ✓ Zero platform fee (0%)<br />
              ✓ Instant 8-digit pickup PIN
            </div>
          </div>
        </div>
      </article>

      {/* Active Vouchers Section */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: 'var(--text)' }}>
              Your MoneyGram Pickup Vouchers
            </h4>
            <span style={{ fontSize: '12.5px', color: 'var(--muted)' }}>
              {vouchers.length === 0
                ? 'No active vouchers yet. Start a cash pickup above to generate your 8-digit counter PIN.'
                : `${vouchers.length} active or historical pickup voucher(s) recorded.`}
            </span>
          </div>

          {vouchers.length > 0 && (
            <button
              type="button"
              className="secondary-btn small"
              onClick={() => setModalOpen(true)}
              style={{ fontSize: '12px' }}
            >
              + New Voucher
            </button>
          )}
        </div>

        {vouchers.length === 0 ? (
          <div
            className="empty-state"
            style={{
              background: 'var(--surface-2)',
              border: '1px dashed var(--border-control)',
              borderRadius: '14px',
              padding: '36px 20px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>💵</div>
            <h5 style={{ margin: '0 0 6px', fontSize: '15px', color: 'var(--text)' }}>
              No Cash Pickup Vouchers Yet
            </h5>
            <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--muted)', maxWidth: '420px', marginLeft: 'auto', marginRight: 'auto' }}>
              When you initiate a MoneyGram cashout, your 8-digit Reference PIN and counter instructions will appear here so you can access them anytime on mobile.
            </p>
            <button
              type="button"
              className="primary-btn"
              onClick={() => setModalOpen(true)}
            >
              Generate Cash Pickup PIN →
            </button>
          </div>
        ) : (
          <div className="vouchers-list">
            {vouchers.map((voucher) => (
              <MoneyGramVoucherCard
                key={voucher.id}
                voucher={voucher}
                onCancelOrRefund={handleCancelVoucher}
              />
            ))}
          </div>
        )}
      </div>

      {/* Interactive Modal */}
      <MoneyGramModal
        open={modalOpen}
        mode="withdraw"
        onClose={() => {
          setModalOpen(false);
          refreshVouchers();
        }}
        onSuccess={() => {
          refreshVouchers();
        }}
        userFullName={userFullName}
        userPhone={userPhone}
        userId={userId}
        userSpendableUsdc={userSpendableUsdc}
        apiBase={apiBase}
      />

      {/* Sleek In-App Voucher Cancellation Confirmation Modal */}
      <ConfirmModal
        open={Boolean(voucherToCancel)}
        title="Cancel Cash Pickup Voucher"
        description={`Are you sure you want to cancel MoneyGram Voucher ${voucherToCancel?.referencePin || ''}? The counter pickup PIN will be deactivated, and your ${voucherToCancel?.amount || ''} USDC will remain in your Stellar wallet.`}
        confirmLabel="Yes, Cancel Voucher"
        cancelLabel="Keep Voucher"
        isDestructive
        onConfirm={handleConfirmCancel}
        onCancel={() => setVoucherToCancel(null)}
      />
    </div>
  );
}
