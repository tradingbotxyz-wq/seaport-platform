// Database schema. Money is always INTEGER minor units (cents/pence) in the program currency.
// Rates are integer basis points. Dates are ISO yyyy-mm-dd; timestamps ISO-8601 UTC.
// Append-only tables (ledger, journal, audit, bank lines once posted) are protected by triggers:
// corrections are made with reversing entries, never UPDATE or DELETE.

import type { Db } from '../lib/db.ts';

const MIGRATIONS: { id: number; name: string; sql: string; foreignKeysOff?: boolean }[] = [
  {
    id: 1,
    name: 'working_capital_initial',
    sql: `
CREATE TABLE users (
  username TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','OPS_MAKER','OPS_CHECKER','CREDIT','TREASURY','VIEWER')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Master Table: programs (deals), their obligors/buyers with limits and pricing, investors, fixings, FX.
CREATE TABLE programs (
  id INTEGER PRIMARY KEY,
  program_code TEXT NOT NULL UNIQUE,            -- PRG-1041
  deal_code TEXT NOT NULL UNIQUE,               -- SG-WC-1041
  deal_name TEXT NOT NULL,                      -- Harborview Foods SCF 2024-1
  client_name TEXT NOT NULL,                    -- anchor / seller
  program_type TEXT NOT NULL CHECK (program_type IN ('SCF','IF','RPA','LC_BACKED','INSURED_AR')),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  rate_basis TEXT NOT NULL,                     -- SOFR / SONIA / ESTR
  day_count TEXT NOT NULL CHECK (day_count IN ('ACT/360','ACT/365')),
  funding_lag_days INTEGER NOT NULL DEFAULT 1 CHECK (funding_lag_days >= 1),
  late_margin_bps INTEGER NOT NULL DEFAULT 300,
  collection_account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at TEXT NOT NULL
);

CREATE TABLE obligors (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  name TEXT NOT NULL,
  rating TEXT NOT NULL,                         -- BBB, BB+, B+ ...
  role TEXT NOT NULL,                           -- Obligor, Subsidiary, Distributor, Insured obligor
  limit_cents INTEGER NOT NULL CHECK (limit_cents >= 0),
  advance_rate_bps INTEGER NOT NULL CHECK (advance_rate_bps BETWEEN 1 AND 10000),
  investor_margin_bps INTEGER NOT NULL CHECK (investor_margin_bps >= 0),
  sp_spread_bps INTEGER NOT NULL CHECK (sp_spread_bps >= 0),
  auto_debit INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (program_id, name)
);

CREATE TABLE investors (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                    -- INV-0001
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE rate_fixings (
  id INTEGER PRIMARY KEY,
  benchmark TEXT NOT NULL,
  fixing_date TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('1-30','31-90','91-180','181+')),
  rate_bps INTEGER NOT NULL,
  UNIQUE (benchmark, fixing_date, bucket)
);

CREATE TABLE fx_rates (
  currency TEXT PRIMARY KEY,
  usd_rate TEXT NOT NULL,                       -- 1 unit of currency in USD (reference only)
  as_of TEXT NOT NULL
);

-- Invoice uploads (Client Onboarding / Purchase & Funding)
CREATE TABLE invoice_imports (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  filename TEXT NOT NULL,
  file_format TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  funding_date TEXT NOT NULL,
  rows_read INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  parse_report TEXT NOT NULL,                   -- JSON: skipped rows + warnings
  status TEXT NOT NULL CHECK (status IN ('UPLOADED','APPROVED','REMOVED')),
  uploaded_by TEXT NOT NULL REFERENCES users(username),
  uploaded_at TEXT NOT NULL,
  approved_by TEXT REFERENCES users(username),
  approved_at TEXT,
  removed_by TEXT,
  removed_reason TEXT
);
CREATE INDEX idx_imports_program ON invoice_imports(program_id);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES invoice_imports(id),
  program_id INTEGER NOT NULL REFERENCES programs(id),
  obligor_id INTEGER REFERENCES obligors(id),
  buyer_name TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT,
  due_date TEXT NOT NULL,
  face_cents INTEGER NOT NULL CHECK (face_cents > 0),
  currency TEXT NOT NULL,
  investor_id INTEGER REFERENCES investors(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','HELD','REJECTED','FUNDED','REMOVED')),
  status_reason TEXT,
  -- pricing frozen at approval
  adv_bps INTEGER, purchase_cents INTEGER, tenor_days INTEGER, bucket TEXT, base_bps INTEGER,
  investor_margin_bps INTEGER, sp_spread_bps INTEGER, all_in_bps INTEGER,
  interest_cents INTEGER, investor_interest_cents INTEGER,
  source_line INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_invoices_import ON invoices(import_id);
CREATE INDEX idx_invoices_obligor ON invoices(obligor_id, status);
-- An invoice number can only be live once per program+buyer (rejected/removed rows may be re-uploaded).
CREATE UNIQUE INDEX uq_live_invoice ON invoices(program_id, buyer_name, invoice_number) WHERE status NOT IN ('REJECTED','REMOVED');

CREATE TABLE loans (
  id INTEGER PRIMARY KEY,
  loan_ref TEXT NOT NULL UNIQUE,                -- L-2026-00418
  invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id),
  import_id INTEGER NOT NULL REFERENCES invoice_imports(id),
  program_id INTEGER NOT NULL REFERENCES programs(id),
  obligor_id INTEGER NOT NULL REFERENCES obligors(id),
  investor_id INTEGER NOT NULL REFERENCES investors(id),
  currency TEXT NOT NULL,
  funding_date TEXT NOT NULL,
  maturity_date TEXT NOT NULL,
  face_cents INTEGER NOT NULL,                  -- amount due at maturity
  purchase_cents INTEGER NOT NULL,              -- finance amount
  interest_cents INTEGER NOT NULL,
  investor_interest_cents INTEGER NOT NULL,
  base_bps INTEGER NOT NULL,
  received_cents INTEGER NOT NULL DEFAULT 0,    -- bank-confirmed only
  status TEXT NOT NULL CHECK (status IN ('OPEN','SETTLED')),
  settled_at TEXT,
  bank_reference TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_loans_status ON loans(status, maturity_date);

-- Settlement advices (Settlement & Repayment): what the client/bank advised. No cash, no approval.
CREATE TABLE settlement_imports (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  filename TEXT NOT NULL,
  file_format TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  settlement_date TEXT NOT NULL,
  rows_read INTEGER NOT NULL,
  matched INTEGER NOT NULL,
  unmatched INTEGER NOT NULL,
  parse_report TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(username),
  uploaded_at TEXT NOT NULL
);

CREATE TABLE settlement_advices (
  id INTEGER PRIMARY KEY,
  settlement_import_id INTEGER NOT NULL REFERENCES settlement_imports(id),
  loan_id INTEGER REFERENCES loans(id),
  loan_ref_raw TEXT,
  invoice_number_raw TEXT,
  amount_cents INTEGER NOT NULL,
  value_date TEXT,
  bank_reference TEXT,
  match_status TEXT NOT NULL CHECK (match_status IN ('MATCHED','UNMATCHED')),
  match_note TEXT
);

-- Reconciliation (bank statements): the only place cash is applied to loans.
CREATE TABLE bank_statements (
  id INTEGER PRIMARY KEY,
  program_id INTEGER REFERENCES programs(id),
  account TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  statement_date TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(username),
  uploaded_at TEXT NOT NULL
);

CREATE TABLE bank_lines (
  id INTEGER PRIMARY KEY,
  statement_id INTEGER NOT NULL REFERENCES bank_statements(id),
  value_date TEXT NOT NULL,
  reference TEXT NOT NULL,
  bank_reference TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  loan_id INTEGER REFERENCES loans(id),
  match_status TEXT NOT NULL CHECK (match_status IN ('MATCHED','AMOUNT_MISMATCH','UNMATCHED','POSTED','RESOLVED')),
  match_note TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  resolved_by TEXT,
  resolved_note TEXT
);

-- Double-entry ledger
CREATE TABLE ledger_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE'))
);

CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  entry_date TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  currency TEXT NOT NULL,
  reverses_id INTEGER UNIQUE REFERENCES journal_entries(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ledger_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_code TEXT NOT NULL REFERENCES ledger_accounts(code),
  program_id INTEGER REFERENCES programs(id),
  loan_id INTEGER REFERENCES loans(id),
  investor_id INTEGER REFERENCES investors(id),
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  CHECK ((debit_cents = 0) <> (credit_cents = 0))
);
CREATE INDEX idx_lines_account ON ledger_lines(account_code, program_id);
CREATE INDEX idx_lines_entry ON ledger_lines(entry_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_outbox_pending ON outbox(published_at) WHERE published_at IS NULL;

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL UNIQUE REFERENCES outbox(id),
  audience TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, actor)
);

CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TRIGGER ledger_lines_no_update BEFORE UPDATE ON ledger_lines BEGIN SELECT RAISE(ABORT, 'ledger_lines are append-only'); END;
CREATE TRIGGER ledger_lines_no_delete BEFORE DELETE ON ledger_lines BEGIN SELECT RAISE(ABORT, 'ledger_lines are append-only'); END;
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal_entries are append-only'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal_entries are append-only'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER loans_no_delete BEFORE DELETE ON loans BEGIN SELECT RAISE(ABORT, 'loans are append-only'); END;
CREATE TRIGGER bank_lines_posted_immutable BEFORE UPDATE ON bank_lines WHEN OLD.match_status = 'POSTED'
  BEGIN SELECT RAISE(ABORT, 'posted bank lines are immutable'); END;

INSERT INTO ledger_accounts (code, name, account_type) VALUES
  ('1000', 'Cash - collection / funding account', 'ASSET'),
  ('1200', 'Purchased receivables', 'ASSET'),
  ('2100', 'Unearned interest (discount)', 'LIABILITY'),
  ('2200', 'Seller reserve payable', 'LIABILITY'),
  ('2300', 'Investor interest payable', 'LIABILITY'),
  ('2400', 'Unapplied cash (suspense)', 'LIABILITY'),
  ('4000', 'Seaport spread income', 'INCOME'),
  ('4100', 'Late payment charges', 'INCOME');
`,
  },
  {
    id: 2,
    name: 'underwrite_documents',
    sql: `
-- Generic document store (uploaded and generated documents for any entity).
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  generated INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_documents_entity ON documents(entity_type, entity_id);
CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT, 'documents are append-only'); END;

-- Versioned, immutable credit scorecard / policy.
CREATE TABLE scorecard_versions (
  version INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER scorecard_no_update BEFORE UPDATE ON scorecard_versions BEGIN SELECT RAISE(ABORT, 'scorecard versions are immutable'); END;
CREATE TRIGGER scorecard_no_delete BEFORE DELETE ON scorecard_versions BEGIN SELECT RAISE(ABORT, 'scorecard versions are immutable'); END;

-- Credit applications: approval of a new obligor, a limit increase or a renewal.
CREATE TABLE credit_applications (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  obligor_id INTEGER REFERENCES obligors(id),
  application_type TEXT NOT NULL CHECK (application_type IN ('NEW','INCREASE','RENEWAL')),
  obligor_name TEXT NOT NULL,
  obligor_role TEXT NOT NULL DEFAULT 'Obligor',
  legal_name TEXT NOT NULL,
  registration_no TEXT,
  country TEXT NOT NULL,
  industry TEXT,
  years_trading INTEGER,
  beneficial_owners TEXT NOT NULL DEFAULT '[]',
  current_limit_cents INTEGER NOT NULL DEFAULT 0,
  requested_limit_cents INTEGER NOT NULL CHECK (requested_limit_cents > 0),
  proposed_adv_bps INTEGER NOT NULL,
  proposed_margin_bps INTEGER NOT NULL,
  proposed_spread_bps INTEGER NOT NULL,
  max_tenor_days INTEGER NOT NULL DEFAULT 120,
  collateral_type TEXT,
  collateral_value_cents INTEGER,
  financials TEXT NOT NULL DEFAULT '[]',
  rationale TEXT,
  screening TEXT,
  bureau TEXT,
  engine TEXT,
  scorecard_version INTEGER REFERENCES scorecard_versions(version),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','IN_REVIEW','REFERRED','APPROVED','DECLINED','WITHDRAWN')),
  decision TEXT CHECK (decision IN ('APPROVE','DECLINE')),
  override INTEGER NOT NULL DEFAULT 0,
  decision_reason TEXT,
  approved_limit_cents INTEGER,
  approved_rating TEXT,
  conditions TEXT,
  review_date TEXT,
  prepared_by TEXT NOT NULL REFERENCES users(username),
  submitted_at TEXT,
  decided_by TEXT REFERENCES users(username),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_credit_apps_status ON credit_applications(status);
`,
  },
  {
    id: 3,
    name: 'roles_and_pools',
    foreignKeysOff: true,
    sql: `
-- Users: roles are validated by the application (the role list grows with modules);
-- columns for sign-in, MFA and the investor portal.
CREATE TABLE users_new (
  username TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  investor_id INTEGER REFERENCES investors(id),
  password_hash TEXT,
  mfa_secret TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO users_new (username, name, email, role, active, created_at) SELECT username, name, email, role, active, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

ALTER TABLE obligors ADD COLUMN country TEXT NOT NULL DEFAULT 'US';
UPDATE obligors SET country = 'DE' WHERE program_id IN (SELECT id FROM programs WHERE currency = 'EUR');
UPDATE obligors SET country = 'GB' WHERE program_id IN (SELECT id FROM programs WHERE currency = 'GBP');
UPDATE obligors SET country = 'CA' WHERE name LIKE '%Canada%';

CREATE TABLE pools (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  strategy TEXT,
  target_size_cents INTEGER NOT NULL CHECK (target_size_cents > 0),
  criteria TEXT NOT NULL,
  limits TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','CLOSED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_by TEXT,
  activated_at TEXT,
  closed_by TEXT,
  closed_at TEXT
);

CREATE TABLE pool_tranches (
  id INTEGER PRIMARY KEY,
  pool_id INTEGER NOT NULL REFERENCES pools(id),
  name TEXT NOT NULL CHECK (name IN ('SENIOR','MEZZANINE','EQUITY')),
  pct_bps INTEGER NOT NULL CHECK (pct_bps BETWEEN 1 AND 10000),
  coupon_bps INTEGER NOT NULL DEFAULT 0,
  UNIQUE (pool_id, name)
);

CREATE TABLE pool_loans (
  id INTEGER PRIMARY KEY,
  pool_id INTEGER NOT NULL REFERENCES pools(id),
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_by TEXT,
  removed_at TEXT
);
CREATE UNIQUE INDEX uq_pool_loan_active ON pool_loans(loan_id) WHERE removed_at IS NULL;
CREATE INDEX idx_pool_loans_pool ON pool_loans(pool_id);

CREATE TABLE stress_runs (
  id INTEGER PRIMARY KEY,
  pool_id INTEGER NOT NULL REFERENCES pools(id),
  inputs TEXT NOT NULL,
  results TEXT NOT NULL,
  run_by TEXT NOT NULL,
  run_at TEXT NOT NULL
);
`,
  },
  {
    id: 4,
    name: 'fund_payments_saga',
    sql: `
INSERT OR IGNORE INTO ledger_accounts (code, name, account_type) VALUES
  ('1100', 'Capital call receivable', 'ASSET'),
  ('2500', 'Seller purchase price payable', 'LIABILITY'),
  ('2600', 'Distributions payable', 'LIABILITY'),
  ('2700', 'Warehouse funding facility', 'LIABILITY'),
  ('3000', 'Investor contributed capital', 'EQUITY');

CREATE TABLE bank_accounts (
  id INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('SEAPORT','PROGRAM','INVESTOR')),
  owner_id INTEGER,
  account_name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  routing_number TEXT,
  account_number TEXT,
  bic TEXT,
  iban TEXT,
  currency TEXT NOT NULL,
  country TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bank_owner ON bank_accounts(owner_type, owner_id, currency);

CREATE TABLE commitments (
  id INTEGER PRIMARY KEY,
  investor_id INTEGER NOT NULL REFERENCES investors(id),
  pool_id INTEGER NOT NULL REFERENCES pools(id),
  tranche TEXT NOT NULL CHECK (tranche IN ('SENIOR','MEZZANINE','EQUITY')),
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  signed_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (investor_id, pool_id, tranche)
);

CREATE TABLE capital_calls (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  pool_id INTEGER NOT NULL REFERENCES pools(id),
  tranche TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  purpose TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ISSUED','SETTLED','CANCELLED')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  issued_at TEXT
);

CREATE TABLE capital_call_lines (
  id INTEGER PRIMARY KEY,
  call_id INTEGER NOT NULL REFERENCES capital_calls(id),
  commitment_id INTEGER NOT NULL REFERENCES commitments(id),
  investor_id INTEGER NOT NULL REFERENCES investors(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  received_cents INTEGER NOT NULL DEFAULT 0,
  received_at TEXT,
  notice_document_id INTEGER REFERENCES documents(id),
  UNIQUE (call_id, commitment_id)
);

CREATE TABLE distributions (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  pool_id INTEGER NOT NULL REFERENCES pools(id),
  tranche TEXT NOT NULL,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CAPITAL','INCOME')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  payment_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','APPROVED','PAID','CANCELLED')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);

CREATE TABLE distribution_lines (
  id INTEGER PRIMARY KEY,
  distribution_id INTEGER NOT NULL REFERENCES distributions(id),
  commitment_id INTEGER NOT NULL REFERENCES commitments(id),
  investor_id INTEGER NOT NULL REFERENCES investors(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);

CREATE TABLE payment_batches (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL,
  rail TEXT NOT NULL CHECK (rail IN ('ACH','FEDWIRE','SWIFT_MT103','PAIN001')),
  value_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','APPROVED','SENT','CANCELLED')),
  file_document_id INTEGER REFERENCES documents(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  sent_by TEXT,
  sent_at TEXT
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER REFERENCES payment_batches(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('FUNDING','DISTRIBUTION','OTHER')),
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  beneficiary_account_id INTEGER REFERENCES bank_accounts(id),
  beneficiary_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENT','LEGACY','CANCELLED')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_payment_source ON payments(source_type, source_id) WHERE status <> 'CANCELLED';

-- Fundings approved before this module existed were paid outside the platform.
INSERT INTO payments (purpose, source_type, source_id, beneficiary_name, amount_cents, currency, reference, status, created_at)
SELECT 'FUNDING', 'invoice_import', f.id, p.client_name,
       (SELECT COALESCE(SUM(purchase_cents - interest_cents), 0) FROM loans WHERE import_id = f.id), p.currency, f.filename, 'LEGACY', f.approved_at
FROM invoice_imports f JOIN programs p ON p.id = f.program_id
WHERE f.status = 'APPROVED' AND (SELECT COUNT(*) FROM loans WHERE import_id = f.id) > 0;

CREATE TABLE saga_runs (
  id INTEGER PRIMARY KEY,
  saga TEXT NOT NULL,
  ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','COMPENSATED','FAILED')),
  steps TEXT NOT NULL,
  error TEXT,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
`,
  },
  {
    id: 5,
    name: 'servicing',
    sql: `
ALTER TABLE loans ADD COLUMN late_fees_posted_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN fees_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN original_maturity_date TEXT;
INSERT OR IGNORE INTO ledger_accounts (code, name, account_type) VALUES
  ('1300', 'Fees and charges receivable', 'ASSET'),
  ('4200', 'Extension and servicing fees', 'INCOME');

CREATE TABLE cases (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  case_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT,
  entity_type TEXT,
  entity_id INTEGER,
  priority TEXT NOT NULL CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status TEXT NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','PENDING_APPROVAL','RESOLVED','REJECTED')),
  assignee TEXT,
  sla_due_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'MANUAL',
  resolution TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_cases_status ON cases(status);
CREATE INDEX idx_cases_entity ON cases(entity_type, entity_id);

CREATE TABLE case_events (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER case_events_no_update BEFORE UPDATE ON case_events BEGIN SELECT RAISE(ABORT, 'case history is append-only'); END;
CREATE TRIGGER case_events_no_delete BEFORE DELETE ON case_events BEGIN SELECT RAISE(ABORT, 'case history is append-only'); END;

CREATE TABLE amendments (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  amendment_type TEXT NOT NULL CHECK (amendment_type IN ('LOAN_EXTENSION','COMMITMENT_TRANSFER','REDEMPTION','RESTRUCTURE')),
  payload TEXT NOT NULL,
  preview TEXT,
  status TEXT NOT NULL CHECK (status IN ('PROPOSED','APPLIED','REJECTED')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  result TEXT
);
`,
  },
  {
    id: 6,
    name: 'reporting',
    sql: `
CREATE TABLE saved_reports (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  owner TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    id: 7,
    name: 'brokerage',
    sql: `
INSERT OR IGNORE INTO ledger_accounts (code, name, account_type) VALUES
  ('1310', 'Brokerage commission receivable', 'ASSET'),
  ('2800', 'Introducer rebates payable', 'LIABILITY'),
  ('4300', 'Brokerage commission income', 'INCOME'),
  ('5100', 'Introducer rebates', 'EXPENSE');

CREATE TABLE brokers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BROKER','INTRODUCER')),
  lei TEXT,
  country TEXT NOT NULL,
  regulator TEXT,
  agreement_date TEXT,
  rebate_bps_of_commission INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','SUSPENDED','REJECTED')),
  kyc_reference TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  notes TEXT
);

CREATE TABLE instruments (
  id INTEGER PRIMARY KEY,
  isin TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('TBILL','CP','BOND','POOL_NOTE')),
  currency TEXT NOT NULL,
  issuer TEXT NOT NULL,
  coupon_bps INTEGER NOT NULL DEFAULT 0,
  maturity_date TEXT NOT NULL,
  spread_bps INTEGER NOT NULL DEFAULT 0,
  settlement_days INTEGER NOT NULL DEFAULT 1,
  restricted INTEGER NOT NULL DEFAULT 0,
  restricted_reason TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  investor_id INTEGER NOT NULL REFERENCES investors(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id),
  introducer_id INTEGER REFERENCES brokers(id),
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  order_type TEXT NOT NULL CHECK (order_type IN ('MARKET','LIMIT')),
  limit_price INTEGER,
  time_in_force TEXT NOT NULL CHECK (time_in_force IN ('DAY','GTC')),
  status TEXT NOT NULL CHECK (status IN ('NEW','REJECTED','FILLED','PARTIALLY_FILLED','NOT_FILLED','CANCELLED')),
  filled_quantity INTEGER NOT NULL DEFAULT 0,
  checks TEXT NOT NULL DEFAULT '[]',
  best_ex TEXT,
  reject_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  settlement_date TEXT NOT NULL,
  principal_cents INTEGER NOT NULL,
  accrued_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  commission_bps INTEGER NOT NULL,
  venue_fee_cents INTEGER NOT NULL,
  rebate_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED','SETTLED','CANCELLED')),
  confirmation_document_id INTEGER REFERENCES documents(id),
  executed_at TEXT NOT NULL,
  settled_by TEXT,
  settled_at TEXT
);
CREATE INDEX idx_trades_order ON trades(order_id);
`,
  },
  {
    id: 8,
    name: 'dashboard history and collections',
    sql: `
-- Month-end utilisation per program (written by the month-end job; history loaded at go-live).
CREATE TABLE utilisation_snapshots (
  month TEXT NOT NULL,                          -- YYYY-MM (month-end position)
  program_id INTEGER NOT NULL REFERENCES programs(id),
  currency TEXT NOT NULL,
  limit_cents INTEGER NOT NULL CHECK (limit_cents >= 0),
  used_cents INTEGER NOT NULL CHECK (used_cents >= 0),
  source TEXT NOT NULL DEFAULT 'MONTH_END_JOB',
  created_at TEXT NOT NULL,
  PRIMARY KEY (month, program_id)
);
CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON utilisation_snapshots BEGIN SELECT RAISE(ABORT, 'snapshots are append-only'); END;

-- Collection actions on past-due loans (reminder, call, dispute, legal, insurance claim...).
CREATE TABLE collection_actions (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  action TEXT NOT NULL,
  note TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_collection_loan ON collection_actions(loan_id, at);
CREATE TRIGGER collection_no_update BEFORE UPDATE ON collection_actions BEGIN SELECT RAISE(ABORT, 'collection history is append-only'); END;
CREATE TRIGGER collection_no_delete BEFORE DELETE ON collection_actions BEGIN SELECT RAISE(ABORT, 'collection history is append-only'); END;
`,
  },
  {
    id: 9,
    name: 'authentication, sessions, approvals and control hardening',
    sql: `
-- Sign-in: passwords (scrypt), TOTP MFA, lockout, forced password change.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
ALTER TABLE users ADD COLUMN mfa_failed INTEGER NOT NULL DEFAULT 0;
-- After an administrator resets someone's credentials, that account cannot approve anything for a cooling-off period.
ALTER TABLE users ADD COLUMN credentials_reset_at TEXT;

-- Server-side sessions. Only a SHA-256 of the session token is stored.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users(username),
  mfa_passed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX idx_sessions_user ON sessions(username, revoked_at);

CREATE TABLE mfa_recovery_codes (
  username TEXT NOT NULL REFERENCES users(username),
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (username, code_hash)
);

-- Audit chain v2: keyed (HMAC) hash that also covers the role. The anchor (keyed) records the last
-- legacy row: every later row must be keyed, so the chain cannot be downgraded without the key.
ALTER TABLE audit_log ADD COLUMN hash_alg TEXT NOT NULL DEFAULT 'sha256';
CREATE TABLE audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), legacy_until INTEGER NOT NULL, mac TEXT NOT NULL);

-- Maker-checker for master data, FX, fixings, bank accounts and user access.
CREATE TABLE change_requests (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  before TEXT,
  reason TEXT,
  requires_role TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPLIED','REJECTED','CANCELLED')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX idx_change_requests ON change_requests(status, kind);

-- Funding: everyone who changed a file's content after upload, and a version for race detection.
ALTER TABLE invoice_imports ADD COLUMN modified_by TEXT NOT NULL DEFAULT '[]';
ALTER TABLE invoice_imports ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
-- Underwriting: everyone who edited or submitted an application.
ALTER TABLE credit_applications ADD COLUMN editors TEXT NOT NULL DEFAULT '[]';
-- Reconciliation: who matched a line by hand.
ALTER TABLE bank_lines ADD COLUMN matched_by TEXT;
-- Fees (late / extension) collected in cash, so account 1300 is cleared when paid.
ALTER TABLE loans ADD COLUMN fees_paid_cents INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_bank_lines_ref ON bank_lines(bank_reference);
`,
  },
];

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    // Table rebuilds need foreign keys off (SQLite cannot toggle this inside a transaction).
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.tx(() => {
        db.exec(m.sql);
        if (m.foreignKeysOff) {
          const broken = db.all('PRAGMA foreign_key_check');
          if (broken.length) throw new Error(`Migration ${m.id} would break foreign keys: ${JSON.stringify(broken.slice(0, 3))}`);
        }
        db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, new Date().toISOString()]);
      });
    } finally {
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}
