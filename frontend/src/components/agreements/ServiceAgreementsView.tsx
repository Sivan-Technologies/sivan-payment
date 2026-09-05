import React, { useState, useMemo } from 'react';
import type { ServiceAgreementsSummary, ServiceAgreementDeal, UserRecord, ServiceAgreement } from '../../types';
import { AgreementCountdownBadge } from './AgreementCountdownBadge';
import { explorerLink, shortHash } from '../../blockExplorer';

interface ServiceAgreementsViewProps {
  user?: UserRecord | null;
  serviceAgreements?: ServiceAgreementsSummary;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  onRefresh: () => Promise<void> | void;
  onGoToTransactions?: () => void;
}

export function ServiceAgreementsView({
  user,
  serviceAgreements,
  api,
  onRefresh,
  onGoToTransactions
}: ServiceAgreementsViewProps) {
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('5');
  const [deliverables, setDeliverables] = useState('');
  const [milestones, setMilestones] = useState('2');
  const [network, setNetwork] = useState('solana');

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
      if (['funded', 'in_delivery', 'delivered', 'pending_payment'].includes(st)) {
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
      const isActive = ['funded', 'in_delivery', 'delivered', 'pending_payment'].includes(st);
      const isCompleted = ['released', 'completed', 'cancelled', 'disputed'].includes(st);

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

  const handleDeliver = async (deal: ServiceAgreementDeal) => {
    const agreementId = deal.id || deal.escrowId;
    if (!agreementId) return;
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
          deadlineDays: 7
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
    <section className="app-page agreements-premium">
      <div className="page-hero">
        <div>
          <h1>Service Agreements</h1>
          <p>Non-custodial, milestone-based multi-chain agreements across Web, Telegram, and AI agents.</p>
        </div>
        <div className="button-row">
          <button className="secondary-btn small" onClick={() => onRefresh()}>↻ Refresh</button>
          <button className="primary-btn small" onClick={() => setShowDraftModal(true)}>+ Draft agreement</button>
        </div>
      </div>

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
            placeholder="Search agreement title, counterparty, ID..."
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
            <p>{searchQuery ? 'No service agreements match your search filter.' : 'No service agreements found.'}</p>
            <div className="button-row">
              <button className="primary-btn" onClick={() => setShowDraftModal(true)}>+ Draft first agreement</button>
              {onGoToTransactions && <button className="secondary-btn" onClick={onGoToTransactions}>View all transactions</button>}
            </div>
          </div>
        ) : (
          <div className="agreements-list">
            {filteredDeals.map((deal) => {
              const agreementId = deal.id || deal.escrowId;
              const isBuyer = deal.role === 'buyer' || deal.buyerUserId === user?.id;
              const st = String(deal.status || '').toLowerCase();
              const networkLabel = (deal.network || 'solana').toUpperCase();
              const isLoading = actionLoadingId === agreementId;

              const agreementObj: ServiceAgreement = {
                id: agreementId,
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
                countdownLabel: deal.countdownLabel || deal.statusLabel || (st === 'funded' ? '⏱ In Delivery' : st === 'delivered' ? '✅ Delivered' : st === 'released' ? '✅ Released' : '⏳ Awaiting payment'),
                reminder6hSent: false,
                overdueNoticeSent: false,
                fundedAt: deal.fundedAt || null,
                deliveredAt: deal.deliveredAt || null,
                releasedAt: deal.releasedAt || null,
                createdAt: deal.createdAt,
                updatedAt: deal.updatedAt || deal.createdAt
              };

              return (
                <div key={agreementId} className="agreement-deal-card">
                  <div className="agreement-card-top">
                    <div className="agreement-title-group">
                      <div className="agreement-tags">
                        <span className="agreement-id-pill">{agreementId}</span>
                        <span className="agreement-network-pill">{networkLabel}</span>
                        {deal.channel && (
                          <span className="agreement-channel-pill">
                            {deal.channel === 'telegram' ? 'Telegram @Sivan_Ai' : deal.channel === 'webmcp' ? 'WebMCP Protocol' : 'Web App'}
                          </span>
                        )}
                        <AgreementCountdownBadge agreement={agreementObj} />
                      </div>
                      <h3>{deal.title}</h3>
                    </div>

                    <div className="agreement-amount-block">
                      <div className="agreement-amount-val">
                        {deal.amount} {deal.currency || 'USDC'}
                      </div>
                      <div className="agreement-role-label">
                        Role: <strong>{deal.role || (isBuyer ? 'Buyer' : 'Seller')}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="agreement-details-grid">
                    <div className="agreement-kv">
                      <span>Counterparty</span>
                      <strong>{deal.counterparty || deal.buyerWhatsapp || deal.sellerWhatsapp || deal.sellerUserId || 'Contractor'}</strong>
                    </div>
                    <div className="agreement-kv">
                      <span>Created</span>
                      <strong>{new Date(deal.createdAt).toLocaleDateString()}</strong>
                    </div>
                    {deal.fundingTxHash && (() => {
                      const link = explorerLink({ txHash: deal.fundingTxHash, network: deal.network || 'solana' });
                      return (
                        <div className="agreement-kv" style={{ gridColumn: '1 / -1' }}>
                          <span>Vault Transaction Proof</span>
                          <strong>
                            {link ? (
                              <a
                                href={link.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: '#007ac7', textDecoration: 'underline' }}
                              >
                                {shortHash(deal.fundingTxHash)} ↗
                              </a>
                            ) : (
                              <span>{shortHash(deal.fundingTxHash)}</span>
                            )}
                          </strong>
                        </div>
                      );
                    })()}
                  </div>

                  <div className="agreement-footer-actions">
                    <div style={{ fontSize: '12px', color: '#5a6678' }}>
                      Status: <strong style={{ color: '#10182b', textTransform: 'capitalize' }}>{st.replace(/_/g, ' ')}</strong>
                    </div>

                    <div className="agreement-action-buttons">
                      {(st === 'pending_payment' || st === 'pending_funding' || st === 'draft' || st === 'pending') && isBuyer && (
                        <>
                          <button
                            disabled={isLoading}
                            onClick={() => handleFund(deal)}
                            className="primary-btn small"
                          >
                            {isLoading ? 'Locking...' : 'Lock Funds in Vault →'}
                          </button>
                          <button
                            disabled={isLoading}
                            onClick={() => handleCancel(deal)}
                            className="ghost-btn small"
                            style={{ color: '#ef4444' }}
                          >
                            Cancel
                          </button>
                        </>
                      )}

                      {(st === 'funded' || st === 'in_delivery') && (
                        <button
                          disabled={isLoading}
                          onClick={() => handleDeliver(deal)}
                          className="primary-btn small"
                          style={{ background: '#16856d', borderColor: '#16856d' }}
                        >
                          {isLoading ? 'Submitting...' : 'Mark Delivered ✓'}
                        </button>
                      )}

                      {st === 'delivered' && isBuyer && (
                        <button
                          disabled={isLoading}
                          onClick={() => handleRelease(deal)}
                          className="primary-btn small"
                          style={{ background: '#007ac7', borderColor: '#007ac7' }}
                        >
                          {isLoading ? 'Releasing...' : 'Approve & Release Funds ↗'}
                        </button>
                      )}

                      {deal.fundingTxHash && (() => {
                        const link = explorerLink({ txHash: deal.fundingTxHash, network: deal.network || 'solana' });
                        if (!link) return null;
                        return (
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="ghost-btn small"
                          >
                            {link.label} Proof ↗
                          </a>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </article>

      {showDraftModal && (
        <div className="sv-modal-backdrop" onClick={() => setShowDraftModal(false)} role="presentation" style={{ zIndex: 9999 }}>
          <div className="sv-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="sv-modal-head">
              <button className="sv-modal-close" onClick={() => setShowDraftModal(false)} aria-label="Close">×</button>
              <span className="sv-modal-eyebrow">Multi-Chain Vault Protocol</span>
              <h2>Draft Service Agreement</h2>
              <p className="sv-modal-sub">
                Create a non-custodial milestone agreement. Funds remain protected in the on-chain vault until deliverables are verified.
              </p>
            </div>

            <form onSubmit={handleCreateDraft} className="sv-modal-body">
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
                  style={{ width: '100%', minHeight: '44px', padding: '0 14px', borderRadius: '12px', border: '1px solid rgba(1, 142, 232, 0.2)' }}
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
                  style={{ width: '100%', minHeight: '44px', padding: '0 14px', borderRadius: '12px', border: '1px solid rgba(1, 142, 232, 0.2)' }}
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
                    style={{ width: '100%', minHeight: '44px', padding: '0 12px', borderRadius: '12px', border: '1px solid rgba(1, 142, 232, 0.2)' }}
                  >
                    <option value="solana">Solana (Instant / Low Fee)</option>
                    <option value="base">Base (USDC Rail)</option>
                    <option value="celo">Celo (Mobile-First)</option>
                    <option value="stellar">Stellar (Cross-Border)</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5a6678', marginBottom: '6px', fontWeight: 700 }}>
                    Milestone Count
                  </label>
                  <select
                    value={milestones}
                    onChange={(e) => setMilestones(e.target.value)}
                    style={{ width: '100%', minHeight: '44px', padding: '0 12px', borderRadius: '12px', border: '1px solid rgba(1, 142, 232, 0.2)' }}
                  >
                    <option value="1">1 Milestone (Full)</option>
                    <option value="2">2 Milestones (50% / 50%)</option>
                    <option value="3">3 Milestones</option>
                  </select>
                </div>
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
                      className={`preset-amount-btn ${amount === preset ? 'active' : ''}`}
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
                  style={{ width: '100%', minHeight: '44px', padding: '0 14px', borderRadius: '12px', border: '1px solid rgba(1, 142, 232, 0.2)', fontFamily: 'var(--mono)' }}
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
    </section>
  );
}

export default ServiceAgreementsView;

