"""Minimal .xlsx writer (Office Open XML, standard library only).

spec: {sheets: [{name, columns: [{label, type: 'text'|'number'|'money'|'percent'|'date', width?}], rows: [[...]]}], title?}
Money values are passed as numbers in major units (e.g. 1250000.5). Dates as ISO strings (written as text).
Header row is bold with a fill, frozen, and auto-filtered.
"""

from __future__ import annotations

import io
import re
import zipfile
from xml.sax.saxutils import escape

from errors import EngineError

STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F8AC0"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>"""

STYLE_FOR = {"money": 2, "percent": 3, "number": 4}


def _col(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _cell(ref: str, value, kind: str) -> str:
    if value is None or value == "":
        return ""
    if kind in STYLE_FOR and isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}" s="{STYLE_FOR[kind]}"><v>{value}</v></c>'
    text = escape(str(value))
    return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def _sheet(columns, rows) -> str:
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
           '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
           '<cols>']
    for i, c in enumerate(columns):
        width = c.get("width") or max(10, min(48, max([len(str(c["label"]))] + [len(str(r[i])) for r in rows[:200] if i < len(r)]) + 2))
        out.append(f'<col min="{i + 1}" max="{i + 1}" width="{width}" customWidth="1"/>')
    out.append('</cols><sheetData>')
    out.append('<row r="1">' + "".join(f'<c r="{_col(i)}1" t="inlineStr" s="1"><is><t>{escape(str(c["label"]))}</t></is></c>' for i, c in enumerate(columns)) + '</row>')
    for r_i, row in enumerate(rows, start=2):
        cells = "".join(_cell(f"{_col(i)}{r_i}", row[i] if i < len(row) else None, columns[i].get("type", "text")) for i in range(len(columns)))
        out.append(f'<row r="{r_i}">{cells}</row>')
    out.append('</sheetData>')
    if columns:
        out.append(f'<autoFilter ref="A1:{_col(len(columns) - 1)}{max(1, len(rows) + 1)}"/>')
    out.append('</worksheet>')
    return "".join(out)


def build(spec: dict) -> bytes:
    sheets = spec.get("sheets") or []
    if not sheets:
        raise EngineError("at least one sheet is required")
    names = []
    for s in sheets:
        name = re.sub(r"[\[\]\*\?/\\:]", " ", str(s.get("name") or "Sheet"))[:31] or "Sheet"
        while name in names:
            name = name[:28] + f"_{len(names)}"
        names.append(name)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(len(sheets)))
                   + '</Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + "".join(f'<sheet name="{escape(n)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, n in enumerate(names)) + '</sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join(f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(sheets)))
                   + f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        z.writestr("xl/styles.xml", STYLES)
        for i, s in enumerate(sheets):
            z.writestr(f"xl/worksheets/sheet{i + 1}.xml", _sheet(s.get("columns") or [], s.get("rows") or []))
    return buf.getvalue()
