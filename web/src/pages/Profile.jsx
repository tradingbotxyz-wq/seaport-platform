import { useApi, dateTime, initials, navigate, post } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Button, Pill, Icon, Loading, ErrorBox, useUi, useAction } from '../ui.jsx';
import { PasswordForm, MfaEnrolSteps, RecoveryCodeList, RECOVERY_HELP } from './Auth.jsx';
import { Modal } from '../ui.jsx';
import { useState } from 'react';

/** Password, MFA status and signed-in devices. Used by staff (Profile) and investors (Security). */
export function SecurityPanel({ profile }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const sessions = useApi('/api/auth/sessions');
  const demo = sessions.error?.status === 400 || sessions.error?.status === 404;
  const [enrol, setEnrol] = useState(null); // null | 'steps' | { recovery_codes }
  return (
    <div className="grid g2">
      <Card title="Sign-in security" subtitle="Two-step verification protects your account even if your password leaks.">
        <dl className="dl">
          <dt>Two-step verification</dt><dd>{profile.mfa_enabled ? <Pill tone="good">On · authenticator app</Pill> : <><Pill tone="warn">Off</Pill> {!demo && <Button size="sm" variant="primary" onClick={() => setEnrol('steps')}>Turn on</Button>}</>}</dd>
          <dt>Recovery codes left</dt><dd>{profile.mfa_enabled ? `${profile.recovery_codes_left} of 8` : '—'}{profile.mfa_enabled && profile.recovery_codes_left <= 2 ? <span className="t-amber small"> · ask an administrator to reset MFA to get new codes</span> : null}</dd>
          <dt>Password last changed</dt><dd>{profile.password_changed_at ? dateTime(profile.password_changed_at) : 'Not yet changed'}</dd>
          <dt>Last sign-in</dt><dd>{profile.last_login_at ? dateTime(profile.last_login_at) : '—'}</dd>
        </dl>
        <div className="divider" />
        <div className="section-title" style={{ marginTop: 0 }}>Change password</div>
        <PasswordForm username={profile.username} onDone={() => { toast('Password changed. Other devices were signed out.', 'success'); sessions.reload(); }} />
        {enrol && (
          <Modal title={enrol === 'steps' ? 'Turn on two-step verification' : 'Save your recovery codes'} subtitle={enrol === 'steps' ? '' : RECOVERY_HELP} onClose={() => setEnrol(null)} width={520}>
            {enrol === 'steps' ? <MfaEnrolSteps onConfirmed={(r) => setEnrol(r)} />
              : <RecoveryCodeList codes={enrol.recovery_codes} onDone={() => { setEnrol(null); location.reload(); }} />}
          </Modal>
        )}
      </Card>
      <Card title="Where you are signed in" subtitle="Sign out any device you do not recognise, then change your password.">
        {demo ? <div className="muted">Demo mode has no sessions.</div> : !sessions.data ? <Loading /> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Device</th><th>IP address</th><th>Last active</th><th /></tr></thead>
            <tbody>{sessions.data.map((x) => (
              <tr key={x.id}>
                <td className="wrap small">{x.user_agent?.replace(/\(.*?\)/g, '').slice(0, 60) || 'Unknown'}{x.current && <Pill tone="info">This device</Pill>}</td>
                <td className="mono small">{x.ip}</td><td className="small">{dateTime(x.last_seen_at)}</td>
                <td>{!x.current && <Button size="sm" disabled={busy} onClick={() => run(async () => { await post(`/api/auth/sessions/${x.id}/revoke`); toast('Device signed out', 'success'); sessions.reload(); })}>Sign out</Button>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

export default function Profile() {
  const { me } = useSession();
  const { data: p, error } = useApi('/api/me');
  const audit = useApi('/api/audit/verify');
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Loading />;

  return (
    <>
      <div className="grid g3">
        <Card title="Profile">
          <div className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
            <span className="avatar" style={{ width: 56, height: 56, fontSize: 20 }}>{initials(p.name)}</span>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{p.name}</div>
              <div className="muted">{p.role_label}</div>
            </div>
          </div>
          <dl className="dl" style={{ marginTop: 16 }}>
            <dt>Username</dt><dd className="mono">{p.username}</dd>
            <dt>Email</dt><dd>{p.email ?? '—'}</dd>
            <dt>Role</dt><dd>{p.role}</dd>
            <dt>Member since</dt><dd>{dateTime(p.created_at)}</dd>
          </dl>
        </Card>
        <Card title="What you can do" subtitle="From your role; enforced by the API on every request.">
          <div className="stack" style={{ gap: 8 }}>
            {p.permissions.filter((x) => x.granted).map((x) => (
              <div key={x.key} className="row" style={{ flexWrap: 'nowrap' }}>
                <span className="t-green"><Icon name="check" size={16} strokeWidth={2.4} /></span><span>{x.label}</span>
              </div>
            ))}
          </div>
          <details className="more"><summary className="small muted">Not available to your role ({p.permissions.filter((x) => !x.granted).length})</summary>
            <div className="stack" style={{ gap: 6, marginTop: 8 }}>{p.permissions.filter((x) => !x.granted).map((x) => <div key={x.key} className="small faint">{x.label}</div>)}</div>
          </details>
        </Card>
        <Card title="Audit trail integrity" subtitle="Every action is hash-chained; editing or deleting any record breaks the chain.">
          {!audit.data ? <Loading /> : audit.data.valid
            ? <div className="row"><Pill tone="good">Verified</Pill><span>{audit.data.checked.toLocaleString()} records, chain intact</span></div>
            : <div className="row"><Pill tone="bad">Broken</Pill><span>Chain breaks at record #{audit.data.brokenAt}</span></div>}
          <div className="divider" />
          <Button size="sm" icon="refresh" onClick={audit.reload}>Verify again</Button>
        </Card>
      </div>

      <SecurityPanel profile={p} />

      <div className="grid g2">
        <Card title="Notifications" subtitle={me.role === 'ADMIN' ? 'All roles (administrator view)' : `For ${p.role_label}`}>
          {!p.notifications.length ? <div className="muted">No notifications.</div> : (
            <div className="table-wrap scroll"><table className="tbl"><tbody>{p.notifications.map((n) => (
              <tr key={n.id} className={n.link ? 'selectable' : ''} onClick={() => n.link && navigate(n.link)}>
                <td className="small muted nowrap">{dateTime(n.created_at)}</td><td className="wrap">{n.message}</td><td><Pill tone="info">{n.audience}</Pill></td>
              </tr>
            ))}</tbody></table></div>
          )}
        </Card>
        <Card title="Your recent activity">
          {!p.activity.length ? <div className="muted">Nothing yet.</div> : (
            <div className="table-wrap scroll"><table className="tbl"><tbody>{p.activity.map((a, i) => (
              <tr key={i}><td className="small muted nowrap">{dateTime(a.ts)}</td><td className="mono">{a.action}</td><td>{a.entity_type} {a.entity_id ?? ''}</td></tr>
            ))}</tbody></table></div>
          )}
        </Card>
      </div>
    </>
  );
}
