// External data adapters for underwriting: KYC/AML screening and credit bureau.
// The platform depends only on these interfaces. The mocks are deterministic (same input,
// same answer) so demos and tests are repeatable. Replace with the chosen providers
// (e.g. a sanctions/PEP screening API and a commercial credit bureau) after discovery;
// set SCREENING_PROVIDER / BUREAU_PROVIDER and add the adapter here.

import { createHash } from 'node:crypto';

export interface ScreeningSubject { legal_name: string; country: string; registration_no?: string | null; owners: { name: string; ownership_pct?: number }[] }

export interface ScreeningResult {
  provider: string;
  reference: string;
  checked_at: string;
  sanctions_hit: boolean;
  pep_hit: boolean;
  adverse_media: boolean;
  high_risk_country: boolean;
  matches: { list: string; name: string; detail: string }[];
}

export interface BureauResult {
  provider: string;
  reference: string;
  checked_at: string;
  bureau_score: number;      // 0-100, higher is better
  payment_dbt: number;       // average days beyond terms
  public_records: number;    // judgments / liens
  trade_lines: number;
}

export interface KycProvider { screen(s: ScreeningSubject): Promise<ScreeningResult> }
export interface BureauProvider { report(s: ScreeningSubject): Promise<BureauResult> }

const SANCTIONS = ['sanctioned holdings', 'blocked trading', 'embargo metals'];
const PEPS = ['minister', 'senator', 'test pep'];
const ADVERSE = ['fraud', 'scandal'];
const HIGH_RISK = ['KP', 'IR', 'SY', 'CU', 'RU', 'BY'];

const hash = (s: string) => parseInt(createHash('sha256').update(s.toLowerCase().trim()).digest('hex').slice(0, 8), 16);
const ref = (prefix: string, s: string) => `${prefix}-${hash(s).toString(36).toUpperCase().padStart(7, '0')}`;

export const mockKyc: KycProvider = {
  async screen(s) {
    const matches: ScreeningResult['matches'] = [];
    const names = [s.legal_name, ...s.owners.map((o) => o.name)];
    for (const n of names) {
      const l = n.toLowerCase();
      if (SANCTIONS.some((w) => l.includes(w))) matches.push({ list: 'Consolidated sanctions (mock)', name: n, detail: 'Exact name match' });
      if (PEPS.some((w) => l.includes(w))) matches.push({ list: 'PEP (mock)', name: n, detail: 'Politically exposed person' });
      if (ADVERSE.some((w) => l.includes(w))) matches.push({ list: 'Adverse media (mock)', name: n, detail: 'Negative news mention' });
    }
    return {
      provider: 'Mock screening v1',
      reference: ref('KYC', s.legal_name + s.country),
      checked_at: new Date().toISOString(),
      sanctions_hit: matches.some((m) => m.list.startsWith('Consolidated')),
      pep_hit: matches.some((m) => m.list.startsWith('PEP')),
      adverse_media: matches.some((m) => m.list.startsWith('Adverse')),
      high_risk_country: HIGH_RISK.includes(s.country.toUpperCase()),
      matches,
    };
  },
};

export const mockBureau: BureauProvider = {
  async report(s) {
    const h = hash(s.legal_name + (s.registration_no ?? ''));
    const l = s.legal_name.toLowerCase();
    const weak = ['distressed', 'troubled'].some((w) => l.includes(w));
    return {
      provider: 'Mock bureau v1',
      reference: ref('CB', s.legal_name),
      checked_at: new Date().toISOString(),
      bureau_score: weak ? 22 + (h % 10) : 52 + (h % 39),
      payment_dbt: weak ? 45 + (h % 30) : h % 18,
      public_records: weak ? 2 : 0,
      trade_lines: 6 + (h % 20),
    };
  },
};
