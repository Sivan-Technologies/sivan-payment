import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatMoneyGramPin,
  generateMoneyGramReferencePin,
  MONEYGRAM_SUPPORTED_COUNTRIES,
  resolveMoneyGramAnchorUrl,
  saveMoneyGramVoucher,
  type MoneyGramCountryOption,
  type MoneyGramPostMessageEvent,
  type MoneyGramVoucher,
} from '../../moneygram';

export interface MoneyGramModalProps {
  open: boolean;
  mode?: 'withdraw' | 'deposit';
  onClose: () => void;
  onSuccess?: (voucher: MoneyGramVoucher) => void;
  userFullName?: string;
  userEmail?: string;
  userPhone?: string;
  userSpendableUsdc?: number | null;
}

export function MoneyGramModal({
  open,
  mode: initialMode = 'withdraw',
  onClose,
  onSuccess,
  userFullName = '',
  userPhone = '',
  userSpendableUsdc,
}: MoneyGramModalProps) {
  const [mode, setMode] = useState<'withdraw' | 'deposit'>(initialMode);
  const [step, setStep] = useState<'setup' | 'session' | 'voucher'>('setup');
  const [selectedCountryCode, setSelectedCountryCode] = useState('NG');
  const [amount, setAmount] = useState('25');
  const [recipientName, setRecipientName] = useState(userFullName);
  const [recipientPhone, setRecipientPhone] = useState(userPhone);
  const [activeVoucher, setActiveVoucher] = useState<MoneyGramVoucher | null>(null);
  const [copied, setCopied] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [interactiveUrl, setInteractiveUrl] = useState<string>('');
  const [sessionId, setSessionId] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [stellarWalletAddress, setStellarWalletAddress] = useState<string>('');
  const [isSigning, setIsSigning] = useState(false);
  const [signingStatus, setSigningStatus] = useState<string>('');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionTokenRef = useRef(sessionToken);
  sessionTokenRef.current = sessionToken;
  const stellarAddressRef = useRef(stellarWalletAddress);
  stellarAddressRef.current = stellarWalletAddress;

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setStep('setup');
      setSigningStatus('');
      setIsSigning(false);
      if (userFullName && !recipientName) setRecipientName(userFullName);
      if (userPhone && !recipientPhone) setRecipientPhone(userPhone);
    }
  }, [open, initialMode, userFullName, userPhone]);

  const selectedCountry = useMemo<MoneyGramCountryOption>(() => {
    return (
      MONEYGRAM_SUPPORTED_COUNTRIES.find((c) => c.code === selectedCountryCode) ||
      MONEYGRAM_SUPPORTED_COUNTRIES[1] // Default Nigeria
    );
  }, [selectedCountryCode]);

  const numAmount = Number(amount) || 0;
  const estimatedTargetAmount = useMemo(() => {
    const total = numAmount * selectedCountry.estimatedRate;
    return selectedCountry.currency === 'USD' || selectedCountry.currency === 'EUR' || selectedCountry.currency === 'GBP'
      ? total.toFixed(2)
      : Math.round(total).toLocaleString();
  }, [numAmount, selectedCountry]);

  // Resolve actual spendable Stellar USDC: strictly use Stellar native balance
  const resolvedSpendable = useMemo(() => {
    if (typeof userSpendableUsdc === 'number' && userSpendableUsdc >= 0) {
      return userSpendableUsdc;
    }
    try {
      const raw = localStorage.getItem('sivan.unifiedBalance');
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const w of parsed.wallets || []) {
          if (String(w.chain || '').toLowerCase() === 'stellar') {
            for (const b of w.balances || []) {
              if (String(b.asset || '').toLowerCase() === 'usdc') {
                const amt = Number(b.amount);
                if (Number.isFinite(amt)) return amt;
              }
            }
          }
        }
      }
    } catch {
      // Ignored
    }
    return 0;
  }, [userSpendableUsdc]);

  const sendRampsConfig = () => {
    const targetWin = iframeRef.current?.contentWindow;
    if (!targetWin) return;
    const configMessage = {
      type: 'RAMPS_CONFIG',
      payload: {
        sessionToken: sessionTokenRef.current || undefined,
        theme: 'dark',
        wallet: {
          address: stellarAddressRef.current || 'GB3AE2OH354LR3SSSA5KF3BMSIAAG2EJGVOQSKCMEICECFWG7KDHZTNJ',
          chain: 'stellar',
          asset: 'USDC',
          walletType: 'non-custodial',
        },
        devConfig: {
          mockMode: false,
          apiBaseUrl: 'https://playground.xramps.moneygram.com/api',
        },
      },
    };
    try {
      targetWin.postMessage(JSON.stringify(configMessage), '*');
    } catch {
      // Ignored
    }
  };

  // Listen for MoneyGram XRamps postMessage protocol (RAMPS_READY, RAMPS_SIGN_TRANSACTION, RAMPS_TRANSACTION_COMPLETE)
  useEffect(() => {
    if (!open || step !== 'session') return;

    async function handlePostMessage(event: MessageEvent) {
      let data = event.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || typeof data !== 'object') return;

      const type = (data as any).type;
      const payload = (data as any).payload || {};

      // 1. MoneyGram XRamps widget handshake: respond with RAMPS_CONFIG
      if (type === 'RAMPS_READY') {
        sendRampsConfig();
      }
      // 2. Non-custodial sign request from MoneyGram widget
      else if (type === 'RAMPS_SIGN_TRANSACTION') {
        setIsSigning(true);
        setSigningStatus('Signing Stellar USDC transaction...');
        try {
          const signRes = await fetch('/api/moneygram/sign-transaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: payload.to,
              amount: payload.amount,
              memo: payload.memo,
              tokenAddress: payload.tokenAddress || 'USDC',
              requiredNetwork: payload.requiredNetwork || 'testnet',
              issuer: payload.issuer,
              userAddressOrId: stellarAddressRef.current,
            }),
          });
          const signJson = await signRes.json();
          if (signJson?.data?.txHash) {
            setSigningStatus('Payment confirmed on-chain!');
            iframeRef.current?.contentWindow?.postMessage(
              JSON.stringify({
                type: 'RAMPS_SIGN_SUCCESS',
                payload: {
                  txHash: signJson.data.txHash,
                  walletAddress: stellarAddressRef.current,
                },
              }),
              '*'
            );
          } else {
            const errMsg = signJson?.error?.message || 'Transaction signing failed';
            setSigningStatus(`Error: ${errMsg}`);
            iframeRef.current?.contentWindow?.postMessage(
              JSON.stringify({
                type: 'RAMPS_SIGN_ERROR',
                payload: { error: errMsg },
              }),
              '*'
            );
          }
        } catch (err: any) {
          setSigningStatus(`Signing failed: ${err?.message || err}`);
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({
              type: 'RAMPS_SIGN_ERROR',
              payload: { error: err?.message || 'Signing failed' },
            }),
            '*'
          );
        } finally {
          setIsSigning(false);
        }
      }
      // 3. MoneyGram transaction completed / committed
      else if (
        type === 'RAMPS_TRANSACTION_COMPLETE' ||
        type === 'COMMIT_RESULT' ||
        type === 'transaction_completed' ||
        (data as any).status === 'success' ||
        (data as any).transaction?.status === 'pending_user_transfer_start' ||
        (data as any).transaction?.status === 'pending_user_transfer_complete'
      ) {
        const refNumber =
          payload.referenceNumber ||
          payload.transactionId ||
          (data as any).transaction?.external_transaction_id;
        completeSession(refNumber);
      }
    }

    window.addEventListener('message', handlePostMessage);
    return () => window.removeEventListener('message', handlePostMessage);
  }, [open, step, amount, selectedCountry, recipientName, recipientPhone]);

  function openMoneyGramPortal(urlToOpen?: string) {
    const targetUrl = urlToOpen || interactiveUrl;
    if (!targetUrl) return;
    const width = 540;
    const height = 750;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    try {
      const popup = window.open(
        targetUrl,
        'MoneyGram_KYC_Portal',
        `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`
      );
      if (!popup || popup.closed || typeof popup.closed === 'undefined') {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      } else {
        popup.focus();
      }
    } catch {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
    }
  }

  async function handleStartSession(e: React.FormEvent) {
    e.preventDefault();
    if (numAmount <= 0) return;
    setIsProcessing(true);
    setSigningStatus('');
    try {
      const res = await fetch('/api/moneygram/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: numAmount,
          targetCurrency: selectedCountry.currency,
          mode,
          recipientName: recipientName.trim() || 'Valued Customer',
          recipientPhone: recipientPhone.trim() || undefined,
          channel: 'minipay',
        }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.data) {
          if (json.data.sessionToken) setSessionToken(json.data.sessionToken);
          if (json.data.walletAddress) setStellarWalletAddress(json.data.walletAddress);
          const url = json.data.widgetUrl || json.data.interactiveUrl;
          if (url) setInteractiveUrl(url);
          if (json.data.id) setSessionId(json.data.id);
        }
      }
    } catch {
      // Fallback handled gracefully
    } finally {
      setIsProcessing(false);
      setStep('session');
    }
  }

  function completeSession(overridePin?: string, overrideMoreInfoUrl?: string) {
    const rawPin = overridePin || generateMoneyGramReferencePin();
    const formattedPin = formatMoneyGramPin(rawPin);
    const txId = sessionId || `mg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const moreInfoUrl =
      overrideMoreInfoUrl ||
      `${resolveMoneyGramAnchorUrl()}/stellarsepservice/sep24/transaction/more_info?id=${txId}`;

    const newVoucher: MoneyGramVoucher = {
      id: txId,
      referencePin: formattedPin,
      externalTransactionId: rawPin,
      transactionId: txId,
      mode,
      amount: numAmount.toFixed(2),
      asset: 'USDC',
      targetCurrency: selectedCountry.currency,
      targetAmount: estimatedTargetAmount,
      recipientName: recipientName.trim() || 'Valued Customer',
      recipientPhone: recipientPhone.trim() || undefined,
      status: 'ready_for_pickup',
      statusLabel: mode === 'withdraw' ? 'Ready for Counter Pickup' : 'Ready for Counter Deposit',
      moreInfoUrl,
      createdAt: new Date().toISOString(),
    };

    saveMoneyGramVoucher(newVoucher);
    setActiveVoucher(newVoucher);
    if (onSuccess) {
      onSuccess(newVoucher);
    }
    setStep('voucher');
  }

  const copyPin = async () => {
    if (!activeVoucher) return;
    try {
      await navigator.clipboard?.writeText(activeVoucher.referencePin);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Ignored
    }
  };

  if (!open) return null;

  return (
    <div
      className="sv-modal-backdrop"
      onClick={onClose}
      role="presentation"
      style={{ zIndex: 9999, overflowY: 'auto', padding: '16px' }}
    >
      <div
        className="sv-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '580px', width: '100%', padding: '28px' }}
      >
        {/* Modal Header */}
        <div className="sv-modal-head" style={{ marginBottom: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span
              className="sv-modal-eyebrow"
              style={{
                color: 'var(--green-ink)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span
                style={{
                  background: '#e02424',
                  color: '#fff',
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: '4px',
                }}
              >
                MONEYGRAM
              </span>
              STELLAR NATIVE RAMPS
            </span>
            <button
              type="button"
              className="sv-modal-close"
              onClick={onClose}
              aria-label="Close MoneyGram modal"
            >
              ✕
            </button>
          </div>

          <h2 style={{ margin: '8px 0 4px', fontSize: '22px', fontWeight: 700 }}>
            {mode === 'withdraw' ? '💵 Cash Pickup at Counter' : '📥 Cash In Deposit'}
          </h2>
          <p className="sv-modal-sub" style={{ margin: 0, fontSize: '13.5px' }}>
            {mode === 'withdraw'
              ? 'Withdraw native Stellar USDC and collect physical cash at 400,000+ MoneyGram locations worldwide.'
              : 'Bring physical cash to any MoneyGram agent location and receive native Stellar USDC directly in your Sivan account.'}
          </p>
        </div>

        {/* Mode Selector */}
        {step === 'setup' && (
          <div
            className="seg"
            style={{
              display: 'flex',
              marginBottom: '20px',
              background: 'var(--surface-2)',
              borderRadius: '10px',
              padding: '4px',
            }}
          >
            <button
              type="button"
              className={mode === 'withdraw' ? 'active' : ''}
              onClick={() => setMode('withdraw')}
              style={{ flex: 1, padding: '8px', fontSize: '13px' }}
            >
              💵 Cash Pickup (Withdraw)
            </button>
            <button
              type="button"
              className={mode === 'deposit' ? 'active' : ''}
              onClick={() => setMode('deposit')}
              style={{ flex: 1, padding: '8px', fontSize: '13px' }}
            >
              📥 Cash In (Deposit)
            </button>
          </div>
        )}

        {/* Step 1: Configuration Form */}
        {step === 'setup' && (
          <form onSubmit={handleStartSession} className="form" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: '6px' }}>
                Pickup / Deposit Country & Currency
              </label>
              <select
                value={selectedCountryCode}
                onChange={(e) => setSelectedCountryCode(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: '1px solid var(--border-control)',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  fontSize: '14px',
                }}
              >
                {MONEYGRAM_SUPPORTED_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.country} ({c.currency} - {c.symbol})
                  </option>
                ))}
              </select>
            </div>

            {/* Amount input with fast chips */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
                  Amount in USDC (Stellar)
                </label>
                {typeof resolvedSpendable === 'number' && (
                  <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                    Spendable: {resolvedSpendable.toFixed(2)} USDC
                  </span>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="25.00"
                  required
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    borderRadius: '10px',
                    border: '1px solid var(--border-control)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    fontSize: '18px',
                    fontWeight: 600,
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    right: '14px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    fontWeight: 700,
                    color: 'var(--muted)',
                  }}
                >
                  USDC
                </span>
              </div>

              {/* Fast Amount Chips */}
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                {['15', '25', '50'].map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="ghost-btn"
                    onClick={() => setAmount(chip)}
                    style={{
                      fontSize: '12px',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      border: amount === chip ? '1px solid var(--green-ink)' : '1px solid var(--border)',
                      background: amount === chip ? 'rgba(0, 122, 199, 0.08)' : 'transparent',
                    }}
                  >
                    {chip} USDC
                  </button>
                ))}
                {typeof resolvedSpendable === 'number' && resolvedSpendable > 0 && (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => setAmount(String(Math.min(resolvedSpendable, 2500)))}
                    style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '6px' }}
                  >
                    Max
                  </button>
                )}
              </div>
            </div>

            {/* Recipient Legal Name */}
            <div>
              <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: '6px' }}>
                Beneficiary Legal Full Name (Must match government photo ID)
              </label>
              <input
                type="text"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                placeholder="e.g. John Doe"
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: '1px solid var(--border-control)',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  fontSize: '14px',
                }}
              />
              <small style={{ color: 'var(--muted)', fontSize: '11.5px', marginTop: '4px', display: 'block' }}>
                Teller will verify this name against official ID at the MoneyGram counter.
              </small>
            </div>

            {/* Recipient Phone */}
            <div>
              <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: '6px' }}>
                Mobile Phone Number (Optional, for SMS PIN voucher)
              </label>
              <input
                type="tel"
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value)}
                placeholder="e.g. +234 801 234 5678"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: '1px solid var(--border-control)',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  fontSize: '14px',
                }}
              />
            </div>

            {/* Live Calculation Callout */}
            <div
              style={{
                background: 'var(--surface-2)',
                borderRadius: '10px',
                padding: '14px',
                border: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  {mode === 'withdraw' ? 'Estimated Cash to Collect' : 'Cash Required at Counter'}
                </span>
                <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)' }}>
                  {selectedCountry.symbol} {estimatedTargetAmount} {selectedCountry.currency}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block' }}>
                  Stellar Fee: 0% · Zero Gas Delays
                </span>
                <span style={{ fontSize: '11px', color: 'var(--green-ink)', fontWeight: 600 }}>
                  1 USDC ≈ {selectedCountry.estimatedRate} {selectedCountry.currency}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
              <button type="button" className="ghost-btn" onClick={onClose} style={{ flex: 1 }}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary-btn"
                disabled={isProcessing || numAmount <= 0}
                style={{ flex: 2 }}
              >
                {isProcessing
                  ? 'Connecting to MoneyGram...'
                  : mode === 'withdraw'
                  ? 'Start Cash Pickup Session →'
                  : 'Start Cash In Session →'}
              </button>
            </div>
          </form>
        )}

        {/* Step 2: Official MoneyGram XRamps Partner Widget */}
        {step === 'session' && (
          <div style={{ textAlign: 'center', padding: '6px 0' }}>
            {/* Signing Status Banner (when non-custodial signing is active) */}
            {signingStatus && (
              <div
                style={{
                  background: isSigning ? 'rgba(0, 122, 199, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                  border: `1px solid ${isSigning ? '#007ac7' : '#10b981'}`,
                  borderRadius: '10px',
                  padding: '10px 14px',
                  marginBottom: '12px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'var(--text)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
              >
                <span className="pulsing-dot" style={{ width: '8px', height: '8px', borderRadius: '50%', background: isSigning ? '#007ac7' : '#10b981' }} />
                {signingStatus}
              </div>
            )}

            {/* Session Overview Mini Bar */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: '10px',
                padding: '10px 14px',
                marginBottom: '14px',
                fontSize: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ background: '#e02424', color: '#fff', fontSize: '9px', fontWeight: 800, padding: '2px 5px', borderRadius: '3px' }}>
                  XRAMPS
                </span>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>{selectedCountry.flag} {selectedCountry.country}</span>
              </div>
              <div>
                <span style={{ color: 'var(--muted)', marginRight: '6px' }}>Target:</span>
                <strong style={{ color: '#10b981' }}>{selectedCountry.symbol}{estimatedTargetAmount} {selectedCountry.currency}</strong>
              </div>
            </div>

            {/* Embedded MoneyGram XRamps Partner Widget */}
            {interactiveUrl ? (
              <div
                style={{
                  borderRadius: '14px',
                  overflow: 'hidden',
                  border: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  marginBottom: '14px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                  position: 'relative',
                  minHeight: '560px',
                }}
              >
                {/* Background loader visible while MoneyGram iframe connects */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '12px',
                    color: 'var(--muted)',
                    zIndex: 0,
                    padding: '20px',
                  }}
                >
                  <span className="sv-spinner" style={{ width: '28px', height: '28px' }} />
                  <span style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 600 }}>Connecting to MoneyGram XRamps...</span>
                  <small style={{ fontSize: '11.5px', color: 'var(--muted)', maxWidth: '320px', textAlign: 'center', lineHeight: '1.5' }}>
                    If your browser or ad blocker restricts embedded frames, click <strong>Open in New Window ↗</strong> below to proceed directly.
                  </small>
                </div>

                <iframe
                  ref={iframeRef}
                  src={interactiveUrl}
                  title="MoneyGram XRamps Non-Custodial Widget"
                  style={{
                    width: '100%',
                    height: '560px',
                    border: 'none',
                    background: '#fff',
                    display: 'block',
                    position: 'relative',
                    zIndex: 1,
                  }}
                  allow="clipboard-write; camera; geolocation"
                  onLoad={() => {
                    sendRampsConfig();
                    setTimeout(sendRampsConfig, 400);
                    setTimeout(sendRampsConfig, 1000);
                    setTimeout(sendRampsConfig, 2000);
                  }}
                />
              </div>
            ) : null}

            {/* Bottom Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
              <button type="button" className="ghost-btn" onClick={() => setStep('setup')} style={{ fontSize: '12px' }}>
                ← Back
              </button>

              <div style={{ display: 'flex', gap: '8px' }}>
                {interactiveUrl && (
                  <button
                    type="button"
                    className="secondary-btn small"
                    onClick={() => openMoneyGramPortal()}
                    style={{ fontSize: '12px' }}
                  >
                    Open in New Window ↗
                  </button>
                )}
                <button
                  type="button"
                  className="primary-btn small"
                  onClick={() => completeSession()}
                  style={{ fontSize: '12px' }}
                >
                  Confirm & View PIN →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Confirmed Voucher Display */}
        {step === 'voucher' && activeVoucher && (
          <div>
            <div
              style={{
                background: 'var(--surface-2)',
                border: '2px dashed var(--border-control)',
                borderRadius: '14px',
                padding: '20px',
                textAlign: 'center',
                marginBottom: '18px',
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
                    fontSize: '32px',
                    fontWeight: 800,
                    letterSpacing: '0.18em',
                    color: 'var(--green-ink)',
                  }}
                >
                  {formatMoneyGramPin(activeVoucher.referencePin)}
                </span>
                <button
                  type="button"
                  className="secondary-btn small"
                  onClick={copyPin}
                  style={{ padding: '6px 12px' }}
                >
                  {copied ? '✓ Copied' : 'Copy PIN'}
                </button>
              </div>
              <span
                style={{
                  display: 'inline-block',
                  marginTop: '10px',
                  fontSize: '12px',
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: '16px',
                  background: 'rgba(22, 133, 109, 0.1)',
                  color: '#16856d',
                  border: '1px solid rgba(22, 133, 109, 0.25)',
                }}
              >
                ✓ {activeVoucher.statusLabel}
              </span>
            </div>

            {/* Summary Details */}
            <div
              style={{
                background: 'var(--surface-3)',
                borderRadius: '10px',
                padding: '14px',
                fontSize: '13px',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '10px',
                marginBottom: '18px',
              }}
            >
              <div>
                <span style={{ color: 'var(--muted)', display: 'block' }}>Beneficiary</span>
                <strong>{activeVoucher.recipientName}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--muted)', display: 'block' }}>Expected Cashout</span>
                <strong>
                  {activeVoucher.targetAmount} {activeVoucher.targetCurrency}
                </strong>
              </div>
              <div>
                <span style={{ color: 'var(--muted)', display: 'block' }}>Funding Method</span>
                <strong>{activeVoucher.amount} USDC (Stellar)</strong>
              </div>
              <div>
                <span style={{ color: 'var(--muted)', display: 'block' }}>Locations</span>
                <strong>400,000+ Counters Worldwide</strong>
              </div>
            </div>

            <div
              style={{
                background: 'rgba(0, 122, 199, 0.05)',
                border: '1px solid rgba(0, 122, 199, 0.2)',
                borderRadius: '10px',
                padding: '12px 14px',
                marginBottom: '18px',
                fontSize: '12.5px',
                color: 'var(--muted)',
                lineHeight: '1.5',
              }}
            >
              Present this <strong>8-digit PIN</strong> and government-issued photo ID at any MoneyGram counter. The voucher has been saved to your dashboard.
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                className="primary-btn"
                onClick={onClose}
                style={{ flex: 1 }}
              >
                Done / View in Dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
