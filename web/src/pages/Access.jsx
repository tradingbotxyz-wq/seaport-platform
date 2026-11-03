import { useState } from 'react';
import { useApi, post, put, dateTime, initials } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, ErrorBox, Loading, Icon, useUi, useAction } from '../ui.jsx';


export default function Access() {
  const { me, can } = useSession();
  const { toast } = useUi();
  const { data: d, error, reload } = useApi('/api/access');
  const [busy, run] = useAction();
  const [form, setForm] = useState({ username: '', name: '', email: '', role: 'VIEWER' });
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  const manage = can('users.manage');
  const label = Object.fromEntries(d.roles.map((r) => [r.role, r.label]));
  const ROLE_ORDER = d.roles.map((r) => r.role);

  const update = (u, patch) => run(async () => {
    await put(`/api/access/users/${u.username}`, patch);
    toast(`${u.name} updated`, 'success');
    reload();
  });
  const create = () => run(async () => {
    await post('/api/access/users', { ...form, email: form.email || undefined });
    toast(`${form.name} added`, 'success');
    setForm({ username: '', name: '', email: '', role: 'VIEWER' });
    reload();
  });

  return (
    <>
      <div className="grid g6">
        {d.roles.filter((r) => r.users > 0 || r.role === 'ADMIN').map((r) => <Kpi key={r.role} label={r.label} value={r.users} sub={`${r.users === 1 ? 'user' : 'users'} · ${r.role}`} />)}
      </div>

      <Card title="Users" subtitle={manage ? 'Change a role or deactivate a user. You cannot change your own access (SoD-4).' : 'Only an administrator can change access.'}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>User</th><th>Username</th><th>Email</th><th>Role</th><th>Active</th><th>Created</th></tr></thead>
            <tbody>
              {d.users.map((u) => {
                const self = u.username === me.username;
                return (
                  <tr key={u.username} className={u.active ? '' : 'dim'}>
                    <td><div className="row" style={{ flexWrap: 'nowrap' }}><span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initials(u.name)}</span><b>{u.name}</b>{self && <Pill tone="info">you</Pill>}</div></td>
                    <td className="mono">{u.username}</td>
                    <td>{u.email ?? '—'}</td>
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
                    <td className="small muted">{dateTime(u.created_at)}</td>
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
    </>
  );
}
