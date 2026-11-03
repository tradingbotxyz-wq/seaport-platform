"""Disbursement file generation and validation.

Formats
  ACH       NACHA fixed-width file (94-char records, CCD credits, blocked to 10 records)
  FEDWIRE   Fedwire Funds Service FAIM tag format, one message per payment
  SWIFT_MT103  SWIFT MT103 single customer credit transfer, one message per payment
  PAIN001   ISO 20022 pain.001.001.03 customer credit transfer initiation (XML)

Input:
  {rail, batch_ref, value_date (YYYY-MM-DD), created_at (ISO), currency,
   originator: {name, bank_name, routing_number?, account_number?, bic?, iban?, company_id?},
   payments: [{reference, amount_cents, beneficiary: {name, bank_name?, routing_number?, account_number?, bic?, iban?, country?}, remittance}]}
Output: {filename, content_type, content, count, total_cents, errors: []}
Validation errors are returned per payment; a file is only produced when there are none.
"""

from __future__ import annotations

import re
from datetime import datetime
from xml.sax.saxutils import escape

from errors import EngineError

BIC_RE = re.compile(r"^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$")


def aba_valid(rtn: str | None) -> bool:
    if not rtn or not re.fullmatch(r"\d{9}", rtn):
        return False
    d = [int(c) for c in rtn]
    return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 == 0


def iban_valid(iban: str | None) -> bool:
    if not iban:
        return False
    s = iban.replace(" ", "").upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}", s):
        return False
    r = s[4:] + s[:4]
    num = "".join(str(int(ch, 36)) for ch in r)
    return int(num) % 97 == 1


def _alnum(s, n, upper=True):
    s = re.sub(r"[^A-Za-z0-9 ,.\-/&]", "", str(s or ""))
    s = s.upper() if upper else s
    return s[:n].ljust(n)


def _num(v, n):
    return str(int(v)).rjust(n, "0")[-n:]


def validate(rail: str, body: dict) -> list[str]:
    errors = []
    o = body.get("originator") or {}
    if rail in ("ACH", "FEDWIRE"):
        if body.get("currency") != "USD":
            errors.append(f"{rail} only carries USD")
        if not aba_valid(o.get("routing_number")):
            errors.append("Originator routing number (ABA) is invalid")
        if not o.get("account_number"):
            errors.append("Originator account number missing")
    else:
        if not BIC_RE.match(o.get("bic") or ""):
            errors.append("Originator BIC is invalid")
        if not iban_valid(o.get("iban")) and not o.get("account_number"):
            errors.append("Originator IBAN/account is invalid")
    pays = body.get("payments") or []
    if not pays:
        errors.append("No payments in batch")
    for p in pays:
        b = p.get("beneficiary") or {}
        ref = p.get("reference") or "?"
        amt = p.get("amount_cents")
        if not isinstance(amt, int) or amt <= 0:
            errors.append(f"{ref}: amount must be a positive integer (cents)")
        if not (b.get("name") or "").strip():
            errors.append(f"{ref}: beneficiary name missing")
        if rail in ("ACH", "FEDWIRE"):
            if not aba_valid(b.get("routing_number")):
                errors.append(f"{ref}: beneficiary routing number (ABA) {b.get('routing_number')} fails checksum")
            if not re.fullmatch(r"[0-9A-Za-z\-]{4,17}", b.get("account_number") or ""):
                errors.append(f"{ref}: beneficiary account number invalid for {rail}")
            if rail == "ACH" and isinstance(amt, int) and amt > 99_999_999_99:
                errors.append(f"{ref}: amount exceeds the ACH field size; use Fedwire")
        else:
            if not BIC_RE.match(b.get("bic") or ""):
                errors.append(f"{ref}: beneficiary BIC {b.get('bic')} invalid")
            if not iban_valid(b.get("iban")):
                errors.append(f"{ref}: beneficiary IBAN {b.get('iban')} fails the mod-97 check")
    return errors


def ach(body: dict) -> str:
    o = body["originator"]
    now = datetime.fromisoformat(body["created_at"].replace("Z", "+00:00"))
    eff = body["value_date"].replace("-", "")[2:]
    odfi = o["routing_number"][:8]
    company_id = _alnum(o.get("company_id") or ("1" + o["routing_number"][:9]), 10)
    lines = []
    lines.append("1" + "01" + " " + o["routing_number"] + " " + o["routing_number"] + now.strftime("%y%m%d%H%M") + "A" + "094" + "10" + "1"
                 + _alnum(o.get("bank_name") or "BANK", 23) + _alnum(o["name"], 23) + _alnum(body["batch_ref"][-8:], 8))
    lines.append("5" + "220" + _alnum(o["name"], 16) + _alnum("", 20) + company_id + "CCD" + _alnum("PAYMENT", 10) + _alnum(eff, 6)
                 + eff + "   " + "1" + odfi + _num(1, 7))
    entry_hash = 0
    total = 0
    for i, p in enumerate(body["payments"], 1):
        b = p["beneficiary"]
        rdfi = b["routing_number"]
        entry_hash += int(rdfi[:8])
        total += p["amount_cents"]
        lines.append("6" + "22" + rdfi[:8] + rdfi[8] + _alnum(b["account_number"], 17, upper=False) + _num(p["amount_cents"], 10)
                     + _alnum(p["reference"], 15) + _alnum(b["name"], 22) + "  " + "0" + odfi + _num(i, 7))
    n = len(body["payments"])
    eh = _num(entry_hash % 10_000_000_000, 10)
    lines.append("8" + "220" + _num(n, 6) + eh + _num(0, 12) + _num(total, 12) + company_id + " " * 19 + " " * 6 + odfi + _num(1, 7))
    records = len(lines) + 1
    blocks = (records + 9) // 10
    lines.append("9" + _num(1, 6) + _num(blocks, 6) + _num(n, 8) + eh + _num(0, 12) + _num(total, 12) + " " * 39)
    while len(lines) % 10:
        lines.append("9" * 94)
    for ln in lines:
        assert len(ln) == 94, (len(ln), ln)
    return "\r\n".join(lines) + "\r\n"


def fedwire(body: dict) -> str:
    o = body["originator"]
    date = body["value_date"].replace("-", "")
    msgs = []
    for i, p in enumerate(body["payments"], 1):
        b = p["beneficiary"]
        tags = [
            "{1500}30" + " " * 8 + "T ",
            "{1510}1000",
            "{1520}" + date + _alnum("SEAPORTG", 8) + _num(i, 6),
            "{2000}" + _num(p["amount_cents"], 12),
            "{3100}" + o["routing_number"] + _alnum(o.get("bank_name") or o["name"], 18).rstrip() + "*",
            "{3400}" + b["routing_number"] + _alnum(b.get("bank_name") or "BENEFICIARY BANK", 18).rstrip() + "*",
            "{3600}CTR",
            "{4200}D" + b["account_number"] + "*" + _alnum(b["name"], 35).rstrip() + "*",
            "{5000}D" + o["account_number"] + "*" + _alnum(o["name"], 35).rstrip() + "*",
            "{6000}" + _alnum(p.get("remittance") or p["reference"], 35).rstrip() + "*",
        ]
        msgs.append("".join(tags))
    return "\n".join(msgs) + "\n"


def _swift_amount(cents: int) -> str:
    return f"{cents // 100},{cents % 100:02d}"


def mt103(body: dict) -> str:
    o = body["originator"]
    vd = body["value_date"].replace("-", "")[2:]
    out = []
    for p in body["payments"]:
        b = p["beneficiary"]
        sender = (o["bic"] + "XXX")[:8] + "A" + (o["bic"] + "XXX")[8:11]
        out.append(
            "{1:F01" + sender + "0000000000}{2:I103" + (b["bic"] + "XXX")[:8] + "X" + (b["bic"] + "XXX")[8:11] + "N}{4:\r\n"
            + f":20:{p['reference'][:16]}\r\n:23B:CRED\r\n:32A:{vd}{body['currency']}{_swift_amount(p['amount_cents'])}\r\n"
            + f":50K:/{(o.get('iban') or o.get('account_number')).replace(' ', '')}\r\n{_alnum(o['name'], 35, False).rstrip()}\r\n"
            + f":57A:{b['bic']}\r\n:59:/{b['iban'].replace(' ', '')}\r\n{_alnum(b['name'], 35, False).rstrip()}\r\n"
            + f":70:{_alnum(p.get('remittance') or p['reference'], 35, False).rstrip()}\r\n:71A:SHA\r\n-}}")
    return "\r\n".join(out) + "\r\n"


def pain001(body: dict) -> str:
    o = body["originator"]
    total = sum(p["amount_cents"] for p in body["payments"])
    amt = lambda c: f"{c // 100}.{c % 100:02d}"  # noqa: E731
    tx = []
    for p in body["payments"]:
        b = p["beneficiary"]
        tx.append(f"""      <CdtTrfTxInf>
        <PmtId><EndToEndId>{escape(p['reference'][:35])}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="{body['currency']}">{amt(p['amount_cents'])}</InstdAmt></Amt>
        <CdtrAgt><FinInstnId><BIC>{b['bic']}</BIC></FinInstnId></CdtrAgt>
        <Cdtr><Nm>{escape(b['name'][:70])}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>{b['iban'].replace(' ', '')}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>{escape((p.get('remittance') or p['reference'])[:140])}</Ustrd></RmtInf>
      </CdtTrfTxInf>""")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>{escape(body['batch_ref'])}</MsgId>
      <CreDtTm>{body['created_at'][:19]}</CreDtTm>
      <NbOfTxs>{len(body['payments'])}</NbOfTxs>
      <CtrlSum>{amt(total)}</CtrlSum>
      <InitgPty><Nm>{escape(o['name'])}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>{escape(body['batch_ref'])}-1</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>{len(body['payments'])}</NbOfTxs>
      <CtrlSum>{amt(total)}</CtrlSum>
      <ReqdExctnDt>{body['value_date']}</ReqdExctnDt>
      <Dbtr><Nm>{escape(o['name'])}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>{(o.get('iban') or '').replace(' ', '')}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BIC>{o['bic']}</BIC></FinInstnId></DbtrAgt>
{chr(10).join(tx)}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
"""


GENERATORS = {
    "ACH": (ach, "txt", "text/plain"),
    "FEDWIRE": (fedwire, "txt", "text/plain"),
    "SWIFT_MT103": (mt103, "fin", "text/plain"),
    "PAIN001": (pain001, "xml", "application/xml"),
}


def generate(body: dict) -> dict:
    rail = body.get("rail")
    if rail not in GENERATORS:
        raise EngineError(f"rail must be one of {', '.join(GENERATORS)}")
    for k in ("batch_ref", "value_date", "created_at", "currency"):
        if not body.get(k):
            raise EngineError(f"{k} is required")
    errors = validate(rail, body)
    total = sum(p.get("amount_cents") or 0 for p in body.get("payments") or [])
    if errors:
        return {"errors": errors, "count": len(body.get("payments") or []), "total_cents": total}
    fn, ext, ctype = GENERATORS[rail]
    return {"errors": [], "filename": f"{body['batch_ref']}_{rail.lower()}.{ext}", "content_type": ctype,
            "content": fn(body), "count": len(body["payments"]), "total_cents": total}
