import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SessionContext, useSession } from './session.js';
import './styles.css';
import { get, setApiUser, navigate, useLocation, useApi, useDebounced, useOutsideClick, initials, money, dateShort, moneyExact, post } from './lib.js';
import { Icon, UiProvider, Modal, Loading, ErrorBox, Pill, Button, useUi, useAction } from './ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Onboarding from './pages/Onboarding.jsx';
import Underwriting from './pages/Underwriting.jsx';
import Pools from './pages/Pools.jsx';
import Capital from './pages/Capital.jsx';
import Disbursements from './pages/Disbursements.jsx';
import Servicing from './pages/Servicing.jsx';
import Brokerage from './pages/Brokerage.jsx';
import Reports from './pages/Reports.jsx';
import Portal from './pages/Portal.jsx';
import PurchaseFunding from './pages/PurchaseFunding.jsx';
import Settlement from './pages/Settlement.jsx';
import MasterTable from './pages/MasterTable.jsx';
import Access from './pages/Access.jsx';
import Revenue from './pages/Revenue.jsx';
import Reconciliation from './pages/Reconciliation.jsx';
import Profile from './pages/Profile.jsx';

const ROUTES = [
  { path: '/dashboard', label: 'Portfolio Dashboard', icon: 'home', Page: Dashboard },
  { section: 'Lifecycle' },
  { path: '/onboarding', label: 'Client Onboarding', icon: 'upload', Page: Onboarding },
  { path: '/underwriting', label: 'Underwriting', icon: 'shield', Page: Underwriting, badge: 'credit' },
  { path: '/purchase-funding', label: 'Purchase & Funding', icon: 'card', Page: PurchaseFunding, badge: 'funding' },
  { path: '/pools', label: 'Pools & Tranches', icon: 'grid', Page: Pools },
  { path: '/capital', label: 'Investors & Capital', icon: 'chart', Page: Capital },
  { path: '/disbursements', label: 'Disbursements', icon: 'download', Page: Disbursements },
  { path: '/settlement', label: 'Settlement & Repayment', icon: 'file', Page: Settlement },
  { path: '/servicing', label: 'Servicing & Cases', icon: 'bell', Page: Servicing, badge: 'cases' },
  { path: '/brokerage', label: 'Brokerage & Trading', icon: 'chart', Page: Brokerage },
  { path: '/reconciliation', label: 'Reconciliation', icon: 'check', Page: Reconciliation, badge: 'recon' },
  { section: 'Reporting' },
  { path: '/reports', label: 'Reports & Analytics', icon: 'chart', Page: Reports },
  { path: '/revenue', label: 'Revenue & Fees', icon: 'chart', Page: Revenue },
  { section: 'Administration' },
  { path: '/master-table', label: 'Master Table (Programs)', icon: 'folder', Page: MasterTable },
  { path: '/access', label: 'User Access & SoD', icon: 'users', Page: Access },
  { path: '/profile', label: 'Profile', icon: 'profile', Page: Profile },
];
const INVESTOR_ROUTES = [{ section: 'Investor portal' }, { path: '/portal', label: 'My portfolio', icon: 'home', Page: Portal }];

// ---------- Session ----------
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function Login({ onLogin }) {
  const { data: users, error } = useApi('/api/users');
  return (
    <div className="login">
      <div className="panel">
        <Brand />
        <h2 style={{ fontSize: 18, marginTop: 22 }}>Sign in</h2>
        <p className="muted small" style={{ margin: '4px 0 12px' }}>
          Local demo sign-in: pick a user to act as. Each role sees and can do different things (maker, checker, credit, treasury).
          In production this is replaced by single sign-on.
        </p>
        <ErrorBox error={error} />
        {!users && !error && <Loading />}
        {users?.map((u) => (
          <button key={u.username} className="user-btn" onClick={() => onLogin(u.username)}>
            <span className="avatar">{initials(u.name)}</span>
            <span><b>{u.name}</b><br /><span className="muted small">{u.role_label}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Brand({ collapsed }) {
  if (collapsed) return <div className="brand-name serif" style={{ fontSize: 22 }}><b>S</b><span className="g">G</span></div>;
  return (
    <div className="brand-text">
      <div className="brand-name">Seaport<b><span className="g">G</span>lobal</b></div>
      <div className="brand-sub">WORKING CAPITAL</div>
    </div>
  );
}

// ---------- Loan detail (opened from anywhere) ----------
function LoanModal({ id, onClose }) {
  const { data: l, error, reload } = useApi(id ? `/api/loans/${id}` : null);
  const { can, today } = useSession();
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [action, setAction] = useState('');
  const logAction = () => run(async () => { await post(`/api/loans/${id}/collection-actions`, { action }); setAction(''); toast('Collection action logged', 'success'); reload(); });
  return (
    <Modal title={l ? `Loan ${l.loan_ref}` : 'Loan'} subtitle={l ? `${l.invoice_number} · ${l.buyer} · ${l.deal_name}` : ''} onClose={onClose} width={880}>
      <ErrorBox error={error} />
      {!l && !error && <Loading />}
      {l && (
        <>
          <div className="grid g2">
            <dl className="dl">
              <dt>Status</dt><dd><Pill status={l.status} /></dd>
              <dt>Program</dt><dd>{l.program_code} · {l.deal_name}</dd>
              <dt>Buyer / obligor</dt><dd>{l.buyer} <span className="rating">{l.rating}</span></dd>
              <dt>Investor</dt><dd>{l.investor_code} · {l.investor_name}</dd>
              <dt>Funding date</dt><dd>{dateShort(l.funding_date)}</dd>
              <dt>Maturity</dt><dd>{dateShort(l.maturity_date)}</dd>
            </dl>
            <dl className="dl">
              <dt>Face (amount due)</dt><dd className="num">{money(l.face_cents, l.currency)}</dd>
              <dt>Purchase price</dt><dd className="num">{money(l.purchase_cents, l.currency)}</dd>
              <dt>Interest (discount)</dt><dd className="num">{moneyExact(l.interest_cents, l.currency)}</dd>
              <dt>To investor</dt><dd className="num">{moneyExact(l.investor_interest_cents, l.currency)}</dd>
              <dt>Received (bank)</dt><dd className="num">{money(l.received_cents, l.currency)}</dd>
              <dt>Bank reference</dt><dd>{l.bank_reference ?? '—'}{l.settled_at ? ` · settled ${dateShort(l.settled_at)}` : ''}</dd>
            </dl>
          </div>
          {(l.status === 'OPEN' && l.maturity_date < today) || l.collection_actions.length ? (
            <>
              <div className="section-title">Collection log</div>
              {l.collection_actions.length ? (
                <div className="table-wrap"><table className="tbl"><tbody>{l.collection_actions.map((c) => <tr key={c.id}><td>{dateShort(c.at)}</td><td className="wrap strong">{c.action}</td><td className="small muted">{c.actor_name ?? c.actor}</td></tr>)}</tbody></table></div>
              ) : <div className="muted small">No collection activity yet.</div>}
              {l.status === 'OPEN' && can('service.cases') && (
                <div className="row" style={{ marginTop: 8 }}>
                  <input className="input" style={{ flex: 1 }} aria-label="Collection action" placeholder="e.g. Called buyer AP, payment promised Friday" value={action} maxLength={120} onChange={(e) => setAction(e.target.value)} />
                  <Button disabled={busy || !action.trim()} onClick={logAction}>Log action</Button>
                </div>
              )}
            </>
          ) : null}
          <div className="section-title">Settlement advices</div>
          {l.advices.length ? (
            <div className="table-wrap"><table className="tbl"><thead><tr><th>File</th><th className="r">Advised amount</th><th>Value date</th><th>Bank ref</th></tr></thead>
              <tbody>{l.advices.map((a) => <tr key={a.id}><td>{a.filename}</td><td className="r">{money(a.amount_cents, l.currency)}</td><td>{dateShort(a.value_date)}</td><td>{a.bank_reference ?? '—'}</td></tr>)}</tbody></table></div>
          ) : <div className="muted small">No advice received yet.</div>}
          <div className="section-title">Bank statement lines</div>
          {l.bank_lines.length ? (
            <div className="table-wrap"><table className="tbl"><thead><tr><th>Statement</th><th>Reference</th><th className="r">Amount</th><th>Status</th></tr></thead>
              <tbody>{l.bank_lines.map((b) => <tr key={b.id}><td>{b.filename}</td><td>{b.reference}</td><td className="r">{money(b.amount_cents, b.currency)}</td><td><Pill status={b.match_status} /></td></tr>)}</tbody></table></div>
          ) : <div className="muted small">Not yet seen on a bank statement.</div>}
          <div className="section-title">Ledger postings</div>
          <div className="table-wrap"><table className="tbl"><thead><tr><th>Entry</th><th>Date</th><th>Description</th><th>Account</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead>
            <tbody>{l.journal.map((j, i) => (
              <tr key={i}><td className="mono">{j.ref}</td><td>{dateShort(j.entry_date)}</td><td className="small">{j.description}</td><td>{j.account_code} {j.account_name}</td>
                <td className="r">{j.debit_cents ? moneyExact(j.debit_cents) : ''}</td><td className="r">{j.credit_cents ? moneyExact(j.credit_cents) : ''}</td></tr>
            ))}</tbody></table></div>
        </>
      )}
    </Modal>
  );
}

// ---------- Header search ----------
function Search({ openLoan }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q.trim(), 200);
  const { data } = useApi(dq.length >= 2 ? `/api/search?q=${encodeURIComponent(dq)}` : null);
  const ref = useOutsideClick(useCallback(() => setOpen(false), []));
  const go = (fn) => { setOpen(false); setQ(''); fn(); };
  const groups = data ? [
    ['Loans', data.loans, (x) => [x.loan_ref, `${x.buyer} · ${x.status}`], (x) => openLoan(x.id)],
    ['Invoices', data.invoices, (x) => [x.invoice_number, `${x.buyer_name} · ${x.status}`], (x) => navigate(`/purchase-funding?import=${x.import_id}`)],
    ['Files', data.files, (x) => [x.filename, x.status], (x) => navigate(`/purchase-funding?import=${x.id}`)],
    ['Obligors', data.obligors, (x) => [x.name, `${x.rating} · ${x.deal_name}`], () => navigate('/master-table')],
    ['Programs', data.programs, (x) => [x.deal_name, `${x.program_code} · ${x.deal_code}`], () => navigate('/master-table')],
  ].filter(([, list]) => list?.length) : [];
  return (
    <div className="search" ref={ref}>
      <label className="search-box">
        <Icon name="search" size={16} />
        <input value={q} placeholder="Search" onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} aria-label="Search loans, invoices, files, obligors" />
      </label>
      {open && dq.length >= 2 && (
        <div className="search-results">
          {!data && <div className="loading">Searching…</div>}
          {data && !groups.length && <div className="empty">No matches for “{dq}”</div>}
          {groups.map(([label, list, show, act]) => (
            <div key={label}>
              <div className="grp">{label}</div>
              {list.map((x) => { const [a, b] = show(x); return <button key={label + x.id} onClick={() => go(() => act(x))}><b>{a}</b><span className="muted small">{b}</span></button>; })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Shell ----------
function Shell({ session, onLogout }) {
  const loc = useLocation();
  const investor = session.me.role === 'INVESTOR';
  const routes = investor ? INVESTOR_ROUTES : ROUTES;
  const route = routes.filter((r) => r.path).find((r) => loc.path.startsWith(r.path)) ?? null;
  const [collapsed, setCollapsed] = useState(() => store.get('sg.sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(() => store.get('sg.theme') || 'light');
  const [loanId, setLoanId] = useState(null);
  const { data: dash, reload: reloadBadges } = useApi(investor ? null : `/api/dashboard?b=${loc.path}`);

  useEffect(() => { if (!route) navigate(investor ? '/portal' : '/dashboard', { replace: true }); }, [route, investor]);
  useEffect(() => { document.documentElement.dataset.theme = theme; store.set('sg.theme', theme); }, [theme]);
  useEffect(() => { store.set('sg.sidebar', collapsed ? 'collapsed' : null); }, [collapsed]);
  useEffect(() => { setMobileOpen(false); document.title = `${route?.label ?? 'Seaport Global'} · Seaport Global`; }, [route]);

  const badges = { funding: dash?.kpis.files_awaiting_approval, recon: dash?.kpis.recon_breaks, credit: dash?.kpis.credit_awaiting_decision, cases: dash?.kpis.cases_attention };
  const ctx = useMemo(() => ({ ...session, openLoan: setLoanId, refreshBadges: reloadBadges }), [session, reloadBadges]);
  if (!route) return null;
  const { Page } = route;

  return (
    <SessionContext.Provider value={ctx}>
      <div className={`app ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <Brand collapsed={collapsed} />
            {!collapsed && <button className="icon-btn" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar"><Icon name="left" /></button>}
          </div>
          <nav className="nav">
            {routes.map((r) => r.section ? <div key={r.section} className="nav-section">{r.section}</div> : (
              <a key={r.path} href={r.path} className={route.path === r.path ? 'active' : ''} title={r.label}
                onClick={(e) => { e.preventDefault(); navigate(r.path); }}>
                <Icon name={r.icon} />
                <span className="nav-label">{r.label}</span>
                {r.badge && badges[r.badge] > 0 && <span className={`badge count ${['recon', 'cases'].includes(r.badge) ? '' : 'info'}`}>{badges[r.badge]}</span>}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            <button onClick={onLogout}><Icon name="logout" /><span className="nav-label">Logout</span></button>
            <button className="minimize" onClick={() => setCollapsed((c) => !c)}>
              <Icon name={collapsed ? 'right' : 'left'} size={15} /><span className="nav-label">Minimize sidebar</span>
            </button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <button className="icon-btn" onClick={() => (innerWidth <= 900 ? setMobileOpen((o) => !o) : setCollapsed((c) => !c))} aria-label="Toggle menu"><Icon name="menu" size={20} /></button>
            <div>
              <h1>{route.label}</h1>
              <div className="sub">Manage your project from one place · business date {dateShort(session.today)}</div>
            </div>
            <div className="spacer" />
            {!investor && <Search openLoan={setLoanId} />}
            <button className="icon-btn" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} aria-label="Toggle dark mode" title="Toggle dark mode">
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button className="user-chip" onClick={() => !investor && navigate('/profile')}>
              <span className="avatar">{initials(session.me.name)}</span>
              <span className="who"><b>{session.me.name}</b><span>{session.me.role_label}</span></span>
            </button>
          </header>
          <main className="content">
            <Page key={session.me.username} />
          </main>
        </div>
      </div>
      {loanId && <LoanModal id={loanId} onClose={() => setLoanId(null)} />}
    </SessionContext.Provider>
  );
}

function App() {
  const [username, setUsername] = useState(() => store.get('sg.user'));
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setApiUser(username);
    setSession(null);
    setError(null);
    if (!username) return;
    Promise.all([get('/api/me'), get('/api/health')]).then(([me, health]) => {
      const granted = new Set(me.permissions.filter((p) => p.granted).map((p) => p.key));
      setSession({ me, today: health.today, engine: health.engine, can: (p) => granted.has(p) });
    }, (e) => {
      if (e.status === 401) { store.set('sg.user', null); setUsername(null); } else setError(e);
    });
  }, [username]);

  const login = (u) => { store.set('sg.user', u); setUsername(u); navigate('/'); };
  const logout = () => { store.set('sg.user', null); setUsername(null); };

  if (!username) return <Login onLogin={login} />;
  if (error) return <div className="login"><div className="panel"><ErrorBox error={error} /></div></div>;
  if (!session) return <Loading />;
  return (
    <>
      {session.engine !== 'ok' && <div className="error-box" style={{ borderRadius: 0 }}>The Python analytics engine is not running - file uploads and pricing will fail. Restart with "npm start".</div>}
      <Shell session={session} onLogout={logout} />
    </>
  );
}

try { document.documentElement.dataset.theme = localStorage.getItem('sg.theme') || 'light'; } catch { /* ignore */ }
createRoot(document.getElementById('root')).render(<UiProvider><App /></UiProvider>);
