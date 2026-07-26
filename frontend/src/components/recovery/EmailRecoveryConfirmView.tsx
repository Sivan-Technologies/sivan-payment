import { FormEvent, useMemo, useState } from 'react';
import type { UserRecord } from '../../types';

type EmailRecoveryConfirmViewProps = {
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  loading: boolean;
  onConfirmed: (user: UserRecord) => void;
  onSignIn: () => void;
  onSupport: () => void;
};

export function EmailRecoveryConfirmView({ api, loading, onConfirmed, onSignIn, onSupport }: EmailRecoveryConfirmViewProps) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [userId, setUserId] = useState(params.get('userId') || '');
  const [requestId, setRequestId] = useState(params.get('requestId') || '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const updated = await api<UserRecord>(`/api/users/${encodeURIComponent(userId)}/email-change/confirm`, {
        method: 'POST',
        body: JSON.stringify({ requestId, code })
      });
      setMessage(`Email confirmed. You can now sign in with ${updated.email}.`);
      onConfirmed(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm email change.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="email-recovery-layout">
      <article className="email-recovery-card">
        <div className="auth-card-topline"><span>Account recovery</span><em>Support verified</em></div>
        <h3>Confirm your new email</h3>
        <p className="muted">Only continue if Sivan Support started this email recovery with you. Enter the recovery reference from the link and the 6-digit code sent to your new email.</p>
        <form className="form auth-form-premium" onSubmit={submit}>
          <label>User ID<input value={userId} onChange={(event) => setUserId(event.target.value.trim())} placeholder="usr_..." required /></label>
          <label>Recovery reference<input value={requestId} onChange={(event) => setRequestId(event.target.value.trim())} placeholder="email_..." required /></label>
          <label>Confirmation code<input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" required /></label>
          {error && <div className="form-error">{error}</div>}
          {message && <div className="success-note">{message}</div>}
          <button className="primary-btn auth-submit" disabled={loading || busy || !userId || !requestId || code.length < 6}>{busy ? 'Confirming…' : 'Confirm email change →'}</button>
        </form>
        <div className="recovery-safe-box">
          <strong>Important safety check</strong>
          <span>Sivan will never ask for your wallet seed phrase, private keys, or card PIN. If you did not request this recovery, stop and contact support.</span>
        </div>
        <div className="auth-trust-row"><span>Code expires in 15 minutes</span><span>Old email gets an alert</span><span>Every action is audited</span></div>
        <div className="recovery-actions-row"><button type="button" className="ghost-btn" onClick={onSignIn}>Back to sign in</button><button type="button" className="secondary-btn" onClick={onSupport}>Contact support</button></div>
      </article>
      <article className="premium-card auth-showcase-card email-recovery-side">
        <span className="orb" />
        <div className="auth-showcase-badge">Secure recovery flow</div>
        <h3>Admin starts. User confirms. No direct email edit.</h3>
        <p>This protects users from account takeover while still letting support help customers who lost access to an old email.</p>
        <div className="auth-flow-preview">
          <div><span>1</span><strong>Support verifies</strong><small>Ticket and evidence required</small></div>
          <div><span>2</span><strong>New email code</strong><small>OTP sent only after admin starts</small></div>
          <div><span>3</span><strong>User confirms</strong><small>Email changes after OTP</small></div>
        </div>
      </article>
    </section>
  );
}
