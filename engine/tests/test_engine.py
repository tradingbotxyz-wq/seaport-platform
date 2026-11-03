import io
import os
import sys
import unittest
import zipfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import parser as p  # noqa: E402
import pricing  # noqa: E402
from errors import EngineError  # noqa: E402

FIXINGS = {"1-30": 428, "31-90": 435, "91-180": 442, "181+": 455}


class PricingTests(unittest.TestCase):
    """Figures reproduce the 'Invoices in this funding' prototype screen (SOFR, ACT/360, funding 21 Sep 26)."""

    def price(self, **inv):
        out = pricing.price_batch("2026-09-21", "ACT/360", FIXINGS, [inv])
        return out["invoices"][0]

    def test_inv_88231(self):
        r = self.price(id=1, face_cents=125_000_000, adv_bps=9500, investor_margin_bps=162, sp_spread_bps=63, due_date="2026-11-26")
        self.assertEqual(r["purchase_cents"], 118_750_000)
        self.assertEqual(r["tenor_days"], 66)
        self.assertEqual(r["bucket"], "31-90")
        self.assertEqual(r["all_in_bps"], 660)
        self.assertEqual(r["interest_cents"], 1_436_875)          # USD 14,368.75 -> screen shows 14,369
        self.assertEqual(round(r["interest_cents"] / 100), 14_369)
        self.assertEqual(round(r["investor_interest_cents"] / 100), 12_997)

    def test_inv_88240(self):
        r = self.price(id=3, face_cents=147_500_000, adv_bps=9000, investor_margin_bps=180, sp_spread_bps=70, due_date="2026-12-04")
        self.assertEqual(r["purchase_cents"], 132_750_000)
        self.assertEqual(r["tenor_days"], 74)
        self.assertEqual(round(r["interest_cents"] / 100), 18_692)
        self.assertEqual(round(r["investor_interest_cents"] / 100), 16_782)

    def test_due_before_funding_not_priceable(self):
        r = self.price(id=9, face_cents=1000, adv_bps=9000, investor_margin_bps=100, sp_spread_bps=50, due_date="2026-09-21")
        self.assertFalse(r["priceable"])

    def test_buckets(self):
        self.assertEqual(pricing.bucket_for(30), "1-30")
        self.assertEqual(pricing.bucket_for(31), "31-90")
        self.assertEqual(pricing.bucket_for(180), "91-180")
        self.assertEqual(pricing.bucket_for(181), "181+")

    def test_weighted_tenor(self):
        out = pricing.price_batch("2026-09-21", "ACT/360", FIXINGS, [
            {"id": 1, "face_cents": 100_00, "adv_bps": 10000, "investor_margin_bps": 0, "sp_spread_bps": 0, "due_date": "2026-10-21"},
            {"id": 2, "face_cents": 300_00, "adv_bps": 10000, "investor_margin_bps": 0, "sp_spread_bps": 0, "due_date": "2026-12-20"},
        ])
        self.assertEqual(out["weighted_tenor_days"], round((100 * 30 + 300 * 90) / 400))

    def test_missing_fixings(self):
        with self.assertRaises(EngineError):
            pricing.price_batch("2026-09-21", "ACT/360", {"1-30": 400}, [])

    def test_late_charge(self):
        out = pricing.late_charges("2026-09-24", "ACT/360", 300, [
            {"id": 1, "shortfall_cents": 360_000_00, "base_bps": 435, "maturity_date": "2026-09-22"}])
        # 360,000 x 7.35% x 2 / 360 = 147.00
        self.assertEqual(out["items"][0]["charge_cents"], 14_700)
        self.assertEqual(out["items"][0]["days_past_due"], 2)


class ValueParsingTests(unittest.TestCase):
    def test_amounts(self):
        self.assertEqual(p.parse_amount("1,250,000"), 125_000_000)
        self.assertEqual(p.parse_amount("USD 860,000.50"), 86_000_050)
        self.assertEqual(p.parse_amount("1.250.000,50"), 125_000_050)
        self.assertEqual(p.parse_amount("(1,000)"), -100_000)
        self.assertEqual(p.parse_amount(620000), 62_000_000)
        self.assertIsNone(p.parse_amount("n/a"))

    def test_dates(self):
        self.assertEqual(p.parse_date("2026-11-26"), "2026-11-26")
        self.assertEqual(p.parse_date("26/11/2026"), "2026-11-26")
        self.assertEqual(p.parse_date("05/09/2026"), "2026-09-05")   # day-first
        self.assertEqual(p.parse_date("26 Nov 26"), "2026-11-26")
        self.assertEqual(p.parse_date("Nov 26, 2026"), "2026-11-26")
        self.assertEqual(p.parse_date(46352), "2026-11-26")           # Excel serial
        self.assertIsNone(p.parse_date("31/02/2026"))


CSV = b"""Invoice No,Buyer,Invoice Date,Due Date,Invoice Amount,Currency
INV-88231,Harborview Foods USA,28/08/2026,26/11/2026,"1,250,000.00",USD
INV-88232,Harborview Foods USA,02/09/2026,01/12/2026,860000,USD
INV-BAD,Harborview Foods USA,02/09/2026,01/08/2026,1000,USD
INV-NOAMT,Harborview Retail LLC,02/09/2026,01/12/2026,,USD
Total,,,,2110000,
"""


def make_xlsx(rows):
    strings, idx = [], {}
    def s(v):
        if v not in idx:
            idx[v] = len(strings)
            strings.append(v)
        return idx[v]
    sheet_rows = []
    for r, row in enumerate(rows, 1):
        cells = []
        for c, v in enumerate(row):
            ref = chr(65 + c) + str(r)
            if isinstance(v, (int, float)):
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="s"><v>{s(v)}</v></c>')
        sheet_rows.append(f'<row r="{r}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>')
        z.writestr("xl/sharedStrings.xml", f'<sst {ns}>' + "".join(f"<si><t>{x}</t></si>" for x in strings) + "</sst>")
    return buf.getvalue()


def make_pdf(lines):
    ops = []
    y = 750
    for cells in lines:
        x = 50
        for cell in cells:
            ops.append(f"BT /F1 10 Tf {x} {y} Td ({cell}) Tj ET")
            x += 110
        y -= 16
    stream = zlib.compress("\n".join(ops).encode())
    return b"%PDF-1.4\n1 0 obj << /Length " + str(len(stream)).encode() + b" /Filter /FlateDecode >>\nstream\n" + stream + b"\nendstream\nendobj\n%%EOF"


class FileParsingTests(unittest.TestCase):
    def test_csv(self):
        r = p.parse("batch.csv", CSV, "invoice")
        self.assertEqual(len(r["rows"]), 2)
        self.assertEqual(r["rows"][0]["amount_cents"], 125_000_000)
        self.assertEqual(r["rows"][0]["due_date"], "2026-11-26")
        self.assertEqual(len(r["skipped"]), 2)  # due<invoice date, missing amount; Total row ignored
        self.assertEqual(r["rows_read"], 4)

    def test_semicolon_txt(self):
        data = b"invoice number;obligor;due date;amount\nA-1;Acme;2026-12-01;1000\n"
        r = p.parse("x.txt", data, "invoice")
        self.assertEqual(r["rows"][0]["buyer"], "Acme")

    def test_xlsx(self):
        data = make_xlsx([["Report title"], ["Invoice", "Buyer", "Invoice date", "Due date", "Face amount"],
                          ["INV-88240", "Harborview Foods Canada", "2026-09-05", 46360, 1475000]])
        r = p.parse("b.xlsx", data, "invoice")
        self.assertEqual(r["format"], "xlsx")
        self.assertEqual(r["rows"][0]["invoice_number"], "INV-88240")
        self.assertEqual(r["rows"][0]["due_date"], "2026-12-04")
        self.assertEqual(r["rows"][0]["amount_cents"], 147_500_000)

    def test_pdf(self):
        data = make_pdf([["Invoice", "Buyer", "Due Date", "Amount"], ["INV-90011", "Vantage Health", "2026-12-15", "2,800,000.00"]])
        r = p.parse("inv.pdf", data, "invoice")
        self.assertEqual(r["format"], "pdf")
        self.assertEqual(len(r["rows"]), 1, r)
        self.assertEqual(r["rows"][0]["amount_cents"], 280_000_000)

    def test_settlement_file(self):
        data = b"Loan ID,Invoice,Amount Received,Value Date,Bank Reference\nL-2026-00291,INV-87104,1480000,22/09/2026,VA-1041-0007\n"
        r = p.parse("settle.csv", data, "settlement")
        self.assertEqual(r["rows"][0]["loan_id"], "L-2026-00291")
        self.assertEqual(r["rows"][0]["bank_reference"], "VA-1041-0007")

    def test_no_header(self):
        r = p.parse("x.csv", b"a,b,c\n1,2,3\n", "invoice")
        self.assertEqual(r["rows"], [])
        self.assertTrue(r["warnings"])


if __name__ == "__main__":
    unittest.main()


import underwriting as uw  # noqa: E402
import pdfgen  # noqa: E402

FIN = [
    {"year": 2024, "revenue_cents": 50_000_000_00, "ebitda_cents": 6_000_000_00, "interest_expense_cents": 900_000_00,
     "total_debt_cents": 15_000_000_00, "current_assets_cents": 14_000_000_00, "current_liabilities_cents": 8_000_000_00,
     "net_worth_cents": 20_000_000_00, "debt_service_cents": 3_000_000_00},
    {"year": 2025, "revenue_cents": 55_000_000_00, "ebitda_cents": 7_150_000_00, "interest_expense_cents": 950_000_00,
     "total_debt_cents": 16_000_000_00, "current_assets_cents": 15_000_000_00, "current_liabilities_cents": 8_500_000_00,
     "net_worth_cents": 22_000_000_00, "debt_service_cents": 3_250_000_00},
]


class UnderwritingTests(unittest.TestCase):
    def run_uw(self, fin=FIN, **kw):
        body = {"financials": fin, "profile": {"bureau_score": 78, "years_trading": 14, "payment_dbt": 6},
                "screening": {}, "requested_limit_cents": 10_000_000_00, **kw}
        return uw.evaluate(body)

    def test_ratios(self):
        s = uw.spread(FIN)[-1]
        self.assertEqual(s["dscr"], "2.2000")            # 7.15m / 3.25m
        self.assertEqual(s["leverage"], "2.2378")        # 16m / 7.15m
        self.assertEqual(s["current_ratio"], "1.7647")
        self.assertEqual(s["ebitda_margin"], "0.1300")
        self.assertEqual(s["revenue_growth"], "0.1000")

    def test_strong_borrower_approves(self):
        r = self.run_uw()
        self.assertEqual(r["outcome"], "APPROVE", r)
        self.assertIn(r["rating"], ("A", "A-", "BBB+"))
        self.assertIsNotNone(r["pricing_guidance"])

    def test_sanctions_knockout(self):
        r = self.run_uw(screening={"sanctions_hit": True})
        self.assertEqual(r["outcome"], "DECLINE")

    def test_weak_dscr_declines(self):
        weak = [dict(FIN[1], ebitda_cents=2_500_000_00)]
        r = self.run_uw(fin=weak)
        self.assertEqual(r["outcome"], "DECLINE")

    def test_pep_and_authority_refer(self):
        r = self.run_uw(screening={"pep_hit": True}, requested_usd_cents=30_000_000_00)
        self.assertEqual(r["outcome"], "REFER")
        self.assertTrue(r["committee_required"])

    def test_negative_ebitda(self):
        r = self.run_uw(fin=[dict(FIN[1], ebitda_cents=-1_000_00)])
        self.assertEqual(r["outcome"], "DECLINE")

    def test_bad_input(self):
        with self.assertRaises(EngineError):
            self.run_uw(fin=[dict(FIN[1], revenue_cents="lots")])


class PdfTests(unittest.TestCase):
    def test_build_multi_page(self):
        spec = {"title": "Credit memo — Harborview Retail LLC", "subtitle": "UW-000001 · £ € test", "meta": [["Program", "PRG-1041"]],
                "sections": [{"heading": "Summary", "paragraphs": ["word " * 400], "bullets": ["one", "two"]},
                             {"heading": "Table", "table": {"columns": ["A", "B"], "rows": [[str(i), f"{i:,}"] for i in range(120)]}}]}
        data = pdfgen.build(spec)
        self.assertTrue(data.startswith(b"%PDF-1.4"))
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))
        self.assertGreaterEqual(data.count(b"/Type /Page "), 3)
        # parser can read its own output back
        rows = p.read_pdf(data)
        self.assertTrue(any("Summary" in " ".join(r) for r in rows))


import pool as pl  # noqa: E402


def _loan(i, obligor, principal, rating="BBB", days=60, program="P1", country="US"):
    return {"id": i, "obligor": obligor, "program": program, "country": country, "rating": rating,
            "principal_cents": principal, "outstanding_cents": round(principal * 1.012), "yield_bps": 600 + i, "days": days}


TR = [{"name": "SENIOR", "pct_bps": 8000, "coupon_bps": 500}, {"name": "MEZZANINE", "pct_bps": 1200, "coupon_bps": 800},
      {"name": "EQUITY", "pct_bps": 800, "coupon_bps": 0}]


class PoolTests(unittest.TestCase):
    loans = [_loan(i, f"Obl{i % 6}", 1_000_000_00, ["A", "BBB", "BB+", "BB", "BBB-", "B+"][i % 6], 20 + i * 5) for i in range(18)]

    def test_select_respects_limits_and_target(self):
        r = pl.select({"candidates": self.loans, "target_size_cents": 12_000_000_00, "limits": {"max_obligor_bps": 2000, "max_sub_ig_bps": 6000}})
        self.assertLessEqual(r["size_cents"], 12_000_000_00)
        self.assertTrue(all(c["status"] != "Breach" for c in r["concentration"]))
        self.assertTrue(r["skipped"])

    def test_losses_hit_equity_first_and_ordering(self):
        out = pl.stress({"loans": self.loans, "tranches": TR})
        losses = [x["pool"]["loss_cents"] for x in out["results"][:3]]
        self.assertEqual(losses, sorted(losses))
        base = {t["name"]: t for t in out["results"][0]["tranches"]}
        self.assertEqual(base["SENIOR"]["loss_cents"], 0)
        self.assertGreater(base["EQUITY"]["loss_cents"], 0)
        be = out["breakeven_pd_multiple"]
        self.assertGreater(be["SENIOR"], be["MEZZANINE"])

    def test_waterfall_conserves_loss(self):
        r = pl.run(self.loans, TR, {"pd_mult": 50, "lgd": 0.9, "dilution": 0.05})
        self.assertAlmostEqual(sum(t["loss_cents"] for t in r["tranches"]), r["pool"]["loss_cents"], delta=3)

    def test_top_n_default(self):
        out = pl.stress({"loans": self.loans, "tranches": TR, "scenarios": [{"name": "t", "top_n_default": 2, "lgd": 0.6, "dilution": 0}]})
        self.assertGreater(out["results"][0]["pool"]["loss_pct"], 5)

    def test_validation(self):
        with self.assertRaises(EngineError):
            pl.stress({"loans": self.loans, "tranches": [{"name": "SENIOR", "pct_bps": 5000}]})
        with self.assertRaises(EngineError):
            pl.stress({"loans": [dict(self.loans[0], rating="ZZ")]})


import payments as pay  # noqa: E402

ORIG_US = {"name": "Seaport Global LLP", "bank_name": "JPMorgan Chase", "routing_number": "021000021", "account_number": "000123456789", "company_id": "1234567890"}
ORIG_EU = {"name": "Seaport Global LLP", "bank_name": "Barclays", "bic": "BARCGB22", "iban": "GB29NWBK60161331926819"}


class PaymentTests(unittest.TestCase):
    def test_checks(self):
        self.assertTrue(pay.aba_valid("021000021"))
        self.assertFalse(pay.aba_valid("021000022"))
        self.assertTrue(pay.iban_valid("GB29 NWBK 6016 1331 9268 19"))
        self.assertTrue(pay.iban_valid("DE89370400440532013000"))
        self.assertFalse(pay.iban_valid("DE89370400440532013001"))

    def base(self, rail, ccy, orig, ben):
        return {"rail": rail, "batch_ref": "PAY-000001", "value_date": "2026-11-04", "created_at": "2026-11-03T10:15:00Z", "currency": ccy,
                "originator": orig, "payments": [{"reference": "L-2026-00067", "amount_cents": 316_830_45, "beneficiary": ben, "remittance": "Funding INV-88231"}]}

    def test_ach_layout(self):
        r = pay.generate(self.base("ACH", "USD", ORIG_US, {"name": "Harborview Foods Inc", "routing_number": "011000015", "account_number": "4400118822"}))
        self.assertEqual(r["errors"], [])
        lines = r["content"].strip().split("\r\n")
        self.assertEqual(len(lines) % 10, 0)
        self.assertTrue(all(len(x) == 94 for x in lines))
        self.assertEqual(lines[0][0], "1")
        self.assertEqual(lines[2][0], "6")
        self.assertIn("0031683045", lines[2])
        self.assertEqual(lines[3][0], "8")
        self.assertEqual(lines[4][0], "9")

    def test_ach_rejects_bad_routing(self):
        r = pay.generate(self.base("ACH", "USD", ORIG_US, {"name": "X", "routing_number": "123456789", "account_number": "1234"}))
        self.assertTrue(any("checksum" in e for e in r["errors"]))
        self.assertNotIn("content", r)

    def test_fedwire_and_mt103_and_pain(self):
        fw = pay.generate(self.base("FEDWIRE", "USD", ORIG_US, {"name": "Atlas", "bank_name": "Wells Fargo", "routing_number": "121000248", "account_number": "998877"}))
        self.assertIn("{2000}000031683045", fw["content"])
        eu_ben = {"name": "Nordhafen Trading GmbH", "bic": "COBADEFFXXX", "iban": "DE89370400440532013000"}
        mt = pay.generate(self.base("SWIFT_MT103", "EUR", ORIG_EU, eu_ben))
        self.assertIn(":32A:261104EUR316830,45", mt["content"])
        px = pay.generate(self.base("PAIN001", "EUR", ORIG_EU, eu_ben))
        self.assertIn('<InstdAmt Ccy="EUR">316830.45</InstdAmt>', px["content"])
        from xml.etree import ElementTree as ET
        ET.fromstring(px["content"].encode())


import servicing as sv  # noqa: E402


class ServicingTests(unittest.TestCase):
    def test_fixed_schedule_ties_out(self):
        r = sv.amortize({"principal_cents": 1_200_000_00, "start_date": "2026-11-03", "periods": 12, "base_bps": 600, "margin_bps": 300})
        self.assertEqual(sum(x["principal_cents"] for x in r["schedule"]), 1_200_000_00)
        self.assertEqual(r["schedule"][-1]["balance_cents"], 0)
        self.assertEqual(r["schedule"][0]["due_date"], "2026-12-03")

    def test_variable_rate_resets_change_payment(self):
        r = sv.amortize({"principal_cents": 1_000_000_00, "start_date": "2026-01-31", "periods": 6, "margin_bps": 250,
                         "rate_path": [{"from_period": 1, "base_bps": 430}, {"from_period": 4, "base_bps": 530}]})
        s = r["schedule"]
        self.assertEqual(s[0]["rate_bps"], 680)
        self.assertEqual(s[3]["rate_bps"], 780)
        self.assertEqual(s[1]["due_date"], "2026-03-31")   # month-end handling (Feb 28 then back to 31)
        self.assertEqual(sum(x["principal_cents"] for x in s), 1_000_000_00)
        self.assertEqual(r["resets"], 2)

    def test_workout_prefers_highest_npv(self):
        r = sv.workout({"exposure_cents": 2_000_000_00, "start_date": "2026-11-03", "recovery_rate": 0.3, "plan": {"months": 6, "rate_bps": 900, "monthly_default_prob": 0.01}})
        best = max(r["options"], key=lambda o: o["npv_cents"])
        self.assertTrue(best["recommended"])
        self.assertEqual(r["recommendation"], best["option"])
        self.assertLess(r["options"][0]["npv_cents"], 2_000_000_00)

    def test_validation(self):
        with self.assertRaises(EngineError):
            sv.workout({"exposure_cents": 100, "recovery_rate": 1.5})


import xlsx_writer  # noqa: E402


class XlsxTests(unittest.TestCase):
    def test_roundtrip_with_own_reader(self):
        data = xlsx_writer.build({"sheets": [{"name": "Loans/Q4", "columns": [{"label": "Loan", "type": "text"}, {"label": "Amount", "type": "money"}, {"label": "Due", "type": "date"}],
                                              "rows": [["L-1", 1250000.5, "2026-11-26"], ["L-2 & <x>", 99, None]]}]})
        rows = p.read_xlsx(data)
        self.assertEqual(rows[0], ["Loan", "Amount", "Due"])
        self.assertEqual(rows[1][1], 1250000.5)
        self.assertEqual(rows[2][0], "L-2 & <x>")
        z = zipfile.ZipFile(io.BytesIO(data))
        self.assertIn("Loans Q4", z.read("xl/workbook.xml").decode())


import brokerage as bk  # noqa: E402

TB = {"isin": "US912797XX11", "type": "TBILL", "maturity_date": "2027-02-04", "spread_bps": 0}
BD = {"isin": "US000000BD01", "type": "BOND", "maturity_date": "2029-06-15", "coupon_bps": 500, "spread_bps": 60}


class BrokerageTests(unittest.TestCase):
    def test_quotes_deterministic_and_sane(self):
        a = bk.quotes(TB, "2026-11-03T10:15:30Z")
        self.assertEqual(a, bk.quotes(TB, "2026-11-03T10:15:59Z"))
        for q in a:
            self.assertLess(q["bid"], q["ask"])
            self.assertTrue(980000 < q["bid"] < 1000000)

    def test_buy_routes_to_best_effective_offer_and_splits(self):
        r = bk.route({"instrument": BD, "side": "BUY", "quantity": 60_000_000, "ts": "2026-11-03T10:15:00Z"})
        self.assertEqual(r["status"], "FILLED")
        self.assertEqual(sum(f["quantity"] for f in r["fills"]), 60_000_000)
        self.assertGreater(len(r["fills"]), 1)
        eff = lambda f: f["price"] * (1 + f["fee_bps"] / 10000)  # noqa: E731
        self.assertLessEqual(eff(r["fills"][0]), eff(r["fills"][1]))

    def test_limit_blocks_fill(self):
        r = bk.route({"instrument": TB, "side": "BUY", "quantity": 1_000_000, "limit_price": 900000, "ts": "2026-11-03T10:15:00Z"})
        self.assertEqual(r["status"], "NOT_FILLED")

    def test_economics_commission_tiers_and_accrued(self):
        e = bk.economics({"instrument": BD, "side": "BUY", "quantity": 2_000_000, "price": 1003500, "settlement_date": "2026-11-04", "fee_bps": 0.5, "rebate_bps_of_commission": 2000})
        self.assertEqual(e["principal_cents"], 2_007_000_00)
        self.assertEqual(e["commission_bps"], 15)
        self.assertGreater(e["accrued_cents"], 0)
        self.assertEqual(e["rebate_cents"], round(e["commission_cents"] * 0.2))
        self.assertEqual(e["net_cents"], e["principal_cents"] + e["accrued_cents"] + e["commission_cents"] + e["venue_fee_cents"])
        small = bk.economics({"instrument": TB, "side": "SELL", "quantity": 10_000, "price": 990000, "settlement_date": "2026-11-04"})
        self.assertEqual(small["commission_cents"], 25_000)
