import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomerRecord, DepositResponse, ExternalAccountRecord, AssetControl, FeePolicy, NetworkControl, OfframpControls, PaymentControl, SystemStatus, UserRecord, ViewKey, WithdrawalRecord, OnrampOrderRecord, SupportTicketRecord, UserPreferencesRecord, IdentityStatus, TransactionTimeline, VirtualAccountControl, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord, SupplierRecord, SupplierPaymentRecord, BalanceSummary, BalanceTransferRecord } from '../types';

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
          <Kv label="NGN" value="Coming soon" />
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


type WithdrawalReviewState = { userId: string; externalAccountId: string; sourceCurrency: string; sourceChain: string; destinationCurrency: string; returnAddress?: string; bankLabel: string; assetLabel: string; networkLabel: string };

export function OffRampWizard({ accounts, enabledControls, enabledAssets, enabledNetworks, primaryAccount, withdrawalReview, depositResult, feePercent, loading, canCreatePaymentActions, onSubmit, onCancelReview, onConfirm }: {
  accounts: ExternalAccountRecord[];
  enabledControls: PaymentControl[];
  enabledAssets: AssetControl[];
  enabledNetworks: NetworkControl[];
  primaryAccount?: ExternalAccountRecord;
  withdrawalReview: WithdrawalReviewState | null;
  depositResult: DepositResponse | null;
  feePercent?: string;
  loading: boolean;
  canCreatePaymentActions: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancelReview: () => void;
  onConfirm: () => void;
}) {
  const hasEnabledBank = accounts.some((account) => enabledControls.some((control) => control.currency === account.currency));
  const step = depositResult ? 3 : withdrawalReview ? 2 : 1;
  return (
    <section className="offramp-wizard">
      <div className="trade-head">
        <div>
          <p className="eyebrow">Sell stablecoins</p>
          <h3>Withdraw to your bank</h3>
          <p className="muted">Choose a verified bank account, asset, and network. Review carefully before a deposit address is created.</p>
        </div>
        <div className="wizard-stepper">
          <StepDot active={step === 1} done={step > 1} label="Details" />
          <StepDot active={step === 2} done={step > 2} label="Review" />
          <StepDot active={step === 3} done={false} label="Deposit" />
        </div>
      </div>
      <div className="trade-grid">
        <div>
          {step === 1 && <WithdrawalDetailsForm accounts={accounts} enabledControls={enabledControls} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} primaryAccount={primaryAccount} hasEnabledBank={hasEnabledBank} loading={loading} canCreatePaymentActions={canCreatePaymentActions} onSubmit={onSubmit} />}
          {step === 2 && <WithdrawalReviewCard review={withdrawalReview} feePercent={feePercent} loading={loading} onCancel={onCancelReview} onConfirm={onConfirm} />}
          {step === 3 && <DepositCard result={depositResult} />}
        </div>
        <OffRampSidePanel step={step} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} />
      </div>
    </section>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return <div className={`step-node ${active ? 'active' : ''} ${done ? 'done' : ''}`}><span>{done ? '✓' : active ? '•' : ''}</span>{label}</div>;
}

function WithdrawalDetailsForm({ accounts, enabledControls, enabledAssets, enabledNetworks, primaryAccount, hasEnabledBank, loading, canCreatePaymentActions, onSubmit }: {
  accounts: ExternalAccountRecord[];
  enabledControls: PaymentControl[];
  enabledAssets: AssetControl[];
  enabledNetworks: NetworkControl[];
  primaryAccount?: ExternalAccountRecord;
  hasEnabledBank: boolean;
  loading: boolean;
  canCreatePaymentActions: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (!hasEnabledBank) return <article className="panel form-panel trade-card"><p className="eyebrow">Step 1</p><h3>Add a bank first</h3><Empty>Add an enabled bank account before creating a withdrawal.</Empty></article>;
  if (!enabledAssets.length || !enabledNetworks.length) return <article className="panel form-panel trade-card"><p className="eyebrow">Step 1</p><h3>Deposits unavailable</h3><Empty>Deposits are temporarily unavailable.</Empty></article>;
  return (
    <article className="panel form-panel trade-card">
      <p className="eyebrow">Step 1</p>
      <h3>Choose payout and deposit rail</h3>
      <p className="muted">Your deposit address will be tied to this bank account, token, and network.</p>
      <form className="form premium-form" onSubmit={onSubmit}>
        <label>Bank payout
          <CustomSelect name="externalAccountId" defaultValue={primaryAccount?.id} options={accounts.filter((account) => enabledControls.some((control) => control.currency === account.currency)).map((account) => ({ value: account.id, label: account.bankName || 'Bank account', helper: `${account.currency.toUpperCase()} · ****${account.accountLast4 || '----'}` }))} />
        </label>
        <div className="split">
          <label>Deposit asset<CustomSelect name="sourceCurrency" defaultValue={enabledAssets[0]?.asset || 'usdc'} options={enabledAssets.map((asset) => ({ value: asset.asset, label: asset.label }))} /></label>
          <label>Deposit network<CustomSelect name="sourceChain" defaultValue={enabledNetworks[0]?.network || 'base'} options={enabledNetworks.map((network) => ({ value: network.network, label: network.label }))} /></label>
        </div>
        <label>Refund wallet address<input name="returnAddress" placeholder="Wallet address for returned funds" defaultValue="0x0000000000000000000000000000000000000000" /></label>
        <div className="warning-box compact">You will review these details before a deposit address is created. Send only the selected token on the selected network.</div>
        <button className="primary-btn" disabled={loading || !canCreatePaymentActions}>{loading ? 'Preparing review...' : canCreatePaymentActions ? 'Review withdrawal' : 'Withdrawals paused'}</button>
      </form>
    </article>
  );
}

function OffRampSidePanel({ step, enabledAssets, enabledNetworks }: { step: number; enabledAssets: AssetControl[]; enabledNetworks: NetworkControl[] }) {
  return (
    <aside className="side-info-stack">
      <article className="panel">
        <p className="eyebrow">How this works</p>
        <h3>Provider-backed deposit address</h3>
        <ol className="ordered-steps">
          <li className={step >= 1 ? 'active' : ''}>Choose your bank, token, and network.</li>
          <li className={step >= 2 ? 'active' : ''}>Review the details and safety warning.</li>
          <li className={step >= 3 ? 'active' : ''}>Send the selected asset to the generated address.</li>
          <li>Track deposit detection, conversion, and bank payout.</li>
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

function WithdrawalReviewCard({ review, feePercent, loading, onCancel, onConfirm }: { review: null | { bankLabel: string; assetLabel: string; networkLabel: string; destinationCurrency: string }; feePercent?: string; loading: boolean; onCancel: () => void; onConfirm: () => void }) {
  if (!review) return null;
  return (
    <article className="deposit-card review-card">
      <p className="eyebrow">Review withdrawal</p>
      <h3>Confirm before creating your deposit address</h3>
      <p className="muted">Check these details carefully. Your deposit address will be tied to the selected asset, network, and bank payout.</p>
      <div className="details-box">
        <Kv label="Asset" value={review.assetLabel} />
        <Kv label="Network" value={review.networkLabel} />
        <Kv label="Bank payout" value={review.bankLabel} />
        <Kv label="Payout currency" value={review.destinationCurrency.toUpperCase()} />
        <Kv label="Sivan fee" value={feePercent ? `${feePercent}%` : '—'} />
      </div>
      <div className="warning-box">Send only {review.assetLabel} on {review.networkLabel}. Sending any other token, or using the wrong network, can permanently lose your funds and may not be recoverable. <a href={legalLinks.risk} target="_blank" rel="noreferrer">Read Risk Disclosure</a>.</div>
      <div className="split-actions">
        <button className="ghost-btn" onClick={onCancel}>Edit details</button>
        <button className="primary-btn" disabled={loading} onClick={onConfirm}>{loading ? 'Creating...' : 'Create deposit address'}</button>
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


export function DashboardAccountNotice({ onVerify }: { onVerify: () => void }) {
  return <article className="kyc-outcome-notice action dashboard-account-notice">
    <span className="kyc-outcome-icon">◈</span>
    <div className="kyc-outcome-copy"><p className="eyebrow">Account status</p><h3>Verify your account</h3><p>Complete identity verification to unlock payments.</p></div>
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
    ? { icon: '✓', title: customer.customerAction?.title || (hasBank ? 'Account ready' : 'Verification complete'), body: customer.customerAction?.message || (hasBank ? 'You can buy, sell, transfer, and manage payment methods.' : 'You’re verified. Add a payout bank to start selling crypto or receiving bank payouts.'), primary: hasBank ? readyPrimaryLabel : 'Add bank account' }
    : isReview
      ? { icon: '⏳', title: customer.customerAction?.title || 'Verification under review', body: customer.customerAction?.message || 'Your verification has been submitted and is being reviewed by our team. We will update this page automatically.', primary: 'Refresh status' }
      : isFailed
        ? { icon: '!', title: customer.customerAction?.title || 'Verification could not be completed', body: customer.customerAction?.message || 'Your secure verification was not approved. This can happen if a document is unclear or details do not match. You can retry or contact support.', primary: verificationLink ? 'Try verification again' : 'Refresh status' }
        : isIncomplete
          ? { icon: '🔔', title: customer.customerAction?.title || 'Verification needs one more step', body: customer.customerAction?.message || 'Your secure verification is not fully complete yet. Continue the secure verification flow to finish your identity check.', primary: verificationLink ? 'Continue verification' : 'Refresh status' }
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


export function VerificationPage({ hasUser, customer, customerTypes, kycFailed, canSubmitKyc, kycActionLabel, verificationRedirectUri, onSubmit, onRefresh, onSupport, onAddBank, onSell, hasBank }: { hasUser: boolean; customer: CustomerRecord | null; customerTypes: Array<{ customerType: 'individual' | 'business'; enabled: boolean; label: string }>; kycFailed: boolean; canSubmitKyc: boolean; kycActionLabel: string; verificationRedirectUri: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onRefresh: () => void; onSupport: () => void; onAddBank: () => void; onSell: () => void; hasBank: boolean }) {
  const emailDone = hasUser;
  const identityDone = customer?.kycStatus === 'kyc_approved';
  const verificationLink = customer?.hostedKycLink || customer?.kycLink;
  const canOpenExistingVerification = Boolean(verificationLink && customer?.id && !identityDone && !kycFailed);
  const started = Boolean(customer?.id);
  const bankDone = hasBank;
  const steps = [emailDone, identityDone, customer?.tosStatus === 'approved', bankDone];
  const pct = Math.round((steps.filter(Boolean).length / steps.length) * 100);
  return (
    <section className="app-page verification-premium">
      <PageHero title="Verification" subtitle="A short, secure check so you can use Sivan payments with confidence." />
      {customer && <KycOutcomeNotice customer={customer} hasBank={hasBank} onContinue={customer.kycStatus === 'kyc_approved' ? (hasBank ? onSell : onAddBank) : onRefresh} onSupport={onSupport} onRefresh={onRefresh} readyPrimaryLabel="Sell crypto" />}
      <div className="verification-grid">
        <article className="dashboard-setup-panel verification-main-card">
          <div className="verification-progress-head"><div><p className="eyebrow">Progress</p><h3>{pct}% complete</h3></div><Badge status={identityDone ? 'verified' : 'pending'}>{identityDone ? 'Level 1: Verified' : 'Level 0: Starter'}</Badge></div>
          <div className="setup-progress big"><div><span style={{ width: `${pct}%` }} /></div></div>
          <div className="level-grid"><div className="active"><strong>Step 1</strong><span>Email confirmed</span></div><div className={identityDone ? 'active' : ''}><strong>Step 2</strong><span>Identity verified</span></div><div className={hasBank ? 'active' : ''}><strong>Step 3</strong><span>Payout ready</span></div></div>
          <div className="verification-steps-list">
            <VerificationStep done={emailDone} index={1} title="Email confirmed" sub="Signed in securely" action="Completed" />
            <div className={`verification-step ${identityDone ? 'done' : ''}`}><span>{identityDone ? '✓' : '2'}</span><div><strong>Identity verification</strong><small>Government-issued ID and selfie. Usually takes about 3 minutes.</small></div>{!hasUser ? <button className="primary-btn small" disabled>Create account</button> : canOpenExistingVerification ? <a className="primary-btn small" href={verificationLink} target="_blank" rel="noreferrer">{kycActionLabel}</a> : <form onSubmit={onSubmit} key={customer?.id || 'new-verification'}><CustomSelect name="type" defaultValue={customer?.customerType || 'individual'} disabled={Boolean(customer?.id && !kycFailed)} options={customerTypes.map((type) => ({ value: type.customerType, label: type.label, helper: type.enabled ? undefined : 'Unavailable', disabled: !type.enabled }))} /><input name="redirectUri" type="hidden" value={verificationRedirectUri} /><button className="primary-btn small" disabled={!canSubmitKyc}>{kycActionLabel}</button></form>}</div>
            <VerificationStep done={customer?.tosStatus === 'approved'} index={3} title="Terms accepted" sub="Provider terms are accepted when required" action={customer?.tosStatus === 'approved' ? 'Completed' : started ? 'Continue' : 'Continue'} />
            <VerificationStep done={hasBank} index={4} title="Payout bank" sub="Add a bank when you are ready to sell crypto" action={hasBank ? 'Completed' : 'Continue'} />
          </div>
        </article>
        <div className="dashboard-side-stack">
          {customer && <article className="panel verification-status-card"><div className="panel-head"><div><p className="eyebrow">Current status</p><h3>Verification summary</h3></div><button className="ghost-btn small" onClick={onRefresh}>Refresh</button></div><CustomerDetails customer={customer} /></article>}
          <article className="panel verify-simple-card"><h3>Why we verify</h3><p className="muted">Verification keeps your account safe and helps Sivan meet payment partner requirements.</p><ul className="plain-list"><li>✓ Encrypted data</li><li>✓ Used only for compliance</li><li>✓ Status refreshes automatically</li></ul></article>
          <article className="security-card verify-help-card"><div className="security-icon">?</div><div><h3>Need help?</h3><p>If you are having trouble, support can review it with you.</p><button onClick={onSupport}>Contact support →</button><button onClick={onRefresh}>Refresh status →</button></div></article>
        </div>
      </div>
    </section>
  );
}

function VerificationStep({ done, index, title, sub, action }: { done: boolean; index: number; title: string; sub: string; action: string }) {
  return <div className={`verification-step ${done ? 'done' : ''}`}><span>{done ? '✓' : index}</span><div><strong>{title}</strong><small>{sub}</small></div><button className={`small ${done ? 'ghost-btn' : 'primary-btn'}`} disabled>{action}</button></div>;
}

export function PaymentMethodsView({ accounts, onSubmit, loading, isVerified, controls, canCreatePaymentActions, isLiveEnv, onRefresh }: { accounts: ExternalAccountRecord[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; isVerified: boolean; controls: PaymentControl[]; canCreatePaymentActions: boolean; isLiveEnv: boolean; onRefresh: () => void }) {
  return <section className="app-page payment-methods-premium"><PageHero title="Payment methods" subtitle="Manage payout banks you own for crypto-to-bank withdrawals." action={<button className="primary-btn small" onClick={onRefresh}>Refresh</button>} /><div className="payment-grid"><article className="dashboard-transactions payment-methods-card"><div className="dash-card-head"><h3>Verified bank accounts</h3></div><BankList accounts={accounts} /></article><BankForm onSubmit={onSubmit} loading={loading} isVerified={isVerified} controls={controls} canCreatePaymentActions={canCreatePaymentActions} isLiveEnv={isLiveEnv} /></div></section>;
}

export function VirtualAccountsView({ requests, accounts, transactions, controls, loading, isVerified, canCreatePaymentActions, onRequest, onRefresh }: { requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; transactions: VirtualAccountTransactionRecord[]; controls: VirtualAccountControl[]; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: 'usd' | 'gbp' | 'eur') => void; onRefresh: () => void }) {
  return <section className="app-page payment-methods-premium"><PageHero title="Virtual accounts" subtitle="Request reusable receiving accounts for fiat deposits into Sivan." action={<button className="primary-btn small" onClick={onRefresh}>Refresh</button>} /><VirtualAccountsCustomerPanel requests={requests} accounts={accounts} controls={controls} loading={loading} isVerified={isVerified} canCreatePaymentActions={canCreatePaymentActions} onRequest={onRequest} /><VirtualAccountDepositHistory transactions={transactions} /></section>;
}

const vaCurrencyMeta: Record<'usd' | 'gbp' | 'eur', { title: string; rails: string; account: string; flag: string }> = {
  usd: { title: 'USD Account', rails: 'ACH / Wire', account: 'US bank account', flag: '$' },
  gbp: { title: 'GBP Account', rails: 'Faster Payments', account: 'UK account number', flag: '£' },
  eur: { title: 'EUR Account', rails: 'SEPA', account: 'IBAN', flag: '€' }
};

function VirtualAccountsCustomerPanel({ requests, accounts, controls, loading, isVerified, canCreatePaymentActions, onRequest }: { requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; controls: VirtualAccountControl[]; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: 'usd' | 'gbp' | 'eur') => void }) {
  const currencies: Array<'usd' | 'gbp' | 'eur'> = ['usd', 'gbp', 'eur'];
  const enabledControls = controls.filter((control) => control.enabled);
  return <article className="virtual-bank-panel"><div className="virtual-bank-head"><div><p className="eyebrow">Virtual Accounts</p><h3>Request virtual bank accounts</h3><p className="muted">After approval, Sivan shows customer-safe bank details only. Provider internals, destination wallets, and economics stay hidden.</p></div><Badge status={enabledControls.length ? 'active' : 'pending'}>{enabledControls.length ? `${enabledControls.length} enabled` : 'Disabled'}</Badge></div><div className="virtual-bank-grid">{currencies.map((currency) => <VirtualAccountCurrencyCard key={currency} currency={currency} request={requests.find((item) => item.currency === currency && !['rejected', 'canceled'].includes(item.status))} account={accounts.find((item) => item.currency === currency && item.status !== 'closed' && item.provider !== 'mock')} control={controls.find((item) => item.currency === currency)} loading={loading} isVerified={isVerified} canCreatePaymentActions={canCreatePaymentActions} onRequest={onRequest} />)}</div></article>;
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

function VirtualAccountCurrencyCard({ currency, request, account, control, loading, isVerified, canCreatePaymentActions, onRequest }: { currency: 'usd' | 'gbp' | 'eur'; request?: VirtualAccountRequestRecord; account?: VirtualAccountRecord; control?: VirtualAccountControl; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: 'usd' | 'gbp' | 'eur') => void }) {
  const [copied, setCopied] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const meta = vaCurrencyMeta[currency];
  const enabled = Boolean(control?.enabled);
  const status = account?.status || request?.status || (enabled ? 'available' : 'disabled');
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
  return <section className={`virtual-bank-card ${account ? 'active has-account-details' : request ? 'pending' : ''}`}><div className="vb-card-top"><span>{meta.flag}</span><div><strong>{meta.title}</strong><small>{meta.rails} · {meta.account}</small></div></div><Badge status={status}>{friendlyStatus(status)}</Badge>{account ? <><div className="va-safety-stack"><div className="va-warning-card"><strong>Beneficiary name must match</strong><span>Use the account name exactly. Mismatched payments may be returned.</span></div><div className="va-info-card"><strong>Transfer timing</strong><span>Deposits may take 1–2 business days.</span></div></div><div className="va-detail-list">{detailRows.map(([label, value]) => <div className="va-detail-row" key={label}><div><strong>{value}</strong><span>{label}</span></div><button type="button" aria-label={`Copy ${label}`} onClick={() => copyValue(label, value)}>{copiedField === label ? '✓' : '⧉'}</button></div>)}</div><div className="vb-copy-actions va-bottom-actions"><div className="vb-copy-buttons"><button type="button" className="secondary-btn small share-button" onClick={shareAll}>↗ Share</button><button type="button" className="ghost-btn small" onClick={copyAll}>{copied ? 'Copied all ✓' : '⧉ Copy all'}</button></div><small>Share or copy all account details in one tap.</small></div></> : request ? <div className="vb-pending"><strong>{request.status === 'requested' ? 'Request received' : friendlyStatus(request.status)}</strong><small>Submitted {new Date(request.createdAt).toLocaleString()}. Sivan operations will review and approve before account details appear here.</small>{request.rejectionReason && <small className="danger-text">{request.rejectionReason}</small>}</div> : <div className="vb-empty"><p>Request a reusable {currency.toUpperCase()} virtual account for fiat deposits.</p><button className="primary-btn small" disabled={loading || Boolean(disabledReason)} onClick={() => onRequest(currency)}>{disabledReason || `Request ${currency.toUpperCase()} account`}</button></div>}</section>;
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
      {approved && <div className="verification-note success-note">You are verified. You can now add a bank account and use Sivan payment features.</div>}
    </div>
  );
}

function Kv({ label, value }: { label: string; value?: string | number | null }) {
  return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>;
}

function BankForm({ onSubmit, loading, isVerified, controls, canCreatePaymentActions, isLiveEnv }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; isVerified: boolean; controls: PaymentControl[]; canCreatePaymentActions: boolean; isLiveEnv: boolean }) {
  const [currency, setCurrency] = useState<'usd' | 'gbp' | 'eur'>((controls[0]?.currency ?? 'usd') as 'usd' | 'gbp' | 'eur');
  useEffect(() => {
    if (controls.length && !controls.some((control) => control.currency === currency)) {
      setCurrency(controls[0].currency);
    }
  }, [controls, currency]);
  if (!isVerified) return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add your bank</h3><Empty>Complete verification before adding a bank account.</Empty></article>;
  if (!controls.length) return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add your bank</h3><Empty>Bank payouts are temporarily unavailable.</Empty></article>;
  const isUsd = currency === 'usd';
  const isGbp = currency === 'gbp';
  return (
    <article className="panel form-panel">
      <p className="eyebrow">Step 3</p>
      <h3>Add your bank</h3>
      <p className="muted">Your payout must go to a bank account you own. Available payout currencies are controlled by Sivan.</p>
      <form className="form" onSubmit={onSubmit}>
        <label>Payout currency
          <CustomSelect name="currency" value={currency} onChange={(value) => setCurrency(value as 'usd' | 'gbp' | 'eur')} options={controls.map((control) => ({ value: control.currency, label: control.label }))} />
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
  return (
    <article className="deposit-card live-deposit-card">
      <p className="eyebrow">Step 3</p>
      <h3>Deposit address created</h3>
      <p className="muted">Send only {result.deposit.currency.toUpperCase()} on {result.deposit.chain}. Sending any other token, or using the wrong network, can permanently lose your funds and may not be recoverable. <a href={legalLinks.risk} target="_blank" rel="noreferrer">Read Risk Disclosure</a>.</p>
      <div className="qr-wrap premium-qr"><img src={qrUrl(result.deposit.address)} alt="Deposit address QR code" /><div><span className="address-label">Deposit address</span><div className="deposit-address clickable-address" title="Click or tap to copy address" onClick={copyDepositAddress} style={{ cursor: 'pointer' }}>{result.deposit.address}</div><button className="secondary-btn" onClick={copyDepositAddress}>{copied ? '✓ Copied to clipboard' : 'Copy address'}</button></div></div>
      <div className="details-box"><Kv label="Reference" value={shortRef(result.withdrawal.id)} /><Kv label="Payout currency" value={result.withdrawal.destinationCurrency.toUpperCase()} /><Kv label="Fee" value={`${result.withdrawal.feePercent || '0'}%`} /><Kv label="Status" value={friendlyStatus(result.withdrawal.status)} /></div>
      {result.withdrawal.transactionTimeline ? <InlineTransactionTimeline timeline={result.withdrawal.transactionTimeline} /> : <div className="tracking-timeline">
        <TimelineItem done title="Address created" body="A unique provider-backed deposit address is ready." />
        <TimelineItem active={result.withdrawal.status === 'pending_deposit'} done={result.withdrawal.status !== 'pending_deposit'} title="Awaiting deposit" body="Send only the selected token and network." />
        <TimelineItem active={['deposit_received', 'payout_processing'].includes(result.withdrawal.status)} done={result.withdrawal.status === 'completed'} title="Convert and payout" body="Sivan detects the deposit, liquidates, and sends fiat to your bank." />
        <TimelineItem done={result.withdrawal.status === 'completed'} title="Completed" body="Bank payout completed once provider status confirms." />
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
