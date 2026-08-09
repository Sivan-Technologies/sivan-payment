import { useCallback, useEffect, useState } from 'react';

/**
 * Set or change the withdrawal PIN.
 *
 * One component serves two callers, because they are the same task at
 * different moments:
 *
 *   - Settings -> Security, where the user came deliberately to set or
 *     change it.
 *   - The withdrawal flow, when the account has no PIN yet and one is
 *     required before money can move.
 *
 * Keeping them as one component means the validation rules, the wording and
 * the confirm step cannot drift apart between the calm path and the urgent
 * one - and the urgent one is where a divergence would actually cost someone
 * money.
 */

/** Mirrors the server's 6-12 digits. Kept in sync with setWithdrawalPinSchema. */
const PIN_PATTERN = /^\d{6,12}$/;

/**
 * A local pre-check, deliberately narrower than the server's.
 *
 * The server owns the real rules (assertPinIsAcceptable also rejects repeated
 * digits and running sequences). This only catches what we can state plainly
 * without duplicating that logic, so the two cannot drift into disagreeing.
 * Anything this misses, the server refuses and we display its message.
 */
function localPinComplaint(pin: string): string | null {
  if (!pin) return 'Enter a PIN.';
  if (!PIN_PATTERN.test(pin)) return 'Your PIN must be 6 to 12 digits, numbers only.';
  return null;
}

export function WithdrawalPinCard({
  api,
  mode = 'settings',
  onPinSet,
}: {
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  /**
   * 'settings' - standalone card, discovers its own state.
   * 'required' - rendered because a withdrawal is blocked on it; skips the
   *   "already set" resting state and goes straight to the form.
   */
  mode?: 'settings' | 'required';
  onPinSet?: () => void;
}) {
  const [hasPin, setHasPin] = useState<boolean | null>(mode === 'required' ? false : null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [editing, setEditing] = useState(mode === 'required');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadStatus = useCallback(async () => {
    const result = await api<{ hasPin: boolean }>('/api/users/me/withdrawal-pin').catch(() => null);
    if (result) setHasPin(Boolean(result.hasPin));
  }, [api]);

  useEffect(() => {
    if (mode === 'settings') void loadStatus();
  }, [loadStatus, mode]);

  const reset = () => {
    setPin('');
    setConfirmPin('');
    setCurrentPin('');
  };

  const submit = async () => {
    setError('');
    setMessage('');

    const complaint = localPinComplaint(pin);
    if (complaint) {
      setError(complaint);
      return;
    }

    /**
     * The confirm field is checked here and nowhere else - the server never
     * receives it. A PIN mistyped identically twice is the user's own choice;
     * a PIN mistyped once becomes a secret they do not know they have, and
     * they find out at the next withdrawal.
     */
    if (pin !== confirmPin) {
      setError('Those two PINs do not match.');
      return;
    }

    if (hasPin && !currentPin) {
      setError('Enter your current PIN to change it.');
      return;
    }

    setBusy(true);
    try {
      await api('/api/users/me/withdrawal-pin', {
        method: 'POST',
        body: JSON.stringify(hasPin ? { pin, currentPin } : { pin }),
      });
      reset();
      setHasPin(true);
      setEditing(false);
      setMessage(hasPin ? 'Your withdrawal PIN has been changed.' : 'Your withdrawal PIN is set.');
      onPinSet?.();
    } catch (caught) {
      /**
       * Show the server's own words. It distinguishes "too easy to guess"
       * from "wrong current PIN" from "6 to 12 digits", and a user who is
       * told only "invalid" will retry 1111, then 2222, and conclude the
       * feature is broken.
       */
      setError(caught instanceof Error ? caught.message : 'Could not save your PIN. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const digitsOnly = (value: string) => value.replace(/\D/g, '').slice(0, 12);

  if (mode === 'settings' && hasPin !== null && !editing) {
    return (
      <div className="identity-link-card">
        <div>
          <p className="eyebrow">Withdrawal PIN</p>
          <h3>{hasPin ? 'PIN is set' : 'No PIN set'}</h3>
          <p className="muted">
            {hasPin
              ? 'Required to approve withdrawals from WhatsApp and Telegram, and on this site.'
              : 'Set a PIN so a withdrawal needs more than access to your chat app or your signed-in session.'}
          </p>
        </div>
        {message && <strong className="username-message">{message}</strong>}
        <div className="identity-link-actions">
          <button type="button" className={hasPin ? 'secondary-btn small' : 'primary-btn'} onClick={() => { setMessage(''); setEditing(true); }}>
            {hasPin ? 'Change PIN' : 'Set PIN'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="identity-link-card">
      <div>
        <p className="eyebrow">Withdrawal PIN</p>
        <h3>{hasPin ? 'Change your PIN' : 'Set your withdrawal PIN'}</h3>
        <p className="muted">
          {mode === 'required'
            ? 'Before your first withdrawal, choose a PIN. You will enter it to approve withdrawals from now on, including from WhatsApp and Telegram.'
            : 'Six to twelve digits. Avoid repeated digits and running sequences.'}
        </p>
      </div>

      <div className="inline-security-form">
        {hasPin && (
          <label>
            Current PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={currentPin}
              onChange={(event) => setCurrentPin(digitsOnly(event.target.value))}
              placeholder="Your existing PIN"
            />
          </label>
        )}
        <label>
          New PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(event) => setPin(digitsOnly(event.target.value))}
            placeholder="6 to 12 digits"
          />
        </label>
        <label>
          Confirm new PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={confirmPin}
            onChange={(event) => setConfirmPin(digitsOnly(event.target.value))}
            placeholder="Enter it again"
          />
        </label>
        <small className="field-hint">
          Sivan will never ask for this PIN by message, email or phone call. Do not type it into a group chat.
        </small>
      </div>

      {error && <strong className="username-message">{error}</strong>}
      {message && <strong className="username-message">{message}</strong>}

      <div className="identity-link-actions">
        <button type="button" className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : hasPin ? 'Change PIN' : 'Set PIN'}
        </button>
        {mode === 'settings' && (
          <button type="button" className="ghost-btn small" disabled={busy} onClick={() => { reset(); setError(''); setEditing(false); }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
