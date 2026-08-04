import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  filterBanks,
  isValidNuban,
  maskAccountNumber,
  shouldResolveAccount,
  type NgnBank,
  type ResolvedNgnBankAccount,
  type SavedNgnPayoutAccount,
} from '../../ngnBank';
import {
  SIGNUP_COUNTRIES,
  normalizeCountry,
  orderCountriesForDetected,
  planToRender,
  shouldAutoSelectCountry,
  type VerificationPathPlan,
  type VerificationPath,
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
  requestedPath,
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
  onVerified: (account: SavedNgnPayoutAccount) => void;
  onStartBridge: () => void;
  /**
   * An explicit path the user asked for, overriding the country default.
   *
   * Set when they click "Verify with ID instead" - a Nigerian who needs
   * USD/GBP/EUR accounts must be able to reach Bridge, and country-only
   * routing meant that button re-opened the bank form they had just finished.
   */
  requestedPath?: VerificationPath;
}) {
  // The country the modal is currently acting on. Seeded from the record, then
  // owned locally so picking a country re-routes the modal instantly rather
  // than waiting on a round trip - the save happens in the background.
  const [chosenCountry, setChosenCountry] = useState<string | undefined>(() => normalizeCountry(country));
  const [savingCountry, setSavingCountry] = useState(false);
  const [countryError, setCountryError] = useState('');
  /**
   * Where the edge says this request came from.
   *
   * A HINT, NEVER A FACT. It pre-orders the picker and nothing more - it is
   * not written to the user record and it does not decide anything. On a VPN
   * this is the exit node rather than the person, which is unavoidable and
   * fine precisely because the user still has to choose.
   */
  const [detectedCountry, setDetectedCountry] = useState<string | undefined>();
  /** True while the geo lookup is in flight. Prevents a flash of the picker. */
  const [detecting, setDetecting] = useState(false);

  // A user who reopens the modal after their country was saved elsewhere must
  // not see a stale local value.
  useEffect(() => { setChosenCountry(normalizeCountry(country)); }, [country, open]);

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

  // Fetched only while the picker is actually open, and only when the user has
  // no country yet - re-detecting for someone who already answered would be a
  // pointless request, and a VPN-flipped result could reorder the list under
  // them mid-interaction.
  useEffect(() => {
    if (!open || normalizeCountry(country)) return;
    let cancelled = false;
    setDetecting(true);
    api<{ country: string | null }>('/api/geo/country')
      .then((result) => {
        if (cancelled) return;
        const found = normalizeCountry(result?.country) ?? undefined;
        setDetectedCountry(found);
        // AUTO-SELECT, not just reorder. Asking someone to confirm a country
        // we already know is a step that exists only to be clicked through,
        // and the answer is shown and reversible on the next screen anyway.
        //
        // Only for countries we actually serve. Detecting Japan and selecting
        // nothing is right - they need to choose from the list.
        if (shouldAutoSelectCountry(found)) void chooseCountry(found!);
      })
      // Silent. Detection is a convenience; failing just means the user picks
      // from the list, which is a working screen.
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setDetecting(false); });
    return () => { cancelled = true; };
  }, [open, country, api, chooseCountry]);

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
    () => planToRender(plan, chosenCountry, requestedPath),
    [plan, chosenCountry, requestedPath]
  );


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
          <h2 id="sv-modal-title">
            {needsCountry ? (detecting ? 'One moment' : 'Where are you based?') : activePlan.title}
          </h2>
          <p className="sv-modal-sub">
            {needsCountry
              ? detecting
                ? 'Finding the fastest way to verify you.'
                : 'Your country decides how we verify you. Nigeria takes under a minute with a bank account; everywhere else needs a photo ID.'
              : activePlan.description}
          </p>
        </div>

        {needsCountry ? (
          detecting
            // A picker that renders and then vanishes half a second later
            // reads as a glitch. One calm line instead.
            ? <div className="sv-modal-body"><div className="sv-resolving"><span className="sv-spinner" />Checking where you are…</div></div>
            : <CountryStep saving={savingCountry} error={countryError} detected={detectedCountry} onChoose={chooseCountry} />
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
  detected,
  onChoose,
}: {
  saving: boolean;
  error: string;
  /** Where the edge thinks this request came from. A hint, never a fact. */
  detected?: string;
  onChoose: (code: string) => void;
}) {
  const [query, setQuery] = useState('');

  // The detected country floats to the top. Nigeria was pinned there with an
  // "INSTANT" badge, which reads as the default to everyone - including the US
  // user whose path it would silently get wrong.
  const ordered = useMemo(() => orderCountriesForDetected(SIGNUP_COUNTRIES, detected), [detected]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return ordered;
    return ordered.filter(
      (item) => item.name.toLowerCase().includes(term) || item.code.toLowerCase() === term
    );
  }, [query, ordered]);

  return (
    <div className="sv-modal-body">
      <label className="sv-field">
        <span>Country</span>
        <input
          autoFocus
          placeholder="Search — United Kingdom, United States…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="sv-country-grid">
        {visible.map((item) => (
          <button
            key={item.code}
            type="button"
            // Highlight follows DETECTION, not a hardcoded country. Only one
            // row is ever emphasised, and only when we actually have a signal.
            className={`sv-country ${detected && item.code === detected ? 'primary' : ''}`}
            disabled={saving}
            onClick={() => onChoose(item.code)}
          >
            <span className="sv-flag" aria-hidden="true">{item.flag}</span>
            <span className="sv-country-name">{item.name}</span>
            {/* Still worth stating that the NGN path is instant - it is true
                and it is a real difference - but the emphasis above is what
                signals "this is probably you", and that follows detection. */}
            {item.code === 'NG'
              ? <em className="sv-country-tag">Instant</em>
              : <em className="sv-country-tag muted">ID check</em>}
            {detected && item.code === detected && <em className="sv-country-tag detected">Detected</em>}
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
  onVerified: (account: SavedNgnPayoutAccount) => void;
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

  const [saving, setSaving] = useState(false);

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
          <button
            className="sv-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setError('');
              try {
                // POST, not just a local confirm. The server re-resolves the
                // account and matches the bank's name against the name on
                // file - the client's copy of accountName is display only, and
                // is never sent, or a stranger's account could be claimed.
                const account = await api<SavedNgnPayoutAccount>('/api/ngn/payout-accounts', {
                  method: 'POST',
                  body: JSON.stringify({ userId, bankId, accountNumber }),
                });
                onVerified(account);
              } catch (err) {
                setError((err as Error).message || 'We could not save that account.');
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : 'Yes, that is me →'}
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
