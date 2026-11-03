import { Router } from './lib/http.ts';
import { intParam } from './lib/validate.ts';
import { notFound, forbidden } from './lib/errors.ts';
import * as audit from './core/audit.ts';
import { can, PERMISSIONS } from './core/context.ts';
import * as master from './modules/master.ts';
import * as funding from './modules/funding.ts';
import * as settlement from './modules/settlement.ts';
import * as recon from './modules/recon.ts';
import * as reports from './modules/reports.ts';
import * as access from './modules/access.ts';
import * as ledger from './modules/ledger.ts';
import * as uw from './modules/underwrite.ts';
import * as docs from './modules/documents.ts';
import * as pools from './modules/pool.ts';
import * as fund from './modules/fund.ts';
import * as service from './modules/service.ts';
import * as reporting from './modules/reporting.ts';
import * as portal from './modules/portal.ts';
import * as brokerage from './modules/brokerage.ts';
import * as dash from './modules/dashboard.ts';
import * as auth from './modules/auth.ts';
import * as approvals from './modules/approvals.ts';
import { notFound as nf } from './lib/errors.ts';
import { requirePermission } from './core/context.ts';

export function buildRouter(): Router {
  const r = new Router();

  // Public: health (load balancers) and authentication
  r.get('/api/health', async ({ services }) => ({
    status: 'ok', engine: (await services.engine.health()) ? 'ok' : 'down',
  }), { public: true });
  r.get('/api/auth/config', ({ services }) => auth.config(services), { public: true });
  r.get('/api/auth/session', ({ services, user, session }) => auth.session(services, user, session), { public: true });
  r.post('/api/auth/login', ({ services, req, body }) => auth.login(services, req, body), { public: true });
  r.post('/api/auth/logout', ({ services, user, session }) => auth.logout(services, user, session), { public: true });
  r.post('/api/auth/mfa', ({ services, req, user, session, body }) => auth.verifyMfa(services, req, user, session!, body));
  r.post('/api/auth/mfa/setup', ({ services, user, session }) => auth.setupMfa(services, user, session));
  r.post('/api/auth/mfa/confirm', ({ services, req, user, session, body }) => auth.confirmMfa(services, req, user, session, body));
  r.post('/api/auth/password', ({ services, req, user, session, body }) => auth.changePassword(services, req, user, session, body));
  r.get('/api/auth/sessions', ({ services, user, session }) => auth.listSessions(services, user, session));
  r.post('/api/auth/sessions/:id/revoke', ({ services, user, params }) => auth.revokeSession(services, user, params.id));
  // Demo mode only: the sign-in user picker. Never available with password sign-in.
  r.get('/api/users', ({ services }) => {
    if (services.auth.mode !== 'demo') throw nf('Route');
    return access.listUsersPublic(services);
  }, { public: true });

  // Session
  r.get('/api/me', ({ services, user }) => access.profile(services, user));
  r.get('/api/search', ({ services, query }) => reports.search(services, (query.get('q') ?? '').trim().slice(0, 60)));

  // Portfolio Dashboard
  r.get('/api/dashboard', ({ services, query }) => dash.dashboard(services, query));

  // Master Table (Programs)
  r.get('/api/programs', ({ services }) => master.listPrograms(services));
  r.post('/api/programs', ({ services, user, body }) => master.createProgram(services, user, body));
  r.get('/api/programs/:id', ({ services, params }) => master.getProgram(services, intParam(params.id)));
  r.put('/api/programs/:id', ({ services, user, params, body }) => master.updateProgram(services, user, intParam(params.id), body));
  r.post('/api/programs/:id/obligors', ({ services, user, params, body }) => master.createObligor(services, user, intParam(params.id), body));
  r.put('/api/obligors/:id', ({ services, user, params, body }) => master.updateObligor(services, user, intParam(params.id), body));
  r.get('/api/investors', ({ services }) => master.listInvestors(services));
  r.post('/api/investors', ({ services, user, body }) => master.createInvestor(services, user, body));
  r.get('/api/fixings', ({ services }) => master.listFixings(services));
  r.post('/api/fixings', ({ services, user, body }) => master.addFixing(services, user, body));
  r.get('/api/fx', ({ services }) => master.listFx(services));
  r.post('/api/fx', ({ services, user, body }) => master.setFx(services, user, body));

  // Underwriting
  r.get('/api/underwriting', ({ services, query }) => uw.listApplications(services, query));
  r.get('/api/underwriting/summary', ({ services }) => uw.underwritingSummary(services));
  r.get('/api/underwriting/scorecard', ({ services }) => ({ current: uw.currentScorecard(services), history: uw.scorecardHistory(services) }));
  r.post('/api/underwriting/scorecard', ({ services, user, body }) => uw.publishScorecard(services, user, body));
  r.post('/api/underwriting', ({ services, user, body }) => uw.createApplication(services, user, body));
  r.get('/api/underwriting/:id', ({ services, user, params }) => uw.getApplication(services, user, intParam(params.id)));
  r.put('/api/underwriting/:id', ({ services, user, params, body }) => uw.updateApplication(services, user, intParam(params.id), body));
  r.post('/api/underwriting/:id/submit', ({ services, user, params }) => uw.submitApplication(services, user, intParam(params.id)));
  r.post('/api/underwriting/:id/rescore', ({ services, user, params }) => uw.submitApplication(services, user, intParam(params.id), true));
  r.post('/api/underwriting/:id/return', ({ services, user, params, body }) => uw.returnToDraft(services, user, intParam(params.id), body));
  r.post('/api/underwriting/:id/withdraw', ({ services, user, params, body }) => uw.withdrawApplication(services, user, intParam(params.id), body));
  r.post('/api/underwriting/:id/decide', ({ services, user, params, body }) => uw.decide(services, user, intParam(params.id), body));
  r.post('/api/underwriting/:id/memo', ({ services, user, params }) => uw.regenerateMemo(services, user, intParam(params.id)));

  // Pools
  r.get('/api/pools', ({ services }) => pools.listPools(services));
  r.post('/api/pools', ({ services, user, body }) => pools.createPool(services, user, body));
  r.get('/api/pools/:id', ({ services, params }) => pools.getPool(services, intParam(params.id)));
  r.put('/api/pools/:id', ({ services, user, params, body }) => pools.updatePool(services, user, intParam(params.id), body));
  r.get('/api/pools/:id/eligible', ({ services, params }) => pools.eligibleLoans(services, intParam(params.id)));
  r.post('/api/pools/:id/loans', ({ services, user, params, body }) => pools.addLoans(services, user, intParam(params.id), body));
  r.post('/api/pools/:id/remove-loans', ({ services, user, params, body }) => pools.removeLoans(services, user, intParam(params.id), body));
  r.post('/api/pools/:id/auto-build', ({ services, user, params, body }) => pools.autoBuild(services, user, intParam(params.id), !!body?.apply));
  r.post('/api/pools/:id/activate', ({ services, user, params }) => pools.activate(services, user, intParam(params.id)));
  r.post('/api/pools/:id/close', ({ services, user, params, body }) => pools.closePool(services, user, intParam(params.id), body));
  r.post('/api/pools/:id/stress', ({ services, user, params, body }) => pools.stressTest(services, user, intParam(params.id), body));

  // Fund: investors, commitments, capital calls, distributions, payments, liquidity
  r.get('/api/commitments', ({ services, query }) => fund.listCommitments(services, query));
  r.post('/api/commitments', ({ services, user, body }) => fund.createCommitment(services, user, body));
  r.get('/api/capital-calls', ({ services }) => fund.listCalls(services));
  r.post('/api/capital-calls', ({ services, user, body }) => fund.createCall(services, user, body));
  r.get('/api/capital-calls/:id', ({ services, params }) => fund.getCall(services, intParam(params.id)));
  r.post('/api/capital-calls/:id/issue', ({ services, user, params }) => fund.issueCall(services, user, intParam(params.id)));
  r.post('/api/capital-calls/:id/receipt', ({ services, user, params, body }) => fund.recordReceipt(services, user, intParam(params.id), body));
  r.post('/api/capital-calls/:id/cancel', ({ services, user, params }) => fund.cancelCall(services, user, intParam(params.id)));
  r.get('/api/distributions', ({ services }) => fund.listDistributions(services));
  r.post('/api/distributions', ({ services, user, body }) => fund.createDistribution(services, user, body));
  r.post('/api/distributions/:id/approve', ({ services, user, params }) => fund.approveDistribution(services, user, intParam(params.id)));
  r.get('/api/bank-accounts', ({ services, user }) => {
    if (!['payments.view', 'payments.accounts', 'payments.accounts.approve', 'payments.prepare', 'payments.approve'].some((p) => can(user, p))) throw forbidden('Your role cannot see bank accounts');
    return fund.listBankAccounts(services);
  });
  r.post('/api/bank-accounts', ({ services, user, body }) => fund.saveBankAccount(services, user, null, body));
  r.put('/api/bank-accounts/:id', ({ services, user, params, body }) => fund.saveBankAccount(services, user, intParam(params.id), body));
  r.get('/api/payments/queue', ({ services }) => fund.paymentQueue(services));
  r.get('/api/payment-batches', ({ services }) => fund.listBatches(services));
  r.post('/api/payment-batches', ({ services, user, body }) => fund.createBatch(services, user, body));
  r.get('/api/payment-batches/:id', ({ services, params }) => fund.getBatch(services, intParam(params.id)));
  r.get('/api/payment-batches/:id/preview', ({ services, params }) => fund.previewBatch(services, intParam(params.id)));
  r.post('/api/payment-batches/:id/approve', ({ services, user, params }) => fund.approveBatch(services, user, intParam(params.id)));
  r.post('/api/payment-batches/:id/release', ({ services, user, params }) => fund.releaseBatch(services, user, intParam(params.id)));
  r.post('/api/payment-batches/:id/cancel', ({ services, user, params }) => fund.cancelBatch(services, user, intParam(params.id)));
  r.get('/api/liquidity', ({ services }) => fund.liquidity(services));

  // Servicing
  r.get('/api/servicing/summary', ({ services }) => service.serviceSummary(services));
  r.get('/api/servicing/delinquency', ({ services }) => service.delinquency(services));
  r.post('/api/servicing/sweep', ({ services, user }) => { requirePermission(user, 'service.run'); return service.sweep(services); });
  r.post('/api/servicing/late-fees', ({ services, user }) => service.postLateFees(services, user));
  r.post('/api/servicing/workout', ({ services, user, body }) => { requirePermission(user, 'service.run'); return service.workout(services, body); });
  r.get('/api/servicing/loans/:id', ({ services, params }) => service.loanSubledger(services, intParam(params.id)));
  r.get('/api/cases', ({ services, user, query }) => service.listCases(services, user, query));
  r.post('/api/cases', ({ services, user, body }) => service.createCase(services, user, body));
  r.get('/api/cases/:id', ({ services, user, params }) => service.getCase(services, user, intParam(params.id)));
  r.put('/api/cases/:id', ({ services, user, params, body }) => service.updateCase(services, user, intParam(params.id), body));
  r.post('/api/cases/:id/amendments', ({ services, user, params, body }) => service.proposeAmendment(services, user, intParam(params.id), body));
  r.post('/api/amendments/:id/decide', ({ services, user, params, body }) => service.decideAmendment(services, user, intParam(params.id), body));

  // Reports
  r.get('/api/reports/executive', ({ services, user }) => { requirePermission(user, 'reports.view'); return reporting.executive(services); });
  r.get('/api/reports/datasets', ({ user }) => { requirePermission(user, 'reports.view'); return reporting.datasets(); });
  r.post('/api/reports/run', ({ services, user, body }) => { requirePermission(user, 'reports.view'); return reporting.runReport(services, body); });
  r.post('/api/reports/export', ({ services, user, body }) => reporting.exportReport(services, user, body));
  r.get('/api/reports/saved', ({ services, user }) => reporting.listSaved(services, user));
  r.post('/api/reports/saved', ({ services, user, body }) => reporting.saveReport(services, user, body));
  r.get('/api/reports/regulatory', ({ user }) => { requirePermission(user, 'reports.regulatory'); return reporting.REGULATORY; });
  r.post('/api/reports/regulatory/:key', ({ services, user, params, body }) => reporting.regulatoryExport(services, user, params.key, body));
  r.get('/api/reports/history', ({ services, user }) => { requirePermission(user, 'reports.view'); return reporting.exportHistory(services); });
  r.post('/api/reports/investors/:id/statement', ({ services, user, params, body }) => { requirePermission(user, 'portal.statements'); return portal.statement(services, user, body, intParam(params.id)); });
  r.post('/api/reports/investors/:id/tax/:year', ({ services, user, params }) => { requirePermission(user, 'portal.statements'); return portal.taxSummary(services, user, Number(params.year), intParam(params.id)); });

  // Investor portal (scoped to the signed-in investor)
  r.get('/api/portal', ({ services, user }) => portal.summary(services, user));
  r.post('/api/portal/statements', ({ services, user, body }) => portal.statement(services, user, body));
  r.post('/api/portal/tax/:year', ({ services, user, params }) => portal.taxSummary(services, user, Number(params.year)));
  r.get('/api/portal/requests', ({ services, user }) => portal.requests(services, user));
  r.post('/api/portal/requests', ({ services, user, body }) => portal.submitRequest(services, user, body));

  // Brokerage
  r.get('/api/brokerage/market', ({ services }) => brokerage.market(services));
  r.get('/api/brokerage/instruments', ({ services }) => brokerage.listInstruments(services));
  r.post('/api/brokerage/instruments/:id/restricted', ({ services, user, params, body }) => brokerage.setRestricted(services, user, intParam(params.id), body));
  r.get('/api/brokerage/brokers', ({ services }) => brokerage.listBrokers(services));
  r.post('/api/brokerage/brokers', ({ services, user, body }) => brokerage.onboardBroker(services, user, body));
  r.post('/api/brokerage/brokers/:id/decide', ({ services, user, params, body }) => brokerage.decideBroker(services, user, intParam(params.id), body));
  r.get('/api/brokerage/orders', ({ services }) => brokerage.listOrders(services));
  r.post('/api/brokerage/orders', ({ services, user, body }) => brokerage.placeOrder(services, user, body));
  r.get('/api/brokerage/trades', ({ services }) => brokerage.listTrades(services));
  r.post('/api/brokerage/trades/:id/settle', ({ services, user, params }) => brokerage.settleTrade(services, user, intParam(params.id)));
  r.get('/api/brokerage/commissions', ({ services }) => brokerage.commissions(services));

  // Documents
  r.get('/api/documents/:id/file', ({ services, user, params }) => docs.downloadDocument(services, intParam(params.id), user));

  // Client Onboarding / Purchase & Funding
  r.get('/api/imports', ({ services, query }) => funding.listImports(services, query));
  r.post('/api/imports', ({ services, user, body }) => funding.uploadInvoiceFile(services, user, body));
  r.get('/api/imports/:id', ({ services, user, params }) => funding.fundingView(services, user, intParam(params.id)));
  r.get('/api/imports/:id/file', ({ services, params }) => funding.downloadImportFile(services, intParam(params.id)));
  r.post('/api/imports/:id/recheck', ({ services, user, params }) => funding.recheck(services, user, intParam(params.id)));
  r.post('/api/imports/:id/reject', ({ services, user, params, body }) => funding.rejectInvoices(services, user, intParam(params.id), body));
  r.post('/api/imports/:id/restore', ({ services, user, params, body }) => funding.restoreInvoices(services, user, intParam(params.id), body));
  r.post('/api/imports/:id/investor', ({ services, user, params, body }) => funding.tagInvestor(services, user, intParam(params.id), body));
  r.post('/api/imports/:id/funding-date', ({ services, user, params, body }) => funding.changeFundingDate(services, user, intParam(params.id), body));
  r.post('/api/imports/:id/remove', ({ services, user, params, body }) => funding.removeImport(services, user, intParam(params.id), body));
  r.post('/api/imports/:id/approve', ({ services, user, params }) => funding.approveFunding(services, user, intParam(params.id)));

  // Settlement & Repayment
  r.get('/api/settlements', ({ services }) => settlement.listSettlementImports(services));
  r.post('/api/settlements', ({ services, user, body }) => settlement.uploadSettlementFile(services, user, body));
  r.get('/api/settlements/:id', ({ services, params }) => settlement.settlementView(services, intParam(params.id)));
  r.get('/api/loans/open', ({ services }) => settlement.openLoans(services));
  r.get('/api/loans/:id', ({ services, params }) => {
    const loan = reports.loanDetail(services, intParam(params.id));
    if (!loan) throw notFound('Loan');
    return { ...loan, collection_actions: dash.collectionActions(services, loan.id) };
  });
  r.post('/api/loans/:id/collection-actions', ({ services, user, params, body }) => dash.logCollectionAction(services, user, intParam(params.id), body));

  // Reconciliation
  r.get('/api/bank-statements', ({ services }) => recon.listStatements(services));
  r.post('/api/bank-statements', ({ services, user, body }) => recon.uploadStatement(services, user, body));
  r.get('/api/bank-statements/:id', ({ services, params }) => recon.statementView(services, intParam(params.id)));
  r.post('/api/bank-statements/:id/post', ({ services, user, params }) => recon.postMatched(services, user, intParam(params.id)));
  r.get('/api/recon/breaks', ({ services }) => recon.openBreaks(services));
  r.post('/api/bank-lines/:id/match', ({ services, user, params, body }) => recon.matchLine(services, user, intParam(params.id), body));
  r.post('/api/bank-lines/:id/resolve', ({ services, user, params, body }) => recon.resolveLine(services, user, intParam(params.id), body));

  // Revenue & Fees / ledger
  r.get('/api/revenue', ({ services }) => reports.revenue(services));
  r.get('/api/ledger/trial-balance', ({ services }) => ledger.trialBalance(services.db));
  r.get('/api/ledger/entries', ({ services, query }) => ledger.entries(services.db, {
    loan_id: query.get('loan_id') ? Number(query.get('loan_id')) : undefined,
    program_id: query.get('program_id') ? Number(query.get('program_id')) : undefined,
  }));

  // User Access & SoD
  r.get('/api/access', ({ services }) => access.accessOverview(services));
  r.post('/api/access/users', ({ services, user, body }) => access.createUser(services, user, body));
  r.put('/api/access/users/:username', ({ services, user, params, body }) => access.updateUser(services, user, params.username, body));
  r.post('/api/access/users/:username/reset-password', ({ services, user, params }) => auth.adminResetPassword(services, user, params.username));
  r.post('/api/access/users/:username/reset-mfa', ({ services, user, params }) => auth.adminResetMfa(services, user, params.username));
  r.post('/api/access/users/:username/unlock', ({ services, user, params }) => auth.adminUnlock(services, user, params.username));

  // Approvals (maker-checker for reference data, bank details and access)
  r.get('/api/approvals', ({ services, user, query }) => approvals.listChanges(services, user, query));
  r.post('/api/approvals/:id/decide', ({ services, user, params, body }) => approvals.decideChange(services, user, intParam(params.id), body));
  r.post('/api/approvals/:id/cancel', ({ services, user, params }) => approvals.cancelChange(services, user, intParam(params.id)));

  // Audit
  r.get('/api/audit', ({ services, user, query }) => {
    if (!can(user, 'reports.regulatory') && !can(user, 'users.manage')) throw forbidden('Only Compliance, Audit and administrators can read the audit trail');
    const type = query.get('entity_type');
    const id = query.get('entity_id');
    const rows = type
      ? services.db.all('SELECT * FROM audit_log WHERE entity_type = ? AND (? IS NULL OR entity_id = ?) ORDER BY id DESC LIMIT 200', [type, id, id])
      : services.db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200');
    return rows.map((x) => ({ ...x, details: JSON.parse(x.details) }));
  });
  r.get('/api/audit/verify', ({ services }) => audit.verify(services.db));
  r.get('/api/notifications', ({ services, user }) =>
    services.db.all("SELECT * FROM notifications WHERE audience = ? OR ? = 'ADMIN' ORDER BY id DESC LIMIT 30", [user.role, user.role]));
  r.get('/api/permissions', ({ user }) => ({ role: user.role, granted: Object.keys(PERMISSIONS).filter((p) => can(user, p)) }));

  return r;
}
