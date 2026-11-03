import { useApi, dateTime, initials, navigate } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Button, Pill, Icon, Loading, ErrorBox } from '../ui.jsx';

export default function Profile() {
  const { me } = useSession();
  const { data: p, error } = useApi('/api/me');
  const audit = useApi('/api/audit/verify');
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Loading />;
  const switchUser = () => { try { localStorage.removeItem('sg.user'); } catch { /* ignore */ } location.href = '/'; };

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
          <div className="divider" />
          <Button icon="users" onClick={switchUser}>Switch user (demo sign-in)</Button>
        </Card>
        <Card title="What you can do" subtitle="From your role; enforced by the API.">
          <div className="stack" style={{ gap: 8 }}>
            {p.permissions.map((x) => (
              <div key={x.key} className="row" style={{ flexWrap: 'nowrap' }}>
                <span className={x.granted ? 't-green' : 'faint'}><Icon name={x.granted ? 'check' : 'x'} size={16} strokeWidth={2.4} /></span>
                <span className={x.granted ? '' : 'faint'}>{x.label}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Audit trail integrity" subtitle="Every action is hash-chained; editing or deleting any record breaks the chain.">
          {!audit.data ? <Loading /> : audit.data.valid
            ? <div className="row"><Pill tone="good">Verified</Pill><span>{audit.data.checked.toLocaleString()} records, chain intact</span></div>
            : <div className="row"><Pill tone="bad">Broken</Pill><span>Chain breaks at record #{audit.data.brokenAt}</span></div>}
          <div className="divider" />
          <Button size="sm" icon="refresh" onClick={audit.reload}>Verify again</Button>
        </Card>
      </div>

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
