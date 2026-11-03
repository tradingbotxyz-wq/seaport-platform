# Security and controls

This document has three parts:

1. The security architecture of the Seaport Global platform.
2. The findings of the two independent reviews carried out before go-live, each with its fix and the test that guards it.
3. The residual risks that remain.

Reviews (3 November 2026):

* **Application security review:** OWASP-style, an external reviewer working from the code and a running copy.
* **Financial-controls review:** ledger, segregation of duties, state machines, payment files.

Both reviews were read-only and reproduced their findings against a copy of the system. Everything below was then fixed and re-tested.

---

## 1. Security architecture

### Identity and sessions

| Control | Implementation |
|---|---|
| Passwords | scrypt (N=32768, r=8, p=1, 16-byte salt); constant-time compare; the same cost for unknown users, so timing does not reveal valid usernames |
| Password policy | 12–128 characters; block-list of common passwords; must not contain the username or name; new ≠ current (NIST SP 800-63B style) |
| MFA | TOTP (RFC 6238, verified against the RFC test vectors); secret encrypted with AES-256-GCM under `APP_SECRET`; ±1 step clock drift; each code usable once (replay-proof, even under concurrent requests); 8 single-use recovery codes stored as HMACs |
| MFA policy | Required for every user when `NODE_ENV=production`; enrolment is forced at first sign-in |
| Sessions | Random 256-bit token in an `HttpOnly; SameSite=Strict` cookie (`Secure` and the `__Host-` prefix over HTTPS). Only a SHA-256 of the token is stored server-side. 30-minute idle timeout and 12-hour absolute lifetime, enforced on the server; the browser warns 2 minutes before. The session id rotates after MFA and after a password change |
| Session states | A session that has not completed MFA, MFA enrolment or a forced password change can call only those endpoints |
| Lockout and rate limits | Progressive lockout from 5 failures (1, 2, 4 … up to 30 minutes), counted atomically so parallel attempts are not lost. One generic message for every failure. Per-IP limits on sign-in and on MFA. 5 wrong MFA codes end the session; 10 across sessions lock the account. Usernames typed for unknown accounts are never logged. nginx adds a second limit in front (real client IP behind an ALB) |
| CSRF | SameSite=Strict cookies, plus a required `X-Requested-With` header on every state-changing request (cross-site forms cannot send it), plus an Origin check |
| Administration | Password and MFA resets are **four-eyes**. An admin requests a reset; a second admin or Compliance approves it and alone receives the one-time password. The reset account cannot approve or release anything for 24 hours. All sessions are revoked when credentials change. A CLI (`npm run admin`, needs shell access to the server) handles bootstrap and break-glass |
| Demo mode | `AUTH_MODE=demo` (the user picker) is refused when `NODE_ENV=production` |

### Authorisation and segregation of duties

* Every API route checks a named permission. 10 roles are mapped in `src/core/context.ts`, and the matrix is shown on the *User Access & SoD* screen.
* **Administrators manage access only.** They hold no transactional permissions. They sit on the credit committee for approvals above delegated authority.
* Investor users can reach only the portal, their own documents and their own account settings.
* Stored documents are released by entity type and role. Report exports go only to the person who ran them, or to Compliance or Audit. For anything else the answer is "not found", so document ids cannot be probed.
* **Maker-checker everywhere money is decided.** Twelve SoD rules (SOD-1 … SOD-12) are enforced in the API, with a live evidence report. Since this review they also cover:
  * every editor of a funding file or credit application;
  * people who matched bank lines by hand;
  * changes to reference data, through the **Approvals** workflow: programs, obligors, limits, pricing, FX, fixings, bank details and user access. The requester can never approve. Limits above authority need the committee. FX with no rate fails closed. The record must be unchanged since the request.

### Financial integrity

| Control | Implementation |
|---|---|
| Money | Integer cents and basis points. Every journal is balanced per currency. Corrections are reversing entries |
| Append-only | Database triggers block updates and deletes on the ledger, audit log, documents, case history, scorecards, utilisation snapshots and the collection log |
| Audit chain | Each record is hashed over the previous one with an HMAC keyed by `APP_SECRET`, covering actor, role, action, entity and details. A keyed anchor marks the last legacy (SHA-256) row; any unkeyed row after it fails verification, so the chain cannot be downgraded. Without the key, a valid chain cannot be rebuilt. Only Compliance, Audit and administrators can read the trail |
| Concurrency | Conditional state transitions (`… WHERE status = 'PENDING'`) on approvals, amendments, distributions and batches. The funding approval re-checks a fingerprint of the file, the pricing inputs and the fixings inside the transaction. Late-fee posting re-reads inside the transaction |
| Idempotency | `Idempotency-Key` on money-moving POSTs replays the stored response |
| Duplicates | A bank transaction (reference + amount + value date) can be applied once, whichever statement it arrives on. A file checksum blocks re-uploads |
| Limits | Capital calls cannot exceed commitments, with drafts counted and re-checked at issue. Capital returned cannot exceed net paid-in capital. Income distributions are capped at income the pool has earned. Pool concentration is measured on the actual pool size, and a limit of 0 is enforced |
| Payment files | SWIFT and ISO 20022 fields are reduced to the permitted character sets. Originator IBAN is required. Once a bank file exists, the batch cannot be cancelled and re-filed |

### Data protection

* **Bank details:** full account, IBAN and routing numbers never leave the server. They appear only in bank files and payment notices; screens and the audit log show the last 4 digits.
* **Exports:** CSV and XLSX exports neutralise spreadsheet formulas.
* **Uploads:**
  * filenames are normalised, and the upload size is capped (15 MB);
  * XLSX expansion is capped (60 MB, ratio 200:1) and PDF streams are scanned linearly;
  * amounts must be unambiguous: debit notations are recognised, and ambiguous formats are refused rather than guessed.
* **Responses and errors:**
  * security headers: CSP (`default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`), HSTS over HTTPS, `nosniff`, `DENY` framing, `no-referrer`, COOP/CORP, Permissions-Policy, `no-store`;
  * errors never return SQL or engine internals.

### Platform

* **Python engine:**
  * listens on 127.0.0.1 and requires a shared token on every call;
  * the API reuses an already running engine only if it knows the token;
  * errors are generic to callers.
* **Service hardening (systemd):** non-root user, read-only system, private /tmp, no capabilities, memory and CPU limits, `UMask=0077`.
* **Secrets:**
  * `APP_SECRET` is kept in a root-only env file (or Secrets Manager);
  * backups are root-owned and copied to S3 with KMS.
* **nginx:** HTTPS (certbot or ALB/ACM), rate limits, `server_tokens off`.
* **Docker:** the published port is bound to 127.0.0.1, and the application code is read-only to the app.

---

## 2. Review findings and fixes

C = Critical, H = High, M = Medium, L = Low. "Test" names the regression test (`test/security.test.ts`, `test/api.test.ts`, `engine/tests/test_security.py`).

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | C | Identity taken from an `X-User` header; user list public | Password + MFA sessions; header honoured only in demo mode (refused in production); `/api/users` removed outside demo | *no identity from headers* |
| 2 | H | Credit could set any limit or pricing directly, bypassing underwriting and committee | Master-data changes are change requests approved by a second user; above authority needs the committee | *master table* (api) |
| 3 | H | Concurrent late-fee runs posted fees 2–3 times | Re-read and conditional update inside the transaction | *late fees cannot be posted twice* |
| 4 | H | The same bank transaction could be applied twice via two statements | Duplicate detection at upload; guard at posting; manual matcher cannot post | *a bank transaction is applied once* |
| 5 | H | PDF generator infinite loop on narrow columns | Bounded binary-search truncation; cell length cap | `test_pdf_long_cell_finishes_quickly` |
| 6 | H | XLSX zip bomb / quadratic PDF regex could exhaust the engine | Expansion and ratio caps; linear stream scan; systemd memory and CPU limits | `test_xlsx_zip_bomb_is_refused`, `test_pdf_stream_scan_is_linear` |
| 7 | H | Capital calls could exceed commitments (drafts not counted) | Drafts reserve capacity; per-line re-check at issue | *capital calls and distributions* |
| 8 | H | Distributions uncapped (income) or double-counted (capital) | Capital capped at net paid-in incl. drafts, re-checked at approval; income capped at pool income earned | *capital calls and distributions* |
| 9 | H | Credit could change FX to dodge the committee; a missing FX rate passed | FX moved to Treasury with four-eyes; unknown FX fails closed | *master table* (api) |
| 10 | H | Checker could edit or submit an application, then decide it | Every editor and submitter is recorded and barred from deciding | api underwriting |
| 11 | H | Funding date or tags could change during an approval | Fingerprint of file, pricing and fixings re-checked in the transaction | api funding |
| 12 | H | Pool concentration measured against the target; a 0 limit ignored; breaches on active pools | Measured on actual size; 0 enforced; no breach on active pools; selection trims to fit | `PoolConcentration` |
| 13 | M | Full bank details visible to every staff role | Masked in every response and in audit; full numbers only in bank files | *bank details: masked* |
| 14 | M | Any staff user could download any document | Per-entity, per-role document access | *documents: staff see only…* |
| 15 | M | CSV formula injection | Formula-leading cells prefixed in CSV and XLSX | *documents … CSV* |
| 16 | M | Checker could restore or tag invoices, then approve the file | Content editors barred from approving (SOD-1) | api funding |
| 17 | M | Bank-detail changes without a second check; weak audit | Change requests with four-eyes; masked before/after in the audit; SoD-10 covers requesters and approvers | *bank details* |
| 18 | M | Statement amounts lost their sign (trailing minus, DR, Unicode minus); missing currency defaulted to USD | Strict parser; ambiguous amounts refused; no currency = unmatched | `AmountSigns` |
| 19 | M | App exposed without TLS / gate; Docker bypassed the firewall | HTTPS required (Secure cookies); rate limits; Docker bound to 127.0.0.1 | deploy |
| 20 | M | Approved batch cancel + re-batch = two bank files | Only drafts can be cancelled | *approved payment batches…* |
| 21 | M | Rejected amendment could still be applied (race) | Decision claimed atomically before applying | api servicing |
| 22 | M | Fees in 1300 could never be collected | Cash applied to principal, then fees (Cr 1300); payment of fees alone recognised | api settlement |
| 23 | M | MT103 field injection; empty originator IBAN in pain.001 | SWIFT x-charset; reference token; IBAN required | `PaymentFiles` |
| 24 | M | Commission tiered per venue fill | Tier and minimum per order | api brokerage |
| 25 | M | Commitment transfer moved gross paid-in only | Moves capital (3000) and the receivable (1100); blocked with open drafts | — |
| 26 | L | Stale or future fixings used for pricing; overwrites unaudited | Only fixings on or before the date, within the maximum age; four-eyes with before/after | — |
| 27 | L | Audit hash unkeyed and without role | HMAC-SHA256 keyed by `APP_SECRET`, covering role | *sign-in … audit verify* |
| 28 | L | Sweep / workout without permission; portal cases logged as OPS_MAKER | `service.run` permission; investor recorded as themselves | — |
| 29 | L | Engine trusted any local process; errors leaked | Shared token; generic errors; malformed URLs → 400 | *the Python engine refuses…*, *security headers* |
| 30 | L | Admin could do everything, incl. creating identities without approval | Admin limited to access management + committee; user changes need a second approver | *administrators manage access…* |
| 31 | L | Unsanitised filenames (CR/LF) broke downloads and bank files | Filename normalisation; RFC 6266 Content-Disposition | — |
| 32 | L | Amendment payloads not validated | Typed validation per amendment type | — |
| 33 | L | Invoice-number matching picked an arbitrary loan | Only a unique match counts | — |
| 34 | Info | CSP lacked `base-uri` / `form-action`; no HSTS; backups deletable by the app; Node installed by piping a remote script into bash | Added; root-owned backups; signed apt repository | — |

### Second review: verification of the fixes

A fresh reviewer checked every fix above and attacked the new code. 27 of the 33 fixes were complete. The partial ones and 10 new issues were fixed as follows:

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| N1 | C | One administrator could reset two users' password and MFA, sign in as both and defeat every four-eyes rule | Resets are change requests approved by a second admin or Compliance; the approver, not the requester, receives the one-time password; 24-hour approval cooldown on reset accounts | *sessions … password reset*, *a reset account cannot approve* |
| N2 | H | Changing a program's currency (or reactivating an obligor) avoided the credit committee | Currency is fixed once a program has obligors or invoices; reactivation counts as an increase; authority re-checked at approval | *program currency cannot change* |
| N3 | M | Audit chain could be downgraded to unkeyed hashes | Keyed anchor; unkeyed rows after it fail | *the audit chain cannot be downgraded* |
| N4 | M | Behind an ALB all users shared one rate-limit bucket | `real_ip` settings documented in the nginx config; the app trusts only the last forwarded address | config |
| N5 | M | Lockout counter lost parallel failures; lockout usable to deny service; "locked" message revealed accounts | Atomic counter; progressive lockout; one generic message | *lockout counts parallel failures* |
| N6 | M | No per-account limit on MFA guesses across sessions | Persistent counter; account lock after 10 | — |
| N7 | L-M | New users could get the demo password / one-time passwords printed to logs | Generated passwords only for the built-in demo users when demo data is loaded | — |
| N8 | L | Idempotency cache stored MFA secrets and one-time passwords | Secret-bearing routes are never cached | *sessions … password reset* |
| N9 | L | Approvals, bank accounts and audit trail readable by any staff role | Permission checks on each | *read access: traders cannot…* |
| N10 | L | One admin could deactivate every other approver | Deactivating an approver needs a second approver | — |
| #4 | — | Unreferenced duplicate bank lines (no bank reference) | Flagged as a break for review | — |

---

## 3. Residual risks and next steps

* **Mock integrations:** KYC/AML, credit bureau and market data are simulated. Replace them with real providers before onboarding real clients.
* **Single-server pilot:** SQLite on one EC2 instance. High availability needs the PostgreSQL adapter (Module 8) and the AWS target architecture in the deployment guide.
* **Holiday calendars:** business days are Monday–Friday. Add calendars per currency before live payments.
* **Break-glass CLI:** `npm run admin` resets credentials without a second approver. It needs root shell access to the server, and every use is audited as `cli:<os user>`. Restrict server access (SSM Session Manager, no SSH keys shared) and review these events.
* **Account lockout:** an attacker who knows a username can trigger short lockouts (at most 30 minutes). Monitor `auth.locked` events; administrators can unlock.
* **Independent penetration test:** required before go-live, as is a DR restore test using `APP_SECRET` from Secrets Manager.
* **SSO:** the identity layer can be federated to Cognito or Entra ID, so corporate policies such as joiners/leavers and conditional access apply.
