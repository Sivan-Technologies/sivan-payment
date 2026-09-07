import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import type { CustomerRecord, DepositResponse, ExternalAccountRecord, AssetControl, FeePolicy, NetworkControl, OfframpControls, PaymentControl, SystemStatus, UserRecord, ViewKey, WithdrawalRecord, OnrampOrderRecord, SupportTicketRecord, UserPreferencesRecord, IdentityStatus, TransactionTimeline, VirtualAccountControl, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord, SupplierRecord, SupplierPaymentRecord, BalanceSummary, BalanceTransferRecord, VerificationSummary, FlowAllowance } from '../types';
import { BRIDGE_CURRENCIES, CURRENCY_LABELS, isBridgeCurrency, RAIL_LABELS, formatPayoutAmount, isNgnCurrency, payoutRailFor, type PayoutCurrency } from '../rails';
import { networkLabel } from '../blockExplorer';
import { approximateNote, formatFromNgn, isConverted, type DisplayCurrency } from '../displayCurrency';
import type { DisplayFx } from '../types';
import { NgnPayoutForm } from './sell/NgnPayoutForm';

/**
 * A gas estimate the user can believe.
 *
 * Fixed 2dp turned Solana's real cost (~$0.0008) into "$0.00", which on a
 * confirmation screen reads as "free" rather than "very small". Both are
 * wrong to state, but claiming zero is the one that becomes a complaint when
 * a fee later appears.
 */
export function formatGasUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.0001) return 'under $0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}


function statusClass(status?: string) {
  if (!status) return 'pending';
  if (['completed', 'kyc_approved', 'verified', 'active'].includes(status)) return 'success';
  if (['failed', 'cancelled', 'kyc_rejected'].includes(status)) return 'danger';
  return 'pending';
}

function friendlyStatus(status?: string) {
  const map: Record<string, string> = { created: 'Started', kyc_not_started: 'Not started', kyc_approved: 'Verified', kyc_under_review: 'Under review', kyc_incomplete: 'Action required', kyc_rejected: 'Verification failed', pending: 'Pending', approved: 'Approved', pending_deposit: 'Waiting for USDC', deposit_received: 'Deposit received', payout_processing: 'Sending to bank', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', requires_action: 'Action required', verified: 'Verified', active: 'Active' };
  return status ? map[status] || status.replaceAll('_', ' ') : 'Not started';
}

function kycNoticeKind(status?: string) {
  if (status === 'kyc_approved') return 'success';
  if (status === 'kyc_under_review') return 'review';
  if (['kyc_rejected', 'failed', 'cancelled'].includes(status || '')) return 'failed';
  if (status === 'kyc_incomplete') return 'action';
  return 'neutral';
}

function Badge({ children, status }: { children: string; status?: string }) { return <span className={`badge ${statusClass(status)}`}>{children}</span>; }
function Empty({ children }: { children: string }) { return <div className="empty-state">{children}</div>; }
function getForm(form: HTMLFormElement) { return Object.fromEntries(new FormData(form).entries()) as Record<string, string>; }
function digitsOnly(value?: string) { return String(value || '').replace(/\D/g, ''); }
function normalizeNgnDateOfBirth(value?: string) {
  const raw = String(value || '').trim();
  const iso = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  const local = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (local) return `${local[1]}-${local[2]}-${local[3]}`;
  return raw;
}
function shortRef(value?: string) { if (!value) return '—'; if (value.length <= 14) return value; return `${value.slice(0, 8)}…${value.slice(-6)}`; }
function timeAgo(value?: string, nowMs = Date.now()) { if (!value) return 'Now'; const then = new Date(value).getTime(); if (!Number.isFinite(then)) return 'Recently'; const seconds = Math.max(0, Math.floor((nowMs - then) / 1000)); if (seconds < 60) return 'Just now'; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; const days = Math.floor(hours / 24); if (days < 7) return `${days}d ago`; return new Date(value).toLocaleDateString(); }
function initials(nameOrEmail?: string) { const value = (nameOrEmail || 'Sivan User').trim(); const parts = value.includes('@') ? value.split('@')[0].split(/[._-]+/) : value.split(/\s+/); return parts.slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || 'SU'; }
function qrUrl(value: string) { return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(value)}`; }

function CustomSelect({ name, options, value, defaultValue, onChange, disabled = false }: { name: string; options: Array<{ value: string; label: string; helper?: string; disabled?: boolean }>; value?: string; defaultValue?: string; onChange?: (value: string) => void; disabled?: boolean }) {
  const firstEnabled = options.find((option) => !option.disabled)?.value || options[0]?.value || '';
  const [internalValue, setInternalValue] = useState(defaultValue || value || firstEnabled);
  const [open, setOpen] = useState(false);
  const selectedValue = value ?? internalValue;
  const selected = options.find((option) => option.value === selectedValue) || options.find((option) => !option.disabled) || options[0];
  const choose = (next: string) => { setInternalValue(next); onChange?.(next); setOpen(false); };
  return <div className="custom-select-wrap app-select-wrap"><input type="hidden" name={name} value={selected?.value || ''} /><button type="button" disabled={disabled} className={`custom-select-trigger ${open ? 'open' : ''}`} onClick={() => !disabled && setOpen((state) => !state)}><span><strong>{selected?.label || 'Select'}</strong>{selected?.helper && <small>{selected.helper}</small>}</span><em>⌄</em></button>{open && <div className="custom-select-menu app-select-menu">{options.map((option) => <button type="button" disabled={option.disabled} className={option.value === selected?.value ? 'selected' : ''} key={option.value} onClick={() => !option.disabled && choose(option.value)}><span>{option.label}</span>{option.helper && <small>{option.helper}</small>}</button>)}</div>}</div>;
}

const legalLinks = { terms: 'https://www.sivantech.online/legal/terms', privacy: 'https://www.sivantech.online/legal/privacy', risk: 'https://www.sivantech.online/legal/risk-disclosure', dataRetention: 'https://www.sivantech.online/legal/data-retention', amlKyc: 'https://www.sivantech.online/legal/aml-kyc', jurisdictions: 'https://www.sivantech.online/legal/supported-jurisdictions', wrongNetwork: 'https://www.sivantech.online/legal/wrong-network', complaints: 'https://www.sivantech.online/legal/complaints', cookies: 'https://www.sivantech.online/legal/cookies' };

type UserNotification = { id: string; icon: string; title: string; message: string; severity: 'info' | 'action' | 'urgent'; createdAt: string; actionLabel?: string; view?: ViewKey; };
type UserTwoFactorStatus = { userId: string; enabled: boolean; enabledAt?: string; lastVerifiedAt?: string; recoveryCodesRemaining?: number; };


export { LandingPage } from './landing/LandingPage';
export { PublicSidebarCta, KpiCard, DashboardTransactions, TwoFactorRecommendationCard, DashboardSetupPanel } from './dashboard/DashboardSections';

function OnRampView({ hasUser, isVerified, onGetStarted }: { hasUser: boolean; isVerified: boolean; onGetStarted: () => void }) {
  return (
    <section className="panel-grid two onramp-view">
      <article className="panel form-panel onramp-hero-card">
        <p className="eyebrow">Buy stablecoins</p>
        <h3>On-ramp experience prepared for rollout</h3>
        <p className="muted">Sivan can support the buy-side product experience, but live on-ramp actions should remain gated until the backend/provider rails are implemented and tested end to end.</p>
        <div className="details-box">
          <Kv label="Current access" value={hasUser ? isVerified ? 'Account ready' : 'Verification required' : 'Create account first'} />
          <Kv label="Planned assets" value="USDC / USDT" />
          <Kv label="Status" value="Provider rollout pending" />
          <Kv label="NGN" value="Supported" />
        </div>
        <button className="primary-btn" onClick={onGetStarted}>{hasUser ? isVerified ? 'Manage bank accounts' : 'Verify account' : 'Get started'}</button>
      </article>
      <article className="panel">
        <div className="panel-head"><div><p className="eyebrow">Future flow</p><h3>Fiat to stablecoin</h3></div></div>
        <div className="onramp-steps">
          <ProgressItem done={hasUser} label="Create or sign in" />
          <ProgressItem done={isVerified} label="Complete verification" />
          <ProgressItem done={false} label="Choose fiat payment method" />
          <ProgressItem done={false} label="Receive stablecoins to your wallet" />
        </div>
        <div className="verification-note">This screen is intentionally not creating live buy orders yet. We will wire it to real on-ramp APIs once those backend rails are ready.</div>
      </article>
    </section>
  );
}


/**
 * What the user is about to confirm.
 *
 * Carries fields for BOTH rails, because the review step is shared and the
 * rail is decided by destinationCurrency. The NGN fields are optional rather
 * than a separate type: a discriminated union would be cleaner in isolation
 * but would fork every component that renders a review, for two extra strings.
 *
 *   Bridge  externalAccountId -> POST /api/withdrawals
 *   Breet   quoteId + bankId + accountNumber -> POST /api/ngn/offramp/orders
 */
export type WithdrawalReviewState = {
  userId: string;
  externalAccountId: string;
  sourceCurrency: string;
  sourceChain: string;
  destinationCurrency: string;
  returnAddress?: string;
  bankLabel: string;
  assetLabel: string;
  networkLabel: string;
  /** NGN rail only. Breet settles against an accepted quote, not an account id. */
  quoteId?: string;
  bankId?: string;
  accountNumber?: string;
  /**
   * The fee the user was actually quoted, in cash.
   *
   * The confirm screen showed only a PERCENTAGE while the quote card behind it
   * showed naira and USDC. A user who has just read "Sivan fee ₦765 · 0.51
   * USDC" and then sees "SIVAN FEE 1.25%" has to work out whether those are
   * the same charge - and on the naira rail they were not, because the
   * percentage came from the Bridge policy.
   *
   * Carried from the accepted quote so the final screen restates the number
   * the user agreed to rather than recomputing one.
   */
  feeSummary?: {
    /** Naira equivalent, already rounded to whole naira. */
    ngn?: string;
    /** The same fee in the source asset. */
    asset?: string;
    /** Effective rate, for the label. */
    percent?: string;
  };
  /** What the user receives, restated on the confirm screen. */
  payoutSummary?: { send?: string; receive?: string };
  /** Shown before confirming, so the floor is visible rather than discovered. */
  minimumUsd?: number;
  estimatedGasUsd?: number;
  /**
   * Which of the two things is about to happen, as the user chose it.
   *
   * Set on BOTH rails now. It used to be naira-only, because the Bridge rail
   * genuinely had no such choice - it could only ever hand over an address.
   */
  fundingSource?: 'balance' | 'external';
  /** How much, when funding from the balance. Shown on review before commit. */
  amount?: string;
};

export type WithdrawAssetOption = {
  asset: 'usdc' | 'usdt';
  label: string;
  spendable?: number | null;
  chainUnavailable?: boolean;
};

export function OffRampWizard({ accounts, enabledControls, enabledAssets, enabledNetworks, primaryAccount, withdrawalReview, depositResult, feePercent, ngnFeePercent, loading, canCreatePaymentActions, onSubmit, onCancelReview, onConfirm, ngnMode, ngnUserId, ngnApi, ngnNetwork, ngnNetworkOptions, onNgnNetworkChange, ngnAsset = 'usdc', onNgnAssetChange, withdrawAssetOptions = [], ngnMinimumUsd, ngnRemainingNgn, ngnSpendable, ngnWindowDays, ngnExternalFundingEnabled, ngnThirdPartyPayoutsEnabled, onNgnReady, onExitNgn, onEnterNgn, ngnAvailable }: {

  /** True when the user is withdrawing to a Nigerian bank. */
  ngnMode?: boolean;
  ngnUserId?: string;
  ngnApi?: <T>(path: string, options?: RequestInit) => Promise<T>;
  /**
   * The currently selected chain. May be '' before /api/ngn/networks answers,
   * which is a real state and not a bug - see the NgnPayoutForm guard.
   */
  ngnNetwork?: string;
  /**
   * Every chain this user may off-ramp on, from the server. Admin's enabled
   * networks intersected with what Breet can actually settle for the asset.
   *
   * Passed in rather than derived here so there is ONE list. The previous
   * `ngnNetwork = 'solana'` default was a second opinion about the same
   * question, and it disagreed with this one for anybody not on Solana.
   */
  ngnNetworkOptions?: Array<{ network: string; minimumDepositUsd?: number }>;
  onNgnNetworkChange?: (network: string) => void;
  ngnAsset?: 'usdc' | 'usdt';
  onNgnAssetChange?: (asset: 'usdc' | 'usdt') => void;
  withdrawAssetOptions?: WithdrawAssetOption[];

  ngnMinimumUsd?: number;
  /** Remaining NGN headroom from the server. Never computed in the UI. */
  ngnRemainingNgn?: number | null;
  /**
   * Spendable balance for the sell asset. undefined = still loading,
   * null = could not be read. Neither is zero.
   */
  ngnSpendable?: number | null;
  ngnWindowDays?: number;
  onNgnReady?: (payload: { quote: any; account: any; fundingSource: 'balance' | 'external' }) => void;
  /** Admin toggle: may the withdraw screen offer "I'll send crypto myself"? */
  ngnExternalFundingEnabled?: boolean;
  /** Admin toggle: may the withdraw screen offer "Pay someone else"? */
  ngnThirdPartyPayoutsEnabled?: boolean;
  onExitNgn?: () => void;
  onEnterNgn?: () => void;
  /** Whether the NGN rail has any usable off-ramp network right now. */
  ngnAvailable?: boolean;
  accounts: ExternalAccountRecord[];
  enabledControls: PaymentControl[];
  enabledAssets: AssetControl[];
  enabledNetworks: NetworkControl[];
  primaryAccount?: ExternalAccountRecord;
  withdrawalReview: WithdrawalReviewState | null;
  depositResult: DepositResponse | null;
  feePercent?: string;
  /** The naira rail's own Sivan rate, from the NGN controls. */
  ngnFeePercent?: string;
  loading: boolean;
  canCreatePaymentActions: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancelReview: () => void;
  onConfirm: () => void;
}) {
  const hasEnabledBank = accounts.some((account) => enabledControls.some((control) => control.currency === account.currency));
  const step = depositResult ? 3 : withdrawalReview ? 2 : 1;
  /**
   * Lifted out of the form so the SIDE PANEL and the STEPPER can describe the
   * same flow the form is in. Kept here rather than in App.tsx because it is
   * presentation state - the server is told about it via a hidden field on
   * submit, and the review object carries it from step 2 onward.
   */
  const [bridgeFunding, setBridgeFunding] = useState<'balance' | 'external'>('balance');
  const balanceFunded = !ngnMode && (withdrawalReview?.fundingSource ?? bridgeFunding) === 'balance';
  return (
    <section className="offramp-wizard">
      <div className="trade-head">
        <div>
          <p className="eyebrow">Withdraw to your bank</p>
          <h3>Withdraw to your bank</h3>
          <p className="muted">{balanceFunded ? "Choose a verified bank account, asset, and amount. We'll move the crypto from your Sivan balance." : "Choose a verified bank account, asset, and network. Review carefully before a deposit address is created."}</p>
        </div>
        <div className="wizard-stepper">
          <StepDot active={step === 1} done={step > 1} label="Details" />
          <StepDot active={step === 2} done={step > 2} label="Review" />
          <StepDot active={step === 3} done={false} label={balanceFunded ? "Sending" : "Deposit"} />
        </div>
      </div>
      {step === 1 && ngnAvailable && (
        // The rail is chosen explicitly rather than inferred from a saved
        // account, because a Nigerian user has no saved account to infer from
        // until this flow creates one.
        <div className="seg">
          <button type="button" className={!ngnMode ? 'active' : ''} onClick={onExitNgn}>Bank transfer (USD · GBP · EUR)</button>
          <button type="button" className={ngnMode ? 'active' : ''} onClick={onEnterNgn}>Nigerian bank (NGN)</button>
        </div>
      )}
      <div className="trade-grid">
        <div>
          {step === 1 && ngnMode
            // Naira needs a different first step entirely: a NUBAN and a
            // quote, not a saved Bridge external account. Bridge account
            // shapes (routing number, sort code, IBAN) cannot express one.
            // network falls back to '' - NOT to a chain. '' means "not
            // resolved yet" and NgnPayoutForm refuses to quote on it; any real
            // default here would be a guess at where someone's money lives.
            ? <NgnPayoutForm userId={ngnUserId ?? ''} api={ngnApi!} network={ngnNetwork ?? ''} networkOptions={ngnNetworkOptions ?? []} onNetworkChange={onNgnNetworkChange} asset={ngnAsset} assetOptions={withdrawAssetOptions} onAssetChange={onNgnAssetChange} breetMinimumUsd={ngnMinimumUsd} remainingNgn={ngnRemainingNgn} spendable={ngnSpendable} windowDays={ngnWindowDays} externalFundingEnabled={ngnExternalFundingEnabled} thirdPartyPayoutsEnabled={ngnThirdPartyPayoutsEnabled} onReady={onNgnReady!} onCancel={onExitNgn!} />

            // The balance and the external-funding toggle are the SAME values
            // the naira form already receives. Reusing them rather than adding
            // parallel props keeps one source of truth for "how much can this
            // user spend" across both rails.
            : step === 1 && <WithdrawalDetailsForm accounts={accounts} enabledControls={enabledControls} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} primaryAccount={primaryAccount} hasEnabledBank={hasEnabledBank} loading={loading} canCreatePaymentActions={canCreatePaymentActions} onSubmit={onSubmit} assetOptions={withdrawAssetOptions} externalFundingEnabled={ngnExternalFundingEnabled} fundingSource={bridgeFunding} onFundingSourceChange={setBridgeFunding} />}
          {step === 2 && <WithdrawalReviewCard review={withdrawalReview} feePercent={feePercent} ngnFeePercent={ngnFeePercent} loading={loading} onCancel={onCancelReview} onConfirm={onConfirm} />}
          {step === 3 && <DepositCard result={depositResult} />}
        </div>
        <OffRampSidePanel step={step} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} balanceFunded={balanceFunded} />
      </div>
    </section>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return <div className={`step-node ${active ? 'active' : ''} ${done ? 'done' : ''}`}><span>{done ? '✓' : active ? '•' : ''}</span>{label}</div>;
}

function WithdrawalDetailsForm({ accounts, enabledControls, enabledAssets, enabledNetworks, primaryAccount, hasEnabledBank, loading, canCreatePaymentActions, onSubmit, assetOptions = [], externalFundingEnabled, fundingSource, onFundingSourceChange }: {
  accounts: ExternalAccountRecord[];
  enabledControls: PaymentControl[];
  enabledAssets: AssetControl[];
  enabledNetworks: NetworkControl[];
  primaryAccount?: ExternalAccountRecord;
  hasEnabledBank: boolean;
  loading: boolean;
  canCreatePaymentActions: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /**
   * Spendable balance for the deposit asset. undefined = still loading,
   * null = could not be READ. Neither of those is zero, and showing "0.00"
   * for either would tell the user they have no money when we simply do not
   * know yet.
   */
  assetOptions?: WithdrawAssetOption[];
  /** Admin toggle, shared with the naira rail: may we offer manual send? */
  externalFundingEnabled?: boolean;
  /** Owned by the wizard, so the side panel can describe the same flow. */
  fundingSource: 'balance' | 'external';
  onFundingSourceChange: (next: 'balance' | 'external') => void;
}) {
  /**
   * THE FOREIGN RAIL CAN NOW BE FUNDED FROM THE SIVAN BALANCE.
   *
   * It could not before, and the omission was invisible: this screen looked
   * exactly like the naira one, which HAS self-funded from the Privy wallet
   * for a while. A user holding USDC in Sivan who wanted dollars in their bank
   * was quietly handed an address and left to send the crypto by hand from a
   * wallet Sivan already controls and can already sign for.
   *
   * Defaults to 'balance' for the same reason the naira form does: it is the
   * path that works without the user touching a wallet app, and manual send is
   * behind the same admin toggle.
   */
  const canFundExternally = externalFundingEnabled !== false;
  const setFundingSource = onFundingSourceChange;
  const [amount, setAmount] = useState('');
  const firstAsset = assetOptions[0]?.asset ?? enabledAssets[0]?.asset ?? 'usdc';
  const [selectedAsset, setSelectedAsset] = useState<'usdc' | 'usdt'>(firstAsset);
  const assetUserChosen = useRef(false);

  const effectiveFunding = canFundExternally ? fundingSource : 'balance';
  const selectableAssets: WithdrawAssetOption[] = (assetOptions.length ? assetOptions : enabledAssets.map((asset) => ({ asset: asset.asset, label: asset.label })))
    .filter((asset) => asset.asset === 'usdc' || asset.asset === 'usdt');
  const selectedAssetBalance = assetOptions.find((option) => option.asset === selectedAsset);
  const selectedSpendable = selectedAssetBalance?.spendable;
  const selectedAssetLabel = selectedAssetBalance?.label || enabledAssets.find((asset) => asset.asset === selectedAsset)?.label || selectedAsset.toUpperCase();
  const amountUsd = Number(amount);
  const balanceKnown = effectiveFunding === 'balance' && typeof selectedSpendable === 'number';
  // Only a REAL overdraft, not an empty box. Number('') is 0, which would
  // otherwise light the warning up before the user has typed anything.
  const shortfall = balanceKnown && amount !== '' && Number.isFinite(amountUsd) && amountUsd > selectedSpendable!
    ? amountUsd - selectedSpendable!
    : 0;

  useEffect(() => {
    if (!selectableAssets.length) return;
    const current = selectableAssets.find((asset) => asset.asset === selectedAsset);
    if (current && assetUserChosen.current) return;
    if (current && selectedAsset === selectableAssets[0].asset) return;
    setSelectedAsset(selectableAssets[0].asset);
  }, [selectableAssets, selectedAsset]);

  if (!hasEnabledBank) return <article className="panel form-panel trade-card"><p className="eyebrow">Step 1</p><h3>Add a bank first</h3><Empty>Add an enabled bank account before creating a withdrawal.</Empty></article>;
  if (!enabledAssets.length || !enabledNetworks.length) return <article className="panel form-panel trade-card"><p className="eyebrow">Step 1</p><h3>Deposits unavailable</h3><Empty>Deposits are temporarily unavailable.</Empty></article>;
  return (
    <article className="panel form-panel trade-card">
      <p className="eyebrow">Step 1</p>
      {/* Both lines describe a deposit address, which the balance path never
          creates. Left exactly as-is for manual send, where they are correct. */}
      <h3>{effectiveFunding === 'balance' ? 'Choose payout and amount' : 'Choose payout and deposit rail'}</h3>
      <p className="muted">{effectiveFunding === 'balance'
        ? 'We\'ll send this from your Sivan balance to your bank. Nothing to copy, nothing to paste.'
        : 'Your deposit address will be tied to this bank account, token, and network.'}</p>
      <form className="form premium-form" onSubmit={onSubmit}>
        <label>Bank payout
          <CustomSelect name="externalAccountId" defaultValue={primaryAccount?.id} options={accounts.filter((account) => enabledControls.some((control) => control.currency === account.currency)).map((account) => ({ value: account.id, label: account.bankName || 'Bank account', helper: `${account.currency.toUpperCase()} · ****${account.accountLast4 || '----'}` }))} />
        </label>
        <div className="split">
          <label>Deposit asset<CustomSelect name="sourceCurrency" value={selectedAsset} onChange={(value) => { assetUserChosen.current = true; setSelectedAsset(value as 'usdc' | 'usdt'); setAmount(''); }} options={selectableAssets.map((asset) => {
            const disabled = effectiveFunding === 'balance' && typeof asset.spendable === 'number' && asset.spendable <= 0;
            return {
              value: asset.asset,
              label: asset.label,
              helper: asset.spendable === undefined
                ? 'Checking balance'
                : asset.spendable === null
                  ? 'Balance unavailable'
                  : `${asset.spendable.toFixed(2)} ${asset.asset.toUpperCase()} available`,
              disabled,
            };
          })} /></label>
          <label>Deposit network<CustomSelect name="sourceChain" defaultValue={enabledNetworks.find((network) => network.isDefault)?.network || enabledNetworks[0]?.network || 'solana'} options={enabledNetworks.map((network) => ({ value: network.network, label: network.label }))} /></label>
        </div>

        {/* Same choice, same words, same default as the naira rail. Two
            withdraw screens that behave differently is the actual defect
            being fixed here, so they are deliberately kept in step. */}
        {canFundExternally && (
          <div className="seg" role="group" aria-label="Where the crypto comes from">
            <button
              type="button"
              className={fundingSource === 'balance' ? 'active' : ''}
              onClick={() => setFundingSource('balance')}
            >
              From my Sivan balance
            </button>
            <button
              type="button"
              className={fundingSource === 'external' ? 'active' : ''}
              onClick={() => setFundingSource('external')}
            >
              I'll send crypto myself
            </button>
          </div>
        )}
        {/* The server decides; this only reports the choice. Sent as a hidden
            field so the existing FormData submit handler needs no special
            case, and so what the UI shows and what the API receives cannot
            disagree. */}
        <input type="hidden" name="fundingSource" value={effectiveFunding} />

        {effectiveFunding === 'balance' && (
          <label>Amount to withdraw ({selectedAsset.toUpperCase()})
            <input
              name="sourceAmount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
            />
            <span className="field-hint">
              {selectedSpendable === undefined
                ? 'Checking your balance…'
                : selectedSpendable === null
                  ? `We couldn't read your ${selectedAsset.toUpperCase()} balance just now. You can still enter an amount.`
                  : `${selectedSpendable.toFixed(2)} ${selectedAsset.toUpperCase()} available to withdraw.`}
            </span>
          </label>
        )}
        {shortfall > 0 && (
          <div className="warning-box compact">
            That's {shortfall.toFixed(2)} more than you have available. Lower the amount
            {canFundExternally ? ', or choose "I\'ll send crypto myself".' : '.'}
          </div>
        )}

        {effectiveFunding === 'external' && (
          <label>Refund wallet address<input name="returnAddress" placeholder="Wallet address for returned funds" defaultValue="0x0000000000000000000000000000000000000000" /></label>
        )}
        {/* The wrong-network warning belongs to the path where the USER sends.
            On the balance path Sivan does the sending, so the warning would
            manufacture a risk that does not exist - the same reasoning already
            applied on the review card. */}
        {effectiveFunding === 'external'
          ? <div className="warning-box compact">You will review these details before a deposit address is created. Send only the selected token on the selected network.</div>
          : <div className="details-box compact"><span>We'll move {selectedAssetLabel} from your Sivan balance automatically. You don't need to send anything.</span></div>}
        <button className="primary-btn" disabled={loading || !canCreatePaymentActions}>{loading ? 'Preparing review...' : canCreatePaymentActions ? 'Review withdrawal' : 'Withdrawals paused'}</button>
      </form>
    </article>
  );
}

function OffRampSidePanel({ step, enabledAssets, enabledNetworks, balanceFunded }: { step: number; enabledAssets: AssetControl[]; enabledNetworks: NetworkControl[]; balanceFunded?: boolean }) {
  return (
    <aside className="side-info-stack">
      {/*
          THE EXPLAINER HAS TO DESCRIBE THE FLOW THE USER IS ACTUALLY IN.

          This panel described one flow - "we give you an address, you send to
          it" - because for the foreign rail that was the only flow there was.
          Now that Sivan can send from the user's balance, the same words are
          wrong on the default path: step 3 told a user to go and send crypto
          that Sivan sends for them, which is the single most confusing thing
          a money screen can do.
      */}
      <article className="panel">
        <p className="eyebrow">How this works</p>
        <h3>{balanceFunded ? 'Paid from your Sivan balance' : 'Provider-backed deposit address'}</h3>
        <ol className="ordered-steps">
          <li className={step >= 1 ? 'active' : ''}>Choose your bank, token, and {balanceFunded ? 'amount.' : 'network.'}</li>
          <li className={step >= 2 ? 'active' : ''}>Review the details {balanceFunded ? 'and confirm.' : 'and safety warning.'}</li>
          <li className={step >= 3 ? 'active' : ''}>{balanceFunded ? 'We move the crypto for you - nothing to send.' : 'Send the selected asset to the generated address.'}</li>
          <li>Track {balanceFunded ? 'conversion and bank payout.' : 'deposit detection, conversion, and bank payout.'}</li>
        </ol>
      </article>
      <article className="panel control-summary-card">
        <p className="eyebrow">Available now</p>
        <div className="rail-chips">{enabledAssets.map((asset) => <span key={asset.asset}>{asset.label}</span>)}</div>
        <div className="rail-chips muted-chips">{enabledNetworks.slice(0, 5).map((network) => <span key={network.network}>{network.label}</span>)}</div>
        <p className="muted">USDT support is controlled from Admin. Users only see enabled assets and networks.</p>
      </article>
    </aside>
  );
}


export function OtpInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const digits = Array.from({ length: 6 }, (_, index) => value[index] || '');

  function setDigit(index: number, next: string) {
    const clean = next.replace(/\D/g, '').slice(-1);
    const values = digits.slice();
    values[index] = clean;
    const joined = values.join('').slice(0, 6);
    onChange(joined);
    if (clean && index < 5) {
      const nextInput = document.querySelector<HTMLInputElement>(`[data-otp-index="${index + 1}"]`);
      nextInput?.focus();
    }
  }

  return (
    <label>Verification code
      <div className="otp-row" onPaste={(event) => {
        event.preventDefault();
        const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
        onChange(pasted);
      }}>
        {digits.map((digit, index) => (
          <input
            key={index}
            data-otp-index={index}
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(event) => setDigit(index, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && !digit && index > 0) {
                document.querySelector<HTMLInputElement>(`[data-otp-index="${index - 1}"]`)?.focus();
              }
            }}
            aria-label={`Verification code digit ${index + 1}`}
          />
        ))}
      </div>
      <input type="hidden" name="code" value={value} />
    </label>
  );
}

function WithdrawalReviewCard({ review, feePercent, ngnFeePercent, loading, onCancel, onConfirm }: { review: WithdrawalReviewState | null; feePercent?: string; /** The naira rail's own rate. Bridge's percentage does not apply to a bank payout. */ ngnFeePercent?: string; loading: boolean; onCancel: () => void; onConfirm: () => void }) {
  if (!review) return null;

  // Naming the rail is deliberate. The user is about to send crypto to an
  // address held by a third party, and which third party is not a detail they
  // should have to infer from the currency.
  const isNgn = isNgnCurrency(review.destinationCurrency);
  const rail = payoutRailFor(review.destinationCurrency as PayoutCurrency);
  /**
   * The rate that actually applies to THIS payout.
   *
   * A naira payout is priced by the NGN rail, not by Bridge - and this card
   * was showing Bridge's 1.25% against a quote charged at 1%.
   */
  const isNgnPayout = isNgnCurrency(review.destinationCurrency as PayoutCurrency);
  const sivanFeeLabel = isNgnPayout
    ? (ngnFeePercent ? `${ngnFeePercent}%` : '—')
    : (feePercent ? `${feePercent}%` : '—');

  /**
   * Cash when we have it, the rail's percentage when we do not.
   *
   * The naira rail accepts a quote before this screen, so the exact fee is
   * known and shown. The Bridge rail creates a liquidation address instead -
   * there is no amount yet, so a percentage is the only honest answer there.
   */
  /**
   * The percentage is dropped here too, so the two screens keep matching.
   *
   * Leaving it would put them back out of sync - the quote card reads "Sivan
   * fee ₦1,148 · 0.765 USDC" and this would read the same figures with a
   * "(1.50%)" the previous screen no longer shows, which is exactly the
   * mismatch this pair of screens was fixed to remove.
   *
   * The Bridge rail still falls back to a bare percentage, because it creates
   * a liquidation address with no amount in existence - there is no cash
   * figure to state there.
   */
  const feeDisplay = review.feeSummary?.ngn
    ? `${review.feeSummary.ngn}${review.feeSummary.asset ? ` · ${review.feeSummary.asset}` : ''}`
    : sivanFeeLabel;

  return (
    <article className="deposit-card review-card">
      <p className="eyebrow">Review withdrawal</p>
      <h3>{review.fundingSource === 'balance' ? 'Confirm your withdrawal' : 'Confirm before creating your deposit address'}</h3>
      <p className="muted">{review.fundingSource === 'balance'
        ? 'Check these details carefully. We\'ll move the crypto from your Sivan balance as soon as you confirm.'
        : 'Check these details carefully. Your deposit address will be tied to the selected asset, network, and bank payout.'}</p>
      <div className="details-box">
        <Kv label="Asset" value={review.assetLabel} />
        {/* networkLabel(), for the same reason the deposit warning uses it:
            review.networkLabel carries the raw chain string, so this rendered
            "NETWORK solana" on the confirmation screen. */}
        <Kv label="Network" value={networkLabel(review.networkLabel)} />
        <Kv label="Bank payout" value={review.bankLabel} />
        <Kv label="Payout currency" value={CURRENCY_LABELS[review.destinationCurrency as PayoutCurrency] ?? review.destinationCurrency.toUpperCase()} />
        <Kv label="Settlement" value={RAIL_LABELS[rail]} />
        {review.minimumUsd !== undefined && <Kv label="Minimum for this network" value={`$${review.minimumUsd.toFixed(2)}`} />}
        {/*
            A SUB-CENT FEE IS NOT ZERO.

            toFixed(2) rendered Solana's real cost - about $0.0008 - as
            "$0.00", which reads as "this is free" on the screen where someone
            decides whether to go ahead. Small values now keep enough digits to
            be true, and anything genuinely below a hundredth of a cent is
            called what it is rather than rounded away.
        */}
        {/*
            NETWORK FEE REMOVED FROM THE NAIRA PAYOUT.
 
            On a bank payout the user is not paying gas - Sivan sponsors it -
            and the amount is $0.0010. Listing a cost the user does not bear,
            in dollars, on a screen whose every other figure is naira, adds a
            number to reconcile and answers no question they have. "Sivan fee"
            is the honest single line, and it is the one they asked for.
 
            KEPT for the foreign/crypto rails, where the gas estimate is a real
            input to whether the withdrawal clears the network minimum.
        */}
        {review.estimatedGasUsd !== undefined && !isNgnPayout && (
          <Kv label="Estimated network fee" value={formatGasUsd(review.estimatedGasUsd)} />
        )}
        {/*
            THE FEE, RESTATED AS THE CASH THE USER ALREADY AGREED TO.

            Two problems, one row.

            First, `feePercent` is feePolicy.percent - the BRIDGE off-ramp
            policy, 1.25%. A naira payout does not go through Bridge; it is
            priced by ngnOfframpFeePercent. So this screen promised 1.25%
            while the quote screen behind it charged 1%.

            Second, even with the right percentage it was still a BARE
            PERCENTAGE on the last screen before money moves, one step after a
            card that itemised "Sivan fee ₦765 · 0.51 USDC". Asking someone to
            reconcile a percentage against a cash figure they read ten seconds
            ago is how a confirmation screen creates doubt instead of removing
            it - and the confirm screen is where doubt is most expensive.

            Now it repeats the quote's own numbers verbatim when they were
            carried, and falls back to the rail-correct percentage when they
            were not (the Bridge rail has no pre-accepted quote).
        */}
        <Kv label="Sivan fee" value={feeDisplay} />
        {review.payoutSummary?.receive && (
          <Kv label="You receive" value={review.payoutSummary.receive} />
        )}
      </div>
      {/* WHAT HAPPENS NEXT, SAID PLAINLY BEFORE THEY COMMIT.
 
          Withdrawing from the balance means Sivan moves the crypto itself and the
          user does nothing further. That is a materially different experience
          from being handed an address, and the confirmation screen was silent
          about which one they were about to get. */}
      {/* NOT gated on isNgn any more. The foreign rail can now be funded from
          the Sivan balance too, and while this said `isNgn &&` a USD
          balance-funded withdrawal showed the manual-send copy - telling the
          user to go and send crypto that Sivan was about to send for them. */}
      {review.fundingSource === 'balance' && (
        <div className="details-box compact">
          <span>We'll move {review.amount ? `${review.amount} ` : ''}{review.assetLabel} from your Sivan balance automatically. You don't need to send anything.</span>
        </div>
      )}
      {isNgn && review.minimumUsd !== undefined && review.fundingSource !== 'balance' && (
        // Stated before they send, because afterwards is too late: below the
        // minimum the funds are confirmed on-chain, held, and not credited.
        <div className="warning-box">Send at least <strong>${review.minimumUsd.toFixed(2)}</strong>. A smaller deposit is held by our settlement partner rather than paid out, and costs a fee to recover.</div>
      )}
      {/* The wrong-network warning is about an address the USER sends to. On
          the balance path there is no such address and no such risk, so
          showing it there manufactures a fear that does not apply. */}
      {review.fundingSource !== 'balance' && (
        <div className="warning-box">Send only {review.assetLabel} on {networkLabel(review.networkLabel)}. Sending any other token, or using the wrong network, can permanently lose your funds and may not be recoverable. <a href={legalLinks.risk} target="_blank" rel="noreferrer">Read Risk Disclosure</a>.</div>
      )}
      <div className="split-actions">
        <button className="ghost-btn" onClick={onCancel}>Edit details</button>
        {/* The button must name what it does. On the balance path it does not
            create a deposit address for the user to use - it sells. */}
        <button className="primary-btn" disabled={loading} onClick={onConfirm}>
          {loading
            ? review.fundingSource === 'balance' ? 'Withdrawing…' : 'Creating...'
            : review.fundingSource === 'balance' ? 'Confirm sale' : 'Create deposit address'}
        </button>
      </div>
    </article>
  );
}


function SetupChecklist({ hasUser, isVerified, hasBank, onContinue, nextStepLabel }: { hasUser: boolean; isVerified: boolean; hasBank: boolean; onContinue: () => void; nextStepLabel: string }) {
  return <article className="panel setup-card"><div className="panel-head"><div><p className="eyebrow">Setup checklist</p><h3>{[hasUser, isVerified, hasBank].filter(Boolean).length}/3 complete</h3></div></div><div className="checklist"><ProgressItem done={hasUser} label="Account created" /><ProgressItem done={isVerified} label="Identity verified" /><ProgressItem done={hasBank} label="Bank account added" /></div><button className="primary-btn animated-cta" onClick={onContinue}>{nextStepLabel}</button></article>;
}

function QuickActionCard({ hasUser, isVerified, hasBank, onContinue }: { hasUser: boolean; isVerified: boolean; hasBank: boolean; onContinue: () => void }) {
  const title = !hasUser ? 'Start with passwordless access' : !isVerified ? 'Verify once to unlock withdrawals' : !hasBank ? 'Add a bank account you own' : 'Create a stablecoin withdrawal';
  const body = !hasUser ? 'Use your email to create or access your Sivan account. No password required.' : !isVerified ? 'Verification protects your account and is required before bank payouts.' : !hasBank ? 'Your payout must go to a verified bank account in your name.' : 'Choose the asset, network, and bank account before creating a deposit address.';
  return <article className="panel quick-card"><div><p className="eyebrow">Quick action</p><h3>{title}</h3><p className="muted">{body}</p></div><button className="primary-btn" onClick={onContinue}>Continue</button></article>;
}

function NeedHelpCard() {
  return <article className="panel help-card"><p className="eyebrow">Need help?</p><h3>Support for withdrawals</h3><p className="muted">If you are unsure which asset or network to use, contact support before sending funds.</p><a className="secondary-btn support-link" href="mailto:support@sivantech.online">Contact support</a></article>;
}


/**
 * The dashboard status notice for a user with no Bridge customer record.
 *
 * THIS USED TO BE UNCONDITIONALLY "Verify your account".
 *
 * App.tsx renders it whenever `customer` is null - and a Nigerian who verified
 * through the bank name check NEVER becomes a Bridge customer. So a user who
 * had completed everything Sivan asks of them was told to verify, forever,
 * with a button that reopened a flow they had already finished.
 *
 * It now reads the summary, which is path-aware, and only falls back to the
 * generic prompt when there genuinely is no verification.
 */
export function DashboardAccountNotice({ summary, summaryLoaded, onVerify, onAddBank, onSell, displayCurrency = 'ngn', displayFx }: {
  summary: VerificationSummary | null;
  summaryLoaded: boolean;
  onVerify: () => void;
  onAddBank: () => void;
  onSell: () => void;
  /** Resolved from the user's saved preference. Defaults to naira so an un-passed caller is unchanged. */
  displayCurrency?: DisplayCurrency;
  displayFx?: DisplayFx | null;
}) {
  /**
   * BEFORE THE SERVER HAS ANSWERED, SAY NOTHING.
   *
   * `summary` is null both while the call is in flight AND when the user has
   * no verification, and the fallback at the bottom of this function treats
   * null as the latter. So a fully verified user opening the dashboard was
   * told "Verify your account" - with a button back into a flow they had
   * already completed - until the request landed and the card swapped itself
   * out. Reported from the live app.
   *
   * VerificationPage already gates on this exact flag; the dashboard was
   * simply missed. Same reasoning applies here: the shape is known, the
   * content is not, so a skeleton and not a spinner.
   *
   * Gated on `summaryLoaded` rather than `summary !== null` so a FAILED call
   * still falls through to the real branches below, instead of hanging on a
   * skeleton forever.
   */
  if (!summaryLoaded) {
    return <article className="kyc-outcome-notice dashboard-account-notice" aria-busy="true">
      <div className="kyc-outcome-copy verification-skeleton">
        <span className="skeleton-line short" />
        <span className="skeleton-line wide" />
        <span className="skeleton-line" />
      </div>
    </article>;
  }


  // A NUBAN sitting with a reviewer. The user cannot act, and must not be told
  // to "verify" again - resubmitting the same account changes nothing.
  if (summary?.hasPendingPayoutReview && !summary.pathComplete) {
    return <article className="kyc-outcome-notice dashboard-account-notice">
      <span className="kyc-outcome-icon">⏳</span>
      <div className="kyc-outcome-copy"><p className="eyebrow">Account status</p><h3>Bank check in progress</h3><p>We are confirming your bank account matches your name. This is usually done within a few hours.</p></div>
    </article>;
  }

  /**
   * A FINISHED ACCOUNT GETS ITS DASHBOARD BACK.
   *
   * Once the path is complete and a payout bank exists, this banner repeats
   * what the rest of the screen already says. Measured on the real dashboard
   * at Level 2 with a bank attached:
   *
   *   "Level 2: Identity verified"  appears 2x  (here + the limit KPI)
   *   the remaining-naira figure     appears 2x  (here + the limit KPI)
   *   a "Withdraw" affordance        appears 7x  (here + an action card + nav)
   *
   * It cost 125px and pushed the action cards - the things a verified user
   * actually came to press - down to y=355. A notice that tells you nothing
   * new is just furniture.
   *
   * The nextStep route is NOT lost: the limit KPI already renders
   * "Raise your limit" from the same summary.nextStep, so the way up stays
   * one click away for the user who is near their ceiling.
   *
   * Deliberately NOT hidden for:
   *   - verified but NO payout bank -> "Add bank account" is the only prompt
   *     to attach one, and nothing else on the dashboard asks for it;
   *   - pending review, unverified, loading -> all still need their say.
   */
  if (summary?.pathComplete && summary.hasPayoutAccount) {
    return null;
  }

  if (summary?.pathComplete) {
    const ngn = summary.allowances.find((item) => item.flow === 'offramp' && item.rail === 'ngn');
    // Headroom in the notice, because "verified" alone does not tell someone
    // what they can actually do next.
    //
    // GATED ON THE PATH, like dashboardKpis.showsNairaLimit already is. This
    // read the naira allowance for every user, so a verified American was told
    // "You can withdraw up to ₦0" - the same class of bug as the limit card,
    // from a second place that had its own copy of the rule.
    const showsNaira = summary.path === 'ngn_bank';
    /**
     * THE FIGURE IS STILL NAIRA; THE SYMBOL IS NOW THE USER'S CHOICE.
     *
     * This sentence hardcoded '₦' and was the second place - after
     * dashboardKpis - that decided currency from the country path. A user who
     * picked USD in Settings read a naira sentence here even once the KPI card
     * above it had been converted, which is worse than either behaviour on its
     * own: two figures for one limit, in two currencies, on one screen.
     */
    const headroom = showsNaira && ngn && ngn.remainingNgn !== null
      ? `You can withdraw up to ${formatFromNgn(ngn.remainingNgn, displayCurrency, displayFx)} in the next ${summary.windowDays} days.`
      : 'You can withdraw crypto to your bank.';

    /**
     * AND THE WAY UP, WHERE A VERIFIED USER WILL SEE IT.
     *
     * A ceiling with no stated route past it reads as the end of the road.
     * The dashboard is where someone notices they are near their limit, so it
     * is where the next rung belongs - not buried on /verification, which a
     * finished user has no reason to open again.
     *
     * Rendered from summary.nextStep so the ladder lives in one place, and
     * only when the server says one exists - at the top there is nothing to
     * offer, and inviting an upgrade that cannot happen is a dead end.
     */
    const next = summary.nextStep;

    return <article className="kyc-outcome-notice ready dashboard-account-notice">
      <span className="kyc-outcome-icon">✓</span>
      <div className="kyc-outcome-copy">
        <p className="eyebrow">Account status</p>
        <h3>{summary.levelLabel}</h3>
        <p>{summary.hasPayoutAccount ? headroom : 'You are verified. Add a payout bank to start withdrawing.'}</p>
        {next && summary.hasPayoutAccount && (
          <small className="dashboard-next-level">
            {next.available ? `Need a higher limit? ${next.description}` : `Higher limits are coming: ${next.description}`}
          </small>
        )}
      </div>
      <div className="kyc-outcome-actions"><button className="primary-btn" onClick={summary.hasPayoutAccount ? onSell : onAddBank}>{summary.hasPayoutAccount ? 'Withdraw' : 'Add bank account'}</button></div>
    </article>;
  }

  // Genuinely unverified. The copy names the path their country puts them on,
  // so a Nigerian is not promised a document check they will never be asked for.
  const isNgnPath = summary?.path === 'ngn_bank';
  return <article className="kyc-outcome-notice action dashboard-account-notice">
    <span className="kyc-outcome-icon">◈</span>
    <div className="kyc-outcome-copy"><p className="eyebrow">Account status</p><h3>Verify your account</h3><p>{isNgnPath ? 'Confirm a Nigerian bank account in your name to unlock payments. No documents needed.' : 'Complete identity verification to unlock payments.'}</p></div>
    <div className="kyc-outcome-actions"><button className="primary-btn" onClick={onVerify}>Start verification</button></div>
  </article>;
}

export function KycOutcomeNotice({ customer, hasBank, onContinue, onSupport, onRefresh, readyPrimaryLabel = 'Send & transfer' }: { customer: CustomerRecord; hasBank: boolean; onContinue: () => void; onSupport: () => void; onRefresh: () => void; readyPrimaryLabel?: string }) {
  const status = customer.kycStatus;
  const kind = kycNoticeKind(status);
  const verificationLink = customer.hostedKycLink || customer.kycLink;
  const isApproved = status === 'kyc_approved';
  const isReview = status === 'kyc_under_review';
  const isFailed = ['kyc_rejected', 'failed', 'cancelled'].includes(status || '');
  const isIncomplete = status === 'kyc_incomplete';
  const copy = isApproved
    ? { icon: '✓', title: customer.customerAction?.title || (hasBank ? 'Account ready' : 'Verification complete'), body: customer.customerAction?.message || (hasBank ? 'You can buy, withdraw, transfer, and manage payment methods.' : 'You’re verified. Add a payout bank to start withdrawing or receiving bank payouts.'), primary: hasBank ? readyPrimaryLabel : 'Add bank account' }
    : isReview
      ? { icon: '⏳', title: customer.customerAction?.title || 'Verification under review', body: customer.customerAction?.message || 'Your verification has been submitted and is being reviewed by our team. We will update this page automatically.', primary: 'Refresh status' }
      : isFailed
        ? { icon: '!', title: customer.customerAction?.title || 'Verification could not be completed', body: customer.customerAction?.message || 'Your secure verification was not approved. This can happen if a document is unclear or details do not match. You can retry or contact support.', primary: verificationLink ? 'Try verification again' : 'Refresh status' }
        : isIncomplete
          ? { icon: '◑', title: customer.customerAction?.title || 'Verification needs one more step', body: customer.customerAction?.message || 'Your secure verification is not fully complete yet. Continue the secure verification flow to finish your identity check.', primary: verificationLink ? 'Continue verification' : 'Refresh status' }
          : { icon: '◈', title: customer.customerAction?.title || 'Verify your account', body: customer.customerAction?.message || 'Complete identity verification to unlock payments.', primary: 'Start verification' };
  const primaryAction = isApproved || (!isReview && !isIncomplete && !isFailed) ? onContinue : onRefresh;
  return <article className={`kyc-outcome-notice ${kind}`}>
    <span className="kyc-outcome-icon">{copy.icon}</span>
    <div className="kyc-outcome-copy"><p className="eyebrow">Verification status</p><h3>{copy.title}</h3><p>{copy.body}</p>{Boolean(customer.customerAction?.requirements?.length) && <small>Needed: {customer.customerAction?.requirements?.join(', ')}</small>}</div>
    <div className="kyc-outcome-actions">
      {(isIncomplete || isFailed) && verificationLink ? <a className="primary-btn small" href={verificationLink} target="_blank" rel="noreferrer">{copy.primary}</a> : <button className="primary-btn small" onClick={primaryAction}>{copy.primary}</button>}
      {!isApproved && <button className="secondary-btn small" onClick={onSupport}>Contact support</button>}
    </div>
  </article>;
}


/**
 * How much this user may move, and what would raise it.
 *
 * NOTHING HERE IS HARDCODED. limitNgn, usedNgn and remainingNgn all arrive
 * from GET /api/users/:id/verification-summary, which resolves them through
 * the admin-overridable limit table. If an operator changes a ceiling in the
 * hub, this card changes on the next load.
 *
 * The upgrade line names the level rather than a marketing phrase, because
 * "verify to increase your limit" does not tell a user what to actually do.
 */
function VerificationLimitCard({
  allowance,
  windowDays,
  upliftApplies,
  nextStep,
  displayCurrency = 'ngn',
  displayFx,
}: {
  allowance: FlowAllowance;
  windowDays: number;
  upliftApplies: boolean;
  /** The server's next rung. See the comment where it is rendered. */
  nextStep?: VerificationSummary['nextStep'];
  displayCurrency?: DisplayCurrency;
  displayFx?: DisplayFx | null;
}) {
  /**
   * The naira formatter is now conditional, because this card is rendered for
   * BOTH rails. Printing '₦' beside a foreign allowance is what put
   * "₦0 left" on an American's dashboard.
   *
   * The underlying figures are still NGN-denominated on both rails - that is
   * the policy engine's unit - so the foreign rail is labelled by what it
   * MEASURES rather than mislabelled with a currency the user never sees.
   * Denominating the foreign ceiling in USD is a separate, agreed change; this
   * one stops the screen lying in the meantime.
   */
  const isForeign = allowance.rail === 'foreign';
  /**
   * THE BARE NUMBER IS GONE.
   *
   * This used to render a foreign allowance as `12,500 left` - no symbol at
   * all - because the figure is naira-denominated and the author correctly
   * refused to print '$' on a naira number with no rate to convert it. That
   * was the honest option at the time. There is a rate now (displayFx, served
   * on /api/offramp/controls), so the number can be stated in the currency the
   * user actually chose, with a '~' saying it was converted.
   *
   * With no displayFx - an older backend - formatFromNgn falls back to naira
   * and drops the '~', which is exact and correctly labelled. It never prints
   * a foreign symbol against an unconverted naira figure.
   */
  const amount = (value: number) => formatFromNgn(value, displayCurrency, displayFx);
  const approxNote = approximateNote(displayCurrency, displayFx);

  /**
   * A CEILING THE USER CANNOT REACH YET IS NOT A NUMBER TO SHOW THEM.
   *
   * A Bridge-approved Nigerian now reaches Level 2 without a payout account,
   * so this card would otherwise read "5,000,000 left" to somebody who cannot
   * move one naira - acceptNgnQuote() refuses until a NUBAN is name-matched.
   *
   * Rendering zero instead would be the opposite lie: the `limit === 0` branch
   * below exists precisely because "0 left" reads as "you have spent your
   * allowance" to someone who has done nothing wrong. The honest answer is
   * neither number - it is the missing step.
   */
  if (allowance.blockedBy === 'payout_account_required') {
    return (
      <article className="panel verification-limit-card">
        <p className="eyebrow">Withdrawal limit</p>
        <h3>Add a payout account</h3>
        <p className="muted">
          You are verified. To withdraw to a Nigerian bank, add an account in your name -
          we confirm it with your bank in under a minute.
        </p>
      </article>
    );
  }

  // null is genuinely uncapped - not zero, and not "unknown".
  if (allowance.limitNgn === null) {
    return (
      <article className="panel verification-limit-card">
        <p className="eyebrow">Withdrawal limit</p>
        <h3>No limit</h3>
        <p className="muted">You have completed every verification step we offer.</p>
      </article>
    );
  }

  const limit = allowance.limitNgn;
  const remaining = allowance.remainingNgn ?? limit;
  const used = allowance.usedNgn;
  const pctUsed = limit > 0 ? Math.min(Math.round((used / limit) * 100), 100) : 100;

  /**
   * A CEILING OF ZERO IS A LOCKED RAIL, NOT AN EMPTY ONE.
   *
   * Rendered through the normal path this said "₦0 left · ₦0 of ₦0 used" with
   * a full progress bar - which is what the reported screenshot shows. Every
   * word of it is technically true and the whole thing is misleading: it reads
   * as "you have spent your allowance", when in fact the user has done nothing
   * wrong and simply has not verified yet.
   *
   * A brand-new user of ANY country lands here, so this is the first thing a
   * beta signup sees. It should tell them what to do, not show them a spent
   * bar and an unfamiliar currency.
   */
  if (limit === 0) {
    return (
      <article className="panel verification-limit-card">
        <p className="eyebrow">Withdrawal limit</p>
        <h3>Not unlocked yet</h3>
        <p className="muted">
          {isForeign
            ? 'Verify your identity to start withdrawing to your bank.'
            : 'Verify your identity to start withdrawing to your Nigerian bank.'}
        </p>
        {nextStep && <p className="verification-limit-next">Next: {nextStep.description}</p>}
      </article>
    );
  }

  return (
    <article className="panel verification-limit-card">
      {/* Names the rail the user is actually on. "Withdrawn to naira" was
          hardcoded and shown to everyone, including users with no naira rail. */}
      <p className="eyebrow">{isForeign ? 'Withdrawn' : 'Withdrawn to naira'} · last {windowDays} days</p>
      <h3>{amount(remaining)} left</h3>
      <div className="verification-limit-bar"><span style={{ width: `${pctUsed}%` }} /></div>
      <p className="muted">
        {amount(used)} of {amount(limit)} used.
        {upliftApplies ? ' Your identity check is complete.' : ''}
      </p>
      {/* The disclosure that has to travel with a converted figure. Rendered
          from the same helper that decides the '~', so the two cannot drift
          apart, and null for naira users - whose number is exact. */}
      {approxNote && <p className="muted small">{approxNote}</p>}
      {/* THE LADDER IS THE SERVER'S, NOT THIS FILE'S.
 
          This used to hold its own `{1: 'Confirm a bank account in your name',
          2: 'Add your NIN or BVN', ...}` map keyed on level alone - which
          cannot be right, because the rungs differ by country. Caught in a
          browser screenshot: a US user at Level 0 was told "To go higher:
          Confirm a bank account in your name", the NIGERIAN instruction, for a
          check their country cannot even take. Their actual next step is a
          document check.
 
          summary.nextStep already answers this per path, so the second copy of
          the ladder is gone rather than corrected - a duplicated rule drifts
          again the moment either side changes.
 
          Still only rendered when a higher level exists; at the top there is
          nothing to ask for, and inviting an upgrade that cannot happen is a
          dead end. */}
      {nextStep && (
        <p className="verification-limit-next">
          To go higher: {nextStep.description}
        </p>
      )}
    </article>
  );
}

export function VerificationPage({ hasUser, userId, api, customer, customerTypes, kycFailed, canSubmitKyc, kycActionLabel, verificationRedirectUri, summary, summaryLoaded, onSubmit, onStartVerification, onStartBridgeVerification, onRefresh, onSupport, onAddBank, onSell, hasBank, displayCurrency = 'ngn', displayFx }: { hasUser: boolean; userId?: string; api: <T>(path: string, options?: RequestInit) => Promise<T>; customer: CustomerRecord | null; customerTypes: Array<{ customerType: 'individual' | 'business'; enabled: boolean; label: string }>; kycFailed: boolean; canSubmitKyc: boolean; kycActionLabel: string; verificationRedirectUri: string; summary: VerificationSummary | null; summaryLoaded: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onStartVerification: () => void; /** Opens the modal on the DOCUMENT path explicitly, whatever the country default is. */ onStartBridgeVerification: () => void; onRefresh: () => void; onSupport: () => void; onAddBank: () => void; onSell: () => void; hasBank: boolean; displayCurrency?: DisplayCurrency; displayFx?: DisplayFx | null }) {
  const emailDone = hasUser;
  // COUNTRY DECIDES THE PATH, so the page cannot describe one flow.
  //
  // A Nigerian verifies with a bank name check - no documents, no selfie, and
  // no Bridge customer ever created. Reading `customer?.kycStatus` for them is
  // asking Bridge about a user Bridge has never heard of, which is why this
  // page showed 25% and "Government-issued ID and selfie" to someone who had
  // already completed everything Sivan asks of them.
  const isNgnPath = summary?.path === 'ngn_bank';
  /**
   * `identityComplete`, NOT `pathComplete`.
   *
   * pathComplete now includes the terms acceptance, and this value drives the
   * step-2 tick, the "Bank verified"/"Identity verified" stepper cell and the
   * Level badge. Reading the combined field made a user whose ID was verified
   * but whose terms were pending see step 2 as unfinished - a green "Verified"
   * badge beside an un-ticked "2". Caught in a screenshot, not in the code.
   */
  const identityDone = summary ? summary.identityComplete : customer?.kycStatus === 'kyc_approved';
  /**
   * WHICH ROUTE ACTUALLY COMPLETED IDENTITY - not which one the country
   * defaults to.
   *
   * `isNgnPath` is verificationPathFor(country), so for every Nigerian it is
   * true regardless of what they did. The steps below were labelled from it
   * alone, which produced two false statements on the screen of a
   * Bridge-verified Nigerian with no payout account:
   *
   *   Step 2  "Bank verification ... Completed"      - they have no bank
   *   Step 3  "Confirmed with your bank verification" - nothing confirmed it
   *
   * Both were caught by LOOKING at the rendered page; every boolean assertion
   * in the journey passed while these two lines were plainly wrong.
   *
   * A Nigerian who is identity-complete WITHOUT a payout account can only have
   * got there through documents (Bridge) or a matched BVN, so the steps are
   * labelled for that route instead.
   */
  const identityViaDocuments = identityDone && !hasBank;
  const verificationLink = customer?.hostedKycLink || customer?.kycLink;
  // Only meaningful on the Bridge path; a Nigerian has no hosted link to resume.
  const canOpenExistingVerification = Boolean(!isNgnPath && verificationLink && customer?.id && !identityDone && !kycFailed);
  const started = Boolean(customer?.id);
  const bankDone = hasBank;

  /**
   * TERMS, FROM THE SERVER.
   *
   * `required` is "does a Bridge customer exist", which is the same question
   * the withdrawal/bank/virtual-account gates ask. Keying it off `isNgnPath`
   * as before meant a Nigerian who took the "Verify with ID instead" route had
   * a terms obligation the page refused to acknowledge.
   *
   * Falls back to the customer record until the summary lands so the row and
   * the percentage do not jump once it does.
   */
  const termsRequired = summary ? summary.terms.required : Boolean(customer?.id && !isNgnPath);
  const termsAccepted = summary ? summary.terms.accepted : customer?.tosStatus === 'approved';
  const termsLink = summary?.terms.link ?? customer?.tosLink;

  // Counted only when actually required, so a user who owes nothing is not
  // held below 100% by a step that does not apply to them.
  const steps = [emailDone, identityDone, ...(termsRequired ? [termsAccepted] : []), bankDone];
  const pct = Math.round((steps.filter(Boolean).length / steps.length) * 100);

  /**
   * OUTSTANDING TERMS ARE A BLOCK, and the page must say so before the user
   * discovers it at the withdrawal screen.
   *
   * identityDone can be true while terms are not - Bridge approves the
   * document check and the terms acceptance independently - and in that state
   * every payout route is refused server-side. The old page showed a green
   * "Account ready" banner in exactly that situation.
   */
  const termsBlocking = termsRequired && !termsAccepted;

  const levelLabel = summary?.levelLabel ?? (identityDone ? 'Level 1: Verified' : 'Level 0: Starter');
  /**
   * THE ALLOWANCE THIS USER ACTUALLY TRANSACTS ON, chosen by their path.
   *
   * This was hardcoded to `rail === 'ngn'`. Reported with a photo of the
   * dashboard: an American who had just signed up was shown
   *
   *     WITHDRAWN TO NAIRA · LAST 30 DAYS
   *     ₦0 left
   *     ₦0 of ₦0 used.
   *
   * Three things wrong at once, all from this one line. The heading names a
   * currency they will never touch - Bridge has no naira rail, and
   * payoutRailFor() has always refused to route them there. The figure is the
   * NGN ceiling, which is correctly 0 for a non-Nigerian and therefore reads
   * as "you can withdraw nothing" rather than "this rail is not yours". And
   * because the row exists for everyone, nothing looked broken.
   *
   * The server already answers this: summary.path is 'ngn_bank' or
   * 'bridge_kyc', decided from country by verificationPathFor(). Selecting on
   * it means the card describes the rail the user is on, and a new rail cannot
   * be added without this following it.
   */
  const railForPath: 'ngn' | 'foreign' = summary?.path === 'ngn_bank' ? 'ngn' : 'foreign';
  const primaryOfframp = summary?.allowances.find((item) => item.flow === 'offramp' && item.rail === railForPath);
  const [showNgnLevel2Form, setShowNgnLevel2Form] = useState(false);
  const [ngnLevel2Busy, setNgnLevel2Busy] = useState(false);
  const [ngnLevel2Result, setNgnLevel2Result] = useState<null | { status: string; message: string; bvnLast4?: string; consentUrl?: string; awaitingUserConsent?: boolean }>(null);
  const [ngnLevel2Error, setNgnLevel2Error] = useState('');
  const [ngnConsentBusy, setNgnConsentBusy] = useState(false);

  /**
   * COLLECT THE RESULT AFTER THE CUSTOMER HAS APPROVED.
   *
   * Flutterwave's BVN check is consent-based by regulation: the CBN requires
   * the BVN owner to approve on a NIBSS page, so the submit above can only
   * ever come back 'review' with a URL. Something has to ask for the answer
   * afterwards, and until now nothing did - the provider method existed with
   * no caller and no route, so a user could start a check and never finish
   * one.
   */
  async function completeNgnConsent() {
    if (!userId) return;
    setNgnConsentBusy(true);
    setNgnLevel2Error('');
    try {
      const result = await api<{ status: string; message: string; bvnLast4?: string; consentUrl?: string; awaitingUserConsent?: boolean }>(
        `/api/users/${userId}/kyc/ngn-bvn/complete`,
        { method: 'POST' }
      );
      setNgnLevel2Result(result);
      if (result?.status === 'matched') onRefresh();
    } catch (error: any) {
      setNgnLevel2Error(error?.message || 'Could not confirm your approval yet. Try again in a moment.');
    } finally {
      setNgnConsentBusy(false);
    }
  }

  async function submitNgnLevel2(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId) return setNgnLevel2Error('Sign in before starting Level 2 verification.');
    const form = event.currentTarget;
    const data = getForm(form);
    setNgnLevel2Busy(true);
    setNgnLevel2Error('');
    setNgnLevel2Result(null);
    try {
      const result = await api<{ status: string; message: string; bvnLast4?: string }>(`/api/users/${userId}/kyc/ngn-bvn/verify`, {
        method: 'POST',
        body: JSON.stringify({
          bvn: digitsOnly(data.bvn),
          firstName: String(data.firstName || '').trim(),
          lastName: String(data.lastName || '').trim(),
          dateOfBirth: normalizeNgnDateOfBirth(data.dateOfBirth),
          mobileNo: digitsOnly(data.mobileNo)
        })
      });
      setNgnLevel2Result(result);
      form.reset();

      /**
       * REFRESH THE SUMMARY, OR THE SCREEN LIES.
       *
       * Without this the POST succeeds, the user is Level 2 in the database,
       * and the page they are looking at still shows "Level 1: Bank verified"
       * with the old ceiling - so the only way to see the result of a
       * successful verification was to reload manually. Level 1 refreshes
       * after its bank check for exactly this reason.
       *
       * Only on a match: a 'review' or 'failed' outcome changes nothing about
       * the level, and re-fetching would just make the form flicker.
       */
      if ((result as any)?.status === 'matched') onRefresh();
    } catch (error) {
      setNgnLevel2Error(error instanceof Error ? error.message : 'Could not complete Level 2 verification.');
    } finally {
      setNgnLevel2Busy(false);
    }
  }


  /**
   * SAY NOTHING UNTIL THERE IS SOMETHING TRUE TO SAY.
   *
   * Every line on this page - the path, the percentage, the level, whether a
   * check is pending - comes from the summary. Rendering it before the answer
   * arrives does not degrade gracefully: it degrades to the BRIDGE path,
   * because that is what the fallbacks read. So a Nigerian with a bank check
   * in the queue was told to photograph a passport.
   *
   * Caught in a real browser on the deployed app: four of six cold loads of
   * /verification showed "Government-issued ID and selfie", Level 0, 25%, to
   * a user whose account was already sitting with a reviewer.
   *
   * This is deliberately a skeleton and not a spinner: the shape of the page
   * does not move when the data lands, so nothing jumps under a thumb that is
   * already reaching for a button.
   *
   * The gate is `summaryLoaded`, not `summary !== null`, so a FAILED call
   * still releases it - the user gets the degraded view rather than a
   * skeleton that never resolves.
   */
  if (hasUser && !summaryLoaded) {
    return (
      <section className="app-page verification-premium">
        <PageHero title="Verification" subtitle="A short, secure check so you can use Sivan payments with confidence." />
        <div className="verification-grid">
          <article className="dashboard-setup-panel verification-main-card" aria-busy="true" aria-live="polite">
            <p className="eyebrow">Checking your verification status</p>
            <div className="verification-skeleton">
              <span className="skeleton-line wide" />
              <span className="skeleton-line" />
              <span className="skeleton-line" />
              <span className="skeleton-line short" />
            </div>
            <p className="muted">One moment. We are loading your current level and limits.</p>
          </article>
        </div>
      </section>
    );
  }

  return (
    <section className="app-page verification-premium">
      <PageHero title="Verification" subtitle="A short, secure check so you can use Sivan payments with confidence." />
      {/* A QUEUED BANK CHECK OUTRANKS THE BRIDGE CARD.

          KycOutcomeNotice reads customer.kycStatus, which is Bridge-only. A
          Nigerian who has just submitted their bank account has no Bridge
          customer, so it rendered "Verify your account - complete identity
          verification" immediately after they submitted. Caught in the
          browser: the page said Level 0, 25%, verify - seconds after a
          successful submission.

          The user's own words for what they did must win over a provider
          status that has no opinion about it. */}
      {/* OUTSTANDING TERMS OUTRANK EVERY OTHER BANNER.
 
          KycOutcomeNotice renders a green "Verification successful - you can
          now use Sivan Payment features that require KYC" card off
          kycStatus === 'kyc_approved' ALONE. Bridge approves the document
          check and the terms acceptance independently, so a user can sit in
          exactly that state with terms still pending - and every payout route
          refused server-side. The page congratulated them and the withdrawal
          screen then turned them away.
 
          Placed first because it is the only thing standing between the user
          and a working account, and it is one click to fix. */}
      {termsBlocking ? (
        <article className="kyc-outcome-notice dashboard-account-notice">
          <span className="kyc-outcome-icon">!</span>
          <div className="kyc-outcome-copy">
            <p className="eyebrow">One step left</p>
            <h3>Accept the provider terms</h3>
            <p>Our payments provider needs you to accept its terms before you can withdraw, add a payout bank, or open a virtual account.</p>
          </div>
          <div className="kyc-outcome-actions">
            {termsLink
              ? <a className="primary-btn small" href={termsLink} target="_blank" rel="noreferrer">Accept terms</a>
              : <button className="ghost-btn small" onClick={onRefresh}>Refresh status</button>}
          </div>
        </article>
      ) : summary?.hasPendingPayoutReview && !summary.pathComplete ? (
        <article className="kyc-outcome-notice dashboard-account-notice">
          <span className="kyc-outcome-icon">⏳</span>
          <div className="kyc-outcome-copy">
            <p className="eyebrow">Account status</p>
            <h3>Bank check in progress</h3>
            <p>We are confirming your bank account matches your name. This is usually done within a few hours, and you do not need to do anything.</p>
          </div>
          <div className="kyc-outcome-actions"><button className="ghost-btn" onClick={onRefresh}>Refresh status</button></div>
        </article>
      ) : (
        /* A BUTTON THAT SAYS "Start verification" MUST START VERIFICATION.
 
           onContinue was `onRefresh` for every non-approved status. On the
           not-started case the card's primary button is labelled "Start
           verification" - so the most prominent button on the page silently
           re-fetched the KYC status and did nothing visible. Caught in a real
           browser on the deployed app: click it, wait 6s, no modal, no
           navigation, no toast.
 
           Only the not-started case is re-pointed. under_review, incomplete
           and failed still refresh or deep-link, which is correct for them -
           their buttons say "Refresh status" and "Continue verification". */
        /* AND THE BANNER MUST NOT CONTRADICT THE STEPS EITHER.
 
            Same root cause as the step-2 button, one level up: this card reads
            customer.kycStatus, a BRIDGE field. Caught in the browser
            screenshot AFTER fixing the steps - the rows all said Completed,
            100%, "Level 1: Bank verified", and the banner directly above them
            still said "Verify your account - complete identity verification to
            unlock payments" with a "Start verification" button.
 
            A Nigerian whose path is complete is DONE, whatever Bridge does or
            does not know about them. Their banner is the finished one. The
            Bridge card still renders for everyone else, and for a Nigerian who
            has genuinely started a Bridge check on top. */
        identityDone && isNgnPath && !customer?.id
          ? <article className="kyc-outcome-notice ready">
              <span className="kyc-outcome-icon">✓</span>
              <div className="kyc-outcome-copy">
                <p className="eyebrow">Verification status</p>
                <h3>{hasBank ? 'Account ready' : 'Bank verified'}</h3>
                <p>{hasBank ? 'Your bank account is confirmed. You can withdraw crypto and receive naira payouts.' : 'Your bank account is confirmed and ready for naira payouts.'}</p>
              </div>
              <div className="kyc-outcome-actions"><button className="primary-btn small" onClick={hasBank ? onSell : onAddBank}>{hasBank ? 'Withdraw' : 'Add bank account'}</button></div>
            </article>
          : customer && <KycOutcomeNotice customer={customer} hasBank={hasBank} onContinue={customer.kycStatus === 'kyc_approved' ? (hasBank ? onSell : onAddBank) : onStartVerification} onSupport={onSupport} onRefresh={onRefresh} readyPrimaryLabel="Withdraw" />
      )}
      <div className="verification-grid">
        <article className="dashboard-setup-panel verification-main-card">
          <div className="verification-progress-head"><div><p className="eyebrow">Progress</p><h3>{pct}% complete</h3></div><Badge status={identityDone ? 'verified' : 'pending'}>{levelLabel}</Badge></div>
          <div className="setup-progress big"><div><span style={{ width: `${pct}%` }} /></div></div>
          <div className="level-grid"><div className="active"><strong>Step 1</strong><span>Email confirmed</span></div><div className={identityDone ? 'active' : ''}><strong>Step 2</strong><span>{isNgnPath ? 'Bank verified' : 'Identity verified'}</span></div><div className={hasBank ? 'active' : ''}><strong>Step 3</strong><span>Payout ready</span></div></div>
          <div className="verification-steps-list">
            <VerificationStep done={emailDone} index={1} title="Email confirmed" sub="Signed in securely" action="Completed" />
            {/* A STEP MARKED ✓ MUST NOT ALSO SAY "Start verification".
 
                Reported from a real screen and reproduced in a browser: a
                Nigerian at Level 1 saw this row rendered done - tick, greyed,
                "Bank verified" in the stepper above - with a primary button
                still reading "Start verification", sandwiched between two rows
                that said "Completed". One screen, three contradictory claims.
 
                The cause was that the label came from `kycActionLabel`, which
                is computed purely from customer.kycStatus - a BRIDGE field. A
                Nigerian verifying by bank check never has a Bridge customer,
                so kycStatus is undefined forever and the label falls through
                to its "nothing has happened yet" default no matter what the
                user has actually completed.
 
                identityDone comes from summary.pathComplete, which is the
                server's answer for whichever path this user is on. When the
                path is complete the step is finished, and it says so. */}
            <div className={`verification-step ${identityDone ? 'done' : ''}`}><span>{identityDone ? '✓' : '2'}</span><div><strong>{isNgnPath && !identityViaDocuments ? 'Bank verification' : 'Identity verification'}</strong><small>{isNgnPath && !identityViaDocuments ? 'Confirm a Nigerian bank account in your name. No documents, usually under a minute.' : 'Government-issued ID and selfie. Usually takes about 3 minutes.'}</small>{summary?.hasPendingPayoutReview && !identityDone && <small className="verification-pending-note">Your bank account is being checked by our team.</small>}</div>{identityDone ? <button className="ghost-btn small" disabled>Completed</button> : !hasUser ? <button className="primary-btn small" disabled>Create account</button> : canOpenExistingVerification ? <a className="primary-btn small" href={verificationLink} target="_blank" rel="noreferrer">{kycActionLabel}</a> : /* Individual verification opens the modal, which asks for the country
   first and then routes: Nigeria to the bank-name check, everywhere else to
   Bridge. Business verification still uses the form below, because the modal
   has no customer-type step and a business cannot be verified by a personal
   bank account. */
<button className="primary-btn small" onClick={onStartVerification} disabled={!canSubmitKyc}>{kycActionLabel}</button>}</div>
            {/* THE TERMS STEP, VISIBLE AND ACTIONABLE.
 
                Two things were wrong with the row this replaces.
 
                It was hidden behind `!isNgnPath`, on the reasoning that a
                Nigerian on the bank path has no Bridge relationship. True
                until they use the "Verify with ID instead" button lower down
                on THIS PAGE - the documented route to USD/GBP/EUR rails. From
                that moment they have a Bridge customer and a real terms
                obligation, and the row stayed hidden. They were refused at
                withdrawal for a step the screen never showed them.
 
                And its button was `disabled` with the label "Continue" - for
                everyone, always. VerificationStep renders a disabled button by
                design; it is a status row, not an action. So even on the Bridge
                path where the step WAS shown, there was nothing to click. The
                only working link was buried in a status card further down,
                which is what "ToS should not be hidden" is about.
 
                `summary.terms.required` comes from the server and asks the
                same question the enforcement gate asks - does a Bridge
                customer exist - so the row appears exactly when the block can
                bite. Falls back to the customer record while the summary is
                still loading, so the step does not flicker in late. */}
            {(summary ? summary.terms.required : Boolean(customer?.id && !isNgnPath)) && (
              <TermsStep
                index={3}
                accepted={termsAccepted}
                link={termsLink}
                onRefresh={onRefresh}
              />
            )}
            <VerificationStep done={hasBank} index={isNgnPath ? 3 : 4} title="Payout bank" sub={isNgnPath && !identityViaDocuments ? 'Confirmed with your bank verification' : 'Add a bank when you are ready to withdraw'} action={hasBank ? 'Completed' : 'Continue'} />
            {/* WHAT COMES AFTER "100% COMPLETE".
 
                A Nigerian who finished Level 1 saw a page that said 100% and
                then stopped dead. Nothing on it mentioned that Level 2 exists,
                that it lifts the ceiling from 100k to 500k, or what it would
                take - so the honest read of the screen was "this is as far as
                Sivan goes". The ladder was only ever visible to whoever read
                the limits table.
 
                Rendered from summary.nextStep so the ladder lives in one
                place. When no provider is wired up for the next rung it says
                so plainly rather than offering a button that goes nowhere - a
                dead button is worse than a stated "coming soon", because the
                user blames themselves for the click that did nothing. */}
            {summary?.nextStep && identityDone && (
              <div className="verification-step verification-next-step">
                <span>{summary.nextStep.level}</span>
                <div>
                  <strong>{summary.nextStep.label}</strong>
                  <small>{summary.nextStep.description}</small>
                  {!summary.nextStep.available && (
                    <small className="verification-pending-note">Coming soon. We will let you know the moment it opens.</small>
                  )}
                </div>
                {summary.nextStep.action === 'contact_support'
                  ? <button className="primary-btn small" onClick={onSupport}>Contact support</button>
                  : summary.nextStep.action === 'nin_bvn'
                    ? <button className="primary-btn small" onClick={() => setShowNgnLevel2Form((open) => !open)}>{showNgnLevel2Form ? 'Close' : 'Start Level 2'}</button>
                    : <button className="primary-btn small" onClick={onStartVerification} disabled={!summary.nextStep.available || !canSubmitKyc}>{summary.nextStep.available ? 'Continue' : 'Coming soon'}</button>}
              </div>
            )}
            {showNgnLevel2Form && <NgnLevel2VerificationForm busy={ngnLevel2Busy} result={ngnLevel2Result} error={ngnLevel2Error} onSubmit={submitNgnLevel2} consentBusy={ngnConsentBusy} onCompleteConsent={completeNgnConsent} />}
          </div>
          {/* A NIGERIAN MAY WANT THE DOCUMENT PATH TOO.
 
              Country picks the DEFAULT path, not the only one. A Nigerian who
              needs USD/GBP/EUR virtual accounts, or who wants the higher
              ceiling without waiting for NIN/BVN, has to reach Bridge - and
              there was no way to get there from this page. The modal already
              lets any country be chosen; this is the door to it.
 
              Only shown once the local path is done, so it is an upgrade
              rather than a distraction from the faster check they should do
              first. */}
          {isNgnPath && identityDone && (
            <div className="verification-alt-path">
              <p className="muted">
                Need USD, GBP or EUR accounts? You can also verify with a government-issued ID and selfie.
                That is the same check international users take, and it unlocks foreign-currency rails.
              </p>
              {/* onStartBridgeVerification, NOT onStartVerification. The
                  generic opener routes by country, so for the Nigerian who
                  needs this button it re-opened the bank form they had just
                  completed - the button did the opposite of its label. */}
              <button className="ghost-btn small" onClick={onStartBridgeVerification} disabled={!canSubmitKyc}>Verify with ID instead</button>
            </div>
          )}
        </article>
        <div className="dashboard-side-stack">
          {/* The ceiling, straight from the server.

              Rendered only when a summary exists - an invented number here
              would be worse than no number, because a user who trusts it and
              starts a withdrawal finds out at the point of failure. Every
              figure comes from the admin-overridable limit table, so moving a
              ceiling in the hub changes this immediately with no deploy. */}
          {primaryOfframp && <VerificationLimitCard allowance={primaryOfframp} windowDays={summary?.windowDays ?? 30} upliftApplies={summary?.upliftApplies ?? false} nextStep={summary?.nextStep} displayCurrency={displayCurrency} displayFx={displayFx} />}
          {/* CustomerDetails renders Bridge's KYC status, account type and
              terms state. For a Nigerian on the bank path there IS no Bridge
              customer, so it printed "Status: Not started / Terms: Pending"
              beside a page reading 100% complete - seen in the browser
              screenshot. Bridge's opinion of a user it has never met is not a
              status worth showing. */}
          {customer?.id && !(isNgnPath && identityDone && !customer.kycStatus) && <article className="panel verification-status-card"><div className="panel-head"><div><p className="eyebrow">Current status</p><h3>Verification summary</h3></div><button className="ghost-btn small" onClick={onRefresh}>Refresh</button></div><CustomerDetails customer={customer} /></article>}
          <article className="panel verify-simple-card"><h3>Why we verify</h3><p className="muted">{isNgnPath ? 'Confirming the bank account belongs to you keeps payouts going to the right person.' : 'Verification keeps your account safe and helps Sivan meet payment partner requirements.'}</p><ul className="plain-list"><li>✓ Encrypted data</li><li>✓ Used only for compliance</li><li>✓ Status refreshes automatically</li></ul></article>
          <article className="security-card verify-help-card"><div className="security-icon">?</div><div><h3>Need help?</h3><p>If you are having trouble, support can review it with you.</p><button onClick={onSupport}>Contact support →</button><button onClick={onRefresh}>Refresh status →</button></div></article>
        </div>
      </div>
    </section>
  );
}

function VerificationStep({ done, index, title, sub, action }: { done: boolean; index: number; title: string; sub: string; action: string }) {
  return <div className={`verification-step ${done ? 'done' : ''}`}><span>{done ? '✓' : index}</span><div><strong>{title}</strong><small>{sub}</small></div><button className={`small ${done ? 'ghost-btn' : 'primary-btn'}`} disabled>{action}</button></div>;
}

/**
 * The provider terms step.
 *
 * NOT a VerificationStep, because that component renders a permanently
 * disabled button - it is a status row. Terms are the one step on this page
 * the user completes by clicking something here, so it needs its own row with
 * a live control.
 *
 * THE LINK IS AN <a>, NOT A BUTTON. Bridge's terms are a hosted page on
 * Bridge's domain; there is nothing to accept in-app and pretending otherwise
 * would mean a button that fakes a signature we never collected.
 *
 * WHEN THERE IS NO LINK the row says so and offers a refresh instead of
 * rendering a dead anchor. That happens for a customer created before we
 * stored tosLink, and for an admin-imported one - a real state, and a user
 * staring at an unclickable "Accept terms" has no way to know why.
 */
function TermsStep({ index, accepted, link, onRefresh }: { index: number; accepted: boolean; link?: string; onRefresh: () => void }) {
  return (
    <div className={`verification-step ${accepted ? 'done' : ''}`}>
      <span>{accepted ? '✓' : index}</span>
      <div>
        <strong>Accept provider terms</strong>
        <small>
          {accepted
            ? 'You have accepted the provider terms.'
            : 'Our payments provider needs you to accept its terms before you can withdraw, add a payout bank, or open a virtual account.'}
        </small>
        {/* SAYS WHAT TO DO AFTER, because the acceptance happens on another
            domain and nothing tells this page when it finished. Without this
            the user accepts, comes back to a row still showing "Accept
            terms", and reasonably concludes it did not work. */}
        {!accepted && link && <small className="verification-pending-note">Opens in a new tab. Come back here and refresh when you are done.</small>}
      </div>
      {accepted
        ? <button className="ghost-btn small" disabled>Completed</button>
        : link
          ? <a className="primary-btn small" href={link} target="_blank" rel="noreferrer">Accept terms</a>
          : <button className="ghost-btn small" onClick={onRefresh}>Refresh status</button>}
    </div>
  );
}

export function PaymentMethodsView({ accounts, onSubmit, loading, isVerified, controls, canCreatePaymentActions, isLiveEnv, onRefresh }: { accounts: ExternalAccountRecord[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; isVerified: boolean; controls: PaymentControl[]; canCreatePaymentActions: boolean; isLiveEnv: boolean; onRefresh: () => void }) {
  return <section className="app-page payment-methods-premium"><PageHero title="Payment methods" subtitle="Manage payout banks you own for crypto-to-bank withdrawals." action={<button className="primary-btn small" onClick={onRefresh}>Refresh</button>} /><div className="payment-grid"><article className="dashboard-transactions payment-methods-card"><div className="dash-card-head"><h3>Verified bank accounts</h3></div><BankList accounts={accounts} /></article><BankForm onSubmit={onSubmit} loading={loading} isVerified={isVerified} controls={controls} canCreatePaymentActions={canCreatePaymentActions} isLiveEnv={isLiveEnv} /></div></section>;
}

export function VirtualAccountsView({ requests, accounts, transactions, controls, loading, isVerified, canCreatePaymentActions, onRequest, onRefresh }: { requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; transactions: VirtualAccountTransactionRecord[]; controls: VirtualAccountControl[]; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: PayoutCurrency) => void; onRefresh: () => void }) {
  return <section className="app-page payment-methods-premium"><PageHero title="Virtual accounts" subtitle="Request reusable receiving accounts for fiat deposits into Sivan." action={<button className="primary-btn small" onClick={onRefresh}>Refresh</button>} /><VirtualAccountsCustomerPanel requests={requests} accounts={accounts} controls={controls} loading={loading} isVerified={isVerified} canCreatePaymentActions={canCreatePaymentActions} onRequest={onRequest} onRefresh={onRefresh} /><VirtualAccountDepositHistory transactions={transactions} /></section>;
}

/**
 * Card copy per virtual-account currency.
 *
 * Keyed by PayoutCurrency, INCLUDING ngn, because the record type this renders
 * (VirtualAccountRequestRecord.currency) already permits 'ngn'. It previously
 * did not: the type allowed naira while this map covered only usd/gbp/eur, so
 * an NGN virtual account produced `meta = undefined` and the next line read
 * `.title` off it - a white screen rather than an "unsupported" message.
 *
 * The entry exists so the lookup is total. Whether NGN is OFFERED is a
 * separate question, decided by the admin control below.
 */
const vaCurrencyMeta: Record<PayoutCurrency, { title: string; rails: string; account: string; flag: string }> = {
  usd: { title: 'USD Account', rails: 'ACH / Wire', account: 'US bank account', flag: '$' },
  gbp: { title: 'GBP Account', rails: 'Faster Payments', account: 'UK account number', flag: '£' },
  eur: { title: 'EUR Account', rails: 'SEPA', account: 'IBAN', flag: '€' },
  ngn: { title: 'NGN Account', rails: 'NIP transfer', account: 'Nigerian bank account', flag: '₦' }
};

function VirtualAccountsCustomerPanel({ requests, accounts, controls, loading, isVerified, canCreatePaymentActions, onRequest, onRefresh }: { requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; controls: VirtualAccountControl[]; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: PayoutCurrency) => void; onRefresh: () => void }) {
  // Driven by the admin controls rather than a literal list, so enabling NGN
  // virtual accounts is a controls change and not a deploy. Falls back to the
  // Bridge currencies when controls have not loaded.
  const currencies: PayoutCurrency[] = controls.length
    ? (controls.map((control) => control.currency).filter((c): c is PayoutCurrency => c in vaCurrencyMeta))
    : [...BRIDGE_CURRENCIES];
  const enabledControls = controls.filter((control) => control.enabled);
  return <article className="virtual-bank-panel"><div className="virtual-bank-head"><div><p className="eyebrow">Virtual Accounts</p><h3>Request virtual bank accounts</h3><p className="muted">After approval, Sivan shows customer-safe bank details only. Provider internals, destination wallets, and economics stay hidden.</p></div><Badge status={enabledControls.length ? 'active' : 'pending'}>{enabledControls.length ? `${enabledControls.length} enabled` : 'Disabled'}</Badge></div><div className="virtual-bank-grid">{currencies.map((currency) => <VirtualAccountCurrencyCard key={currency} currency={currency} request={requests.find((item) => item.currency === currency && !['rejected', 'canceled'].includes(item.status))} account={accounts.find((item) => item.currency === currency && item.status !== 'closed' && item.provider !== 'mock')} control={controls.find((item) => item.currency === currency)} loading={loading} isVerified={isVerified} canCreatePaymentActions={canCreatePaymentActions} onRequest={onRequest} onRefresh={onRefresh} />)}</div></article>;
}


function VirtualAccountDepositHistory({ transactions }: { transactions: VirtualAccountTransactionRecord[] }) {
  return <article className="virtual-bank-panel va-deposit-history"><div className="virtual-bank-head"><div><p className="eyebrow">Deposit history</p><h3>Virtual account deposits</h3><p className="muted">Fiat deposits and settlement events from Sivan virtual accounts. Completed deposits can credit your Sivan balance.</p></div><Badge status={transactions.length ? 'active' : 'pending'}>{transactions.length ? `${transactions.length} deposits` : 'No deposits'}</Badge></div>{!transactions.length ? <Empty>No virtual account deposits yet.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>Deposit</th><th>Amount</th><th>Settled</th><th>Status</th><th>Rail</th><th>Date</th></tr></thead><tbody>{transactions.map((tx) => <tr key={tx.id}><td>{shortRef(tx.depositId)}</td><td>{tx.sourceAmount || '—'} {tx.sourceCurrency?.toUpperCase() || ''}</td><td>{tx.destinationAmount || '—'} {tx.destinationCurrency?.toUpperCase() || ''}</td><td><Badge status={tx.status}>{friendlyStatus(tx.status)}</Badge></td><td>{tx.paymentRail || '—'}</td><td>{new Date(tx.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}</article>;
}

function virtualAccountInstructions(account?: VirtualAccountRecord) {
  const raw = account?.rawProviderPayload as any;
  const instructions = raw?.source_deposit_instructions ?? raw?.sourceDepositInstructions ?? raw?.source ?? {};
  return {
    bankName: instructions.bank_name || account?.bankName,
    accountName: instructions.bank_beneficiary_name || instructions.account_name || instructions.beneficiary_name || account?.accountName,
    accountNumber: instructions.bank_account_number || instructions.account_number || instructions.clabe || instructions.account?.account_number || account?.accountNumberMasked,
    routingNumber: instructions.bank_routing_number || instructions.routing_number || instructions.sort_code || account?.routingNumberMasked,
    accountType: instructions.account_type || instructions.account?.checking_or_savings || (account?.currency === 'usd' ? 'Checking' : undefined),
    iban: instructions.iban || instructions.iban_number || account?.ibanMasked,
    bic: instructions.bic,
    bankAddress: [instructions.bank_address, instructions.bank_city, instructions.bank_state, instructions.bank_country].filter(Boolean).join(', '),
    paymentRails: Array.isArray(instructions.payment_rails) ? instructions.payment_rails.join(', ') : undefined,
  };
}

function bridgeKycIframeUrl(url?: string) {
  if (!url) return undefined;
  try {
    const framed = new URL(url);
    framed.searchParams.set('iframe-origin', window.location.origin);
    return framed.toString();
  } catch {
    return url;
  }
}

function VirtualAccountCurrencyCard({ currency, request, account, control, loading, isVerified, canCreatePaymentActions, onRequest, onRefresh }: { currency: PayoutCurrency; request?: VirtualAccountRequestRecord; account?: VirtualAccountRecord; control?: VirtualAccountControl; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: PayoutCurrency) => void; onRefresh: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [kycModalOpen, setKycModalOpen] = useState(false);
  const [providerFlowStarted, setProviderFlowStarted] = useState(false);
  const meta = vaCurrencyMeta[currency];
  const enabled = Boolean(control?.enabled);
  const customerAction = request?.customerAction;
  const status = account?.status || (customerAction?.level === 'action_required' ? 'requires_action' : customerAction?.level === 'review' ? 'under_review' : request?.status === 'approved' ? 'provisioning' : request?.status) || (enabled ? 'available' : 'disabled');
  const disabledReason = !enabled ? 'Not available yet' : !isVerified ? 'Complete verification first' : !canCreatePaymentActions ? 'Temporarily unavailable' : '';
  const instructions = virtualAccountInstructions(account);
  const detailRows = (instructions.iban ? [
    ['Account name', instructions.accountName || 'Sivan account'],
    ['Bank name', instructions.bankName || 'Partner bank'],
    ['IBAN', instructions.iban],
    ...(instructions.bic ? [['BIC / SWIFT', instructions.bic]] : []),
    ...(instructions.bankAddress ? [['Bank address', instructions.bankAddress]] : []),
  ] : [
    ['Account name', instructions.accountName || 'Sivan account'],
    ['Bank name', instructions.bankName || 'Partner bank'],
    ['Account number', instructions.accountNumber || 'Assigned'],
    ...(instructions.accountType ? [['Account type', String(instructions.accountType).replaceAll('_', ' ')]] : []),
    ['Routing number', instructions.routingNumber || meta.rails],
    ...(instructions.bankAddress ? [['Bank address', instructions.bankAddress]] : []),
  ]).filter(([, value]) => value && value !== '—') as string[][];
  const accountDetailsText = () => [
    `Hi,`,
    ``,
    `I’m using Sivan to receive ${currency.toUpperCase()} payments.`,
    ``,
    `Here are my ${currency.toUpperCase()} account details.`,
    ``,
    ...detailRows.map(([label, value]) => `${value}\n${label}`),
    ``,
    `Please make sure the beneficiary/account name matches exactly to avoid returned payments.`,
    ``,
    `Thanks`
  ].join('\n\n');
  const copyValue = async (label: string, value: string) => {
    await navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopiedField(label);
    window.setTimeout(() => setCopiedField(null), 1400);
  };
  const copyAll = async () => {
    if (!account) return;
    await navigator.clipboard?.writeText(accountDetailsText()).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const shareAll = async () => {
    if (!account) return;
    const text = accountDetailsText();
    if (navigator.share) {
      await navigator.share({ title: `${currency.toUpperCase()} account details`, text }).catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const pendingTitle = customerAction?.title || (request?.status === 'approved' ? 'Account pending' : request?.status === 'under_review' ? 'Review in progress' : request?.status === 'requested' ? 'Request received' : friendlyStatus(request?.status));
  const pendingMessage = customerAction?.message || (request?.status === 'approved'
    ? 'Sivan has approved this request, but account details are not available yet. If more information is needed, it will appear here after refresh.'
    : request?.status === 'under_review'
      ? 'Sivan is reviewing this request. If additional information is required, a secure action link will appear here.'
      : `Submitted ${request ? new Date(request.createdAt).toLocaleString() : 'recently'}. Sivan operations will review and approve before account details appear here.`);
  const iframeUrl = bridgeKycIframeUrl(customerAction?.kycUrl);
  const closeKycModal = () => {
    setKycModalOpen(false);
    setProviderFlowStarted(true);
    void onRefresh();
  };
  return <><section className={`virtual-bank-card ${account ? 'active has-account-details' : request ? 'pending' : ''}`}><div className="vb-card-top"><span>{meta.flag}</span><div><strong>{meta.title}</strong><small>{meta.rails} · {meta.account}</small></div></div><Badge status={status}>{friendlyStatus(status)}</Badge>{account ? <><div className="va-safety-stack"><div className="va-warning-card"><strong>Beneficiary name must match</strong><span>Use the account name exactly. Mismatched payments may be returned.</span></div><div className="va-info-card"><strong>Transfer timing</strong><span>Deposits may take 1–2 business days.</span></div></div><div className="va-detail-list">{detailRows.map(([label, value]) => <div className="va-detail-row" key={label}><div><strong>{value}</strong><span>{label}</span></div><button type="button" aria-label={`Copy ${label}`} onClick={() => copyValue(label, value)}>{copiedField === label ? '✓' : '⧉'}</button></div>)}</div><div className="vb-copy-actions va-bottom-actions"><div className="vb-copy-buttons"><button type="button" className="secondary-btn small share-button" onClick={shareAll}>↗ Share</button><button type="button" className="ghost-btn small" onClick={copyAll}>{copied ? 'Copied all ✓' : '⧉ Copy all'}</button></div><small>Share or copy all account details in one tap.</small></div></> : request ? <div className="vb-pending"><strong>{providerFlowStarted && customerAction?.level === 'action_required' ? 'Checking provider review status' : pendingTitle}</strong><small>{providerFlowStarted && customerAction?.level === 'action_required' ? 'If you completed the secure step, check your status before opening the verification page again. This helps avoid duplicate submissions.' : pendingMessage}</small>{customerAction?.requirements?.length && !providerFlowStarted ? <small>Required: {customerAction.requirements.map((item) => item.replaceAll('_', ' ')).join(', ')}</small> : null}{customerAction?.kycUrl && customerAction?.level === 'action_required' && !providerFlowStarted && <button type="button" className="primary-btn small" onClick={() => setKycModalOpen(true)}>Complete additional information</button>}{(customerAction?.level === 'review' || providerFlowStarted) && <button type="button" className="ghost-btn small" onClick={onRefresh}>Check review status</button>}{!customerAction?.kycUrl && customerAction?.level === 'action_required' && <small>Refresh this page shortly if the secure verification link is not visible.</small>}{request.rejectionReason && <small className="danger-text">{request.rejectionReason}</small>}</div> : <div className="vb-empty"><p>Request a reusable {currency.toUpperCase()} virtual account for fiat deposits.</p><button className="primary-btn small" disabled={loading || Boolean(disabledReason)} onClick={() => onRequest(currency)}>{disabledReason || `Request ${currency.toUpperCase()} account`}</button></div>}</section>{kycModalOpen && iframeUrl && <div className="sv-modal-backdrop bridge-kyc-backdrop" role="presentation" onClick={closeKycModal}><div className="sv-modal bridge-kyc-modal" role="dialog" aria-modal="true" aria-labelledby={`bridge-kyc-title-${currency}`} onClick={(event) => event.stopPropagation()}><button className="sv-modal-close" onClick={closeKycModal} aria-label="Close">×</button><div className="sv-modal-head"><span className="sv-modal-eyebrow">Secure Sivan verification</span><h2 id={`bridge-kyc-title-${currency}`}>Complete {currency.toUpperCase()} account requirements</h2><p className="sv-modal-sub">Sivan may ask for only the missing information. Continue on the secure provider page, then return here to check your review status.</p></div><div className="bridge-kyc-handoff"><strong>{providerFlowStarted ? 'Check your review status next' : 'Open the secure verification page'}</strong><span>{providerFlowStarted ? 'If you already completed the secure provider step, check the latest status before opening the page again.' : 'The provider page may block embedded loading on some browsers. Opening it directly is the most reliable mobile-friendly path.'}</span></div><div className="bridge-kyc-actions">{providerFlowStarted ? <button type="button" className="primary-btn small" onClick={closeKycModal}>I’m done check status</button> : <a className="primary-btn small" href={customerAction?.kycUrl || iframeUrl} target="_blank" rel="noreferrer" onClick={() => setProviderFlowStarted(true)}>Continue securely ↗</a>}{providerFlowStarted ? <a className="ghost-btn small" href={customerAction?.kycUrl || iframeUrl} target="_blank" rel="noreferrer">Open secure page again ↗</a> : <button type="button" className="ghost-btn small" onClick={closeKycModal}>I’m done check status</button>}</div></div></div>}</>;
}type CustomerTransactionRow = {
  id: string;
  kind: 'withdrawal' | 'onramp_order';
  label: string;
  direction: 'sell' | 'buy';
  asset: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  providerReference?: string;
  timeline?: TransactionTimeline;
  raw: WithdrawalRecord | OnrampOrderRecord;
};



import { InlineTransactionTimeline } from './transactions/TransactionsSection';
export { TransactionsView, InlineTransactionTimeline } from './transactions/TransactionsSection';
export { BuyCryptoView, TransferCryptoView } from './transfer/TradeTransferSections';

export function NotificationCenter({ open, notifications, unreadCount, dotClass, readIds, timeNow, onToggle, onClose, onMarkAllRead, onOpen }: { open: boolean; notifications: UserNotification[]; unreadCount: number; dotClass: string; readIds: string[]; timeNow: number; onToggle: () => void; onClose: () => void; onMarkAllRead: () => void; onOpen: (item: UserNotification) => void }) {
  const visible = notifications.slice(0, 10);
  return <div className="notification-center-wrap">
    <button className={`icon-btn notification-button ${open ? 'active' : ''}`} aria-label="Notifications" aria-expanded={open} onClick={onToggle}>
      {unreadCount > 0 && <span className={`notif-dot ${dotClass}`}></span>}▢
    </button>
    {open && <div className="notification-panel" role="dialog" aria-label="Notifications">
      <div className="notification-head"><div><p className="eyebrow">Activity center</p><h3>Notifications</h3></div><button className="ghost-btn small" onClick={onClose}>Close</button></div>
      <div className="notification-summary"><span>{unreadCount ? `${unreadCount} unread` : 'All read'}</span>{notifications.length > 0 && <button onClick={onMarkAllRead}>Mark all as read</button>}</div>
      {!visible.length ? <div className="notification-empty"><strong>You’re all caught up</strong><small>Important updates about payments, verification, and support will appear here.</small></div> : <div className="notification-list">{visible.map((item) => {
        const read = readIds.includes(item.id);
        return <button key={item.id} className={`notification-item ${item.severity} ${read ? 'read' : 'unread'}`} onClick={() => onOpen(item)}>
          <span className="notification-icon">{item.icon}</span>
          <div><strong>{item.title}</strong><small>{item.message}</small><em>{timeAgo(item.createdAt, timeNow)}</em></div>
          {item.actionLabel && <b>{item.actionLabel} →</b>}
        </button>;
      })}</div>}
    </div>}
  </div>;
}

export function IncidentBanner({ systemStatus }: { systemStatus: SystemStatus }) {
  const incidents = systemStatus.activeIncidents ?? [];
  if (incidents.length) {
    return <section className="maintenance-banner incident-banner dynamic"><strong>{incidents.some((item) => item.severity === 'critical') ? 'Service disruption' : 'Service notice'}</strong><div className="incident-banner-list">{incidents.map((incident) => <span key={incident.id}><b>{incident.provider}</b> · {incident.customerMessage || incident.message}{incident.eta ? ` ETA: ${incident.eta}` : ''}</span>)}</div></section>;
  }
  if (systemStatus.mode === 'active') return null;
  return <section className="maintenance-banner"><strong>{systemStatus.mode === 'maintenance' ? 'Maintenance mode' : 'Payments paused'}</strong><span>{systemStatus.message || (systemStatus.mode === 'maintenance' ? 'New withdrawals are temporarily unavailable while maintenance is in progress.' : 'New payment actions are temporarily paused.')}</span>{systemStatus.estimatedResumeAt && <small>Estimated resume: {new Date(systemStatus.estimatedResumeAt).toLocaleString()}</small>}</section>;
}

function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function LegalResources({ compact = false }: { compact?: boolean }) {
  const links = [
    { label: 'Terms', href: legalLinks.terms },
    { label: 'Privacy', href: legalLinks.privacy },
    { label: 'Risk Disclosure', href: legalLinks.risk },
    { label: 'Data Retention', href: legalLinks.dataRetention },
    { label: 'AML/KYC Policy', href: legalLinks.amlKyc },
    { label: 'Supported Jurisdictions', href: legalLinks.jurisdictions },
    { label: 'Wrong Network Policy', href: legalLinks.wrongNetwork },
    { label: 'Complaints Policy', href: legalLinks.complaints },
    { label: 'Cookie Policy', href: legalLinks.cookies }
  ];
  return <article className={compact ? 'legal-resource-card compact' : 'legal-resource-card'}><h3>Legal resources</h3><p className="muted">Review Sivan’s user terms, privacy practices, risk disclosures, and data retention policy.</p><div>{links.map((link) => <a key={link.label} href={link.href} target="_blank" rel="noreferrer">{link.label} ↗</a>)}</div></article>;
}





function NgnLevel2VerificationForm({ busy, result, error, onSubmit, consentBusy = false, onCompleteConsent }: { busy: boolean; result: null | { status: string; message: string; bvnLast4?: string; consentUrl?: string; awaitingUserConsent?: boolean }; error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; consentBusy?: boolean; onCompleteConsent?: () => void }) {
  /**
   * THE CONSENT HAND-OFF, WHICH USED TO BE A DEAD END.
   *
   * On Flutterwave the submit below cannot return 'matched' - the CBN requires
   * the BVN owner to approve on a NIBSS page first. The server returned that
   * URL all along, inside matchedFields, and this form rendered only the
   * message. So the user read "Your verification needs manual review", had no
   * link to approve with, and waited for a human who was never coming.
   *
   * Two steps now, in the order the user performs them: open the approval
   * page, then come back and press the button that collects the result.
   */
  const awaitingConsent = Boolean(result?.awaitingUserConsent && result?.consentUrl);

  return <form className="ngn-level2-card" onSubmit={onSubmit}>
    <div><p className="eyebrow">Level 2 · Nigerian identity</p><h3>Verify your BVN identity</h3><p className="muted">This checks your BVN identity details. We never show your full BVN after submission and this does not run automatically.</p></div>
    <div className="split"><label>First name<input name="firstName" placeholder="John" autoComplete="given-name" required /></label><label>Last name<input name="lastName" placeholder="Doe" autoComplete="family-name" required /></label></div>
    <div className="split"><label>Date of birth<input name="dateOfBirth" placeholder="dd-MM-yyyy" inputMode="numeric" autoComplete="bday" required /></label><label>Mobile number<input name="mobileNo" placeholder="08012345678" inputMode="tel" autoComplete="tel" required /></label></div>
    <label>BVN<input name="bvn" placeholder="11-digit BVN" inputMode="numeric" autoComplete="off" required minLength={11} maxLength={11} /></label>
    <div className="warning-box compact">BVN is sensitive. Sivan uses it only for this Level 2 check. It is not sent to Sivan Assistant and should not be shared in support chat.</div>
    {result && <div className={result.status === 'matched' ? 'success-note' : 'verification-note'}><strong>{result.message}</strong>{result.bvnLast4 && <span> BVN ending {result.bvnLast4}</span>}</div>}
    {awaitingConsent && (
      <div className="ngn-consent-steps">
        <ol className="ordered-steps">
          <li className="active">Open the approval page and confirm with the OTP sent by your bank.</li>
          <li>Come back here and select “I have approved” to finish.</li>
        </ol>
        <div className="consent-actions">
          {/* rel="noreferrer" matters: this is a third-party page being handed
              a BVN consent session, and it has no business reading our URL. */}
          <a className="primary-btn small" href={result?.consentUrl} target="_blank" rel="noreferrer">Open approval page ↗</a>
          <button type="button" className="secondary-btn small" disabled={consentBusy} onClick={onCompleteConsent}>
            {consentBusy ? 'Checking…' : 'I have approved'}
          </button>
        </div>
        <small className="muted">Approval happens on your provider’s secure page. Sivan never sees your OTP.</small>
      </div>
    )}
    {error && <div className="form-error">{error}</div>}
    {/* Hidden once the check is waiting on the user: re-submitting would start
        a SECOND consent request and burn one of their three daily attempts. */}
    {!awaitingConsent && <button className="primary-btn" disabled={busy}>{busy ? 'Checking…' : 'Submit Level 2 check'}</button>}
  </form>;
}



export { SettingsView, UserAvatar } from './settings/SettingsSection';
export { EmailRecoveryConfirmView } from './recovery/EmailRecoveryConfirmView';
export { SupportView } from './support/SupportSection';

function ProgressItem({ done, label }: { done: boolean; label: string }) {
  return <div className={`progress-item ${done ? 'done' : ''}`}><span>{done ? '✓' : '•'}</span>{label}</div>;
}

function Stat({ label, value, helper }: { label: string; value: string; helper: string }) {
  return <article className="stat-card"><p>{label}</p><strong>{value}</strong><span>{helper}</span></article>;
}

function CustomerDetails({ customer }: { customer: CustomerRecord }) {
  const verificationLink = customer.hostedKycLink || customer.kycLink;
  const termsLink = customer.tosLink;
  const approved = customer.kycStatus === 'kyc_approved';
  const underReview = customer.kycStatus === 'kyc_under_review';
  const termsApproved = customer.tosStatus === 'approved';
  const actionLabel = approved ? 'Verification complete' : underReview ? 'Review in progress' : 'Open verification page';
  return (
    <div className="verification-summary-clean">
      <div className="verification-status-list">
        <div><span>Status</span><strong>{friendlyStatus(customer.kycStatus)}</strong></div>
        <div><span>Account type</span><strong>{customer.customerType === 'business' ? 'Business' : 'Individual'}</strong></div>
        <div><span>Terms</span><strong>{customer.tosStatus ? friendlyStatus(customer.tosStatus) : 'Pending'}</strong></div>
      </div>
      {verificationLink && !approved && !underReview && (
        <a className="verification-action-card" href={verificationLink} target="_blank" rel="noreferrer">
          <span>Secure verification</span>
          <strong>Continue your verification</strong>
          <small>Your secure link opens in a new tab. We hide the long URL to keep this page clean.</small>
          <em>{actionLabel} →</em>
        </a>
      )}
      {termsLink && !termsApproved && (
        <a className="verification-action-card terms-card" href={termsLink} target="_blank" rel="noreferrer">
          <span>Terms required</span>
          <strong>Accept terms to finish</strong>
          <small>Complete this step, then return here and refresh status.</small>
          <em>Accept terms →</em>
        </a>
      )}
      {!approved && !underReview && !termsApproved && <div className="verification-note">If you already finished, allow a few moments for processing and refresh status.</div>}
      {underReview && <div className="verification-note success-note">Your verification is under review. We will update your account as soon as it is approved.</div>}
      {/* THE SUCCESS LINE MUST NOT PROMISE WHAT TERMS ARE BLOCKING.
 
          Read `approved` alone - a Bridge KYC field - so it printed "You can
          now add a bank account and use Sivan payment features" on the very
          screen that was refusing both for want of a terms acceptance. Caught
          in a screenshot: this green note sat directly under a "Terms:
          Pending" row and an "Accept terms to finish" card.
 
          Both halves are true statements about different things, so both are
          kept - the identity check really did pass - but the entitlement is
          only claimed once it is real. */}
      {approved && (termsApproved
        ? <div className="verification-note success-note">You are verified. You can now add a bank account and use Sivan payment features.</div>
        : <div className="verification-note">Your identity is verified. Accept the provider terms above to finish and unlock payouts.</div>)}
    </div>
  );
}

function Kv({ label, value }: { label: string; value?: string | number | null }) {
  return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>;
}

function BankForm({ onSubmit, loading, isVerified, controls, canCreatePaymentActions, isLiveEnv }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; isVerified: boolean; controls: PaymentControl[]; canCreatePaymentActions: boolean; isLiveEnv: boolean }) {
  /**
   * THIS FORM IS BRIDGE-ONLY, SO NGN IS FILTERED OUT BEFORE IT IS OFFERED.
   *
   * Adding 'ngn' to the payout controls surfaced it here, and the compiler
   * caught it: this component posts to the Bridge external-account endpoint,
   * whose schema is a discriminated union over accountType 'us' | 'gb' |
   * 'iban'. A NUBAN is none of the three. Had the state simply been widened to
   * accept 'ngn', a Nigerian would have been shown a currency they could
   * select and then a routing-number field they cannot fill, and the POST
   * would have been rejected by the provider after they typed it all in.
   *
   * Naira has its own first step - NgnPayoutForm, reached from the Nigerian
   * bank tab in the withdrawal wizard - because the account shape genuinely
   * differs. Filtering here keeps the two rails apart at the only point where
   * they could be confused.
   */
  // The predicate is typed so .filter() NARROWS the element type rather than
  // just shortening the array. Without the annotation TS keeps the union
  // including 'ngn' and setCurrency below stops type-checking - which is the
  // error that caught this whole class of mistake in the first place, so it is
  // worth keeping sharp rather than casting it away.
  const bridgeControls = controls.filter(
    (control): control is PaymentControl & { currency: 'usd' | 'gbp' | 'eur' } => isBridgeCurrency(control.currency),
  );
  const [currency, setCurrency] = useState<'usd' | 'gbp' | 'eur'>((bridgeControls[0]?.currency ?? 'usd') as 'usd' | 'gbp' | 'eur');
  useEffect(() => {
    if (bridgeControls.length && !bridgeControls.some((control) => control.currency === currency)) {
      setCurrency(bridgeControls[0].currency);
    }
  }, [bridgeControls, currency]);
  if (!isVerified) return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add your bank</h3><Empty>Complete verification before adding a bank account.</Empty></article>;
  // bridgeControls, not controls: with only NGN enabled this form has nothing
  // it can offer, and saying "temporarily unavailable" is correct - the naira
  // rail is reached from the withdrawal wizard, not from here.
  if (!bridgeControls.length) return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add your bank</h3><Empty>Bank payouts are temporarily unavailable.</Empty></article>;
  const isUsd = currency === 'usd';
  const isGbp = currency === 'gbp';
  return (
    <article className="panel form-panel">
      <p className="eyebrow">Step 3</p>
      <h3>Add your bank</h3>
      <p className="muted">Your payout must go to a bank account you own. Available payout currencies are controlled by Sivan.</p>
      <form className="form" onSubmit={onSubmit}>
        <label>Payout currency
          <CustomSelect name="currency" value={currency} onChange={(value) => setCurrency(value as 'usd' | 'gbp' | 'eur')} options={bridgeControls.map((control) => ({ value: control.currency, label: control.label }))} />
        </label>
        <label>Bank name<input name="bankName" placeholder={isUsd ? 'Bank name' : isGbp ? 'Bank name' : 'SEPA bank name'} defaultValue={isLiveEnv ? '' : isUsd ? 'Lead Bank' : isGbp ? 'Example UK Bank' : 'Example SEPA Bank'} required /></label>
        <label>Account owner name<input name="accountOwnerName" placeholder="Account holder name" defaultValue={isLiveEnv ? '' : 'Ada Lovelace'} required /></label>
        <div className="split"><label>First name<input name="firstName" placeholder="First name" defaultValue={isLiveEnv ? '' : 'Ada'} /></label><label>Last name<input name="lastName" placeholder="Last name" defaultValue={isLiveEnv ? '' : 'Lovelace'} /></label></div>
        {isUsd ? <>
          <label>Routing number<input name="routingNumber" placeholder="Routing number" defaultValue={isLiveEnv ? '' : '101019644'} /></label>
          <label>Account number<input name="accountNumber" placeholder="Account number" defaultValue={isLiveEnv ? '' : '215268129123'} /></label>
        </> : isGbp ? <>
          <label>Sort code<input name="sortCode" placeholder="Sort code" defaultValue={isLiveEnv ? '' : '123456'} /></label>
          <label>Account number<input name="gbAccountNumber" placeholder="Account number" defaultValue={isLiveEnv ? '' : '12345678'} /></label>
        </> : <>
          <label>IBAN<input name="ibanAccountNumber" placeholder="FR7630006000011234567890189" required /></label>
          <label>BIC / SWIFT<input name="bic" placeholder="AGRIFRPP" /></label>
          <label>Bank country<input name="ibanCountry" defaultValue="FRA" maxLength={3} /></label>
        </>}
        <button className="primary-btn" disabled={loading || !canCreatePaymentActions}>{loading ? 'Adding...' : canCreatePaymentActions ? 'Add bank account' : 'Temporarily unavailable'}</button>
      </form>
    </article>
  );
}

function BankList({ accounts }: { accounts: ExternalAccountRecord[] }) {
  if (!accounts.length) return <Empty>No bank account added yet.</Empty>;
  return <div className="list">{accounts.map((account) => <div className="list-item" key={account.id}><strong>{account.bankName || 'Bank account'} • {account.currency.toUpperCase()}</strong><Badge status={account.status}>{friendlyStatus(account.status)}</Badge><small>{account.paymentRail.replaceAll('_', ' ')} · ****{account.accountLast4 || '----'}</small></div>)}</div>;
}

function DepositCard({ result }: { result: DepositResponse | null }) {
  const [copied, setCopied] = useState(false);
  if (!result) return <article className="deposit-card"><p className="eyebrow">Deposit address</p><h3>Ready when you are</h3><p className="muted">Create a withdrawal to receive a deposit address. You will review the asset, network, fee, and payout currency before sending.</p></article>;
  const copyDepositAddress = () => {
    if (!result.deposit?.address) return;
    navigator.clipboard?.writeText(result.deposit.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  /**
   * NEVER CRASH THE PAGE OVER A MISSING FIELD ON THIS SCREEN.
   *
   * This card renders AFTER the money has already moved. `result.deposit`
   * was read straight through - `result.deposit.currency.toUpperCase()` - and
   * the naira rail returns no `deposit` object at all, so every NGN
   * withdrawal threw here and took the whole app down with it. The user had
   * been charged and got a black screen; the deposit address they needed in
   * order to complete the send was in the response that crashed.
   *
   * App.tsx now normalises both rails so this should always be populated.
   * The guard stays anyway, because the cost of being wrong is asymmetric:
   * a missing chain label is a degraded card, a thrown error is a lost
   * address.
   */
  const depositAddress = result.deposit?.address;
  const depositCurrency = result.deposit?.currency?.toUpperCase();
  /**
   * networkLabel(), not the raw string. The chain arrives as a database value
   * - 'solana', 'avalanche_c_chain' - and rendering it straight gave
   * "Send only USDC on solana" on the one screen where a user is deciding
   * where to send real money. The same helper already fixes this on the
   * activity rows; a safety warning deserves it at least as much.
   */
  const depositChain = result.deposit?.chain ? networkLabel(result.deposit.chain) : undefined;
  const withdrawal = result.withdrawal;
  // '' rather than undefined so the .includes() and === comparisons below stay
  // total without each one needing its own guard.
  const withdrawalStatus = withdrawal?.status ?? '';


  // No address means there is nothing actionable to show, but the withdrawal
  // still exists - so point the user at their history rather than at nothing.
  if (!depositAddress) {
    return (
      <article className="deposit-card live-deposit-card">
        <p className="eyebrow">Step 3</p>
        <h3>Withdrawal created</h3>
        <p className="muted">Your withdrawal was created, but we could not load the deposit address. Open Transactions to view it - your funds are safe and nothing needs to be resubmitted.</p>
        {result.withdrawal?.id ? <div className="details-box"><Kv label="Reference" value={shortRef(result.withdrawal.id)} /></div> : null}
      </article>
    );
  }

  return (
    <article className="deposit-card live-deposit-card">
      <p className="eyebrow">Step 3</p>
      <h3>Deposit address created</h3>
      <p className="muted">
        {depositCurrency && depositChain
          ? <>Send only {depositCurrency} on {depositChain}. </>
          : <>Send only the asset and network you selected. </>}
        Sending any other token, or using the wrong network, can permanently lose your funds and may not be recoverable. <a href={legalLinks.risk} target="_blank" rel="noreferrer">Read Risk Disclosure</a>.
      </p>
      <div className="qr-wrap premium-qr"><img src={qrUrl(depositAddress)} alt="Deposit address QR code" /><div><span className="address-label">Deposit address</span><div className="deposit-address clickable-address" title="Click or tap to copy address" onClick={copyDepositAddress} style={{ cursor: 'pointer' }}>{depositAddress}</div><button className="secondary-btn" onClick={copyDepositAddress}>{copied ? '✓ Copied to clipboard' : 'Copy address'}</button></div></div>
      {/* Kv already renders '—' for null/undefined, so every value below is
          passed through rather than read into. `withdrawal` itself is
          optional-chained for the same reason the block above is: this screen
          runs after the money moved and must never be the thing that throws. */}
      {/*
        FEE READ FROM BOTH RAILS, AND THE AMOUNT SHOWN AT ALL.

        This read only `feePercent`, which Bridge sends and the naira rail
        does not - so every NGN withdrawal rendered "FEE —" on the one screen
        that exists to confirm what the user is paying. Breet sends
        `feeAmount` (an absolute figure in the source asset), so both are
        read and the absolute number wins when present, because it is the
        one the user can check against their own arithmetic.

        "You receive" was missing entirely. It is the single number a person
        actually cares about on a withdrawal confirmation, and it was in the
        response the whole time.
      */}
      <div className="details-box"><Kv label="Reference" value={withdrawal?.id ? shortRef(withdrawal.id) : undefined} /><Kv label="You send" value={withdrawal?.sourceAmount ? `${withdrawal.sourceAmount} ${String(withdrawal.sourceCurrency ?? '').toUpperCase()}` : undefined} /><Kv label="You receive" value={withdrawal?.destinationAmount ? `${Number(withdrawal.destinationAmount).toLocaleString()} ${String(withdrawal.destinationCurrency ?? '').toUpperCase()}` : undefined} /><Kv label="Fee" value={withdrawal?.feeAmount ? `${withdrawal.feeAmount} ${String(withdrawal.sourceCurrency ?? '').toUpperCase()}` : withdrawal?.feePercent ? `${withdrawal.feePercent}%` : undefined} /><Kv label="Status" value={withdrawal?.status ? friendlyStatus(withdrawal.status) : undefined} /></div>
      {withdrawal?.transactionTimeline ? <InlineTransactionTimeline timeline={withdrawal.transactionTimeline} /> : <div className="tracking-timeline">
        <TimelineItem done title="Address created" body="A unique provider-backed deposit address is ready." />
        <TimelineItem active={withdrawalStatus === 'pending_deposit'} done={Boolean(withdrawalStatus) && withdrawalStatus !== 'pending_deposit'} title="Awaiting deposit" body="Send only the selected token and network." />
        <TimelineItem active={['deposit_received', 'payout_processing'].includes(withdrawalStatus)} done={withdrawalStatus === 'completed'} title="Convert and payout" body="Sivan detects the deposit, liquidates, and sends fiat to your bank." />
        <TimelineItem done={withdrawalStatus === 'completed'} title="Completed" body="Bank payout completed once provider status confirms." />
      </div>}
    </article>
  );
}

function TimelineItem({ title, body, done = false, active = false }: { title: string; body: string; done?: boolean; active?: boolean }) {
  return <div className={`timeline-item ${done ? 'done' : ''} ${active ? 'active' : ''}`}><span>{done ? '✓' : active ? '•' : ''}</span><div><strong>{title}</strong><small>{body}</small></div></div>;
}

function WithdrawalsList({ withdrawals, compact = false }: { withdrawals: WithdrawalRecord[]; compact?: boolean }) {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Withdrawals</p><h3>{compact ? 'Recent activity' : 'Withdrawal activity'}</h3></div></div>{!withdrawals.length ? <Empty>No withdrawals yet.</Empty> : compact ? <div className="list">{withdrawals.map((w) => <div className="list-item" key={w.id}><strong>{w.destinationCurrency.toUpperCase()} withdrawal</strong><Badge status={w.status}>{friendlyStatus(w.status)}</Badge><small>Reference {shortRef(w.id)}</small></div>)}</div> : <div className="table-wrap"><table className="table"><thead><tr><th>Reference</th><th>Status</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Date</th></tr></thead><tbody>{withdrawals.map((w) => <tr key={w.id}><td>{shortRef(w.id)}</td><td><Badge status={w.status}>{friendlyStatus(w.status)}</Badge></td><td>{w.destinationCurrency.toUpperCase()}</td><td>{w.destinationAmount || '—'}</td><td>{w.feeAmount || (w.feePercent ? `${w.feePercent}%` : '—')}</td><td>{new Date(w.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}</article>;
}

function UserGuidePanel() {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">How it works</p><h3>A simple withdrawal flow</h3></div></div><div className="details-box"><Kv label="1" value="Create your account" /><Kv label="2" value="Complete verification" /><Kv label="3" value="Add your bank account" /><Kv label="4" value="Send the selected stablecoin to your deposit address" /><Kv label="5" value="Receive USD, GBP, or EUR in your bank account" /></div></article>;
}
