"""Minimal PDF writer (standard library only) for credit memos, term sheets, statements and reports.

Document spec (JSON):
  {title, subtitle?, meta?: [[label, value], ...], sections: [
      {heading?, paragraphs?: [str], table?: {columns: [str], rows: [[str]], align?: ['l'|'r'], widths?: [num]},
       kv?: [[label, value]]}
  ], footer?}
Uses the built-in Helvetica fonts (WinAnsi), A4 portrait, automatic word wrap and page breaks.
"""

from __future__ import annotations

import zlib

W, H = 595.28, 841.89
MARGIN = 48
BRAND = (0.12, 0.54, 0.75)
TEXT = (0.11, 0.14, 0.19)
MUTED = (0.37, 0.42, 0.47)
RULE = (0.86, 0.89, 0.92)

# Helvetica advance widths (1/1000 em) for ASCII 32..126.
_HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
       556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
       1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
       667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
       333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
       556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]


def text_width(s: str, size: float, bold: bool = False) -> float:
    w = 0
    for ch in s:
        o = ord(ch)
        w += _HW[o - 32] if 32 <= o <= 126 else 556
    return w * size / 1000 * (1.06 if bold else 1)


def _esc(s: str) -> bytes:
    b = str(s).encode("cp1252", errors="replace")
    return b.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def wrap(s: str, size: float, width: float, bold=False) -> list[str]:
    lines = []
    for para in str(s).split("\n"):
        words = para.split(" ")
        cur = ""
        for word in words:
            trial = (cur + " " + word).strip()
            if text_width(trial, size, bold) <= width or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


class _Doc:
    def __init__(self, title: str, footer: str):
        self.pages: list[list[str]] = []
        self.title = title
        self.footer = footer
        self.new_page()

    def new_page(self):
        self.ops: list[str] = []
        self.pages.append(self.ops)
        self.y = H - MARGIN

    def ensure(self, needed: float):
        if self.y - needed < MARGIN + 24:
            self.new_page()
            self.text(MARGIN, self.y - 10, self.title, 8, color=MUTED)
            self.y -= 26

    def color(self, rgb, stroke=False):
        self.ops.append("%.3f %.3f %.3f %s" % (*rgb, "RG" if stroke else "rg"))

    def text(self, x, y, s, size=10, bold=False, color=TEXT):
        self.color(color)
        font = "F2" if bold else "F1"
        self.ops.append(f"BT /{font} {size:.1f} Tf {x:.2f} {y:.2f} Td ({_esc(s).decode('latin-1')}) Tj ET")

    def rule(self, y, color=RULE, x0=MARGIN, x1=W - MARGIN, width=0.6):
        self.color(color, stroke=True)
        self.ops.append(f"{width} w {x0:.2f} {y:.2f} m {x1:.2f} {y:.2f} l S")

    def rect(self, x, y, w, h, rgb):
        self.color(rgb)
        self.ops.append(f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re f")

    def para(self, s, size=9.5, bold=False, color=TEXT, gap=4):
        for line in wrap(s, size, W - 2 * MARGIN, bold):
            self.ensure(size + 4)
            self.y -= size + 3
            self.text(MARGIN, self.y, line, size, bold, color)
        self.y -= gap


def build(spec: dict) -> bytes:
    title = str(spec.get("title") or "Document")
    doc = _Doc(title, str(spec.get("footer") or ""))
    # Header band
    doc.rect(0, H - 6, W, 6, BRAND)
    doc.text(MARGIN, H - MARGIN + 6, "Seaport Global", 11, True, BRAND)
    doc.text(MARGIN + text_width("Seaport Global ", 11, True), H - MARGIN + 6, "WORKING CAPITAL", 7.5, True, MUTED)
    doc.y = H - MARGIN - 20
    doc.para(title, 17, True, gap=2)
    if spec.get("subtitle"):
        doc.para(spec["subtitle"], 10, color=MUTED, gap=6)
    meta = spec.get("meta") or []
    if meta:
        _kv(doc, meta)
    for sec in spec.get("sections") or []:
        if sec.get("heading"):
            doc.ensure(48)
            doc.y -= 20
            doc.text(MARGIN, doc.y, str(sec["heading"]), 11.5, True)
            doc.y -= 6
            doc.rule(doc.y, BRAND, width=1)
            doc.y -= 4
        for p in sec.get("paragraphs") or []:
            doc.para(p)
        if sec.get("kv"):
            _kv(doc, sec["kv"])
        if sec.get("table"):
            _table(doc, sec["table"])
        for b in sec.get("bullets") or []:
            lines = wrap(str(b), 9.5, W - 2 * MARGIN - 12)
            for i, line in enumerate(lines):
                doc.ensure(13)
                doc.y -= 12.5
                if i == 0:
                    doc.text(MARGIN + 2, doc.y, "\x95", 9.5)
                doc.text(MARGIN + 12, doc.y, line, 9.5)
            doc.y -= 2
    return _serialize(doc)


def _kv(doc: _Doc, rows):
    label_w = max(text_width(str(k), 9) for k, _ in rows) + 16
    for k, v in rows:
        lines = wrap(str(v), 9.5, W - 2 * MARGIN - label_w)
        doc.ensure(13 * len(lines))
        doc.y -= 13
        doc.text(MARGIN, doc.y, str(k), 9, color=MUTED)
        for i, line in enumerate(lines):
            if i:
                doc.y -= 12
            doc.text(MARGIN + label_w, doc.y, line, 9.5)
    doc.y -= 4


def _table(doc: _Doc, t: dict):
    cols = [str(c) for c in t.get("columns") or []]
    rows = [[("" if c is None else str(c)) for c in r] for r in t.get("rows") or []]
    n = len(cols)
    if not n:
        return
    align = t.get("align") or ["l"] + ["r"] * (n - 1)
    avail = W - 2 * MARGIN
    if t.get("widths"):
        tot = sum(t["widths"])
        widths = [avail * w / tot for w in t["widths"]]
    else:
        need = [max([text_width(cols[i], 8.5, True)] + [text_width(r[i], 8.5) for r in rows if i < len(r)]) + 12 for i in range(n)]
        scale = min(1, avail / sum(need))
        widths = [w * scale for w in need]
        widths[0] += avail - sum(widths)
    size = 8.5

    def header():
        doc.ensure(20)
        doc.rect(MARGIN, doc.y - 16, avail, 16, (0.95, 0.96, 0.98))
        x = MARGIN
        for i, c in enumerate(cols):
            tx = x + 5 if align[i] == "l" else x + widths[i] - 5 - text_width(c, size, True)
            doc.text(tx, doc.y - 11.5, c, size, True, MUTED)
            x += widths[i]
        doc.y -= 16

    header()
    for ri, r in enumerate(rows):
        bold = bool(t.get("total_last")) and ri == len(rows) - 1
        if doc.y - 15 < MARGIN + 24:
            doc.new_page()
            doc.text(MARGIN, doc.y - 10, doc.title, 8, color=MUTED)
            doc.y -= 26
            header()
        x = MARGIN
        for i in range(n):
            cell = r[i] if i < len(r) else ""
            maxw = widths[i] - 10
            while cell and text_width(cell, size, bold) > maxw:
                cell = cell[:-2] + "\x85"
            tx = x + 5 if align[i] == "l" else x + widths[i] - 5 - text_width(cell, size, bold)
            doc.text(tx, doc.y - 11, cell, size, bold)
            x += widths[i]
        doc.y -= 15
        doc.rule(doc.y)
    doc.y -= 6


def _serialize(doc: _Doc) -> bytes:
    objs: list[bytes] = []

    def add(b: bytes) -> int:
        objs.append(b)
        return len(objs)

    font1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    font2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    pages_id = len(objs) + 1 + 2 * len(doc.pages)  # reserved after page objects
    page_ids = []
    total = len(doc.pages)
    for i, ops in enumerate(doc.pages, 1):
        footer = f"BT /F1 7.5 Tf {MARGIN:.2f} 26 Td ({_esc(doc.footer).decode('latin-1')}) Tj ET" if doc.footer else ""
        num = f"Page {i} of {total}"
        footer += f" 0.37 0.42 0.47 rg BT /F1 7.5 Tf {W - MARGIN - text_width(num, 7.5):.2f} 26 Td ({num}) Tj ET"
        stream = zlib.compress(("\n".join(ops) + "\n0.37 0.42 0.47 rg " + footer).encode("latin-1"))
        content = add(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(stream) + stream + b"\nendstream")
        page_ids.append(add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> >>"
            % (pages_id, W, H, content, font1, font2)))
    assert len(objs) + 1 == pages_id
    add(b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % p for p in page_ids) + b"] /Count %d >>" % len(page_ids))
    info = add(b"<< /Title (" + _esc(doc.title) + b") /Producer (Seaport Global platform) >>")
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, catalog, info, xref)
    return bytes(out)
