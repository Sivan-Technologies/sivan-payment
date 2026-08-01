import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  filterBanks,
  isValidNuban,
  maskAccountNumber,
  shouldResolveAccount,
  type NgnBank,
  type ResolvedNgnBankAccount,
} from '../../ngnBank';
import type { VerificationPathPlan } from '../../verificationPath';

/**
 * Level 1 verification, as a modal.
 *
 * A modal rather than a page because the Nigerian path is short - pick a bank,
 * type ten digits, confirm a name - and bouncing a user to a separate screen
 * for that loses the context they were in (usually a withdrawal they are
 * halfway through starting).
 *
 * The Bridge path is NOT a modal. It redirects to a hosted flow on Bridge's
 * domain, so it cannot be contained in one, and pretending otherwise would
 * mean a modal that vanishes the moment it is used.
 */

export function VerificationModal({
  open,
  plan,
  userId,
  fullName,
  api,
  loading,
  onClose,
  onVerified,
  onStartBridge,
}: {
  open: boolean;
  plan: VerificationPathPlan;
  userId: string;
  fullName: string;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  loading: boolean;
  onClose: () => void;
  onVerified: (account: ResolvedNgnBankAccount) => void;
  onStartBridge: () => void;
}) {
  // Escape closes, because a modal that traps you is worse than no modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // Stops the page behind scrolling under the overlay on mobile, which is
    // the single most common way a modal feels broken on a phone.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sv-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="sv-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sv-modal-title"
        // Without this a click inside the panel bubbles to the backdrop and
        // closes the dialog mid-typing.
        onClick={(event) => event.stopPropagation()}
      >
        <button className="sv-modal-close" onClick={onClose} aria-label="Close">×</button>

        <div className="sv-modal-head">
          <span className="sv-modal-eyebrow">
            {plan.path === 'ngn_bank' ? 'Level 1 · Bank check' : 'Identity verification'}
          </span>
          <h2 id="sv-modal-title">{plan.title}</h2>
          <p className="sv-modal-sub">{plan.description}</p>
        </div>

        {plan.path === 'ngn_bank' ? (
          <NgnBankVerification
            userId={userId}
            fullName={fullName}
            api={api}
            onVerified={onVerified}
          />
        ) : (
          <BridgeVerification plan={plan} loading={loading} onStart={onStartBridge} />
        )}

        <ul className="sv-modal-unlocks">
          {plan.unlocks.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
    </div>
  );
}

/**
 * The Nigerian path: bank, account number, name confirmation.
 *
 * The name check is the point of the whole screen. A resolved Nigerian account
 * proves a licensed bank verified SOMEONE - matching the holder to the name on
 * file is what makes it evidence about THIS user.
 */
function NgnBankVerification({
  userId,
  fullName,
  api,
  onVerified,
}: {
  userId: string;
  fullName: string;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  onVerified: (account: ResolvedNgnBankAccount) => void;
}) {
  const [banks, setBanks] = useState<NgnBank[]>([]);
  const [query, setQuery] = useState('');
  const [bankId, setBankId] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [resolved, setResolved] = useState<ResolvedNgnBankAccount | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api<NgnBank[]>(`/api/ngn/banks?userId=${encodeURIComponent(userId)}`)
      .then((list) => { if (!cancelled) setBanks(list ?? []); })
      .catch(() => { if (!cancelled) setError('Could not load banks. Try again shortly.'); });
    return () => { cancelled = true; };
  }, [api, userId]);

  const visible = useMemo(() => filterBanks(banks, query).slice(0, 6), [banks, query]);
  const selectedBank = banks.find((bank) => bank.id === bankId);

  const resolve = useCallback(async () => {
    if (!shouldResolveAccount(bankId, accountNumber)) return;
    setResolving(true);
    setError('');
    setResolved(null);
    try {
      const result = await api<ResolvedNgnBankAccount>(
        `/api/ngn/bank-account/resolve?userId=${encodeURIComponent(userId)}` +
        `&bankId=${encodeURIComponent(bankId)}&accountNumber=${encodeURIComponent(accountNumber)}`
      );
      setResolved(result);
    } catch (err) {
      setError((err as Error).message || 'We could not verify that account.');
    } finally {
      setResolving(false);
    }
  }, [api, userId, bankId, accountNumber]);

  // Fires only on a complete 10-digit NUBAN. Resolution is a paid,
  // rate-limited provider call; firing per keystroke spends a request per
  // digit and shows failures for a number still being typed.
  useEffect(() => {
    if (shouldResolveAccount(bankId, accountNumber)) void resolve();
    else setResolved(null);
  }, [bankId, accountNumber, resolve]);

  const step = resolved ? 3 : bankId ? 2 : 1;

  return (
    <div className="sv-modal-body">
      <div className="sv-steps">
        {['Bank', 'Account', 'Confirm'].map((label, index) => (
          <div key={label} className={`sv-step ${step > index + 1 ? 'done' : ''} ${step === index + 1 ? 'active' : ''}`}>
            <span>{step > index + 1 ? '✓' : index + 1}</span>{label}
          </div>
        ))}
      </div>

      {!bankId && (
        <>
          <label className="sv-field">
            <span>Your bank</span>
            <input
              autoFocus
              placeholder="Search — GTB, Access, UBA…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="sv-bank-list">
            {!banks.length && !error && <p className="sv-muted">Loading banks…</p>}
            {visible.map((bank) => (
              <button key={bank.id} type="button" className="sv-bank" onClick={() => { setBankId(bank.id); setQuery(''); }}>
                {bank.logoUrl
                  ? <img src={bank.logoUrl} alt="" width={22} height={22} />
                  : <span className="sv-bank-dot">{bank.name.slice(0, 1)}</span>}
                <span>{bank.name}</span>
                <em>→</em>
              </button>
            ))}
            {Boolean(query) && !visible.length && <p className="sv-muted">No bank matches “{query}”.</p>}
          </div>
        </>
      )}

      {bankId && (
        <>
          <div className="sv-selected">
            {selectedBank?.logoUrl && <img src={selectedBank.logoUrl} alt="" width={20} height={20} />}
            <strong>{selectedBank?.name}</strong>
            <button type="button" onClick={() => { setBankId(''); setResolved(null); setAccountNumber(''); }}>Change</button>
          </div>

          <label className="sv-field">
            <span>Account number</span>
            <input
              autoFocus
              inputMode="numeric"
              maxLength={10}
              placeholder="10 digits"
              value={accountNumber}
              onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, '').slice(0, 10))}
            />
            {Boolean(accountNumber) && !isValidNuban(accountNumber) && (
              <em className="sv-hint">{10 - accountNumber.length} more digit{10 - accountNumber.length === 1 ? '' : 's'}</em>
            )}
          </label>
        </>
      )}

      {resolving && <div className="sv-resolving"><span className="sv-spinner" />Checking that account…</div>}

      {resolved && (
        <div className="sv-resolved">
          <div className="sv-resolved-head">
            <span className="sv-tick">✓</span>
            <div>
              <strong>{resolved.accountName}</strong>
              <small>{resolved.bankName ?? selectedBank?.name} · {maskAccountNumber(resolved.accountNumber)}</small>
            </div>
          </div>
          <p className="sv-muted">
            Signed up as <strong>{fullName}</strong>. These should be the same person.
          </p>
          {!resolved.trustworthy && (
            // The sandbox resolves ANY account number to a plausible name, so
            // presenting this as confirmation would be a lie.
            <p className="sv-warn">Test environment — this name is simulated and confirms nothing.</p>
          )}
          <button className="sv-primary" onClick={() => onVerified(resolved)}>
            Yes, that is me →
          </button>
        </div>
      )}

      {error && <p className="sv-error">{error}</p>}
    </div>
  );
}

/** The Bridge path. A handoff, not a form. */
function BridgeVerification({
  plan,
  loading,
  onStart,
}: {
  plan: VerificationPathPlan;
  loading: boolean;
  onStart: () => void;
}) {
  return (
    <div className="sv-modal-body">
      {plan.isFallback && (
        // "We do not know where you are" reads very differently from "you are
        // American, so you use Bridge", and the user can act on the first.
        <p className="sv-warn">
          Set your country in Settings so we can show you the fastest verification for where you live.
        </p>
      )}

      <ol className="sv-bridge-steps">
        <li><strong>Photo ID</strong><span>Passport, driver’s licence or national ID</span></li>
        <li><strong>A short selfie</strong><span>Confirms the ID belongs to you</span></li>
        <li><strong>Your address</strong><span>Where you are based</span></li>
      </ol>

      <p className="sv-muted">
        This opens our partner Bridge in a new tab. Come back here when you are done — this page
        updates on its own.
      </p>

      <button className="sv-primary" disabled={loading} onClick={onStart}>
        {loading ? 'Opening…' : 'Start verification →'}
      </button>
    </div>
  );
}
