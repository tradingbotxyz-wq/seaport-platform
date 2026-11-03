// Sign-in, MFA challenge and enrolment, recovery codes, temporary-password change, idle warning.
import { useEffect, useRef, useState } from 'react';
import { post, get, lastApiActivity, errorText } from '../lib.js';
import { Button, Field, Icon, Modal, ErrorBox } from '../ui.jsx';

export function Brand({ collapsed }) {
  if (collapsed) return <div className="brand-name serif" style={{ fontSize: 22 }}><b>S</b><span className="g">G</span></div>;
  return (
    <div className="brand-text">
      <div className="brand-name">Seaport<b><span className="g">G</span>lobal</b></div>
      <div className="brand-sub">WORKING CAPITAL</div>
    </div>
  );
}

function AuthCard({ title, subtitle, children, footer }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <h2 className="auth-title">{title}</h2>
        {subtitle && <p className="auth-sub">{subtitle}</p>}
        {children}
        {footer && <div className="auth-foot">{footer}</div>}
      </div>
      <p className="auth-legal"><Icon name="shield" size={14} /> Authorised users only. Activity is recorded in a tamper-evident audit trail.</p>
    </div>
  );
}

/** Steps a password-mode session through sign-in → MFA → password change. */
export function AuthFlow({ session, notice, onSession }) {
  const state = session?.authenticated ? session.state : 'SIGNED_OUT';
  if (state === 'MFA') return <MfaChallenge session={session} onSession={onSession} />;
  if (state === 'MFA_SETUP') return <MfaSetup session={session} onSession={onSession} />;
  if (state === 'PASSWORD') return <ChangePassword session={session} onSession={onSession} />;
  return <SignIn notice={notice} onSession={onSession} />;
}

function SignIn({ notice, onSession }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSession(await post('/api/auth/login', { username: username.trim().toLowerCase(), password }));
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="Sign in" subtitle="Use your Seaport Global username and password.">
      {notice && <div className="infobar" role="status">{notice}</div>}
      <form onSubmit={submit} className="auth-form" noValidate>
        <Field label="Username"><input className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
        <Field label="Password" hint={caps ? 'Caps Lock is on' : undefined} htmlFor="signin-password">
          <div className="pw-wrap">
            <input id="signin-password" className="input" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} aria-describedby={caps ? 'signin-password-hint' : undefined}
              onChange={(e) => setPassword(e.target.value)} onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock'))} />
            <button type="button" className="pw-toggle" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </Field>
        {error && <div className="error-box" role="alert">{errorText(error)}</div>}
        <Button variant="primary" type="submit" className="block" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </AuthCard>
  );
}

function CodeInput({ value, onChange, onComplete, recovery }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, [recovery]);
  return (
    <input ref={ref} className={`input code-input ${recovery ? 'recovery' : ''}`} value={value} inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code"
      aria-label={recovery ? 'Recovery code' : '6-digit code'} placeholder={recovery ? 'xxxxx-xxxxx' : '000000'} maxLength={recovery ? 11 : 6}
      onChange={(e) => {
        const v = recovery ? e.target.value.toLowerCase().replace(/[^a-z2-7-]/g, '') : e.target.value.replace(/\D/g, '');
        onChange(v);
        if (!recovery && v.length === 6) onComplete?.(v);
      }} />
  );
}

function MfaChallenge({ session, onSession }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (c = code) => {
    setBusy(true);
    setError(null);
    try {
      onSession(await post('/api/auth/mfa', { code: c }));
    } catch (err) {
      setError(err);
      setCode('');
      if (err.status === 401 && /Sign in again/.test(err.message)) onSession({ authenticated: false, notice: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="Two-step verification" subtitle={recovery ? 'Enter one of the recovery codes you saved when you set up MFA. Each code works once.' : `Enter the 6-digit code from the authenticator app for ${session.user.username}.`}
      footer={<SignOutLink onSession={onSession} />}>
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <CodeInput value={code} onChange={setCode} onComplete={(v) => submit(v)} recovery={recovery} />
        {error && <div className="error-box" role="alert">{errorText(error)}</div>}
        <Button variant="primary" type="submit" className="block" disabled={busy || (recovery ? code.length < 10 : code.length !== 6)}>{busy ? 'Checking…' : 'Verify'}</Button>
        <button type="button" className="link-btn" onClick={() => { setRecovery((r) => !r); setCode(''); setError(null); }}>
          {recovery ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code'}
        </button>
      </form>
    </AuthCard>
  );
}

function SignOutLink({ onSession }) {
  return <button type="button" className="link-btn" onClick={async () => { try { await post('/api/auth/logout'); } catch { /* already out */ } onSession({ authenticated: false }); }}>Sign in as someone else</button>;
}

function copy(text) {
  try { navigator.clipboard?.writeText(text); return true; } catch { return false; }
}

/** The three enrolment steps; used at sign-in (required MFA) and from the Security panel (optional). */
export function MfaEnrolSteps({ onConfirmed }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { post('/api/auth/mfa/setup').then(setSetup, setError); }, []);
  const confirm = async (c = code) => {
    setBusy(true);
    setError(null);
    try {
      onConfirmed(await post('/api/auth/mfa/confirm', { code: c }));
    } catch (err) {
      setError(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  const grouped = setup?.secret.match(/.{1,4}/g)?.join(' ');
  return (
    <ol className="steps">
      <li><b>Install an authenticator app</b> on your phone, such as Microsoft Authenticator, Google Authenticator or 1Password.</li>
      <li>
        <b>Add an account</b> in the app and choose <i>Enter a setup key</i>:
        {!setup && !error && <div className="muted small">Preparing your key…</div>}
        {setup && (
          <div className="setup-key">
            <div className="kv"><span>Account</span><b>{setup.issuer} · {setup.account}</b></div>
            <div className="kv"><span>Key</span><code>{grouped}</code>
              <button type="button" className="btn sm" onClick={() => setCopied(copy(setup.secret))}>{copied ? 'Copied' : 'Copy'}</button></div>
            <div className="kv"><span>Type</span><b>Time-based, 6 digits</b></div>
            <a className="btn sm ghost open-app" href={setup.otpauth_uri}>On this phone? Open in authenticator app</a>
          </div>
        )}
      </li>
      <li>
        <b>Enter the 6-digit code</b> the app shows for Seaport Global:
        <form className="auth-form" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); confirm(); }}>
          <CodeInput value={code} onChange={setCode} onComplete={(v) => confirm(v)} />
          {error && <div className="error-box" role="alert">{errorText(error)}</div>}
          <Button variant="primary" type="submit" className="block" disabled={busy || code.length !== 6 || !setup}>{busy ? 'Checking…' : 'Turn on verification'}</Button>
        </form>
      </li>
    </ol>
  );
}

function MfaSetup({ session, onSession }) {
  const [done, setDone] = useState(null);
  if (done) return <AuthCard title="Save your recovery codes" subtitle={RECOVERY_HELP}><RecoveryCodeList codes={done.recovery_codes} onDone={() => onSession(done)} /></AuthCard>;
  return (
    <AuthCard title="Set up two-step verification" subtitle="Seaport Global requires an authenticator app for every account. It takes about a minute." footer={<SignOutLink onSession={onSession} />}>
      <MfaEnrolSteps onConfirmed={setDone} />
    </AuthCard>
  );
}

export const RECOVERY_HELP = 'If you lose your phone, each of these codes lets you sign in once. Store them somewhere safe and private, such as your password manager. They will not be shown again.';

export function RecoveryCodeList({ codes, onDone }) {
  const [saved, setSaved] = useState(false);
  const text = `Seaport Global recovery codes\nEach code can be used once if you lose your authenticator.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'seaport-recovery-codes.txt' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <div className="codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="row" style={{ justifyContent: 'center', margin: '12px 0' }}>
        <Button icon="download" onClick={download}>Download</Button>
        <Button onClick={() => copy(text)}>Copy</Button>
      </div>
      <label className="row check-row"><input type="checkbox" className="check" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved my recovery codes</label>
      <Button variant="primary" className="block" disabled={!saved} onClick={onDone}>Continue</Button>
    </>
  );
}

export function passwordChecks(pw, username) {
  return [
    ['At least 12 characters', pw.length >= 12],
    ['Does not contain your username', !!pw && !pw.toLowerCase().includes((username || '').toLowerCase())],
    ['Not a single repeated character', !!pw && !/^(.)\1+$/.test(pw)],
  ];
}

export function PasswordForm({ username, onDone, submitLabel = 'Change password' }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const checks = passwordChecks(f.next, username);
  const ok = checks.every(([, v]) => v) && f.next === f.confirm && f.current;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await post('/api/auth/password', { current_password: f.current, new_password: f.next }));
      setF({ current: '', next: '', confirm: '' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="auth-form" onSubmit={submit}>
      <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={f.current} onChange={set('current')} /></Field>
      <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={f.next} onChange={set('next')} /></Field>
      <ul className="pw-checks">
        {checks.map(([label, v]) => <li key={label} className={v ? 'ok' : ''}><Icon name={v ? 'check' : 'x'} size={13} />{label}</li>)}
        <li className="muted">A short phrase of unrelated words is easy to remember and hard to guess.</li>
      </ul>
      <Field label="Confirm new password" hint={f.confirm && f.confirm !== f.next ? 'Does not match' : undefined}><input className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} /></Field>
      {error && <div className="error-box" role="alert">{errorText(error)}</div>}
      <Button variant="primary" type="submit" className="block" disabled={busy || !ok}>{busy ? 'Saving…' : submitLabel}</Button>
    </form>
  );
}

function ChangePassword({ session, onSession }) {
  return (
    <AuthCard title="Choose a new password" subtitle="Your administrator issued a temporary password. Choose your own before continuing." footer={<SignOutLink onSession={onSession} />}>
      <PasswordForm username={session.user.username} onDone={onSession} submitLabel="Save and continue" />
    </AuthCard>
  );
}

/** Warn two minutes before the server-side idle timeout; "Stay signed in" touches the session. */
export function IdleWarning({ idleMinutes, onExpired }) {
  const [left, setLeft] = useState(null);
  useEffect(() => {
    if (!idleMinutes) return undefined;
    const t = setInterval(() => {
      const ms = idleMinutes * 60_000 - (Date.now() - lastApiActivity());
      if (ms <= 0) { clearInterval(t); onExpired(); } else setLeft(ms <= 120_000 ? Math.ceil(ms / 1000) : null);
    }, 1000);
    return () => clearInterval(t);
  }, [idleMinutes, onExpired]);
  if (left === null) return null;
  return (
    <Modal title="Are you still there?" onClose={() => get('/api/auth/session').catch(() => {})} width={440}
      footer={<><Button onClick={onExpired}>Sign out</Button><Button variant="primary" onClick={() => get('/api/auth/session').then(() => setLeft(null)).catch(() => {})}>Stay signed in</Button></>}>
      <p>For security, you will be signed out in <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b> unless you continue.</p>
    </Modal>
  );
}

export { ErrorBox };
