import React, { useState, useMemo } from 'react';
import type { ServiceAgreementsSummary, ServiceAgreementDeal, UserRecord, ServiceAgreement } from '../../types';
import { AgreementCountdownBadge } from './AgreementCountdownBadge';
import { explorerLink, shortHash } from '../../blockExplorer';

const HANDLE_NUDGE_DISMISSED_KEY = 'sivan_web_handle_nudge_dismissed_at';
const HANDLE_NUDGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isHandleNudgeDismissed(): boolean {
  try {
    const ts = localStorage.getItem(HANDLE_NUDGE_DISMISSED_KEY);
    return !!ts && Date.now() - Number(ts) < HANDLE_NUDGE_TTL_MS;
  } catch { return false; }
}

function HandleNudgeBanner({ onGoToSettings, onDismiss }: { onGoToSettings?: () => void; onDismiss: () => void }) {
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        background: 'linear-gradient(135deg, rgba(52,211,153,0.08), rgba(16,185,129,0.03))',
        border: '1px solid rgba(52,211,153,0.25)',
        borderRadius: '14px', padding: '11px 14px', marginBottom: '18px',
        position: 'relative', overflow: 'hidden',
      }}
    >
      {/* left accent bar */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: 'linear-gradient(to bottom, #34d399, #10b981)', borderRadius: '3px 0 0 3px' }} />
      {/* icon */}
      <div style={{ flexShrink: 0, width: 36, height: 36, background: 'rgba(52,211,153,0.10)', border: '1px solid rgba(52,211,153,0.22)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, marginLeft: 4 }}>🏷️</div>
      {/* text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e', marginBottom: 2 }}>Complete your profile — add a @handle</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted, #8892a4)', lineHeight: 1.4 }}>A @handle lets counterparties tag you in deals by name across Web, MiniPay, and WhatsApp.</div>
      </div>
      {/* CTA */}
      {onGoToSettings && (
        <button
          onClick={onGoToSettings}
          style={{ flexShrink: 0, background: 'linear-gradient(135deg,#10b981,#34d399)', border: 'none', borderRadius: 10, color: '#fff', fontSize: 12, fontWeight: 700, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Set handle
        </button>
      )}
      {/* dismiss */}
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--text-muted,#8892a4)', fontSize: 15, cursor: 'pointer', padding: '2px 4px', opacity: 0.6 }}
      >✕</button>
    </div>
  );
}

interface ServiceAgreementsViewProps {
  user?: UserRecord | null;
  serviceAgreements?: ServiceAgreementsSummary;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  onRefresh: () => Promise<void> | void;
  onGoToTransactions?: () => void;
  onGoToSettings?: () => void;
}

function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function Kv({ label, value }: { label: string; value?: string | number | null | React.ReactNode }) {
  return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>;
}

function statusClass(status?: string) {
  if (!status) return 'pending';
  const s = status.toUpperCase();
  if (['COMPLETED', 'RELEASED', 'DELIVERED', 'ACTIVE', 'VERIFIED'].includes(s)) return 'success';
  if (['FAILED', 'CANCELLED', 'DISPUTED'].includes(s)) return 'danger';
  return 'pending';
}

function getChannelBadge(channel?: string) {
  const ch = String(channel || 'web').toLowerCase();
  if (ch === 'telegram') {
    return {
      label: 'Telegram',
      icon: '✈',
      bg: 'rgba(36, 161, 222, 0.12)',
      color: '#24a1de',
      border: 'rgba(36, 161, 222, 0.3)',
    };
  }
  if (ch === 'whatsapp') {
    return {
      label: 'WhatsApp',
      icon: '💬',
      bg: 'rgba(37, 211, 102, 0.12)',
      color: '#25d366',
      border: 'rgba(37, 211, 102, 0.3)',
    };
  }
  if (ch === 'minipay' || ch === 'mini_pay' || ch === 'celo_minipay') {
    return {
      label: 'MiniPay',
      icon: '💚',
      bg: 'rgba(52, 211, 153, 0.12)',
      color: '#34d399',
      border: 'rgba(52, 211, 153, 0.3)',
    };
  }
  if (ch === 'agent' || ch === 'ai' || ch === 'webmcp' || ch === 'mcp') {
    return {
      label: 'Sivan AI / MCP',
      icon: '✦',
      bg: 'rgba(168, 85, 247, 0.12)',
      color: '#a855f7',
      border: 'rgba(168, 85, 247, 0.3)',
    };
  }
  return {
    label: 'Web App',
    icon: '🌐',
    bg: 'rgba(59, 130, 246, 0.12)',
    color: '#3b82f6',
    border: 'rgba(59, 130, 246, 0.3)',
  };
}

function friendlyStatus(status?: string) {
  if (!status) return 'Pending';
  const map: Record<string, string> = {
    draft: 'Draft',
    pending: 'Pending',
    pending_payment: 'Awaiting Payment',
    pending_funding: 'Awaiting Funding',
    funded: 'Funded / In Delivery',
    in_delivery: 'In Delivery',
    delivered: 'Delivered',
    released: 'Released',
    completed: 'Completed',
    cancelled: 'Cancelled',
    disputed: 'Disputed'
  };
  return map[status.toLowerCase()] || status.replace(/_/g, ' ');
}

export function ServiceAgreementsView({
  user,
  serviceAgreements,
  api,
  onRefresh,
  onGoToTransactions,
  onGoToSettings,
}: ServiceAgreementsViewProps) {
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [handleNudgeDismissed, setHandleNudgeDismissed] = useState(() => isHandleNudgeDismissed());

  const showHandleNudge = !handleNudgeDismissed && !!user && !user.username;

  const dismissHandleNudge = () => {
    try { localStorage.setItem(HANDLE_NUDGE_DISMISSED_KEY, String(Date.now())); } catch {}
    setHandleNudgeDismissed(true);
  };

  // Draft form state
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('5');
  const [deliverables, setDeliverables] = useState('');
  const [milestones, setMilestones] = useState('2');
  const [network, setNetwork] = useState('solana');
  const [deadlineDays, setDeadlineDays] = useState('2');

  // Tiered verification state for Naira agreements
  const [nairaModalDeal, setNairaModalDeal] = useState<ServiceAgreementDeal | null>(null);
  const [whatsappPhoneInput, setWhatsappPhoneInput] = useState('');
  const [savingWhatsapp, setSavingWhatsapp] = useState(false);

  const deals = useMemo(() => {
    return serviceAgreements?.deals || [];
  }, [serviceAgreements?.deals]);

  const stats = useMemo(() => {
    let activeCount = 0;
    let tvl = 0;
    let completedCount = 0;

    deals.forEach((deal) => {
      const st = String(deal.status || '').toLowerCase();
      const numAmount = Number(deal.amount || deal.amountUsdc || 0);
      if (['funded', 'in_delivery', 'delivered', 'pending_payment', 'pending_funding'].includes(st)) {
        activeCount += 1;
        tvl += numAmount;
      } else if (['released', 'completed'].includes(st)) {
        completedCount += 1;
      }
    });

    return { activeCount, tvl, completedCount, totalCount: deals.length };
  }, [deals]);

  const filteredDeals = useMemo(() => {
    return deals.filter((deal) => {
      const st = String(deal.status || '').toLowerCase();
      const isActive = ['funded', 'in_delivery', 'delivered', 'pending_payment', 'pending_funding', 'draft', 'pending', 'pending_seller_acceptance', 'pending_acceptance'].includes(st);
      const isCompleted = ['released', 'completed', 'cancelled', 'disputed', 'declined'].includes(st);

      if (filter === 'active' && !isActive) return false;
      if (filter === 'completed' && !isCompleted) return false;

      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesTitle = deal.title?.toLowerCase().includes(query);
        const matchesCounterparty = deal.counterparty?.toLowerCase().includes(query) || deal.buyerWhatsapp?.toLowerCase().includes(query) || deal.sellerWhatsapp?.toLowerCase().includes(query);
        const matchesId = (deal.escrowId || deal.id || '').toLowerCase().includes(query);
        if (!matchesTitle && !matchesCounterparty && !matchesId) return false;
      }

      return true;
    });
  }, [deals, filter, searchQuery]);

  const selectedDeal = useMemo(() => {
    if (!filteredDeals.length) return null;
    if (selectedId) {
      const found = filteredDeals.find((d) => (d.id || d.escrowId) === selectedId);
      if (found) return found;
    }
    return filteredDeals[0] || null;
  }, [filteredDeals, selectedId]);

  const handleFund = async (deal: ServiceAgreementDeal) => {
    const agreementId = deal.id || deal.escrowId;
    if (!agreementId) return;
    setActionLoadingId(agreementId);
    setErrorBanner(null);
    setSuccessBanner(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/fund`, {
        method: 'POST',
        body: JSON.stringify({ network: deal.network || 'solana' })
      });
      setSuccessBanner(`Agreement ${agreementId} funded successfully! Funds locked in on-chain vault.`);
      await onRefresh();
    } catch (e: any) {
      setErrorBanner(e?.message || 'Failed to fund agreement vault.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleAccept = async (deal: ServiceAgreementDeal) => {
    const agreementId = deal.id || deal.escrowId;
    if (!agreementId) return;
    setActionLoadingId(agreementId);
    setErrorBanner(null);
    setSuccessBanner(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          sellerUserId: user?.id || user?.email || user?.username || deal.sellerUserId
        })
      });
      setSuccessBanner(`Agreement ${agreementId} accepted successfully! Client notified to fund vault.`);
      await onRefresh();
    } catch (e: any) {
      setErrorBanner(e?.message || 'Failed to accept agreement.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleDecline = async (deal: ServiceAgreementDeal) => {
    const agreementId = deal.id || deal.escrowId;
    if (!agreementId) return;
    if (!window.confirm('Are you sure you want to decline this Service Agreement?')) return;
    setActionLoadingId(agreementId);
    setErrorBanner(null);
    setSuccessBanner(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/decline`, {
        method: 'POST',
        body: JSON.stringify({
          sellerUserId: user?.id || user?.email || user?.username || deal.sellerUserId,
          reason: 'Declined by contractor from web dashboard'
        })
      });
      setSuccessBanner(`Agreement ${agreementId} declined.`);
      await onRefresh();
    } catch (e: any) {
      setErrorBanner(e?.message || 'Failed to decline agreement.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleDeliver = async (deal: ServiceAgreementDeal) => {
    const agreementId = deal.id || deal.escrowId;
    if (!agreementId) return;

    // Tiered verification protocol:
    // Naira agreements require a verified WhatsApp phone number for local NIBSS/NIP banking compliance.
    // USDC agreements proceed frictionlessly without phone gating.
    const isNaira = String(deal.currency || '').toUpperCase() === 'NAIRA' || String(deal.currency || '').toUpperCase() === 'NGN';
    const hasPhone = Boolean(user?.whatsappNumber || (user as any)?.phone);
    if (isNaira && !hasPhone) {
      setNairaModalDeal(deal);
      return;
    }

    setActionLoadingId(agreementId);
    setErrorBanner(null);
    setSuccessBanner(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/deliver`, {
        method: 'POST'
      });
      setSuccessBanner(`Work marked as delivered for ${agreementId}. Client notified for milestone release.`);
      await onRefresh();
    } catch (e: any) {
      setErrorBanner(e?.message || 'Failed to submit deliverable.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleRelease = async (deal: ServiceAgreementDeal) => {
    const agreementId = deal.id || deal.escrowId;
    if (!agreementId) return;
    setActionLoadingId(agreementId);
    setErrorBanner(null);
    setSuccessBanner(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/release`, {
        method: 'POST'
      });
      setSuccessBanner(`Funds successfully released to contractor for agreement ${agreementId}!`);
      await onRefresh();
    } catch (e: any) {
      setErrorBanner(e?.message || 'Failed to release agreement payout.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleCancel = async (deal: ServiceAgreementDeal) => {
    const agreementId = deal.id || deal.escrowId;
    if (!agreementId) return;
    if (!window.confirm('Are you sure you want to cancel this Service Agreement?')) return;
    setActionLoadingId(agreementId);
    setErrorBanner(null);
    setSuccessBanner(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/cancel`, {
        method: 'POST'
      });
      setSuccessBanner(`Agreement ${agreementId} cancelled.`);
      await onRefresh();
    } catch (e: any) {
      setErrorBanner(e?.message || 'Failed to cancel agreement.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleCreateDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!counterparty.trim() || !deliverables.trim() || !amount) {
      setErrorBanner('Please fill in counterparty, deliverables, and amount.');
      return;
    }
    setSubmitting(true);
    setErrorBanner(null);
    setSuccessBanner(null);

    try {
      const res = await api<any>('/api/agreements', {
        method: 'POST',
        body: JSON.stringify({
          buyerUserId: user?.id || 'usr_me',
          sellerUserId: counterparty.trim(),
          title: deliverables.trim(),
          description: `Scope: ${deliverables.trim()}. Milestones: ${milestones}`,
          amountUsdc: Number(amount),
          currency: 'USDC',
          network,
          deadlineDays: Number(deadlineDays) || 2
        })
      });

      setShowDraftModal(false);
      setCounterparty('');
      setDeliverables('');
      setAmount('5');
      setSuccessBanner(`Service Agreement created! ID: ${res?.id || 'new'}. Vault ready for funding.`);
      await onRefresh();
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to create Service Agreement.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="app-page transactions-premium">
      <PageHero
        title="Service Agreements"
        subtitle="Non-custodial, milestone-based multi-chain agreements across Web, Telegram, and AI agents."
        action={
          <div className="button-row">
            <button className="secondary-btn small" onClick={() => onRefresh()}>↻ Refresh</button>
            <button className="primary-btn small" onClick={() => setShowDraftModal(true)}>+ Draft agreement</button>
          </div>
        }
      />

      <div className="kpi-grid">
        <article className="kpi-card">
          <p>Active deals</p>
          <strong>{stats.activeCount}</strong>
          <span>In progress & awaiting release</span>
          <small className="kpi-trend action">Live</small>
        </article>

        <article className="kpi-card">
          <p>Total value protected</p>
          <strong style={{ color: '#16856d' }}>${stats.tvl.toFixed(2)} USDC</strong>
          <span>Multi-chain vaults</span>
          <small className="kpi-trend ok">Protected</small>
        </article>

        <article className="kpi-card">
          <p>Completed deals</p>
          <strong>{stats.completedCount}</strong>
          <span>Milestones settled & released</span>
          <small className="kpi-trend ok">Settled</small>
        </article>

        <article className="kpi-card">
          <p>All agreements</p>
          <strong>{stats.totalCount}</strong>
          <span>Recorded across channels</span>
          <small className="kpi-trend muted">Web + Telegram</small>
        </article>
      </div>

      {showHandleNudge && (
        <HandleNudgeBanner
          onGoToSettings={onGoToSettings ? () => { onGoToSettings(); } : undefined}
          onDismiss={dismissHandleNudge}
        />
      )}

      {errorBanner && (
        <div className="toast-banner danger" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: '14px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444' }}>
          <span>{errorBanner}</span>
          <button onClick={() => setErrorBanner(null)} style={{ background: 'transparent', border: 0, color: '#ef4444', fontWeight: 'bold', cursor: 'pointer' }}>✕</button>
        </div>
      )}
      {successBanner && (
        <div className="toast-banner success" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: '14px', background: 'rgba(22, 133, 109, 0.1)', border: '1px solid rgba(22, 133, 109, 0.3)', color: '#16856d' }}>
          <span>{successBanner}</span>
          <button onClick={() => setSuccessBanner(null)} style={{ background: 'transparent', border: 0, color: '#16856d', fontWeight: 'bold', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      <article className="transactions-table-card transaction-control-card">
        <div className="transactions-toolbar">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by agreement title, counterparty, ID..."
          />
          <div>
            <button
              className={filter === 'all' ? 'primary-btn small' : 'ghost-btn small'}
              onClick={() => setFilter('all')}
            >
              All ({deals.length})
            </button>
            <button
              className={filter === 'active' ? 'primary-btn small' : 'ghost-btn small'}
              onClick={() => setFilter('active')}
            >
              Active ({stats.activeCount})
            </button>
            <button
              className={filter === 'completed' ? 'primary-btn small' : 'ghost-btn small'}
              onClick={() => setFilter('completed')}
            >
              Completed ({stats.completedCount})
            </button>
          </div>
        </div>

        {!filteredDeals.length ? (
          <div className="dashboard-empty">
            <p>{searchQuery ? 'No service agreements match your filter.' : 'No service agreements yet.'}</p>
            <div className="button-row">
              <button className="primary-btn" onClick={() => setShowDraftModal(true)}>+ Draft first agreement</button>
              {onGoToTransactions && <button className="secondary-btn" onClick={onGoToTransactions}>View transactions</button>}
            </div>
          </div>
        ) : (
          <div className="transaction-ledger-layout">
            {/* List */}
            <div className="activity-list activity-list-page">
              {filteredDeals.map((deal) => {
                const dealId = deal.id || deal.escrowId;
                const isSelected = selectedDeal && (selectedDeal.id || selectedDeal.escrowId) === dealId;
                const st = String(deal.status || '').toLowerCase();
                const isBuyer = deal.role === 'buyer' || deal.buyerUserId === user?.id;

                const agreementObj: ServiceAgreement = {
                  id: dealId,
                  buyerUserId: deal.buyerUserId || '',
                  sellerUserId: deal.sellerUserId || '',
                  title: deal.title || 'Service Agreement Deliverable',
                  description: deal.description || deal.terms || '',
                  amountUsdc: Number(deal.amount || deal.amountUsdc || 0),
                  currency: deal.currency || 'USDC',
                  network: deal.network || 'solana',
                  status: deal.status as any,
                  deadlineDays: 7,
                  deliveryDueAt: deal.deliveryDueAt || null,
                  countdownLabel: deal.countdownLabel || (st === 'funded' ? '⏱ In Delivery' : st === 'delivered' ? '✅ Delivered' : st === 'released' ? '✅ Released' : '⏳ Awaiting payment'),
                  reminder6hSent: false,
                  overdueNoticeSent: false,
                  fundedAt: deal.fundedAt || null,
                  deliveredAt: deal.deliveredAt || null,
                  releasedAt: deal.releasedAt || null,
                  createdAt: deal.createdAt,
                  updatedAt: deal.updatedAt || deal.createdAt
                };

                const channelInfo = getChannelBadge(deal.channel);

                return (
                  <div
                    key={dealId}
                    className={`activity-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedId(dealId)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="activity-icon">📜</div>
                    <div className="activity-main">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <strong>{deal.title || 'Service Agreement'}</strong>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '11px',
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: '12px',
                            background: channelInfo.bg,
                            color: channelInfo.color,
                            border: `1px solid ${channelInfo.border}`,
                            lineHeight: '1.3',
                          }}
                        >
                          <span>{channelInfo.icon}</span>
                          <span>{channelInfo.label}</span>
                        </span>
                      </div>
                      <small>
                        <span style={{ fontFamily: 'var(--mono)' }}>{dealId}</span> • {(deal.network || 'solana').toUpperCase()} • {deal.role || (isBuyer ? 'Buyer' : 'Seller')}
                      </small>
                    </div>
                    <div className="activity-figures agreement-figures">
                      <strong className="agreement-amount">
                        {deal.amount} {deal.currency || 'USDC'}
                      </strong>
                      <span className={`badge ${statusClass(deal.status)}`}>
                        {friendlyStatus(deal.status)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Selected Deal Timeline Panel */}
            {selectedDeal && (() => {
              const currentId = selectedDeal.id || selectedDeal.escrowId;
              const isBuyer = selectedDeal.role === 'buyer' || selectedDeal.buyerUserId === user?.id;
              const isSeller = selectedDeal.role === 'seller' || selectedDeal.sellerUserId === user?.id;
              const st = String(selectedDeal.status || '').toLowerCase();
              const isLoading = actionLoadingId === currentId;
              const link = selectedDeal.fundingTxHash ? explorerLink({ txHash: selectedDeal.fundingTxHash, network: selectedDeal.network || 'solana' }) : undefined;

              const agreementObj: ServiceAgreement = {
                id: currentId,
                buyerUserId: selectedDeal.buyerUserId || '',
                sellerUserId: selectedDeal.sellerUserId || '',
                title: selectedDeal.title || 'Service Agreement Deliverable',
                description: selectedDeal.description || selectedDeal.terms || '',
                amountUsdc: Number(selectedDeal.amount || selectedDeal.amountUsdc || 0),
                currency: selectedDeal.currency || 'USDC',
                network: selectedDeal.network || 'solana',
                status: selectedDeal.status as any,
                deadlineDays: 7,
                deliveryDueAt: selectedDeal.deliveryDueAt || null,
                countdownLabel: selectedDeal.countdownLabel || (st === 'pending_seller_acceptance' || st === 'pending_acceptance' ? '⏳ Awaiting Seller Acceptance' : st === 'funded' ? '⏱ In Delivery' : st === 'delivered' ? '✅ Delivered' : st === 'released' ? '✅ Released' : st === 'declined' ? '✕ Declined' : '⏳ Awaiting payment'),
                reminder6hSent: false,
                overdueNoticeSent: false,
                fundedAt: selectedDeal.fundedAt || null,
                deliveredAt: selectedDeal.deliveredAt || null,
                releasedAt: selectedDeal.releasedAt || null,
                createdAt: selectedDeal.createdAt,
                updatedAt: selectedDeal.updatedAt || selectedDeal.createdAt
              };

              return (
                <div className="timeline-card panel">
                  <div className="timeline-card-head">
                    <div>
                      <p className="eyebrow">Service Agreement Details</p>
                      <h3>{selectedDeal.title || 'Service Agreement'}</h3>
                    </div>
                    <span className={`badge ${statusClass(selectedDeal.status)}`}>
                      {friendlyStatus(selectedDeal.status)}
                    </span>
                  </div>

                  <div className="details-box" style={{ margin: '14px 0' }}>
                    <Kv label="Agreement ID" value={currentId} />
                    <Kv label="Amount" value={`${selectedDeal.amount} ${selectedDeal.currency || 'USDC'}`} />
                    <Kv label="Role" value={selectedDeal.role || (isBuyer ? 'Buyer' : 'Seller')} />
                    <Kv label="Origin Channel" value={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: getChannelBadge(selectedDeal.channel).color }}>
                        <span>{getChannelBadge(selectedDeal.channel).icon}</span>
                        <span>{getChannelBadge(selectedDeal.channel).label}</span>
                      </span>
                    } />
                    <Kv label="Settlement Rail" value={(selectedDeal.network || 'solana').toUpperCase()} />
                    <Kv label="Counterparty" value={selectedDeal.counterparty || selectedDeal.buyerWhatsapp || selectedDeal.sellerWhatsapp || selectedDeal.sellerUserId || 'Contractor'} />
                    <Kv label="Created Date" value={new Date(selectedDeal.createdAt).toLocaleDateString()} />
                    {link && (
                      <Kv
                        label="On-Chain Vault Proof"
                        value={
                          <a href={link.url} target="_blank" rel="noreferrer" style={{ color: '#007ac7', textDecoration: 'underline' }}>
                            {shortHash(selectedDeal.fundingTxHash || '')} ↗
                          </a>
                        }
                      />
                    )}
                  </div>

                  <div style={{ margin: '12px 0' }}>
                    <AgreementCountdownBadge agreement={agreementObj} />
                  </div>

                  {/* Actions */}
                  <div className="button-row" style={{ marginTop: '16px' }}>
                    {/* Contractor / Seller: Pending Seller Acceptance */}
                    {(st === 'pending_seller_acceptance' || st === 'pending_acceptance') && !isBuyer && (
                      <>
                        <button
                          disabled={isLoading}
                          onClick={() => handleAccept(selectedDeal)}
                          className="primary-btn small"
                          style={{ background: '#16a34a', borderColor: '#16a34a' }}
                        >
                          {isLoading ? 'Accepting...' : 'Accept Agreement ✓'}
                        </button>
                        <button
                          disabled={isLoading}
                          onClick={() => handleDecline(selectedDeal)}
                          className="ghost-btn small"
                          style={{ color: '#ef4444' }}
                        >
                          Decline ✕
                        </button>
                        <button
                          disabled={isLoading}
                          onClick={() => handleCancel(selectedDeal)}
                          className="ghost-btn small"
                        >
                          Cancel
                        </button>
                      </>
                    )}

                    {/* Client / Buyer: Pending Seller Acceptance */}
                    {(st === 'pending_seller_acceptance' || st === 'pending_acceptance') && isBuyer && (
                      <button
                        disabled={isLoading}
                        onClick={() => handleCancel(selectedDeal)}
                        className="ghost-btn small"
                        style={{ color: '#ef4444' }}
                      >
                        Cancel Agreement
                      </button>
                    )}

                    {/* Client / Buyer: Pending Payment */}
                    {(st === 'pending_payment' || st === 'pending_funding' || st === 'draft' || st === 'pending') && isBuyer && (
                      <>
                        <button
                          disabled={isLoading}
                          onClick={() => handleFund(selectedDeal)}
                          className="primary-btn small"
                        >
                          {isLoading ? 'Locking...' : 'Lock Funds in Vault →'}
                        </button>
                        <button
                          disabled={isLoading}
                          onClick={() => handleCancel(selectedDeal)}
                          className="ghost-btn small"
                          style={{ color: '#ef4444' }}
                        >
                          Cancel
                        </button>
                      </>
                    )}

                    {/* Contractor / Seller: Pending Payment */}
                    {(st === 'pending_payment' || st === 'pending_funding' || st === 'draft' || st === 'pending') && !isBuyer && (
                      <button
                        disabled={isLoading}
                        onClick={() => handleCancel(selectedDeal)}
                        className="ghost-btn small"
                        style={{ color: '#ef4444' }}
                      >
                        Cancel Agreement
                      </button>
                    )}

                    {(st === 'funded' || st === 'in_delivery') && (
                      <button
                        disabled={isLoading}
                        onClick={() => handleDeliver(selectedDeal)}
                        className="primary-btn small"
                      >
                        {isLoading ? 'Submitting...' : 'Mark Delivered ✓'}
                      </button>
                    )}

                    {st === 'delivered' && isBuyer && (
                      <button
                        disabled={isLoading}
                        onClick={() => handleRelease(selectedDeal)}
                        className="primary-btn small"
                      >
                        {isLoading ? 'Releasing...' : 'Approve & Release Funds ↗'}
                      </button>
                    )}

                    {link && (
                      <a href={link.url} target="_blank" rel="noreferrer" className="ghost-btn small">
                        {link.label} Proof ↗
                      </a>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </article>

      {/* Draft Agreement Modal */}
      {showDraftModal && (
        <div className="sv-modal-backdrop" onClick={() => setShowDraftModal(false)} role="presentation" style={{ zIndex: 9999 }}>
          <div className="sv-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className="sv-modal-head">
              <button className="sv-modal-close" onClick={() => setShowDraftModal(false)} aria-label="Close">×</button>
              <span className="sv-modal-eyebrow">Multi-Chain Vault Protocol</span>
              <h2>Draft Service Agreement</h2>
              <p className="sv-modal-sub">
                Create a non-custodial milestone agreement. Funds remain protected in the on-chain vault until deliverables are verified.
              </p>
            </div>

            <form onSubmit={handleCreateDraft} className="sv-modal-body form">
              <div>
                <label style={{ display: 'block', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5a6678', marginBottom: '6px', fontWeight: 700 }}>
                  Deliverables & Scope *
                </label>
                <input
                  type="text"
                  placeholder="e.g. NFT Artwork Design with 2 Revisions"
                  value={deliverables}
                  onChange={(e) => setDeliverables(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5a6678', marginBottom: '6px', fontWeight: 700 }}>
                  Counterparty (Username / Email / Address) *
                </label>
                <input
                  type="text"
                  placeholder="@designer or designer@example.com"
                  value={counterparty}
                  onChange={(e) => setCounterparty(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5a6678', marginBottom: '6px', fontWeight: 700 }}>
                    Settlement Network
                  </label>
                  <select
                    value={network}
                    onChange={(e) => setNetwork(e.target.value)}
                  >
                    <option value="solana">Solana (High Speed)</option>
                    <option value="base">Base (USDC Rail)</option>
                    <option value="celo">Celo (Mobile-First)</option>
                    <option value="stellar">Stellar (Cross-Border)</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5a6678', marginBottom: '6px', fontWeight: 700 }}>
                    Delivery Deadline
                  </label>
                  <select
                    value={deadlineDays}
                    onChange={(e) => setDeadlineDays(e.target.value)}
                  >
                    <option value="1">24 Hours (1 Day)</option>
                    <option value="2">48 Hours (2 Days)</option>
                    <option value="3">72 Hours (3 Days)</option>
                    <option value="5">5 Days (Business Week)</option>
                    <option value="7">7 Days (1 Week)</option>
                    <option value="14">14 Days (2 Weeks)</option>
                    <option value="30">30 Days (1 Month)</option>
                  </select>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5a6678', marginBottom: '6px', fontWeight: 700 }}>
                  Milestone Count
                </label>
                <select
                  value={milestones}
                  onChange={(e) => setMilestones(e.target.value)}
                >
                  <option value="1">1 Milestone (Full)</option>
                  <option value="2">2 Milestones (50% / 50%)</option>
                  <option value="3">3 Milestones</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5a6678', marginBottom: '6px', fontWeight: 700 }}>
                  Amount (USDC) *
                </label>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  {['5', '10', '20', '50'].map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      className={amount === preset ? 'primary-btn small' : 'ghost-btn small'}
                      onClick={() => setAmount(preset)}
                    >
                      ${preset} USDC
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  step="0.1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setShowDraftModal(false)}
                  disabled={submitting}
                  style={{ flex: 1 }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={submitting}
                  style={{ flex: 1 }}
                >
                  {submitting ? 'Creating...' : 'Create Agreement →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Naira Delivery WhatsApp Modal */}
      {nairaModalDeal && (
        <div className="sv-modal-backdrop" onClick={() => setNairaModalDeal(null)} role="presentation" style={{ zIndex: 9999 }}>
          <div className="sv-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
            <div className="sv-modal-head">
              <button className="sv-modal-close" onClick={() => setNairaModalDeal(null)} aria-label="Close">×</button>
              <span className="sv-modal-eyebrow">Banking Rail Compliance</span>
              <h2>Link WhatsApp to Deliver</h2>
              <p className="sv-modal-sub">
                Naira service agreements settle directly into Nigerian bank accounts via NIBSS/NIP rails and require your WhatsApp phone number for transaction receipts and identity compliance.
              </p>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!whatsappPhoneInput.trim()) return;
                setSavingWhatsapp(true);
                setErrorBanner(null);
                try {
                  await api(`/api/users/${user?.id || 'me'}/profile`, {
                    method: 'POST',
                    body: JSON.stringify({ whatsappNumber: whatsappPhoneInput.trim() })
                  }).catch(() => null);
                  if (user) (user as any).whatsappNumber = whatsappPhoneInput.trim();
                  const targetDeal = nairaModalDeal;
                  setNairaModalDeal(null);
                  if (targetDeal) {
                    await handleDeliver(targetDeal);
                  }
                } catch (err: any) {
                  setErrorBanner(err?.message || 'Failed to link WhatsApp number.');
                } finally {
                  setSavingWhatsapp(false);
                }
              }}
              className="sv-modal-body form"
            >
              <div>
                <label style={{ display: 'block', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5a6678', marginBottom: '6px', fontWeight: 700 }}>
                  WhatsApp Phone Number *
                </label>
                <input
                  type="tel"
                  placeholder="+2348012345678"
                  value={whatsappPhoneInput}
                  onChange={(e) => setWhatsappPhoneInput(e.target.value)}
                  required
                />
              </div>

              <div className="sv-modal-foot" style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
                <button type="button" className="secondary-btn" onClick={() => setNairaModalDeal(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn" disabled={savingWhatsapp || !whatsappPhoneInput.trim()}>
                  {savingWhatsapp ? 'Verifying...' : 'Verify & Submit Delivery'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

export default ServiceAgreementsView;

