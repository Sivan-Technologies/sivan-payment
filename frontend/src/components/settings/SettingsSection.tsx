import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { UserRecord, UserPreferencesRecord, IdentityStatus } from '../../types';
import { SIGNUP_COUNTRIES } from '../../verificationPath';
function initials(nameOrEmail?: string) { const value = (nameOrEmail || 'Sivan User').trim(); const parts = value.includes('@') ? value.split('@')[0].split(/[._-]+/) : value.split(/\s+/); return parts.slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || 'SU'; }
function CustomSelect({ name, options, value, defaultValue, onChange, disabled = false }: { name: string; options: Array<{ value: string; label: string; helper?: string; disabled?: boolean }>; value?: string; defaultValue?: string; onChange?: (value: string) => void; disabled?: boolean }) { const firstEnabled = options.find((option) => !option.disabled)?.value || options[0]?.value || ''; const [internalValue,setInternalValue]=useState(defaultValue || value || firstEnabled); const [open,setOpen]=useState(false); const selectedValue=value ?? internalValue; const selected=options.find((option)=>option.value===selectedValue)||options.find((option)=>!option.disabled)||options[0]; const choose=(next:string)=>{setInternalValue(next); onChange?.(next); setOpen(false);}; return <div className="custom-select-wrap app-select-wrap"><input type="hidden" name={name} value={selected?.value || ''} /><button type="button" disabled={disabled} className={`custom-select-trigger ${open ? 'open' : ''}`} onClick={() => !disabled && setOpen((state)=>!state)}><span><strong>{selected?.label || 'Select'}</strong>{selected?.helper && <small>{selected.helper}</small>}</span><em>⌄</em></button>{open && <div className="custom-select-menu app-select-menu">{options.map((option)=><button type="button" disabled={option.disabled} className={option.value===selected?.value ? 'selected' : ''} key={option.value} onClick={()=>!option.disabled && choose(option.value)}><span>{option.label}</span>{option.helper && <small>{option.helper}</small>}</button>)}</div>}</div>; }
function Empty({ children }: { children: string }) { return <div className="empty-state">{children}</div>; }
const legalLinks = { terms: 'https://www.sivantech.online/legal/terms', privacy: 'https://www.sivantech.online/legal/privacy', risk: 'https://www.sivantech.online/legal/risk-disclosure', dataRetention: 'https://www.sivantech.online/legal/data-retention', amlKyc: 'https://www.sivantech.online/legal/aml-kyc', jurisdictions: 'https://www.sivantech.online/legal/supported-jurisdictions', wrongNetwork: 'https://www.sivantech.online/legal/wrong-network', complaints: 'https://www.sivantech.online/legal/complaints', cookies: 'https://www.sivantech.online/legal/cookies' };
function LegalResources({ compact = false }: { compact?: boolean }) { const links=[['Terms','https://www.sivantech.online/legal/terms'],['Privacy','https://www.sivantech.online/legal/privacy'],['Risk Disclosure','https://www.sivantech.online/legal/risk-disclosure'],['Data Retention','https://www.sivantech.online/legal/data-retention'],['AML/KYC Policy','https://www.sivantech.online/legal/aml-kyc'],['Supported Jurisdictions','https://www.sivantech.online/legal/supported-jurisdictions'],['Wrong Network Policy','https://www.sivantech.online/legal/wrong-network'],['Complaints Policy','https://www.sivantech.online/legal/complaints'],['Cookie Policy','https://www.sivantech.online/legal/cookies']]; return <article className={compact ? 'legal-resource-card compact' : 'legal-resource-card'}><h3>Legal resources</h3><p className="muted">Review Sivan’s user terms, privacy practices, risk disclosures, and data retention policy.</p><div>{links.map(([label,href])=><a key={label} href={href} target="_blank" rel="noreferrer">{label} ↗</a>)}</div></article>; }
type UserTwoFactorStatus = { userId: string; enabled: boolean; enabledAt?: string; lastVerifiedAt?: string; recoveryCodesRemaining?: number; recoveryQuestionsConfigured?: boolean; recoveryQuestionsCount?: number; };

function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }
export function UserAvatar({ user, className = '' }: { user: UserRecord | null; className?: string }) {
  if (user?.avatarUrl) return <span className={`user-avatar-image ${className}`}><img src={user.avatarUrl} alt={`${user.fullName || 'Sivan user'} avatar`} /></span>;
  return <span className={className}>{initials(user?.fullName || user?.email)}</span>;
}

function ProfileSettingsPanel({ api, user, isVerified, identityStatus, pairingCode, pairingExpiresAt, timeNow, loading, onUserUpdated, onStartWhatsappLink, onCancelWhatsappLink, onUnlinkWhatsapp, onRefreshIdentity }: { api: <T>(path: string, options?: RequestInit) => Promise<T>; user: UserRecord | null; isVerified: boolean; identityStatus: IdentityStatus | null; pairingCode: string; pairingExpiresAt: string; timeNow: number; loading: boolean; onUserUpdated: (user: UserRecord) => void; onStartWhatsappLink: () => void; onCancelWhatsappLink: () => void; onUnlinkWhatsapp: () => void; onRefreshIdentity: () => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState(user?.username || '');
  const [usernameMessage, setUsernameMessage] = useState('');
  const [usernameBusy, setUsernameBusy] = useState(false);
  useEffect(() => { setUsernameDraft(user?.username || ''); }, [user?.username]);
  const nameParts = (user?.fullName || '').split(/\s+/);
  async function uploadAvatar(file?: File) {
    if (!file || !user?.id) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return alert('Upload JPG, PNG, or WEBP.');
    if (file.size > 5 * 1024 * 1024) return alert('Profile photo must be 5MB or less.');
    setUploading(true);
    try {
      const upload = await api<any>(`/api/users/${user.id}/avatar/upload-url`, { method: 'POST', body: JSON.stringify({ fileName: file.name, contentType: file.type, sizeBytes: file.size }) });
      if (upload.provider !== 'mock') {
        const uploaded = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers || { 'Content-Type': file.type }, body: file });
        if (!uploaded.ok) throw new Error('Profile photo upload failed.');
      }
      const updated = await api<UserRecord>(`/api/users/${user.id}/avatar/confirm`, { method: 'POST', body: JSON.stringify({ objectKey: upload.objectKey, publicUrl: upload.publicUrl }) });
      onUserUpdated(updated);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Profile photo upload failed.');
    } finally {
      setUploading(false);
    }
  }
  async function removeAvatar() {
    if (!user?.id || !user.avatarUrl) return;
    if (!window.confirm('Remove your profile photo?')) return;
    setUploading(true);
    try {
      const updated = await api<UserRecord>(`/api/users/${user.id}/avatar`, { method: 'DELETE' });
      onUserUpdated(updated);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not remove profile photo.');
    } finally {
      setUploading(false);
    }
  }

  async function saveUsername() {
    if (!user?.id) return;
    setUsernameBusy(true);
    setUsernameMessage('');
    try {
      const updated = await api<UserRecord>(`/api/users/${user.id}/username`, { method: 'PUT', body: JSON.stringify({ username: usernameDraft }) });
      onUserUpdated(updated);
      setUsernameMessage(`Your Sivan username is @${updated.username}.`);
    } catch (error) {
      setUsernameMessage(error instanceof Error ? error.message : 'Could not update username.');
    } finally {
      setUsernameBusy(false);
    }
  }
  async function checkUsername() {
    if (!user?.id || !usernameDraft.trim()) return;
    setUsernameBusy(true);
    setUsernameMessage('');
    try {
      const result = await api<any>(`/api/users/${user.id}/username/availability?username=${encodeURIComponent(usernameDraft)}`);
      setUsernameMessage(result.available ? `@${result.username} is available.` : `@${result.username} is already taken.`);
    } catch (error) {
      setUsernameMessage(error instanceof Error ? error.message : 'Could not check username.');
    } finally {
      setUsernameBusy(false);
    }
  }
  const usernameLocked = Boolean(isVerified && user?.username);

  // CONTROLLED INPUTS. These were defaultValue with no name and no onChange,
  // so nothing could read them - the "Save changes" button had nothing to
  // send even if it had been wired to anything, which it was not.
  const [firstName, setFirstName] = useState(nameParts[0] || '');
  const [lastName, setLastName] = useState(nameParts.slice(1).join(' '));
  const [countryDraft, setCountryDraft] = useState(user?.country || '');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');

  // Reseed when the record changes underneath, or a save elsewhere leaves
  // these boxes showing the old values.
  useEffect(() => {
    const parts = String(user?.fullName ?? '').trim().split(/\s+/).filter(Boolean);
    setFirstName(parts[0] || '');
    setLastName(parts.slice(1).join(' '));
    setCountryDraft(user?.country || '');
  }, [user?.fullName, user?.country]);

  const nameChanged = `${firstName} ${lastName}`.trim() !== String(user?.fullName ?? '').trim();
  const countryChanged = Boolean(countryDraft) && countryDraft !== (user?.country || '');

  async function saveProfile() {
    if (!user?.id) return;
    setProfileBusy(true);
    setProfileMessage('');
    try {
      let latest = user;
      // Two independent endpoints, because they have different rules: a name
      // locks once verified, a country never does. Saved separately so one
      // failing does not silently discard the other.
      if (nameChanged) {
        latest = await api<UserRecord>(`/api/users/${user.id}/name`, {
          method: 'PUT',
          body: JSON.stringify({ fullName: `${firstName} ${lastName}`.trim() }),
        });
      }
      if (countryChanged) {
        latest = await api<UserRecord>(`/api/users/${user.id}/country`, {
          method: 'PUT',
          body: JSON.stringify({ country: countryDraft }),
        });
      }
      onUserUpdated(latest);
      setProfileMessage('Saved.');
    } catch (error) {
      // The server owns the lock, so its message is the accurate one - it
      // knows whether a bank match or a pending review is the blocker.
      setProfileMessage(error instanceof Error ? error.message : 'Could not save your profile.');
    } finally {
      setProfileBusy(false);
    }
  }

  return <><h3>Profile</h3><p className="muted">Your personal information.</p><div className="profile-row"><UserAvatar user={user} className="avatar-lg" /><div><strong>{user?.fullName || 'Sivan user'}</strong><small>{user?.email || '—'} · {user ? 'Verified email' : 'Guest'}</small><div className="avatar-actions"><label className="ghost-btn small avatar-upload-button"><input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void uploadAvatar(event.target.files?.[0])} />{uploading ? 'Uploading...' : user?.avatarUrl ? 'Change photo' : 'Upload photo'}</label>{user?.avatarUrl && <button type="button" className="ghost-btn small" disabled={uploading} onClick={removeAvatar}>Remove photo</button>}</div></div></div><div className="username-settings-card"><div><p className="eyebrow">Sivan username</p><h3>{user?.username ? `@${user.username}` : 'Choose your username'}</h3><p className="muted">Usernames are used for future Sivan-to-Sivan transfers and support lookup. Choose carefully.</p></div><label>Username<div className="username-input-row"><span>@</span><input value={usernameDraft} onChange={(event) => setUsernameDraft(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="michael" readOnly={usernameLocked} className={usernameLocked ? 'locked-input' : ''} /></div><div className="username-action-row"><button type="button" className="ghost-btn small" disabled={usernameBusy || usernameLocked || !usernameDraft.trim()} onClick={checkUsername}>Check</button><button type="button" className="secondary-btn small" disabled={usernameBusy || usernameLocked || !usernameDraft.trim()} onClick={saveUsername}>{usernameBusy ? 'Saving...' : user?.username ? 'Update' : 'Save'}</button></div></label><small>{usernameLocked ? 'Username changes are locked after verification. Contact support if this needs to change.' : '3–30 characters. Lowercase letters, numbers, and underscores. Reserved names are blocked.'}</small>{usernameMessage && <strong className="username-message">{usernameMessage}</strong>}</div>{isVerified && <div className="verified-profile-lock"><strong>Verified legal name locked</strong><span>Your name is linked to your verified identity. Contact Sivan Support if it needs to be corrected.</span></div>}<div className="split"><label>First name<input value={firstName} onChange={(event) => setFirstName(event.target.value)} readOnly={isVerified} aria-readonly={isVerified} className={isVerified ? 'locked-input' : ''} /></label><label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} readOnly={isVerified} aria-readonly={isVerified} className={isVerified ? 'locked-input' : ''} /></label></div><label>Email<input defaultValue={user?.email || ''} readOnly /></label><IdentityLinkCard identityStatus={identityStatus} pairingCode={pairingCode} pairingExpiresAt={pairingExpiresAt} timeNow={timeNow} loading={loading} onStart={onStartWhatsappLink} onCancel={onCancelWhatsappLink} onUnlink={onUnlinkWhatsapp} onRefresh={onRefreshIdentity} /><div className="split"><label>Country<CustomSelect name="country" value={countryDraft} onChange={setCountryDraft} options={SIGNUP_COUNTRIES.map((item) => ({ value: item.code, label: item.name }))} /></label><label>Phone<input value={identityStatus?.link?.whatsappNumber || user?.whatsappNumber || ''} placeholder="Link WhatsApp to populate this securely" readOnly /></label></div>{isVerified ? <a className="secondary-btn support-link" href="mailto:support@sivantech.online?subject=Verified%20name%20correction">Contact support to change name →</a> : <button type="button" className="primary-btn" disabled={profileBusy || (!nameChanged && !countryChanged)} onClick={() => void saveProfile()}>{profileBusy ? 'Saving…' : 'Save changes'}</button>}{profileMessage && <strong className="username-message">{profileMessage}</strong>}</>;
}
export function SettingsView({ api, user, isVerified, onUserUpdated, preferences, initialTab, twoFactorStatus, onTwoFactorStatusChanged, identityStatus, pairingCode, pairingExpiresAt, timeNow, onStartWhatsappLink, onCancelWhatsappLink, onUnlinkWhatsapp, onRefreshIdentity, onSavePreferences, onUpdatePreferences, loading, onLogout }: { api: <T>(path: string, options?: RequestInit) => Promise<T>; user: UserRecord | null; isVerified: boolean; onUserUpdated: (user: UserRecord) => void; preferences: UserPreferencesRecord | null; initialTab: 'profile' | 'security' | 'notifications' | 'preferences'; twoFactorStatus: UserTwoFactorStatus | null; onTwoFactorStatusChanged: (status: UserTwoFactorStatus | null) => void; identityStatus: IdentityStatus | null; pairingCode: string; pairingExpiresAt: string; timeNow: number; onStartWhatsappLink: () => void; onCancelWhatsappLink: () => void; onUnlinkWhatsapp: () => void; onRefreshIdentity: () => Promise<void>; onSavePreferences: (event: FormEvent<HTMLFormElement>) => void; onUpdatePreferences: (patch: Partial<UserPreferencesRecord>) => Promise<void>; loading: boolean; onLogout: () => void }) {
  const [tab, setTab] = useState<'profile' | 'security' | 'notifications' | 'preferences'>(initialTab || 'profile');
  useEffect(() => { setTab(initialTab || 'profile'); }, [initialTab]);
  const nameParts = (user?.fullName || '').split(/\s+/);
  const currentPreferences = preferences ?? {
    userId: user?.id || '',
    defaultFiatCurrency: 'usd' as const,
    language: 'en-US' as const,
    transactionUpdates: true,
    marketingEmails: false,
    securityAlerts: true,
    emailConfirmationsForHighValue: false,
    updatedAt: new Date().toISOString()
  };
  return <section className="app-page settings-premium"><PageHero title="Settings" subtitle="Manage your account, security and preferences." /><div className="settings-grid-premium"><aside className="settings-tabs"><button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>♙ Profile</button><button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}>▣ Security</button><button className={tab === 'notifications' ? 'active' : ''} onClick={() => setTab('notifications')}>♢ Notifications</button><button className={tab === 'preferences' ? 'active' : ''} onClick={() => setTab('preferences')}>◎ Preferences</button></aside><article className="settings-panel">{tab === 'profile' && <ProfileSettingsPanel api={api} user={user} isVerified={isVerified} identityStatus={identityStatus} pairingCode={pairingCode} pairingExpiresAt={pairingExpiresAt} timeNow={timeNow} loading={loading} onUserUpdated={onUserUpdated} onStartWhatsappLink={onStartWhatsappLink} onCancelWhatsappLink={onCancelWhatsappLink} onUnlinkWhatsapp={onUnlinkWhatsapp} onRefreshIdentity={onRefreshIdentity} />}{tab === 'security' && <SecuritySettingsPanel api={api} user={user} preferences={currentPreferences} initialStatus={twoFactorStatus} onStatusChanged={onTwoFactorStatusChanged} loading={loading} onUpdate={onUpdatePreferences} onLogout={onLogout} />}{tab === 'notifications' && <NotificationPreferencesPanel preferences={currentPreferences} loading={loading} onUpdate={onUpdatePreferences} />}{tab === 'preferences' && <form onSubmit={onSavePreferences}><h3>Preferences</h3><p className="muted">Customize your experience.</p><label>Default fiat currency<CustomSelect name="defaultFiatCurrency" defaultValue={currentPreferences.defaultFiatCurrency} options={[{ value: 'usd', label: 'USD', helper: 'US Dollar' }, { value: 'gbp', label: 'GBP', helper: 'British Pound' }, { value: 'eur', label: 'EUR', helper: 'Euro' }, { value: 'ngn', label: 'NGN', helper: 'Nigerian Naira' }]} /></label><label>Language<CustomSelect name="language" defaultValue={currentPreferences.language} options={[{ value: 'en-US', label: 'English', helper: 'United States' }, { value: 'en-GB', label: 'English', helper: 'United Kingdom' }, { value: 'fr-FR', label: 'French', helper: 'European Union' }, { value: 'de-DE', label: 'German', helper: 'European Union' }, { value: 'es-ES', label: 'Spanish', helper: 'European Union' }, { value: 'it-IT', label: 'Italian', helper: 'European Union' }, { value: 'nl-NL', label: 'Dutch', helper: 'European Union' }, { value: 'pt-PT', label: 'Portuguese', helper: 'European Union' }]} /><span className="field-hint">App language rollout for US, UK, and EU markets. Provider verification pages may use the closest supported language.</span></label><input type="hidden" name="transactionUpdates" value="on" checked={currentPreferences.transactionUpdates} readOnly /><input type="hidden" name="marketingEmails" value="on" checked={currentPreferences.marketingEmails} readOnly /><input type="hidden" name="securityAlerts" value="on" checked={currentPreferences.securityAlerts} readOnly /><input type="hidden" name="emailConfirmationsForHighValue" value="on" checked={currentPreferences.emailConfirmationsForHighValue} readOnly /><button className="primary-btn" disabled={loading}>{loading ? 'Saving...' : 'Save preferences'}</button><button type="button" className="secondary-btn" onClick={onLogout}>Sign out</button></form>}<LegalResources compact /></article></div></section>;
}


function IdentityLinkCard({ identityStatus, pairingCode, pairingExpiresAt, timeNow, loading, onStart, onCancel, onUnlink, onRefresh }: { identityStatus: IdentityStatus | null; pairingCode: string; pairingExpiresAt: string; timeNow: number; loading: boolean; onStart: () => void; onCancel: () => void; onUnlink: () => void; onRefresh: () => Promise<void> }) {
  const link = identityStatus?.link;
  const pending = identityStatus?.pendingPairing;
  const expiresAt = pairingExpiresAt || pending?.expiresAt || '';
  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - timeNow) / 1000)) : 0;
  const whatsappHref = pairingCode ? `https://wa.me/2349136717403?text=${encodeURIComponent(pairingCode)}` : '';
  const copyPairingCode = async () => {
    if (!pairingCode) return;
    await navigator.clipboard?.writeText(pairingCode).catch(() => undefined);
  };

  return <div className="identity-link-card"><div><p className="eyebrow">Sivan unified identity</p><h3>Linked WhatsApp / Escrow account</h3><p className="muted">Link your WhatsApp escrow identity so your web dashboard and WhatsApp use one Sivan customer profile.</p></div>{link ? <div className="identity-link-status linked"><span>Linked</span><strong>{link.whatsappNumber}</strong><small>Linked {link.linkedAt ? new Date(link.linkedAt).toLocaleString() : 'recently'}</small><div className="identity-link-actions"><button type="button" className="ghost-btn small" disabled={loading} onClick={() => void onRefresh()}>Refresh status</button><button type="button" className="ghost-btn small" disabled={loading} onClick={onUnlink}>Unlink</button></div></div> : pending ? <div className="identity-link-status pending"><span>Pairing code active</span><strong>{pairingCode || 'Code generated'}</strong><small>{secondsLeft ? `Expires in ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s` : `Expires ${new Date(pending.expiresAt).toLocaleString()}`}</small><div className="identity-link-actions"><button type="button" className="ghost-btn small" disabled={!pairingCode || loading} onClick={copyPairingCode}>Copy code</button>{whatsappHref && <a className="ghost-btn small" href={whatsappHref} target="_blank" rel="noreferrer">Open WhatsApp</a>}<button type="button" className="ghost-btn small" disabled={loading} onClick={() => void onRefresh()}>Refresh</button><button type="button" className="ghost-btn small" disabled={loading} onClick={onCancel}>Cancel code</button></div></div> : <div className="identity-link-status"><span>Not linked</span><strong>Connect WhatsApp Escrow</strong><small>Generate a code, then send it to Sivan on WhatsApp.</small><div className="identity-link-actions"><button type="button" className="secondary-btn" disabled={loading} onClick={onStart}>Generate pairing code</button><button type="button" className="ghost-btn small" disabled={loading} onClick={() => void onRefresh()}>Refresh status</button></div></div>}</div>;
}



type RecoveryQuestionOption = { id: string; question: string };
type SafeRecoveryQuestion = { id: string; questionId: string; questionText: string; createdAt?: string; updatedAt?: string };

function SecuritySettingsPanel({ api, user, preferences, initialStatus, onStatusChanged, loading, onUpdate, onLogout }: { api: <T>(path: string, options?: RequestInit) => Promise<T>; user: UserRecord | null; preferences: UserPreferencesRecord; initialStatus: UserTwoFactorStatus | null; onStatusChanged: (status: UserTwoFactorStatus | null) => void; loading: boolean; onUpdate: (patch: Partial<UserPreferencesRecord>) => Promise<void>; onLogout: () => void }) {
  const [status, setStatus] = useState<UserTwoFactorStatus | null>(initialStatus);
  const [setup, setSetup] = useState<{ manualEntryKey: string; otpauthUrl: string } | null>(null);
  const [setupCode, setSetupCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryCatalog, setRecoveryCatalog] = useState<RecoveryQuestionOption[]>([]);
  const [savedRecoveryQuestions, setSavedRecoveryQuestions] = useState<SafeRecoveryQuestion[]>([]);
  const [showRecoveryQuestionSetup, setShowRecoveryQuestionSetup] = useState(false);
  const [recoveryQuestionOne, setRecoveryQuestionOne] = useState('private_phrase');
  const [recoveryQuestionTwo, setRecoveryQuestionTwo] = useState('childhood_friend_nickname');
  const [recoveryAnswerOne, setRecoveryAnswerOne] = useState('');
  const [recoveryAnswerTwo, setRecoveryAnswerTwo] = useState('');
  const [recoveryQuestionMessage, setRecoveryQuestionMessage] = useState('');
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);
  const [busy, setBusy] = useState(false);
  const emailConfirmations = Boolean(preferences.emailConfirmationsForHighValue);
  const securityAlerts = Boolean(preferences.securityAlerts);
  const enabled = Boolean(status?.enabled);
  const recoveryQuestionsConfigured = Boolean(status?.recoveryQuestionsConfigured);
  const load2fa = useCallback(async () => {
    if (!user?.id) return;
    const result = await api<any>(`/api/users/${user.id}/2fa`).catch(() => null);
    if (result) { setStatus(result); onStatusChanged(result); }
  }, [api, onStatusChanged, user?.id]);
  const loadRecoveryQuestions = useCallback(async () => {
    if (!user?.id) return;
    const result = await api<any>(`/api/users/${user.id}/2fa/recovery-questions`).catch(() => null);
    if (!result) return;
    setRecoveryCatalog(result.catalog || []);
    setSavedRecoveryQuestions(result.questions || []);
    setShowRecoveryQuestionSetup(Boolean(result.configured === false && status?.enabled));
    if (result.catalog?.[0]?.id) setRecoveryQuestionOne(result.catalog[0].id);
    if (result.catalog?.[1]?.id) setRecoveryQuestionTwo(result.catalog[1].id);
  }, [api, status?.enabled, user?.id]);
  useEffect(() => { void load2fa(); }, [load2fa]);
  useEffect(() => { void loadRecoveryQuestions(); }, [loadRecoveryQuestions]);
  async function startSetup() {
    if (!user?.id) return;
    setBusy(true);
    try {
      const result = await api<any>(`/api/users/${user.id}/2fa/setup`, { method: 'POST', body: '{}' });
      setSetup(result);
      setRecoveryCodes([]);
      setRecoveryQuestionMessage('');
    } finally { setBusy(false); }
  }
  async function enableSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return;
    setBusy(true);
    try {
      const result = await api<any>(`/api/users/${user.id}/2fa/enable`, { method: 'POST', body: JSON.stringify({ code: setupCode }) });
      setRecoveryCodes(result.recoveryCodes || []);
      if (result.recoveryQuestionCatalog?.length) setRecoveryCatalog(result.recoveryQuestionCatalog);
      setSetup(null);
      setSetupCode('');
      setShowRecoveryQuestionSetup(true);
      setRecoveryQuestionMessage('Authenticator is enabled. Save your recovery codes, then set 2 recovery questions to finish recovery protection.');
      await load2fa();
    } finally { setBusy(false); }
  }
  async function disable2fa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return;
    setBusy(true);
    try {
      await api<any>(`/api/users/${user.id}/2fa/disable`, { method: 'POST', body: JSON.stringify({ code: disableCode }) });
      setDisableCode('');
      setRecoveryCodes([]);
      await load2fa();
    } finally { setBusy(false); }
  }
  async function saveRecoveryQuestions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return;
    if (recoveryQuestionOne === recoveryQuestionTwo) return setRecoveryQuestionMessage('Choose two different recovery questions.');
    setBusy(true);
    setRecoveryQuestionMessage('');
    try {
      const result = await api<any>(`/api/users/${user.id}/2fa/recovery-questions`, { method: 'PUT', body: JSON.stringify({ answers: [{ questionId: recoveryQuestionOne, answer: recoveryAnswerOne }, { questionId: recoveryQuestionTwo, answer: recoveryAnswerTwo }] }) });
      setSavedRecoveryQuestions(result.questions || []);
      setShowRecoveryQuestionSetup(false);
      setRecoveryAnswerOne('');
      setRecoveryAnswerTwo('');
      setRecoveryQuestionMessage('Recovery questions saved securely. Sivan staff cannot view your answers.');
      await load2fa();
    } catch (error) {
      setRecoveryQuestionMessage(error instanceof Error ? error.message : 'Could not save recovery questions.');
    } finally { setBusy(false); }
  }
  const score = enabled && recoveryQuestionsConfigured && emailConfirmations && securityAlerts ? 'Excellent' : enabled && recoveryQuestionsConfigured && securityAlerts ? 'Strong' : enabled && securityAlerts ? 'Strong' : emailConfirmations && securityAlerts ? 'Strong' : 'Good';
  const questionOptions = recoveryCatalog.length ? recoveryCatalog : [{ id: 'private_phrase', question: 'What is a private phrase only you would remember?' }, { id: 'childhood_friend_nickname', question: 'What was the nickname of your childhood best friend?' }];
  return <div className="security-settings-panel">
    <div className="settings-section-head"><h3>Security</h3><p className="muted">Protect access to your Sivan account with passwordless email, authenticator 2FA, recovery questions, and high-value confirmations.</p></div>
    <div className="security-health-card"><span>Security score</span><strong>{score}</strong><small>{enabled ? `Authenticator 2FA is enabled${status?.lastVerifiedAt ? ` · last verified ${new Date(status.lastVerifiedAt).toLocaleDateString()}` : ''}. ${recoveryQuestionsConfigured ? 'Recovery questions are configured.' : 'Set recovery questions to strengthen support recovery.'}` : 'Enable authenticator 2FA for stronger account protection.'}</small></div>
    <div className="security-settings-list">
      <div className="security-setting-row connected"><span>▣</span><div><strong>Passwordless email access</strong><small>Sign in with a one-time code sent to {user?.email || 'your verified email'}. Sivan does not store a password for your account.</small><em>Active</em></div><button type="button" className="ghost-btn small" onClick={onLogout}>Sign out</button></div>
      <div className={`security-setting-row connected ${enabled ? 'enabled' : ''}`}><span>⚿</span><div><strong>Authenticator 2FA</strong><small>{enabled ? `Enabled. Recovery codes remaining: ${status?.recoveryCodesRemaining ?? 0}.` : 'Use Google Authenticator, 1Password, Authy, iCloud Passwords, or any TOTP app.'}</small><em>{enabled ? 'Enabled' : 'Recommended'}</em></div>{enabled ? <form className="inline-security-form" onSubmit={disable2fa}><input value={disableCode} onChange={(event) => setDisableCode(event.target.value)} placeholder="Code to disable" /><button className="ghost-btn small" disabled={busy || disableCode.length < 6}>Disable</button></form> : <button type="button" className="secondary-btn small" disabled={busy} onClick={startSetup}>{busy ? 'Starting…' : 'Enable 2FA'}</button>}</div>
      {setup && <form className="two-factor-setup-card" onSubmit={enableSetup}><div><p className="eyebrow">Authenticator setup</p><h3>Add Sivan to your authenticator app</h3><p className="muted">Enter this setup key manually in your authenticator app, then type the 6-digit code it generates.</p></div><div className="manual-key-box"><span>Manual setup key</span><strong>{setup.manualEntryKey}</strong><button type="button" className="ghost-btn small" onClick={() => navigator.clipboard?.writeText(setup.manualEntryKey)}>Copy key</button></div><label>Authenticator code<input value={setupCode} onChange={(event) => setSetupCode(event.target.value.replace(/\s/g, ''))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" /></label><button className="primary-btn" disabled={busy || setupCode.length < 6}>{busy ? 'Verifying…' : 'Verify and enable 2FA'}</button></form>}
      {recoveryCodes.length > 0 && <div className="recovery-code-card"><p className="eyebrow">Save these recovery codes now</p><h3>Recovery codes</h3><p className="muted">Store these securely. Each code works once if you lose your authenticator app.</p><div>{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button className="secondary-btn small" onClick={() => navigator.clipboard?.writeText(recoveryCodes.join('\n'))}>Copy recovery codes</button></div>}
      {enabled && <div className={`security-setting-row connected ${recoveryQuestionsConfigured ? 'enabled' : ''}`}><span>?</span><div><strong>Recovery questions</strong><small>{recoveryQuestionsConfigured ? `${status?.recoveryQuestionsCount ?? savedRecoveryQuestions.length} secure recovery questions configured. Answers are hashed and cannot be viewed by Sivan staff.` : 'Set 2 private questions to help Sivan Support verify you if you lose your authenticator.'}</small><em>{recoveryQuestionsConfigured ? 'Configured' : 'Required'}</em></div><button type="button" className="secondary-btn small" onClick={() => setShowRecoveryQuestionSetup((value) => !value)}>{recoveryQuestionsConfigured ? 'Update' : 'Set now'}</button></div>}
      {enabled && showRecoveryQuestionSetup && <form className="recovery-question-card" onSubmit={saveRecoveryQuestions}><div><p className="eyebrow">Secure recovery questions</p><h3>Set 2 private recovery questions</h3><p className="muted">These help Sivan Support verify you if you lose your authenticator app. They do not automatically disable 2FA or unlock payments.</p></div><div className="split"><label>Question 1<select value={recoveryQuestionOne} onChange={(event) => setRecoveryQuestionOne(event.target.value)}>{questionOptions.map((item) => <option key={item.id} value={item.id}>{item.question}</option>)}</select></label><label>Answer 1<input value={recoveryAnswerOne} onChange={(event) => setRecoveryAnswerOne(event.target.value)} placeholder="Private answer" autoComplete="off" required minLength={3} /></label></div><div className="split"><label>Question 2<select value={recoveryQuestionTwo} onChange={(event) => setRecoveryQuestionTwo(event.target.value)}>{questionOptions.map((item) => <option key={item.id} value={item.id}>{item.question}</option>)}</select></label><label>Answer 2<input value={recoveryAnswerTwo} onChange={(event) => setRecoveryAnswerTwo(event.target.value)} placeholder="Private answer" autoComplete="off" required minLength={3} /></label></div><div className="warning-box compact">Use answers that cannot be found on social media or public records. Sivan stores only secure hashes, never plain answers.</div><button className="primary-btn" disabled={busy || recoveryAnswerOne.trim().length < 3 || recoveryAnswerTwo.trim().length < 3}>{busy ? 'Saving…' : 'Save recovery questions'}</button></form>}
      {recoveryQuestionMessage && <div className="success-note recovery-question-message">{recoveryQuestionMessage}</div>}
      <div className={`security-setting-row connected ${emailConfirmations ? 'enabled' : ''}`}><span>✉</span><div><strong>Email confirmations for high-value actions</strong><small>Require email confirmation for high-value transfers and sensitive payment actions where supported.</small><em>{emailConfirmations ? 'Enabled' : 'Disabled'}</em></div><label className="switch-toggle connected"><input type="checkbox" checked={emailConfirmations} disabled={loading} onChange={(event) => void onUpdate({ emailConfirmationsForHighValue: event.target.checked })} /><i /></label></div>
      <div className={`security-setting-row connected ${securityAlerts ? 'enabled' : ''}`}><span>◈</span><div><strong>Security alerts</strong><small>Receive notices about verification, account changes, risk events, support escalations, and important account safety updates.</small><em>{securityAlerts ? 'Enabled' : 'Disabled'}</em></div><label className="switch-toggle connected"><input type="checkbox" checked={securityAlerts} disabled={loading} onChange={(event) => void onUpdate({ securityAlerts: event.target.checked })} /><i /></label></div>
      <div className="security-setting-row"><span>◷</span><div><strong>Active session</strong><small>Current browser session active. Sign out if this is not your device.</small><em>Current device</em></div><button type="button" className="secondary-btn small" onClick={onLogout}>Sign out</button></div>
    </div>
    <div className="notification-settings-foot"><strong>Connected</strong><span>2FA recovery questions are a support verification factor, not an automatic 2FA bypass.</span></div>
  </div>;
}

function NotificationPreferencesPanel({ preferences, loading, onUpdate }: { preferences: UserPreferencesRecord; loading: boolean; onUpdate: (patch: Partial<UserPreferencesRecord>) => Promise<void> }) {
  const rows: Array<{ key: keyof Pick<UserPreferencesRecord, 'transactionUpdates' | 'marketingEmails' | 'securityAlerts' | 'emailConfirmationsForHighValue'>; icon: string; title: string; body: string; locked?: boolean }> = [
    { key: 'transactionUpdates', icon: '♢', title: 'Transaction updates', body: 'Deposits, on-ramp payments, payouts, balance credits, supplier payments, and transfer status.' },
    { key: 'securityAlerts', icon: '◈', title: 'Security alerts', body: 'Verification, account changes, support-risk events, and important account safety notices.' },
    { key: 'emailConfirmationsForHighValue', icon: '✉', title: 'High-value confirmations', body: 'Require email confirmation for high-value transfers where supported.' },
    { key: 'marketingEmails', icon: '◎', title: 'Marketing emails', body: 'Product news, feature updates, offers, and launch announcements.' }
  ];
  return <div className="notification-settings-panel"><div className="settings-section-head"><h3>Notifications</h3><p className="muted">These switches save directly to your Sivan preferences. Critical transactional and security notices may still be sent when required for account safety or compliance.</p></div><div className="notification-settings-list">{rows.map((row) => {
    const checked = Boolean(preferences[row.key]);
    return <div className={`notification-setting-row ${checked ? 'enabled' : ''}`} key={row.key}><span>{row.icon}</span><div><strong>{row.title}</strong><small>{row.body}</small><em>{checked ? 'Enabled' : 'Disabled'}</em></div><label className="switch-toggle connected"><input name={row.key} type="checkbox" checked={checked} disabled={loading} onChange={(event) => void onUpdate({ [row.key]: event.target.checked } as Partial<UserPreferencesRecord>)} /><i /></label></div>;
  })}</div><div className="notification-settings-foot"><strong>Connected</strong><span>Saved to your account preferences and used by Sivan notification surfaces.</span></div></div>;
}

function SettingsRows({ rows, preferences }: { rows: string[][]; preferences?: UserPreferencesRecord }) {
  return <div className="settings-row-list">{rows.map((row) => {
    const key = row[3];
    const isToggle = ['transactionUpdates', 'marketingEmails', 'securityAlerts', 'emailConfirmationsForHighValue'].includes(key);
    const checked = key === 'transactionUpdates' ? preferences?.transactionUpdates : key === 'marketingEmails' ? preferences?.marketingEmails : key === 'securityAlerts' ? preferences?.securityAlerts : key === 'emailConfirmationsForHighValue' ? preferences?.emailConfirmationsForHighValue : false;
    return <div className="settings-row" key={row[1]}><span>{row[0]}</span><div><strong>{row[1]}</strong><small>{row[2]}</small></div>{isToggle ? <label className="switch-toggle"><input name={key} type="checkbox" defaultChecked={Boolean(checked)} /><i /></label> : <button type="button" className="ghost-btn small">{key}</button>}</div>;
  })}</div>;
}

