"""File parsing for invoice, settlement and bank-statement uploads (standard library only).

Supported formats: .csv / .txt / .tsv (any delimiter), .xlsx (Office Open XML), .pdf (text-based PDFs).
Columns are matched by header synonyms, so files from different clients/banks work without mapping.
Each data row is either returned normalised, or reported in `skipped` with a reason - never silently dropped.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
import zlib

MAX_INFLATED = 60 * 1024 * 1024  # bytes of decompressed content per file
from datetime import date, datetime, timedelta
from xml.etree import ElementTree as ET

from errors import EngineError

FIELDS = {
    "invoice": {
        "invoice_number": ["invoice", "invoice no", "invoice number", "invoice #", "inv no", "invoice id", "document number", "doc no"],
        "buyer": ["buyer", "obligor", "debtor", "customer", "buyer name", "obligor name", "account debtor"],
        "invoice_date": ["invoice date", "issue date", "doc date", "date"],
        "due_date": ["due date", "maturity", "maturity date", "payment due", "due"],
        "amount": ["amount", "invoice amount", "face amount", "face value", "original amount", "gross amount", "total", "value"],
        "currency": ["currency", "ccy", "cur"],
    },
    "settlement": {
        "loan_id": ["loan id", "loan", "loan ref", "loan reference", "loan no"],
        "invoice_number": ["invoice", "invoice no", "invoice number", "inv no"],
        "amount": ["amount received", "amount paid", "paid", "received", "amount", "payment amount"],
        "value_date": ["value date", "payment date", "date", "settlement date"],
        "bank_reference": ["bank reference", "bank ref", "reference", "confirmation", "va reference", "payment reference"],
        "currency": ["currency", "ccy"],
    },
    "bank": {
        "value_date": ["value date", "date", "booking date", "transaction date"],
        "reference": ["reference", "narrative", "description", "details", "remittance info", "payment details"],
        "amount": ["amount", "credit", "credit amount", "amount credited"],
        "currency": ["currency", "ccy"],
        "bank_reference": ["bank reference", "transaction id", "txn id", "bank ref", "end to end id"],
    },
}

REQUIRED = {
    "invoice": ["invoice_number", "buyer", "due_date", "amount"],
    "settlement": ["amount"],
    "bank": ["value_date", "reference", "amount"],
}

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _norm_header(h: str) -> str:
    return re.sub(r"[^a-z0-9#]+", " ", str(h).strip().lower()).strip()


def map_headers(headers: list[str], kind: str) -> dict[str, int]:
    """Map canonical field -> column index. Exact synonym matches win over partial ones."""
    norm = [_norm_header(h) for h in headers]
    mapping: dict[str, int] = {}
    used: set[int] = set()
    for exact in (True, False):
        for field, synonyms in FIELDS[kind].items():
            if field in mapping:
                continue
            for syn in synonyms:
                for i, h in enumerate(norm):
                    if i in used or not h:
                        continue
                    if (h == syn) if exact else (syn in h and len(syn) > 3):
                        mapping[field] = i
                        used.add(i)
                        break
                if field in mapping:
                    break
    return mapping


def parse_amount(value) -> int | None:
    """Return integer cents, or None when the text is not an unambiguous amount.

    Accepts 1,250,000.00 / USD 1 250 000 / 1.250.000,50 / and the debit notations
    -1,000.00, (1,000.00), 1,000.00-, 1,000.00 DR, −1,000.00 (Unicode minus). "CR" marks a credit.
    Ambiguous text such as 1.250 (thousands or decimals?) is refused rather than guessed.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if value != value or abs(value) > 1e13:  # NaN or absurd
            return None
        return int(round(float(value) * 100))
    s = str(value).strip().replace("\u2212", "-").replace("\u2013", "-").replace("\u00a0", " ")
    if not s or len(s) > 40:
        return None
    up = s.upper()
    neg = False
    if up.endswith("DR") or up.endswith(" D"):
        neg, s = True, s[:-2].strip()
    elif up.endswith("CR"):
        s = s[:-2].strip()
    if s.startswith("(") and s.endswith(")"):
        neg, s = True, s[1:-1].strip()
    elif s.startswith("(") or s.endswith(")"):
        return None
    s = re.sub(r"^[A-Za-z$\u00a3\u20ac\u00a5 ]+", "", s)  # leading currency code or symbol
    if s.startswith("-"):
        neg, s = (not neg) if neg else True, s[1:].strip()
    if s.endswith("-"):
        neg, s = True, s[:-1].strip()
    s = s.replace(" ", "").replace("'", "")
    if not re.fullmatch(r"[0-9.,]+", s):
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):  # European 1.250.000,50
            if not re.fullmatch(r"\d{1,3}(\.\d{3})*,\d{1,2}", s):
                return None
            s = s.replace(".", "").replace(",", ".")
        else:
            if not re.fullmatch(r"\d{1,3}(,\d{3})*\.\d{1,2}", s):
                return None
            s = s.replace(",", "")
    elif "," in s:
        if re.fullmatch(r"\d{1,3}(,\d{3})+", s):
            s = s.replace(",", "")
        elif re.fullmatch(r"\d+,\d{1,2}", s):
            s = s.replace(",", ".")
        else:
            return None
    elif "." in s:
        if re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
            return None  # 1.250 / 1.250.000: thousands separator or decimals - refuse to guess
        if not re.fullmatch(r"\d+(\.\d{1,2})?", s):
            return None
    try:
        cents = int(round(float(s) * 100))
    except ValueError:
        return None
    return -cents if neg else cents


def parse_date(value) -> str | None:
    """Return ISO yyyy-mm-dd. Day-first for ambiguous numeric dates (UK / India convention)."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) or re.fullmatch(r"\d{5}(\.\d+)?", str(value).strip()):
        serial = float(value)
        if 20000 < serial < 80000:  # Excel serial date
            return (date(1899, 12, 30) + timedelta(days=int(serial))).isoformat()
        return None
    s = str(value).strip()
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?", s)
    if m:
        y, mo, d = map(int, m.groups())
        return _safe(y, mo, d)
    m = re.fullmatch(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})", s)
    if m:
        a, b, y = map(int, m.groups())
        y = y + 2000 if y < 100 else y
        if a > 12:
            return _safe(y, b, a)
        if b > 12:
            return _safe(y, a, b)
        return _safe(y, b, a)  # day-first
    m = re.fullmatch(r"(\d{1,2})[ \-/]([A-Za-z]{3,9})[ \-/,]*(\d{2,4})", s)
    if m:
        d, mon, y = m.groups()
        mo = MONTHS.get(mon[:3].lower())
        y = int(y) + 2000 if int(y) < 100 else int(y)
        return _safe(y, mo, int(d)) if mo else None
    m = re.fullmatch(r"([A-Za-z]{3,9})[ \-](\d{1,2}),?[ \-](\d{2,4})", s)
    if m:
        mon, d, y = m.groups()
        mo = MONTHS.get(mon[:3].lower())
        y = int(y) + 2000 if int(y) < 100 else int(y)
        return _safe(y, mo, int(d)) if mo else None
    return None


def _safe(y, mo, d) -> str | None:
    try:
        return date(y, mo, d).isoformat()
    except (TypeError, ValueError):
        return None


# ---------- format readers: each returns a list of rows (list of cell values) ----------

def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace")


def read_delimited(data: bytes) -> list[list[str]]:
    text = _decode(data)
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        delim = dialect.delimiter
    except csv.Error:
        delim = max([",", ";", "\t", "|"], key=sample.count)
    return [row for row in csv.reader(io.StringIO(text), delimiter=delim) if any(c.strip() for c in row)]


def _col_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_xlsx(data: bytes) -> list[list]:
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise EngineError("File is not a valid .xlsx workbook") from exc
    infos = z.infolist()
    if len(infos) > 500:
        raise EngineError("Workbook has too many parts")
    total = sum(i.file_size for i in infos)
    if total > MAX_INFLATED:
        raise EngineError("Workbook expands to more than 60 MB; split it into smaller files")
    for i in infos:
        if i.compress_size and i.file_size / i.compress_size > 200:
            raise EngineError("Workbook compression ratio is suspicious (possible zip bomb)")

    def read_part(name: str) -> bytes:
        with z.open(name) as fh:
            out = fh.read(MAX_INFLATED + 1)  # never trust the declared size
        if len(out) > MAX_INFLATED:
            raise EngineError("Workbook part too large")
        return out

    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(read_part("xl/sharedStrings.xml"))
        for si in root.findall("m:si", ns):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
    sheets = sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    if not sheets:
        raise EngineError("Workbook has no worksheets")
    root = ET.fromstring(read_part(sheets[0]))
    rows = []
    for r in root.iter(f"{{{ns['m']}}}row"):
        cells: dict[int, object] = {}
        for c in r.findall("m:c", ns):
            t = c.get("t")
            v = c.find("m:v", ns)
            if t == "s" and v is not None:
                try:
                    val = shared[int(v.text)]
                except (ValueError, IndexError, TypeError):
                    raise EngineError("Workbook references a missing shared string") from None
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(f"{{{ns['m']}}}t"))
            elif v is not None:
                val = v.text
                if t not in ("str", "b", "e"):
                    try:
                        f = float(val)
                        val = int(f) if f.is_integer() and abs(f) < 1e15 else f
                    except ValueError:
                        pass
            else:
                continue
            cells[_col_index(c.get("r", "A1"))] = val
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return rows


def _pdf_text(data: bytes) -> str:
    """Extract text from text-based PDFs.

    Inflates content streams, tracks the text position (BT/Td/TD/Tm/T*), and groups text
    fragments by their y coordinate so table rows come back as lines, cells separated by
    two spaces (read_pdf then splits on that).
    """
    chunks = []
    inflated = 0
    pos = 0
    while len(chunks) < 2000:  # linear scan for stream ... endstream (no backtracking regex)
        start = data.find(b"stream", pos)
        if start < 0:
            break
        body = start + 6
        if data[body:body + 2] == b"\r\n":
            body += 2
        elif data[body:body + 1] in (b"\n", b"\r"):
            body += 1
        else:
            pos = body
            continue
        end = data.find(b"endstream", body)
        if end < 0:
            break
        raw = data[body:end].rstrip(b"\r\n")
        pos = end + 9
        try:
            d = zlib.decompressobj()
            out = d.decompress(raw, MAX_INFLATED - inflated + 1)
            if len(out) > MAX_INFLATED - inflated:
                raise EngineError("PDF expands to more than 60 MB of content; it cannot be read")
        except zlib.error:
            out = raw
        inflated += len(out)
        chunks.append(out)

    def unescape(s: bytes) -> str:
        s = re.sub(rb"\\([nrtbf()\\])", lambda x: {b"n": b" ", b"r": b"", b"t": b" ", b"b": b"", b"f": b"", b"(": b"(", b")": b")", b"\\": b"\\"}[x.group(1)], s)
        s = re.sub(rb"\\(\d{1,3})", lambda x: bytes([int(x.group(1), 8) & 0xFF]), s)
        return s.decode("latin-1")

    num = rb"-?\d+\.?\d*|-?\.\d+"
    tok = re.compile(rb"\((?:\\.|[^\\)])*\)|\[(?:\\.|[^\]])*\]|" + num + rb"|[A-Za-z\*']+")
    fragments: list[tuple[float, float, str]] = []
    for chunk in chunks:
        x = y = lx = ly = 0.0
        leading = 0.0
        stack: list[bytes] = []
        for t in tok.findall(chunk):
            if t[:1] in (b"(", b"[") or re.fullmatch(num, t):
                stack.append(t)
                continue
            op = t
            nums = [float(s) for s in stack if re.fullmatch(num, s)]
            if op == b"BT":
                x = y = lx = ly = 0.0
            elif op == b"Tm" and len(nums) >= 6:
                x = lx = nums[-2]
                y = ly = nums[-1]
            elif op in (b"Td", b"TD") and len(nums) >= 2:
                lx += nums[-2]
                ly += nums[-1]
                x, y = lx, ly
                if op == b"TD":
                    leading = -nums[-1]
            elif op == b"TL" and nums:
                leading = nums[-1]
            elif op in (b"T*", b"'"):
                ly -= leading or 12
                x, y = lx, ly
            if op in (b"Tj", b"'") and stack and stack[-1][:1] == b"(":
                fragments.append((y, x, unescape(stack[-1][1:-1])))
            elif op == b"TJ" and stack and stack[-1][:1] == b"[":
                text = ""
                for s, kern in re.findall(rb"\(((?:\\.|[^\\)])*)\)|(" + num + rb")", stack[-1][1:-1]):
                    if s:
                        text += unescape(s)
                    elif kern and float(kern) < -200:
                        text += " "
                fragments.append((y, x, text))
            stack = []
    rows: dict[int, list[tuple[float, str]]] = {}
    for y, x, text in fragments:
        if text.strip():
            rows.setdefault(round(y / 2), []).append((x, text.strip()))
    return "\n".join("  ".join(t for _, t in sorted(cells)) for _, cells in sorted(rows.items(), key=lambda kv: -kv[0]))


def read_pdf(data: bytes) -> list[list[str]]:
    if not data.startswith(b"%PDF"):
        raise EngineError("File is not a PDF")
    text = _pdf_text(data)
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if "|" in line:
            rows.append([c.strip() for c in line.split("|")])
        elif "," in line and line.count(",") >= 3 and not re.search(r"\d,\d{3}", line):
            rows.append([c.strip() for c in line.split(",")])
        else:
            rows.append([c.strip() for c in re.split(r"\s{2,}|\t", line)])
    return rows


def read_rows(filename: str, data: bytes) -> tuple[str, list[list]]:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext == "xlsx":
        return "xlsx", read_xlsx(data)
    if ext == "xls":
        raise EngineError("Legacy .xls is not supported; please save as .xlsx or .csv")
    if ext == "pdf":
        return "pdf", read_pdf(data)
    if ext in ("csv", "txt", "tsv", ""):
        return ext or "txt", read_delimited(data)
    if data[:2] == b"PK":
        return "xlsx", read_xlsx(data)
    if data[:4] == b"%PDF":
        return "pdf", read_pdf(data)
    return ext, read_delimited(data)


def parse(filename: str, data: bytes, kind: str) -> dict:
    if kind not in FIELDS:
        raise EngineError(f"unknown kind {kind}")
    fmt, rows = read_rows(filename, data)
    # Find the header row: the first row (within the first 25) that maps every required field.
    header_idx, mapping = None, {}
    for i, row in enumerate(rows[:25]):
        m = map_headers([str(c) for c in row], kind)
        if all(f in m for f in REQUIRED[kind]):
            header_idx, mapping = i, m
            break
    if header_idx is None:
        return {"format": fmt, "rows": [], "skipped": [], "rows_read": 0,
                "warnings": [f"No header row found with columns: {', '.join(REQUIRED[kind])}"]}

    out, skipped = [], []
    for n, row in enumerate(rows[header_idx + 1:], start=header_idx + 2):
        get = lambda f: row[mapping[f]] if f in mapping and mapping[f] < len(row) else None  # noqa: E731
        if all(str(c).strip() == "" for c in row):
            continue
        if any(str(c).strip().lower().startswith(("total", "subtotal")) for c in row[:2]):
            continue
        rec, problems = {"line": n}, []
        for field in FIELDS[kind]:
            raw = get(field)
            if field == "amount":
                val = parse_amount(raw)
                if val is None:
                    problems.append("amount missing or unreadable")
                elif val < 0 or (val == 0 and kind != "settlement"):
                    problems.append("amount must be positive")
                rec["amount_cents"] = val
            elif field.endswith("_date"):
                val = parse_date(raw)
                if raw not in (None, "") and val is None:
                    problems.append(f"{field.replace('_', ' ')} unreadable ({raw})")
                rec[field] = val
            else:
                rec[field] = str(raw).strip() if raw not in (None, "") else None
        for f in REQUIRED[kind]:
            key = "amount_cents" if f == "amount" else f
            if rec.get(key) in (None, "") and not any(f.replace("_", " ") in p for p in problems):
                problems.append(f"{f.replace('_', ' ')} missing")
        if kind == "invoice" and rec.get("invoice_date") and rec.get("due_date") and rec["due_date"] < rec["invoice_date"]:
            problems.append("due date is before invoice date")
        if kind == "settlement" and not (rec.get("loan_id") or rec.get("invoice_number")):
            problems.append("loan id or invoice number required")
        if problems:
            skipped.append({"line": n, "reasons": problems, "raw": [str(c) for c in row]})
        else:
            if rec.get("currency"):
                rec["currency"] = rec["currency"].upper()[:3]
            out.append(rec)
    return {"format": fmt, "rows": out, "skipped": skipped, "rows_read": len(out) + len(skipped), "warnings": []}
