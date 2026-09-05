import React, { useState, useMemo } from 'react';
import type { ServiceAgreementsSummary, ServiceAgreementDeal, UserRecord, ServiceAgreement } from '../../types';
import { AgreementCountdownBadge } from './AgreementCountdownBadge';

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

  // Draft form state
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('5');
  const [deliverables, setDeliverables] = useState('');
  const [milestones, setMilestones] = useState('2');
  const [network, setNetwork] = useState('solana');
  const [deadlineDays, setDeadlineDays] = useState('7');

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
      if (['funded', 'in_delivery', 'delivered'].includes(st)) {
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
      setSuccessBanner(`Agreement ${agreementId} funded successfully! Funds locked in non-custodial vault.`);
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
      setSuccessBanner(`Work marked as delivered for ${agreementId}. Client notified for milestone payout.`);
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
          deadlineDays: Number(deadlineDays) || 7
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
    <div className="space-y-6 animate-fade-in" style={{ padding: '4px 0' }}>
      {/* Header section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-md">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white tracking-tight">Service Agreements</h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              WebMCP Protocol
            </span>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            Non-custodial, milestone-based multi-chain agreements across Web, Telegram, and AI agents.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onRefresh()}
            className="px-4 py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:text-white bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 transition-colors"
          >
            ↻ Refresh
          </button>
          <button
            onClick={() => setShowDraftModal(true)}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 shadow-lg shadow-emerald-600/20 transition-all flex items-center gap-2"
          >
            <span>+</span> Draft Agreement
          </button>
        </div>
      </div>

      {/* Alert banners */}
      {errorBanner && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center justify-between">
          <span>{errorBanner}</span>
          <button onClick={() => setErrorBanner(null)} className="text-red-400 font-bold hover:text-red-300">✕</button>
        </div>
      )}
      {successBanner && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm flex items-center justify-between">
          <span>{successBanner}</span>
          <button onClick={() => setSuccessBanner(null)} className="text-emerald-400 font-bold hover:text-emerald-300">✕</button>
        </div>
      )}

      {/* Top Stats Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-5">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Deals</div>
          <div className="text-2xl font-bold text-white mt-1">{stats.activeCount}</div>
          <div className="text-xs text-emerald-400 mt-1">In progress & awaiting release</div>
        </div>

        <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-5">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Total Value Locked</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">${stats.tvl.toFixed(2)} USDC</div>
          <div className="text-xs text-slate-400 mt-1">Protected in multi-chain vaults</div>
        </div>

        <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-5">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Completed Deals</div>
          <div className="text-2xl font-bold text-white mt-1">{stats.completedCount}</div>
          <div className="text-xs text-slate-400 mt-1">Milestones settled & released</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-2 p-1 bg-slate-900/60 border border-slate-800 rounded-xl">
          <button
            onClick={() => setFilter('all')}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              filter === 'all'
                ? 'bg-slate-700 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            All ({deals.length})
          </button>
          <button
            onClick={() => setFilter('active')}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              filter === 'active'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Active ({stats.activeCount})
          </button>
          <button
            onClick={() => setFilter('completed')}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              filter === 'completed'
                ? 'bg-slate-700 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Completed ({stats.completedCount})
          </button>
        </div>

        <div className="relative flex-1 sm:max-w-xs">
          <input
            type="text"
            placeholder="Search agreement, handle, or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>
      </div>

      {/* Agreements List / Feed */}
      <div className="space-y-3">
        {filteredDeals.length === 0 ? (
          <div className="bg-slate-900/30 border border-slate-800/60 rounded-2xl p-12 text-center">
            <div className="text-4xl mb-3">📜</div>
            <h3 className="text-base font-semibold text-white">No Service Agreements found</h3>
            <p className="text-slate-400 text-xs mt-1 max-w-sm mx-auto">
              {searchQuery
                ? 'No agreements match your search query.'
                : 'You have no active or historical agreements yet. Draft one now or prompt Sivan AI on Telegram or WebMCP.'}
            </p>
            <div className="mt-5">
              <button
                onClick={() => setShowDraftModal(true)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 transition-colors"
              >
                + Draft First Agreement
              </button>
            </div>
          </div>
        ) : (
          filteredDeals.map((deal) => {
            const agreementId = deal.id || deal.escrowId;
            const isBuyer = deal.role === 'buyer' || deal.buyerUserId === user?.id;
            const isSeller = deal.role === 'seller' || deal.sellerUserId === user?.id;
            const st = String(deal.status || '').toLowerCase();
            const networkLabel = (deal.network || 'solana').toUpperCase();
            const isLoading = actionLoadingId === agreementId;

            // Generate agreement structure for AgreementCountdownBadge
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
              countdownLabel: deal.countdownLabel || deal.statusLabel || (st === 'funded' ? '⏱ In Delivery' : st === 'delivered' ? '✅ Delivered — awaiting release' : st === 'released' ? '✅ Released' : '⏳ Awaiting payment'),
              reminder6hSent: false,
              overdueNoticeSent: false,
              fundedAt: deal.fundedAt || null,
              deliveredAt: deal.deliveredAt || null,
              releasedAt: deal.releasedAt || null,
              createdAt: deal.createdAt,
              updatedAt: deal.updatedAt || deal.createdAt
            };

            return (
              <div
                key={agreementId}
                className="bg-slate-900/50 hover:bg-slate-900/80 border border-slate-800/80 rounded-2xl p-5 transition-all space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-medium text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded">
                        {agreementId}
                      </span>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        {networkLabel}
                      </span>
                      {deal.channel && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                          {deal.channel === 'telegram' ? 'Telegram @Sivan_Ai' : deal.channel === 'webmcp' ? 'WebMCP Agent' : 'Web App'}
                        </span>
                      )}
                      <AgreementCountdownBadge agreement={agreementObj} />
                    </div>
                    <h3 className="text-base font-semibold text-white mt-1">
                      {deal.title}
                    </h3>
                  </div>

                  <div className="text-right flex sm:flex-col items-baseline sm:items-end justify-between gap-1">
                    <div className="text-lg font-bold text-emerald-400">
                      {deal.amount} {deal.currency || 'USDC'}
                    </div>
                    <div className="text-xs text-slate-400">
                      Role: <span className="font-semibold text-slate-300 capitalize">{deal.role || (isBuyer ? 'Buyer' : 'Seller')}</span>
                    </div>
                  </div>
                </div>

                {/* Scope & Counterparty info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-400 bg-slate-950/40 p-3 rounded-xl border border-slate-800/40">
                  <div>
                    <span className="text-slate-500">Counterparty: </span>
                    <span className="text-slate-300 font-medium">{deal.counterparty || deal.buyerWhatsapp || deal.sellerWhatsapp || deal.sellerUserId || 'Contractor'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Created: </span>
                    <span className="text-slate-300 font-medium">{new Date(deal.createdAt).toLocaleDateString()}</span>
                  </div>
                  {deal.fundingTxHash && (
                    <div className="col-span-full truncate">
                      <span className="text-slate-500">Vault Tx: </span>
                      <span className="text-blue-400 font-mono text-[11px]">{deal.fundingTxHash}</span>
                    </div>
                  )}
                </div>

                {/* Interactive Action Controls */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800/60 flex-wrap">
                  <div className="text-xs text-slate-500">
                    Status: <span className="text-slate-300 font-medium capitalize">{st.replace('_', ' ')}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Pending state -> Buyer can Fund */}
                    {st === 'pending_payment' && isBuyer && (
                      <>
                        <button
                          disabled={isLoading}
                          onClick={() => handleFund(deal)}
                          className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 transition-colors"
                        >
                          {isLoading ? 'Locking...' : 'Lock Funds in Vault →'}
                        </button>
                        <button
                          disabled={isLoading}
                          onClick={() => handleCancel(deal)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    )}

                    {/* Funded/In delivery state -> Seller can Deliver */}
                    {(st === 'funded' || st === 'in_delivery') && (
                      <button
                        disabled={isLoading}
                        onClick={() => handleDeliver(deal)}
                        className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-50 transition-colors"
                      >
                        {isLoading ? 'Submitting...' : 'Mark Delivered ✓'}
                      </button>
                    )}

                    {/* Delivered state -> Buyer can Release payout */}
                    {st === 'delivered' && (
                      <button
                        disabled={isLoading}
                        onClick={() => handleRelease(deal)}
                        className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                      >
                        {isLoading ? 'Releasing...' : 'Approve & Release Payout ✓'}
                      </button>
                    )}

                    {/* Released state */}
                    {st === 'released' && (
                      <span className="text-xs text-emerald-400 font-semibold px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/20">
                        ✓ Milestone Settled & Released
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Draft New Agreement Modal */}
      {showDraftModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl relative space-y-5 animate-scale-in">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">Draft Service Agreement</h3>
                <p className="text-xs text-slate-400 mt-0.5">Non-custodial milestone vault with automated on-chain locking.</p>
              </div>
              <button
                onClick={() => setShowDraftModal(false)}
                className="text-slate-400 hover:text-white p-1"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateDraft} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Counterparty (Username, Email, or Wallet Address)
                </label>
                <input
                  type="text"
                  required
                  placeholder="@soliame or email or address"
                  value={counterparty}
                  onChange={(e) => setCounterparty(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Agreement Amount (USDC)
                </label>
                <div className="flex gap-2 mb-2">
                  {['5', '10', '20', '50'].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setAmount(amt)}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                        amount === amt
                          ? 'bg-emerald-600 text-white'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      ${amt} USDC
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  required
                  min="1"
                  max="1000"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Deliverables & Scope of Work
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="e.g. Design 3 mobile UI screens in Figma and deliver export assets within 7 days."
                  value={deliverables}
                  onChange={(e) => setDeliverables(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Milestones
                  </label>
                  <select
                    value={milestones}
                    onChange={(e) => setMilestones(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="1">1 Milestone (Full)</option>
                    <option value="2">2 Milestones (50% / 50%)</option>
                    <option value="3">3 Milestones</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Blockchain Network
                  </label>
                  <select
                    value={network}
                    onChange={(e) => setNetwork(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="solana">Solana Devnet</option>
                    <option value="base">Base Sepolia</option>
                    <option value="stellar">Stellar Testnet</option>
                    <option value="celo">Celo Alfajores</option>
                  </select>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-400">
                🔒 Funds will only be locked in the non-custodial vault once you review and approve the agreement.
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDraftModal(false)}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-white bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                >
                  {submitting ? 'Creating...' : 'Create Agreement →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default ServiceAgreementsView;
