import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  filterBanks,
  isValidNuban,
  maskAccountNumber,
  shouldResolveAccount,
  type NgnBank,
  type ResolvedNgnBankAccount,
} from '../../ngnBank';
import {
  SIGNUP_COUNTRIES,
  normalizeCountry,
  planToRender,
  type VerificationPathPlan,
} from '../../verificationPath';

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
  country,
  api,
  loading,
  onClose,
  onCountryChange,
  onVerified,
  onStartBridge,
}: {
  open: boolean;
  /** The server's plan for the country already on file, if any. */
  plan: VerificationPathPlan;
  userId: string;
  fullName: string;
  /** Country on the user record. Undefined for everyone who signed up before this existed. */
  country?: string;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  loading: boolean;
  onClose: () => void;
  /** Persisted so the choice survives a reload and the server can re-plan. */
  onCountryChange: (country: string) => Promise<void> | void;
  onVerified: (account: ResolvedNgnBankAccount) => void;
  onStartBridge: () => void;
}) {
  // The country the modal is currently acting on. Seeded from the record, then
  // owned locally so picking a country re-routes the modal instantly rather
  // than waiting on a round trip - the save happens in the background.
  const [chosenCountry, setChosenCountry] = useState<string | undefined>(() => normalizeCountry(country));
  const [savingCountry, setSavingCountry] = useState(false);
  const [countryError, setCountryError] = useState('');

  // A user who reopens the modal after their country was saved elsewhere must
  // not see a stale local value.
  useEffect(() => { setChosenCountry(normalizeCountry(country)); }, [country, open]);

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

  /**
   * Which plan to render.
   *
   * The server's plan wins while the country it was computed for still matches
   * what the user has selected. The moment they pick a different one it is
   * stale - it would describe the wrong path - so the local mirror takes over
   * until the parent refetches. Both come from the same routing rule, so they
   * cannot disagree about which path a country maps to.
   */
  const activePlan = useMemo<VerificationPathPlan>(
    () => planToRender(plan, chosenCountry),
    [plan, chosenCountry]
  );

  const chooseCountry = useCallback(async (code: string) => {
    const normalized = normalizeCountry(code);
    if (!normalized) return;
    // Set first, save second. The branch is a UI decision; making the user
    // wait on a network call to see the right form is latency for nothing.
    setChosenCountry(normalized);
    setCountryError('');
    setSavingCountry(true);
    try {
      await onCountryChange(normalized);
    } catch (err) {
      // The path shown is still correct - it is derived from the selection,
      // not from the save - so this warns without tearing the form away.
      setCountryError((err as Error).message || 'We could not save your country. Verification still works.');
    } finally {
      setSavingCountry(false);
    }
  }, [onCountryChange]);

  if (!open) return null;

  const needsCountry = !chosenCountry;

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
            {needsCountry
              ? 'Verification'
              : activePlan.path === 'ngn_bank' ? 'Level 1 · Bank check' : 'Identity verification'}
          </span>
          <h2 id="sv-modal-title">{needsCountry ? 'Where are you based?' : activePlan.title}</h2>
          <p className="sv-modal-sub">
            {needsCountry
              ? 'Your country decides how we verify you. Nigeria takes under a minute with a bank account; everywhere else needs a photo ID.'
              : activePlan.description}
          </p>
        </div>

        {needsCountry ? (
          <CountryStep saving={savingCountry} error={countryError} onChoose={chooseCountry} />
        ) : (
          <>
            <ChosenCountry
              country={chosenCountry}
              saving={savingCountry}
              // Clearing the local choice re-shows the picker. The saved value
              // is left alone until they pick again, so an abandoned change
              // does not wipe a country that was already on file.
              onChange={() => setChosenCountry(undefined)}
            />

            {Boolean(countryError) && <p className="sv-warn">{countryError}</p>}

            {activePlan.path === 'ngn_bank' ? (
              <NgnBankVerification
                userId={userId}
                fullName={fullName}
                api={api}
                onVerified={onVerified}
              />
            ) : (
              <BridgeVerification plan={activePlan} loading={loading} onStart={onStartBridge} />
            )}

            <ul className="sv-modal-unlocks">
              {activePlan.unlocks.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Step 1: the country.
 *
 * Asked here rather than at signup because it is only ever read to pick a
 * verification path, and that happens days later. Adding a field to the
 * signup screen to answer a question nothing consumes until verification
 * costs conversion on the highest-drop-off page for no gain.
 *
 * Nigeria is first and visually distinct because it is the only country with
 * a different flow, and it is the majority of the userbase.
 */
function CountryStep({
  saving,
  error,
  onChoose,
}: {
  saving: boolean;
  error: string;
  onChoose: (code: string) => void;
}) {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return SIGNUP_COUNTRIES;
    return SIGNUP_COUNTRIES.filter(
      (item) => item.name.toLowerCase().includes(term) || item.code.toLowerCase() === term
    );
  }, [query]);

  return (
    <div className="sv-modal-body">
      <label className="sv-field">
        <span>Country</span>
        <input
          autoFocus
          placeholder="Search — Nigeria, United States…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="sv-country-grid">
        {visible.map((item) => (
          <button
            key={item.code}
            type="button"
            className={`sv-country ${item.code === 'NG' ? 'primary' : ''}`}
            disabled={saving}
            onClick={() => onChoose(item.code)}
          >
            <span className="sv-flag" aria-hidden="true">{item.flag}</span>
            <span className="sv-country-name">{item.name}</span>
            {item.code === 'NG'
              ? <em className="sv-country-tag">Instant</em>
              : <em className="sv-country-tag muted">ID check</em>}
          </button>
        ))}
        {!visible.length && (
          <p className="sv-muted">
            We do not verify {query.trim()} directly yet. Pick the country on your ID and our
            partner Bridge will handle it.
          </p>
        )}
      </div>

      {saving && <div className="sv-resolving"><span className="sv-spinner" />Saving…</div>}
      {Boolean(error) && <p className="sv-error">{error}</p>}
    </div>
  );
}

/** The chosen country, kept visible so a wrong pick is obvious and reversible. */
function ChosenCountry({
  country,
  saving,
  onChange,
}: {
  country?: string;
  saving: boolean;
  onChange: () => void;
}) {
  const match = SIGNUP_COUNTRIES.find((item) => item.code === country);
  return (
    <div className="sv-chosen-country">
      <span className="sv-flag" aria-hidden="true">{match?.flag ?? '🌐'}</span>
      <strong>{match?.name ?? country}</strong>
      {saving && <span className="sv-spinner small" />}
      <button type="button" onClick={onChange}>Change</button>
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
