import type { Db } from '../lib/db.ts';
import type { EngineClient } from '../integrations/engine.ts';
import type { KycProvider, BureauProvider } from '../integrations/screening.ts';
import { forbidden } from '../lib/errors.ts';

export type Role = 'ADMIN' | 'OPS_MAKER' | 'OPS_CHECKER' | 'CREDIT' | 'TREASURY' | 'PORTFOLIO' | 'TRADER' | 'COMPLIANCE' | 'INVESTOR' | 'VIEWER';

export const ROLES: { role: Role; label: string }[] = [
  { role: 'ADMIN', label: 'Administrator' },
  { role: 'OPS_MAKER', label: 'Operations - maker' },
  { role: 'OPS_CHECKER', label: 'Operations - checker' },
  { role: 'CREDIT', label: 'Credit' },
  { role: 'TREASURY', label: 'Treasury' },
  { role: 'PORTFOLIO', label: 'Portfolio manager' },
  { role: 'TRADER', label: 'Brokerage - trader' },
  { role: 'COMPLIANCE', label: 'Compliance' },
  { role: 'INVESTOR', label: 'Investor (portal)' },
  { role: 'VIEWER', label: 'Read only' },
];

export interface User {
  username: string;
  name: string;
  role: Role;
}

export interface Services {
  db: Db;
  engine: EngineClient;
  kyc: KycProvider;
  bureau: BureauProvider;
  filesDir: string;
  /** Business date provider; overridable in tests. */
  today: () => string;
}

/** Permission catalogue: the single source of truth for both API checks and the User Access & SoD screen. */
export const PERMISSIONS: Record<string, { label: string; roles: Role[] }> = {
  'invoices.upload': { label: 'Upload invoice files', roles: ['OPS_MAKER'] },
  'invoices.review': { label: 'Recheck / reject / restore invoices, tag investors', roles: ['OPS_MAKER', 'OPS_CHECKER'] },
  'funding.approve': { label: 'Approve funding (checker)', roles: ['OPS_CHECKER'] },
  'settlement.upload': { label: 'Upload settlement advices', roles: ['OPS_MAKER', 'TREASURY'] },
  'recon.upload': { label: 'Upload bank statements', roles: ['TREASURY'] },
  'recon.post': { label: 'Post matched cash / resolve breaks', roles: ['TREASURY'] },
  'master.edit': { label: 'Edit programs, obligors, limits and pricing', roles: ['CREDIT'] },
  'master.rates': { label: 'Maintain benchmark fixings and FX', roles: ['TREASURY', 'CREDIT'] },
  'underwrite.prepare': { label: 'Prepare and submit credit applications', roles: ['CREDIT', 'OPS_MAKER'] },
  'underwrite.decide': { label: 'Decide credit applications within delegated authority', roles: ['CREDIT'] },
  'underwrite.committee': { label: 'Credit committee: above-authority approvals and knock-out overrides', roles: [] },
  'underwrite.policy': { label: 'Publish credit scorecard / policy versions', roles: ['CREDIT'] },
  'pool.manage': { label: 'Create pools, allocate loans, structure tranches', roles: ['PORTFOLIO'] },
  'pool.activate': { label: 'Activate / close pools (checker)', roles: ['PORTFOLIO', 'CREDIT'] },
  'pool.stress': { label: 'Run pool stress tests', roles: ['PORTFOLIO', 'CREDIT'] },
  'fund.commit': { label: 'Record investor commitments', roles: ['PORTFOLIO'] },
  'fund.call': { label: 'Prepare capital calls and distributions', roles: ['PORTFOLIO', 'TREASURY'] },
  'fund.approve': { label: 'Approve and issue capital calls / distributions (checker)', roles: ['TREASURY'] },
  'fund.receive': { label: 'Record capital call receipts', roles: ['TREASURY'] },
  'payments.prepare': { label: 'Prepare disbursement batches', roles: ['TREASURY', 'OPS_MAKER'] },
  'payments.approve': { label: 'Approve disbursement batches and release files (checker)', roles: ['TREASURY'] },
  'payments.accounts': { label: 'Maintain beneficiary bank accounts', roles: ['TREASURY', 'OPS_MAKER'] },
  'service.cases': { label: 'Open and work servicing cases', roles: ['OPS_MAKER', 'OPS_CHECKER', 'TREASURY', 'CREDIT', 'PORTFOLIO', 'COMPLIANCE'] },
  'service.amend': { label: 'Propose amendments (extensions, transfers, redemptions, restructures)', roles: ['OPS_MAKER', 'CREDIT', 'PORTFOLIO'] },
  'service.approve': { label: 'Approve and apply amendments (checker)', roles: ['OPS_CHECKER', 'CREDIT'] },
  'service.fees': { label: 'Post late fees to the ledger', roles: ['TREASURY'] },
  'reports.view': { label: 'Executive dashboards and the report builder', roles: ['OPS_MAKER', 'OPS_CHECKER', 'CREDIT', 'TREASURY', 'PORTFOLIO', 'TRADER', 'COMPLIANCE', 'VIEWER'] },
  'reports.regulatory': { label: 'Regulatory and audit exports', roles: ['COMPLIANCE', 'VIEWER', 'CREDIT'] },
  'portal.statements': { label: 'Generate investor statements and tax summaries', roles: ['PORTFOLIO', 'TREASURY'] },
  'brokerage.trade': { label: 'Enter and route client orders', roles: ['TRADER'] },
  'brokerage.onboard': { label: 'Onboard brokers and introducers', roles: ['TRADER', 'COMPLIANCE'] },
  'brokerage.approve': { label: 'Approve brokers / introducers; manage the restricted list', roles: ['COMPLIANCE'] },
  'brokerage.settle': { label: 'Settle trades (operations)', roles: ['OPS_CHECKER', 'TREASURY'] },
  'users.manage': { label: 'Manage users and roles', roles: [] },
};

/** Segregation-of-duties rules enforced in code (shown on the User Access & SoD screen). */
export const SOD_RULES = [
  { id: 'SOD-1', rule: 'Funding approver must differ from the invoice file uploader (four-eyes).', enforced_in: 'Purchase & Funding' },
  { id: 'SOD-2', rule: 'Settlement advices never move cash or change settled status; only bank-statement matches do.', enforced_in: 'Settlement & Repayment / Reconciliation' },
  { id: 'SOD-3', rule: 'Cash posting from a bank statement must be done by a different user than the statement uploader.', enforced_in: 'Reconciliation' },
  { id: 'SOD-4', rule: 'Users cannot change their own role.', enforced_in: 'User Access & SoD' },
  { id: 'SOD-5', rule: 'Limit and pricing changes are restricted to Credit and are audit-logged with before/after values.', enforced_in: 'Master Table' },
  { id: 'SOD-6', rule: 'A credit application must be decided by a different user than the one who prepared it.', enforced_in: 'Underwriting' },
  { id: 'SOD-8', rule: 'A pool is activated by a different user than the one who built it, and only when no concentration limit is breached.', enforced_in: 'Pools' },
  { id: 'SOD-9', rule: 'Capital calls and distributions are approved by someone other than the preparer.', enforced_in: 'Investors & Capital' },
  { id: 'SOD-10', rule: 'A disbursement batch is approved by someone other than its preparer and other than anyone who changed a beneficiary bank account in it.', enforced_in: 'Disbursements' },
  { id: 'SOD-11', rule: 'Amendments (extensions, transfers, redemptions, restructures) are applied only after approval by someone other than the requester.', enforced_in: 'Servicing' },
  { id: 'SOD-12', rule: 'Brokers and introducers are approved by Compliance, not by the person who onboarded them; trades are settled by operations, not by the trader.', enforced_in: 'Brokerage' },
  { id: 'SOD-7', rule: 'Approvals above delegated authority, and approvals that override an engine knock-out, need the credit committee (administrator).', enforced_in: 'Underwriting' },
];

export function can(user: User, permission: keyof typeof PERMISSIONS | string): boolean {
  if (user.role === 'ADMIN') return true;
  return PERMISSIONS[permission]?.roles.includes(user.role) ?? false;
}

export function requirePermission(user: User, permission: string): void {
  if (!can(user, permission)) throw forbidden(`Your role (${user.role}) cannot: ${PERMISSIONS[permission]?.label ?? permission}`);
}

export const now = () => new Date().toISOString();
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 864e5);
}

/** Add business days (Mon-Fri). Holiday calendars per currency are a later enhancement. */
export function addBusinessDays(iso: string, days: number): string {
  let d = iso;
  let left = days;
  while (left > 0) {
    d = addDays(d, 1);
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

/** Sequential reference, e.g. nextRef(db, 'L-2026', 5) -> L-2026-00418. Call inside a transaction. */
export function nextRef(db: Db, prefix: string, width = 6): string {
  db.run('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', [prefix]);
  const { value } = db.get<{ value: number }>('SELECT value FROM counters WHERE name = ?', [prefix])!;
  return `${prefix}-${String(value).padStart(width, '0')}`;
}
