"""Regression tests for findings from the external security and financial-controls reviews."""

import base64
import io
import os
import sys
import time
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import brokerage  # noqa: E402
import parser as file_parser  # noqa: E402
import payments  # noqa: E402
import pdfgen  # noqa: E402
import pool  # noqa: E402
from errors import EngineError  # noqa: E402


class AmountSigns(unittest.TestCase):
    def test_debit_notations_are_negative(self):
        for s in ["-1,000.00", "(1,000.00)", "1,000.00-", "1,000.00 DR", "−1,000.00"]:
            self.assertEqual(file_parser.parse_amount(s), -100000, s)

    def test_ambiguous_or_malformed_is_refused(self):
        for s in ["1.250", "(1,000", "1,2345", "1.5.5", "12abc"]:
            self.assertIsNone(file_parser.parse_amount(s), s)

    def test_common_formats(self):
        self.assertEqual(file_parser.parse_amount("USD 1 250 000"), 125000000)
        self.assertEqual(file_parser.parse_amount("1.250.000,50"), 125000050)
        self.assertEqual(file_parser.parse_amount("1,000.00 CR"), 100000)


class ResourceLimits(unittest.TestCase):
    def test_pdf_long_cell_finishes_quickly(self):
        start = time.time()
        pdf = pdfgen.build({"title": "T", "sections": [{"table": {"columns": ["A"] * 12, "rows": [["x" * 5000] * 12]}}]})
        self.assertLess(time.time() - start, 2)
        self.assertTrue(pdf.startswith(b"%PDF"))

    def test_xlsx_zip_bomb_is_refused(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("xl/worksheets/sheet1.xml", b"<a>" + b" " * (80 * 1024 * 1024) + b"</a>")
        with self.assertRaises(EngineError):
            file_parser.parse("bomb.xlsx", buf.getvalue(), "invoice")

    def test_pdf_stream_scan_is_linear(self):
        start = time.time()
        try:
            file_parser.parse("x.pdf", b"%PDF-1.4\n" + b"stream\n" * 200000, "invoice")
        except EngineError:
            pass
        self.assertLess(time.time() - start, 3)


class PaymentFiles(unittest.TestCase):
    def body(self, ref):
        return {"rail": "SWIFT_MT103", "batch_ref": "PAY-1", "value_date": "2026-11-05", "created_at": "2026-11-03T10:00:00Z", "currency": "EUR",
                "originator": {"name": "Seaport", "bic": "DEUTDEFF", "iban": "DE89370400440532013000"},
                "payments": [{"reference": ref, "amount_cents": 1000, "remittance": ref,
                              "beneficiary": {"name": "Kestrel {4:", "bic": "COBADEFFXXX", "iban": "DE44500105175407324931"}}]}

    def test_mt103_fields_cannot_break_out(self):
        out = payments.generate(self.body("X\r\n-}{4:\r\n:20:EVIL"))
        content = out["content"]
        self.assertEqual(content.count("{4:"), 1)
        self.assertEqual(content.count(":20:"), 1)
        self.assertEqual(content.count("-}"), 1)  # one message, closed once
        self.assertIn(":20:X-420EVIL\r\n:23B:CRED", content)  # the reference stays one token

    def test_originator_iban_required(self):
        b = self.body("REF1")
        b["originator"] = {"name": "Seaport", "bic": "DEUTDEFF", "account_number": "123"}
        out = payments.generate(b)
        self.assertTrue(any("IBAN" in e for e in out["errors"]))


class PoolConcentration(unittest.TestCase):
    loans = [{"id": 1, "obligor": "A", "program": "P", "country": "US", "rating": "BBB", "principal_cents": 1000, "outstanding_cents": 1000, "days": 30}]

    def test_measured_on_actual_size_not_target(self):
        c = pool.concentration(self.loans, {"max_obligor_bps": 1000}, 100000)
        self.assertEqual(c[0]["bps"], 10000)
        self.assertEqual(c[0]["status"], "Breach")

    def test_zero_limit_is_enforced(self):
        c = pool.concentration(self.loans, {"max_program_bps": 0}, 0)
        self.assertEqual(c[0]["status"], "Breach")


if __name__ == "__main__":
    unittest.main()
