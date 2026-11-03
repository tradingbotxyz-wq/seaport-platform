# Seaport Global – Working Capital platform (MVP)

A runnable MVP of the Seaport Global working-capital / receivables-finance platform:

| Layer | Technology | Where |
|---|---|---|
| UI | **React 19** (bundled with esbuild) | `web/src` → built into `public/` |
| API, data, ledger, workflow | **Node.js** (TypeScript, built-in SQLite) | `src/` |
| File parsing, pricing, late charges | **Python** (standard library only) | `engine/` |

No `npm install` or `pip install` is needed to run it. Everything uses built-in Node.js and Python features, and the React UI ships pre-built.

## Requirements

* **Node.js 22.18 or newer** (you have 26 ✔)
* **Python 3.10 or newer**: https://www.python.org/downloads/. On Windows, tick **"Add python.exe to PATH"** in the installer.

Check in a new PowerShell window:

```powershell
node -v
python --version
```

## Run it

**Option A:** double-click `start.bat`.

**Option B:** from PowerShell:

```powershell
cd $HOME\Documents\seaport-platform
npm start
```

Then open **http://localhost:3000**. The first start loads demo data, with dates positioned around today's date. Press `Ctrl+C` to stop.

| Command | What it does |
|---|---|
| `npm start` | Start the Python engine and the Node API + UI on port 3000 |
| `npm run reset` | Delete the database and uploaded files, then reload demo data |
| `npm test` | End-to-end API tests (real Node API + real Python engine) |
| `npm run test:engine` | Python unit tests (pricing, parsing) |
| `npm run build:web` | Rebuild the React UI after editing `web/src` (see below) |

Settings (environment variables): `PORT` (3000), `ENGINE_PORT` (8001), `DB_PATH` (`data/seaport.db`), `BUSINESS_DATE` (override "today", e.g. `2026-09-21`), `PYTHON` (path to python.exe if it is not on PATH).

## Demo users (local sign-in)

Pick a user on the sign-in screen. Each role sees and can do different things, and the API enforces it.

| User | Role | Typical actions |
|---|---|---|
| Seaport Administrator | Admin | Everything; manages users |
| Rabuan | Operations – maker | Uploads invoice and settlement files |
| Priya Nair | Operations – checker | Reviews and **approves funding** (four-eyes vs uploader) |
| Daniel Okafor | Credit | Edits programs, obligors, limits, pricing |
| Meera Shah / Tom Reyes | Treasury | Uploads bank statements / **posts cash** (four-eyes) |
| Internal Audit | Read only | Views everything |

**Try the main flow:** as **Priya**, open *Purchase & Funding*. Select the Harborview batch and note it is *Blocked – limit breach*. Reject INV-88244 (Harborview Retail is at 104% of limit), tag an investor on INV-88232, then **Approve funding**. Next, as **Tom**, open *Reconciliation* and **Post matched cash**. The loans become *Settled* on *Settlement & Repayment*, and the ledger and revenue update.

## Screens

* **Portfolio Dashboard**: utilisation donut, limits / outstanding / pipeline, breach and tight counts, buyer limit vs usage, maturities over the next 7 days, past due.
* **Client Onboarding**: upload invoice files (xlsx, csv, txt, pdf) for a deal; file import list with per-file invoice view.
* **Purchase & Funding**: per-batch KPIs, obligor limit check, invoice pricing (advance, tenor bucket, base + investor margin + SP spread), investor tagging, reject/restore, four-eyes approval → loans + ledger.
* **Settlement & Repayment**: settlement advices (what the client/bank *said*), received / short paid / pending, late charges. These never move cash.
* **Reconciliation**: bank statements are the only place cash is applied. Automatic matching runs on loan ID, then advised bank reference, then invoice number. Manual match and break resolution are available, and posting is four-eyes.
* **Master Table (Programs)**: programs, obligors (limits, advance, margins, auto-debit), benchmark fixings, investors, reference FX.
* **User Access & SoD**: users and roles, the permission matrix, SoD rules with live evidence.
* **Revenue & Fees**: interest booked, investor vs Seaport split, earned/unearned, late-charge accrual, trial balance, journal.
* **Profile**: permissions, notifications, activity, audit-chain verification.

## Key rules built in

* Purchase price = face × advance rate. Interest = purchase × (base + investor margin + SP spread) × tenor ÷ day count (ACT/360 or ACT/365). The benchmark bucket is chosen by tenor (1–30 / 31–90 / 91–180 / 181+). The tests reproduce the prototype figures: USD 3,332,000 purchase price, USD 43,695 interest, 70-day weighted tenor.
* Funding is T+1 business days from upload. Same-day funding is rejected.
* Limit check uses finance amount (purchase price), not face value. Invoices that would breach are **held**, and approval is blocked until they are resolved.
* Duplicate invoices, unknown buyers, currency mismatches and due dates on or before funding are rejected with a reason. Unreadable rows are reported, never silently dropped. The same file (by checksum) cannot be uploaded twice.
* Four-eyes: the funding approver must differ from the uploader, and the cash poster must differ from the statement uploader. Users cannot change their own role.
* Double-entry ledger per currency. The ledger, journal and audit log are **append-only** (database triggers), and the audit log is SHA-256 hash-chained so tampering is detectable.
* Approve / post requests use idempotency keys, so a double click cannot fund twice.

## Project layout

```
engine/            Python analytics engine (HTTP on 127.0.0.1:8001)
  parser.py        csv/txt/xlsx/pdf parsing with header-synonym matching
  pricing.py       purchase pricing and late charges (Decimal, half-up)
  server.py        JSON API used by Node
src/               Node.js API
  core/            schema + migrations, audit chain, outbox/notifications, roles & SoD
  modules/         funding, settlement, recon, ledger, master data, exposure, reports, access
  lib/             HTTP router, SQLite wrapper, validation
  seed.ts          demo data
web/src/           React UI source (pages/, ui.jsx, lib.js, styles.css)
public/            built UI served by Node
test/              end-to-end API tests
data/              local database + uploaded files (created on first run)
```

## Changing the UI

The UI source is in `web/src`. To rebuild after editing:

```powershell
cd web
npm install        # one time: installs React and esbuild into web/node_modules
cd ..
npm run build:web  # or: npm run dev:web  (rebuilds on every save)
```

## Moving to production (AWS)

The code is structured so each local piece maps to a managed service:

* SQLite (`src/lib/db.ts`) → Aurora PostgreSQL (re-implement this one file and adjust SQL dialect in `schema.ts`)
* Python engine → Lambda or ECS service behind a private endpoint (same JSON contracts)
* `data/files` → S3 with Object Lock; audit-log exports to S3
* Outbox dispatcher → EventBridge; notifications → SES/SNS
* Demo sign-in (`X-User` header) → Cognito / Entra ID SSO with the same role model

Still needed for production: real SSO, bank and payment-rail integrations, a holiday calendar per currency, pen-testing and UAT.
