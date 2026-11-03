"""Seaport analytics engine - JSON-over-HTTP service (Python standard library only).

Endpoints
  GET  /health
  POST /parse          {filename, content_base64, kind: invoice|settlement|bank} -> normalised rows
  POST /price          {funding_date, day_count, fixings{bucket: bps}, invoices[...]} -> pricing
  POST /late-charges   {as_of, day_count, margin_bps, items[...]}                 -> late charges
  POST /underwrite     {financials[], profile, screening, requested_limit_cents, model?} -> score, rating, decision
  POST /pdf            {title, sections[...]}                                      -> generated PDF (base64)
  POST /pool/select    {candidates[], current[], target_size_cents, limits}         -> loans chosen under limits
  POST /payments/file {rail: ACH|FEDWIRE|SWIFT_MT103|PAIN001, payments[...]}      -> validated bank file
  POST /service/amortize {principal_cents, start_date, periods, rate_path[], margin_bps} -> variable-rate schedule
  POST /service/workout  {exposure_cents, recovery/extension/plan assumptions}          -> option NPVs
  POST /export/xlsx    {sheets: [{name, columns[], rows[]}]}                       -> Excel workbook (base64)
  POST /brokerage/market | /route | /economics                                     -> quotes, best-ex routing, trade economics
  POST /pool/stress    {loans[], tranches[], scenarios?}                            -> waterfall, break-even, cash flows

Binds to 127.0.0.1 only; the Node API is its only client. On AWS this maps to a Lambda
(or ECS task) behind a private endpoint with the same request/response contracts.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import brokerage  # noqa: E402
import parser as file_parser  # noqa: E402
import payments  # noqa: E402
import pdfgen  # noqa: E402
import pool  # noqa: E402
import pricing  # noqa: E402
import servicing  # noqa: E402
import underwriting  # noqa: E402
import xlsx_writer  # noqa: E402
from errors import EngineError  # noqa: E402

MAX_BODY = 20 * 1024 * 1024
VERSION = "0.3.0"


def handle(path: str, body: dict) -> dict:
    if path == "/parse":
        try:
            data = base64.b64decode(body.get("content_base64") or "", validate=True)
        except (binascii.Error, ValueError) as exc:
            raise EngineError("content_base64 is not valid base64") from exc
        if not data:
            raise EngineError("file is empty")
        result = file_parser.parse(str(body.get("filename") or "upload"), data, body.get("kind") or "invoice")
        result["sha256"] = hashlib.sha256(data).hexdigest()
        result["size_bytes"] = len(data)
        return result
    if path == "/price":
        return pricing.price_batch(body.get("funding_date"), body.get("day_count"), body.get("fixings") or {}, body.get("invoices") or [])
    if path == "/underwrite":
        return underwriting.evaluate(body)
    if path == "/underwrite/model":
        return underwriting.DEFAULT_MODEL
    if path == "/pdf":
        data = pdfgen.build(body)
        return {"content_base64": base64.b64encode(data).decode(), "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if path == "/pool/select":
        return pool.select(body)
    if path == "/pool/stress":
        return pool.stress(body)
    if path == "/pool/concentration":
        return {"concentration": pool.concentration(body.get("loans") or [], body.get("limits") or {}, int(body.get("target_size_cents") or 0))}
    if path == "/payments/file":
        return payments.generate(body)
    if path == "/service/amortize":
        return servicing.amortize(body)
    if path == "/service/workout":
        return servicing.workout(body)
    if path == "/export/xlsx":
        data = xlsx_writer.build(body)
        return {"content_base64": base64.b64encode(data).decode(), "size_bytes": len(data)}
    if path == "/brokerage/market":
        return brokerage.market(body)
    if path == "/brokerage/route":
        return brokerage.route(body)
    if path == "/brokerage/economics":
        return brokerage.economics(body)
    if path == "/late-charges":
        return pricing.late_charges(body.get("as_of"), body.get("day_count"), int(body.get("margin_bps") or 0), body.get("items") or [])
    raise KeyError(path)


class Handler(BaseHTTPRequestHandler):
    server_version = "SeaportEngine/" + VERSION

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, {"status": "ok", "service": "engine", "version": VERSION})
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._send(413, {"error": "payload_too_large"})
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("body must be a JSON object")
        except ValueError as exc:
            self._send(400, {"error": "invalid_json", "message": str(exc)})
            return
        try:
            self._send(200, handle(self.path, body))
        except KeyError:
            self._send(404, {"error": "not_found"})
        except EngineError as exc:
            self._send(422, {"error": "validation_error", "message": str(exc)})
        except Exception as exc:  # pragma: no cover - defensive
            self._send(500, {"error": "engine_error", "message": f"{type(exc).__name__}: {exc}"})

    def log_message(self, fmt, *args):
        if os.environ.get("ENGINE_DEBUG"):
            super().log_message(fmt, *args)


def main() -> None:
    port = int(os.environ.get("ENGINE_PORT", "8001"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[engine] Python analytics engine listening on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
