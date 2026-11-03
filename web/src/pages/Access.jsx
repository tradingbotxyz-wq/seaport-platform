import { useState } from 'react';
import { useApi, post, put, dateTime, initials, doneMessage, isPending } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, ErrorBox, Loading, Icon, Modal, useUi, useAction } from '../ui.jsx';


export default function Access() {
  const { me, can } = useSession();
  const { toast, ask } = useUi();
  const { data: d, error, reload } = useApi('/api/access');
  const [busy, run] = useAction();
  const [form, setForm] = useState({ username: '', name: '', email: '', role: 'VIEWER' });
  const [temp, setTemp] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  const manage = can('users.manage');
  const label = Object.fromEntries(d.roles.map((r) => [r.role, r.label]));
  const ROLE_ORDER = d.roles.map((r) => r.role);

  const update = (u, patch) => run(async () => {
    const r = await put(`/api/access/users/${u.username}`, patch);
    toast(doneMessage(r, `${u.name} updated`), isPending(r) ? 'info' : 'success');
    reload();
  });
  const create = () => run(async () => {
    const r = await post('/api/access/users', { ...form, email: form.email || undefined });
    toast(doneMessage(r, `${form.name} added`), isPending(r) ? 'info' : 'success');
    setForm({ username: '', name: '', email: '', role: 'VIEWER' });
    reload();
  });

  const resetPassword = async (u) => {
    if (!(await ask({ title: `Request a password reset for ${u.name}?`, message: 'A second administrator or Compliance approves the reset and receives the one-time password to give to the user. They are then signed out everywhere and must choose a new password.', confirm: 'Request reset' }))) return;
    run(async () => { const r = await post(`/api/access/users/${u.username}/reset-password`); toast(doneMessage(r, 'Reset requested'), 'info'); reload(); });
  };
  const resetMfa = async (u) => {
    if (!(await ask({ title: `Request an MFA reset for ${u.name}?`, message: 'Use this when someone lost their phone. A second administrator or Compliance verifies their identity and approves it; they then set up a new authenticator at their next sign-in.', confirm: 'Request reset' }))) return;
    run(async () => { const r = await post(`/api/access/users/${u.username}/reset-mfa`); toast(doneMessage(r, 'Reset requested'), 'info'); reload(); });
  };
  const unlock = (u) => run(async () => { await post(`/api/access/users/${u.username}/unlock`); toast(`${u.name} unlocked`, 'success'); reload(); });

  return (
    <>
      <div className="grid g6">
        {d.roles.filter((r) => r.users > 0 || r.role === 'ADMIN').map((r) => <Kpi key={r.role} label={r.label} value={r.users} sub={`${r.users === 1 ? 'user' : 'users'} · ${r.role}`} />)}
      </div>

      <Card title="Users" subtitle={manage ? 'Role changes and new users take effect when a second administrator or Compliance approves them (SoD-4). Deactivation is immediate. You cannot change your own access.' : 'Only an administrator can change access.'}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>User</th><th>Username</th><th>Role</th><th>Active</th><th>Sign-in</th><th>Last sign-in</th>{manage && <th />}</tr></thead>
            <tbody>
              {d.users.map((u) => {
                const self = u.username === me.username;
                return (
                  <tr key={u.username} className={u.active ? '' : 'dim'}>
                    <td><div className="row" style={{ flexWrap: 'nowrap' }}><span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initials(u.name)}</span><div><b>{u.name}</b>{self && <Pill tone="info">you</Pill>}<div className="small muted">{u.email ?? ''}</div></div></div></td>
                    <td className="mono">{u.username}</td>
                    <td>
                      {manage && !self ? (
                        <select className="select sm" style={{ width: 210 }} value={u.role} disabled={busy} onChange={(e) => update(u, { role: e.target.value })}>
                          {ROLE_ORDER.map((r) => <option key={r} value={r}>{label[r]}</option>)}
                        </select>
                      ) : u.role_label}
                    </td>
                    <td>{manage && !self
                      ? <input type="checkbox" className="check" checked={!!u.active} disabled={busy} onChange={(e) => update(u, { active: e.target.checked })} aria-label={`Active ${u.name}`} />
                      : (u.active ? 'Yes' : 'No')}</td>
                    <td>{u.locked_until ? <Pill tone="bad">Locked</Pill> : u.must_change_password ? <Pill tone="warn">Temporary password</Pill> : u.mfa_enabled ? <Pill tone="good">MFA on</Pill> : <Pill tone="warn">MFA not set up</Pill>}</td>
                    <td className="small muted">{u.last_login_at ? dateTime(u.last_login_at) : 'Never'}</td>
                    {manage && <td className="row" style={{ flexWrap: 'nowrap' }}>{!self && <>
                      {u.locked_until && <Button size="sm" disabled={busy} onClick={() => unlock(u)}>Unlock</Button>}
                      <Button size="sm" disabled={busy} onClick={() => resetPassword(u)}>Reset password</Button>
                      {!!u.mfa_enabled && <Button size="sm" disabled={busy} onClick={() => resetMfa(u)}>Reset MFA</Button>}
                    </>}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {manage && (
          <>
            <div className="section-title">Add user</div>
            <div className="grid g4" style={{ alignItems: 'end' }}>
              <Field label="Username"><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} placeholder="firstname" /></Field>
              <Field label="Full name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Email"><input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
              <Field label="Role">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLE_ORDER.map((r) => <option key={r} value={r}>{label[r]}</option>)}</select>
                  <Button variant="primary" disabled={busy || !form.username || !form.name} onClick={create} style={{ height: 44 }}>Add</Button>
                </div>
              </Field>
            </div>
          </>
        )}
      </Card>

      <div className="grid g2">
        <Card title="Permission matrix" subtitle="Enforced by the API on every request, not just hidden in the screens.">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Permission</th>{ROLE_ORDER.map((r) => <th key={r} className="c" title={label[r]}>{r.replace('OPS_', 'OPS ')}</th>)}</tr></thead>
              <tbody>
                {d.matrix.map((m) => (
                  <tr key={m.key}>
                    <td>{m.label}<div className="faint mono">{m.key}</div></td>
                    {ROLE_ORDER.map((r) => <td key={r} className="c">{m.roles[r] ? <span className="t-green"><Icon name="check" size={16} strokeWidth={2.4} /></span> : <span className="faint">—</span>}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Segregation of duties" subtitle="Rules and live evidence from the transaction history.">
          <div className="stack" style={{ gap: 10 }}>
            {d.sod_rules.map((r) => {
              const ev = d.sod_evidence.find((e) => e.rule === r.id);
              return (
                <div key={r.id} className="infobar" style={{ margin: 0, alignItems: 'flex-start' }}>
                  <span className="t-green"><Icon name="shield" size={18} /></span>
                  <div style={{ flex: 1 }}>
                    <b>{r.id}</b> · {r.rule}
                    <div className="small faint">Enforced in {r.enforced_in}</div>
                    {ev && <div className="small" style={{ marginTop: 4 }}>{ev.description}: <b>{ev.checked}</b> checked, {ev.violations ? <b className="t-red">{ev.violations} violations</b> : <b className="t-green">0 violations</b>}</div>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="section-title">Recent access changes</div>
          {d.recent_changes.length ? (
            <div className="table-wrap"><table className="tbl"><thead><tr><th>When</th><th>By</th><th>Change</th><th>User</th></tr></thead>
              <tbody>{d.recent_changes.map((c, i) => (
                <tr key={i}><td className="small">{dateTime(c.ts)}</td><td>{c.actor}</td><td>{c.action.replace('user.', '')}{c.details.after ? ` → ${c.details.after.role}${c.details.after.active ? '' : ' (inactive)'}` : ''}</td><td className="mono">{c.entity_id}</td></tr>
              ))}</tbody></table></div>
          ) : <div className="muted small">No access changes yet.</div>}
        </Card>
      </div>
      {temp && (
        <Modal title={`One-time password for ${temp.user.name}`} onClose={() => setTemp(null)} width={520} footer={<Button variant="primary" onClick={() => setTemp(null)}>Done</Button>}>
          <p>Give this to <b>{temp.user.name}</b> through a separate channel (phone or in person, never the same email as their username). It is shown only once.</p>
          <div className="temp-pw"><code>{temp.temporary_password}</code><Button size="sm" onClick={() => navigator.clipboard?.writeText(temp.temporary_password)}>Copy</Button></div>
          <p className="muted small">They must choose their own password at sign-in. All their sessions were ended.</p>
        </Modal>
      )}
    </>
  );
}
