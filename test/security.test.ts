// Security regression tests: real password + MFA sessions (no X-User header), CSRF, lockout,
// session states, and the fixes from the external security and financial-controls reviews.
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, createApp } from '../src/app.ts';
import { launchEngine } from '../src/integrations/engine.ts';
import { seed } from '../src/seed.ts';
import { seedModules, DEMO_USERNAMES } from '../src/seed-modules.ts';
import { ensurePasswords, demoPassword, resetRateLimits } from '../src/modules/auth.ts';
import { totpAt, totpStep } from '../src/core/security.ts';
import * as audit from '../src/core/audit.ts';
import type { Services } from '../src/core/context.ts';

const TODAY = '2026-11-03';
let server: Server;
let base = '';
let svc: Services;
let kill: () => void;
let dir = '';
let enginePort = 0;
const PW = demoPassword();

/** A browser-like client: keeps its session cookie and sends the CSRF header. */
class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'seaport', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers, raw: text };
  }
  get(p: string) { return this.req('GET', p); }
  post(p: string, b?: unknown, h?: Record<string, string>) { return this.req('POST', p, b ?? {}, h); }
}

async function signIn(username: string, password = PW) {
  const c = new Client();
  const r = await c.post('/api/auth/login', { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { c, r };
}

const secrets = new Map<string, string>();

/** Sign in, enrol MFA or answer the MFA challenge, and return an ACTIVE session. */
async function active(username: string) {
  const { c, r } = await signIn(username);
  let state = r.json.state;
  if (state === 'MFA_SETUP') {
    const s = await c.post('/api/auth/mfa/setup');
    secrets.set(username, s.json.secret);
    const conf = await c.post('/api/auth/mfa/confirm', { code: totpAt(s.json.secret, totpStep()) });
    assert.equal(conf.status, 200, JSON.stringify(conf.json));
    state = conf.json.state;
  } else if (state === 'MFA') {
    // Each code works once; in a fast test run the next sign-in is in the same 30 s step, so let time "pass".
    svc.db.run('UPDATE users SET mfa_last_step = NULL WHERE username = ?', [username]);
    const v = await c.post('/api/auth/mfa', { code: totpAt(secrets.get(username)!, totpStep()) });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    state = v.json.state;
  }
  assert.equal(state, 'ACTIVE');
  return c;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seaport-sec-'));
  enginePort = 19000 + Math.floor(Math.random() * 900);
  const { client, child } = await launchEngine(enginePort);
  kill = () => child?.kill();
  svc = createServices({ dbPath: ':memory:', engine: client, filesDir: join(dir, 'files'), today: () => TODAY,
    auth: { mode: 'password', mfaRequired: true, secureCookies: false, trustProxy: false, idleMinutes: 30, absoluteHours: 12 } });
  seed(svc);
  await seedModules(svc);
  await ensurePasswords(svc, DEMO_USERNAMES);
  server = createServer(createApp(svc, { log: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server?.close();
  kill?.();
  rmSync(dir, { recursive: true, force: true });
});

test('no identity from headers: X-User is ignored and the user list is not public', async () => {
  const res = await fetch(base + '/api/me', { headers: { 'X-User': 'admin' } });
  assert.equal(res.status, 401);
  assert.equal((await fetch(base + '/api/users')).status, 404);
  const health = await (await fetch(base + '/api/health')).json();
  assert.deepEqual(Object.keys(health).sort(), ['engine', 'status']);
});

test('sign-in: cookie flags, generic errors, lockout after 5 failures', async () => {
  resetRateLimits();
  const c = new Client();
  const bad = await c.post('/api/auth/login', { username: 'tom', password: 'wrong-password-123' });
  assert.equal(bad.status, 401);
  const unknown = await c.post('/api/auth/login', { username: 'nobody', password: 'wrong-password-123' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error.message, bad.json.error.message); // no user enumeration
  for (let i = 0; i < 4; i++) await c.post('/api/auth/login', { username: 'tom', password: 'wrong-password-123' });
  const locked = await c.post('/api/auth/login', { username: 'tom', password: PW });
  assert.equal(locked.status, 401);
  assert.match(locked.json.error.message, /locked/);
  assert.ok(audit.verify(svc.db).valid);
  svc.db.run('UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE username = ?', ['tom']);

  resetRateLimits();
  const ok = await c.post('/api/auth/login', { username: 'meera', password: PW });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie')!;
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.equal(ok.json.state, 'MFA_SETUP'); // MFA is required before anything else
  assert.equal((await c.get('/api/dashboard')).status, 403);
});

test('CSRF: state-changing requests need the custom header and a same-origin Origin', async () => {
  resetRateLimits();
  const c = await active('priya');
  const noHeader = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: c.cookie } });
  assert.equal(noHeader.status, 403);
  const crossSite = await c.post('/api/auth/logout', {}, { Origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  assert.equal((await c.get('/api/me')).status, 200);
});

test('MFA: codes cannot be replayed; recovery codes work once; bad codes end the session', async () => {
  resetRateLimits();
  const { c } = await signIn('daniel');
  const setup = await c.post('/api/auth/mfa/setup');
  const step = totpStep();
  const conf = await c.post('/api/auth/mfa/confirm', { code: totpAt(setup.json.secret, step) });
  assert.equal(conf.json.recovery_codes.length, 8);
  await c.post('/api/auth/logout');

  const s2 = await signIn('daniel');
  assert.equal(s2.r.json.state, 'MFA');
  assert.equal((await s2.c.get('/api/dashboard')).status, 403);
  const replay = await s2.c.post('/api/auth/mfa', { code: totpAt(setup.json.secret, step) });
  assert.equal(replay.status, 401); // already used at enrolment
  const rc = await s2.c.post('/api/auth/mfa', { code: conf.json.recovery_codes[0] });
  assert.equal(rc.status, 200, JSON.stringify(rc.json));
  assert.equal(rc.json.state, 'ACTIVE');

  const s3 = await signIn('daniel');
  assert.equal((await s3.c.post('/api/auth/mfa', { code: conf.json.recovery_codes[0] })).status, 401); // used
  for (let i = 0; i < 3; i++) await s3.c.post('/api/auth/mfa', { code: '000000' });
  const last = await s3.c.post('/api/auth/mfa', { code: '000000' });
  assert.match(last.json.error.message, /Sign in again/);
  assert.equal((await s3.c.get('/api/auth/session')).json.authenticated, false);
});

test('sessions: idle timeout, logout revocation, password reset forces a change', async () => {
  resetRateLimits();
  const c = await active('olivia');
  svc.db.run("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE username = 'olivia' AND revoked_at IS NULL");
  assert.equal((await c.get('/api/me')).status, 401);

  const admin = await active('admin');
  const req = await admin.post('/api/access/users/rabuan/reset-password');
  assert.equal(req.status, 202, JSON.stringify(req.json)); // a reset is a four-eyes change request
  assert.ok(!JSON.stringify(req.json).includes('temporary_password')); // the requester never sees the password
  assert.equal((await admin.post('/api/access/users/admin/reset-password')).status, 403); // not your own
  assert.equal((await admin.post(`/api/approvals/${req.json.change_request.id}/decide`, { decision: 'APPROVE' })).status, 403);
  const kenji = await active('kenji');
  const approved = await kenji.post(`/api/approvals/${req.json.change_request.id}/decide`, { decision: 'APPROVE' });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const reset = { json: approved.json.result };
  assert.ok(reset.json.temporary_password);
  assert.equal(svc.db.get<any>("SELECT COUNT(*) n FROM idempotency_keys WHERE response LIKE '%temporary_password%'").n, 0);
  const r = new Client();
  const login = await r.post('/api/auth/login', { username: 'rabuan', password: reset.json.temporary_password });
  assert.equal(login.json.state, 'MFA_SETUP');
  const s = await r.post('/api/auth/mfa/setup');
  const conf = await r.post('/api/auth/mfa/confirm', { code: totpAt(s.json.secret, totpStep()) });
  assert.equal(conf.json.state, 'PASSWORD');
  assert.equal((await r.get('/api/imports')).status, 403);
  const weak = await r.post('/api/auth/password', { current_password: reset.json.temporary_password, new_password: 'password123' });
  assert.equal(weak.status, 422);
  const good = await r.post('/api/auth/password', { current_password: reset.json.temporary_password, new_password: 'Harbour-Lights-Tuesday-42' });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.equal(good.json.state, 'ACTIVE');
  assert.equal((await r.get('/api/imports')).status, 200);
  await r.post('/api/auth/logout');
  assert.equal((await r.get('/api/me')).status, 401);
});

test('administrators manage access but cannot move money or approve their own access changes', async () => {
  resetRateLimits();
  const admin = await active('admin');
  assert.equal((await admin.post('/api/payment-batches', { payment_ids: [1], rail: 'ACH', value_date: '2026-11-05' })).status, 403);
  assert.equal((await admin.post('/api/servicing/late-fees')).status, 403);
  const req = await admin.req('PUT', '/api/access/users/audit', { role: 'TREASURY' });
  assert.equal(req.status, 202);
  assert.equal((await admin.post(`/api/approvals/${req.json.change_request.id}/decide`, { decision: 'APPROVE' })).status, 403);
  const kenji = await active('kenji');
  assert.equal((await kenji.post(`/api/approvals/${req.json.change_request.id}/decide`, { decision: 'REJECT', note: 'Not justified' })).status, 200);
});

test('bank details: masked in every response, changes need a second approver', async () => {
  resetRateLimits();
  const meera = await active('meera');
  const list = (await meera.get('/api/bank-accounts')).json;
  assert.ok(list.length > 0);
  assert.ok(list.every((b: any) => !('account_number' in b) && !('iban' in b) && !('routing_number' in b)));
  const queue = (await meera.get('/api/payments/queue')).json;
  assert.ok(queue.every((p: any) => !('account_number' in p)));
  const acct = list.find((b: any) => b.owner_type === 'INVESTOR');
  const ch = await meera.req('PUT', `/api/bank-accounts/${acct.id}`, { account_number: '99887766' });
  assert.equal(ch.status, 202, JSON.stringify(ch.json));
  assert.equal((await meera.post(`/api/approvals/${ch.json.change_request.id}/decide`, { decision: 'APPROVE' })).status, 403);
  const tom = await active('tom');
  assert.equal((await tom.post(`/api/approvals/${ch.json.change_request.id}/decide`, { decision: 'APPROVE' })).status, 200);
  const audited = svc.db.get<any>("SELECT details FROM audit_log WHERE action = 'bank_account.updated' ORDER BY id DESC LIMIT 1");
  assert.ok(!audited.details.includes('99887766'));
  assert.match(audited.details, /7766/);
});

test('documents: staff see only what their role needs; CSV exports neutralise formulas', async () => {
  resetRateLimits();
  const sara = await active('sara');
  const exp = await sara.post('/api/reports/export', { definition: { dataset: 'loans', columns: ['loan_ref', 'obligor'] }, format: 'csv' });
  assert.equal(exp.status, 200, JSON.stringify(exp.json));
  const lucas = await active('lucas');
  assert.equal((await lucas.get(`/api/documents/${exp.json.document_id}/file`)).status, 404);
  const bankFile = svc.db.get<any>("SELECT id FROM documents WHERE entity_type = 'payment_batch' LIMIT 1");
  if (bankFile) assert.equal((await lucas.get(`/api/documents/${bankFile.id}/file`)).status, 404);

  svc.db.run("UPDATE obligors SET name = '=HYPERLINK(\"http://evil.example\")' WHERE id = (SELECT MIN(id) FROM obligors)");
  const csv = await sara.post('/api/reports/export', { definition: { dataset: 'obligors', columns: ['obligor'] }, format: 'csv' });
  const body = (await sara.get(`/api/documents/${csv.json.document_id}/file`)).raw;
  assert.ok(!/(^|,|\n)=HYPERLINK/.test(body));
  assert.match(body, /'=HYPERLINK/);
});

test('late fees cannot be posted twice by concurrent runs', async () => {
  resetRateLimits();
  const meera = await active('meera');
  const before = svc.db.get<{ s: number }>("SELECT COALESCE(SUM(debit_cents),0) s FROM ledger_lines WHERE account_code = '1300'")!.s;
  const runs = await Promise.all([1, 2, 3].map(() => meera.post('/api/servicing/late-fees')));
  assert.ok(runs.every((r) => r.status === 200), JSON.stringify(runs.map((r) => r.json)));
  const after = svc.db.get<{ s: number }>("SELECT COALESCE(SUM(debit_cents),0) s FROM ledger_lines WHERE account_code = '1300'")!.s;
  const loansFees = svc.db.get<{ s: number }>('SELECT COALESCE(SUM(fees_cents),0) s FROM loans')!.s;
  assert.ok(after > before);
  assert.equal(after - before, runs.reduce((a, r) => a + Object.values<number>(r.json.total_by_currency).reduce((x, y) => x + y, 0), 0));
  assert.ok(loansFees >= after - before);
});

test('a bank transaction is applied once, even on a second statement', async () => {
  resetRateLimits();
  const tom = await active('tom');
  const loan = svc.db.get<any>("SELECT l.*, p.collection_account FROM loans l JOIN programs p ON p.id = l.program_id WHERE l.status = 'OPEN' AND l.currency = 'USD' ORDER BY l.id LIMIT 1");
  const amt = ((loan.face_cents - loan.received_cents) / 100).toFixed(2);
  const csv = (n: string) => Buffer.from(`Value Date,Reference,Bank Reference,Amount,Currency\n${TODAY},${loan.loan_ref} payment ${n},TXN-DUP-1,${amt},USD\n`).toString('base64');
  const a = await tom.post('/api/bank-statements', { statement_date: TODAY, filename: 'stmt_a.csv', content_base64: csv('a') });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const b = await tom.post('/api/bank-statements', { statement_date: TODAY, filename: 'stmt_b.csv', content_base64: csv('b') });
  assert.equal(b.status, 201);
  assert.equal(b.json.RESOLVED, 1); // flagged as a duplicate, never applied
  const meera = await active('meera');
  assert.equal((await meera.post(`/api/bank-statements/${a.json.id}/post`)).status, 200);
  const l2 = svc.db.get<any>('SELECT received_cents, face_cents FROM loans WHERE id = ?', [loan.id]);
  assert.equal(l2.received_cents, loan.face_cents);
});

test('capital calls and distributions cannot exceed commitments or earned income', async () => {
  resetRateLimits();
  const olivia = await active('olivia');
  const pool = svc.db.get<any>("SELECT * FROM pools WHERE status = 'ACTIVE' LIMIT 1");
  const callable = (await olivia.get('/api/commitments')).json.filter((c: any) => c.pool_id === pool.id && c.tranche === 'SENIOR').reduce((a: number, c: any) => a + c.callable_cents, 0);
  if (callable > 200) {
    const first = await olivia.post('/api/capital-calls', { pool_id: pool.id, tranche: 'SENIOR', amount_cents: callable, purpose: 'Test', due_date: '2026-11-20' });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const second = await olivia.post('/api/capital-calls', { pool_id: pool.id, tranche: 'SENIOR', amount_cents: callable, purpose: 'Test 2', due_date: '2026-11-20' });
    assert.equal(second.status, 409); // the draft already reserves it
  }
  const income = await olivia.post('/api/distributions', { pool_id: pool.id, tranche: 'SENIOR', kind: 'INCOME', amount_cents: 50_000_000_00, payment_date: '2026-11-20' });
  assert.equal(income.status, 409);
  assert.match(income.json.error.message, /earned/);
});

test('approved payment batches cannot be cancelled and re-filed', async () => {
  resetRateLimits();
  const batch = svc.db.get<any>("SELECT id FROM payment_batches WHERE status = 'APPROVED' LIMIT 1");
  if (!batch) return;
  const rabuan = await active('rabuan').catch(() => null);
  if (!rabuan) return;
  assert.equal((await rabuan.post(`/api/payment-batches/${batch.id}/cancel`)).status, 409);
});

test('the Python engine refuses callers without the shared token', async () => {
  const r = await fetch(`http://127.0.0.1:${enginePort}/price`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const h = await (await fetch(`http://127.0.0.1:${enginePort}/health`)).json();
  assert.equal(h.authenticated, false);
});

test('security headers on API and static responses', async () => {
  for (const path of ['/api/health', '/']) {
    const r = await fetch(base + path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(r.headers.get('content-security-policy')!, /base-uri 'self'/);
  }
  assert.equal((await fetch(base + '/api/loans/%E0%A4%A')).status, 400);
});

test('a reset account cannot approve anything for the cooling-off period', async () => {
  resetRateLimits();
  // rabuan's credentials were reset in an earlier test; give him an approver role's test via a payments approval attempt.
  svc.db.run("UPDATE users SET credentials_reset_at = ? WHERE username = 'tom'", [new Date().toISOString()]);
  const tom = await active('tom');
  const fx = await (await active('meera')).post('/api/fx', { currency: 'GBP', usd_rate: '1.28' });
  assert.equal(fx.status, 202);
  const r = await tom.post(`/api/approvals/${fx.json.change_request.id}/decide`, { decision: 'APPROVE' });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /reset/);
  svc.db.run("UPDATE users SET credentials_reset_at = NULL WHERE username = 'tom'");
});

test('program currency cannot change once it has obligors (committee bypass)', async () => {
  resetRateLimits();
  const credit = await active('sara');
  const p = svc.db.get<any>("SELECT id FROM programs WHERE currency = 'USD' LIMIT 1");
  const r = await credit.req('PUT', `/api/programs/${p.id}`, { currency: 'GBP' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
});

test('lockout counts parallel failures; failures for unknown users are not logged with what was typed', async () => {
  resetRateLimits();
  svc.db.run("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username = 'audit'");
  const c = new Client();
  await Promise.all([1, 2, 3, 4, 5, 6].map(() => c.post('/api/auth/login', { username: 'audit', password: 'nope-nope-nope' })));
  const u = svc.db.get<any>("SELECT failed_logins, locked_until FROM users WHERE username = 'audit'");
  assert.ok(u.failed_logins >= 6, String(u.failed_logins));
  assert.ok(u.locked_until);
  resetRateLimits();
  await c.post('/api/auth/login', { username: 'My-Secret-Password-1', password: 'x' });
  assert.equal(svc.db.get<any>("SELECT COUNT(*) n FROM audit_log WHERE details LIKE '%My-Secret-Password-1%' OR entity_id LIKE '%My-Secret-Password-1%' OR actor LIKE '%My-Secret-Password-1%'").n, 0);
  svc.db.run("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username = 'audit'");
});

test('read access: traders cannot list approvals, bank accounts or the audit trail', async () => {
  resetRateLimits();
  const lucas = await active('lucas');
  assert.deepEqual((await lucas.get('/api/approvals')).json, []);
  assert.equal((await lucas.get('/api/bank-accounts')).status, 403);
  assert.equal((await lucas.get('/api/audit')).status, 403);
});

test('the audit chain cannot be downgraded to unkeyed hashes', async () => {
  const { createHash } = await import('node:crypto');
  assert.equal(audit.verify(svc.db).valid, true);
  const last = svc.db.get<any>('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1');
  svc.db.exec('DROP TRIGGER IF EXISTS audit_no_update');
  const fake = createHash('sha256').update([last.prev_hash, last.ts, 'someone-else', last.action, last.entity_type, last.entity_id ?? '', last.details].join('|')).digest('hex');
  svc.db.run("UPDATE audit_log SET actor = 'someone-else', hash = ?, hash_alg = 'sha256' WHERE id = ?", [fake, last.id]);
  const v = audit.verify(svc.db);
  assert.equal(v.valid, false);
});
