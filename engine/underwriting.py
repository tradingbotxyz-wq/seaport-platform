"""Underwriting engine: financial spreading, ratio engine (incl. DSCR), configurable weighted
scorecard, risk rating, rules-based decision and pricing guidance.

Inputs are plain JSON; money is integer minor units. Ratios use Decimal and are returned as
strings rounded to 4 dp so the Node side can store and display them without float drift.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP, InvalidOperation

from errors import EngineError

D = Decimal

DEFAULT_MODEL = {
    "factors": [
        {"key": "dscr", "label": "Debt service coverage (DSCR)", "weight": 25, "direction": "higher",
         "bands": [[2.0, 100], [1.5, 80], [1.25, 60], [1.0, 30], [0, 0]]},
        {"key": "leverage", "label": "Debt / EBITDA", "weight": 15, "direction": "lower",
         "bands": [[1.5, 100], [2.5, 80], [3.5, 60], [5.0, 30], [1e9, 0]]},
        {"key": "interest_cover", "label": "Interest cover (EBITDA / interest)", "weight": 10, "direction": "higher",
         "bands": [[6, 100], [4, 80], [2.5, 60], [1.5, 30], [0, 0]]},
        {"key": "current_ratio", "label": "Current ratio", "weight": 10, "direction": "higher",
         "bands": [[2.0, 100], [1.5, 80], [1.2, 60], [1.0, 40], [0, 10]]},
        {"key": "ebitda_margin", "label": "EBITDA margin", "weight": 10, "direction": "higher",
         "bands": [[0.20, 100], [0.12, 80], [0.08, 60], [0.04, 30], [-1e9, 0]]},
        {"key": "revenue_growth", "label": "Revenue growth (YoY)", "weight": 5, "direction": "higher",
         "bands": [[0.10, 100], [0.03, 75], [0, 50], [-0.10, 20], [-1e9, 0]]},
        {"key": "bureau_score", "label": "Credit bureau score", "weight": 15, "direction": "higher",
         "bands": [[80, 100], [65, 75], [50, 50], [35, 25], [0, 0]]},
        {"key": "years_trading", "label": "Years trading", "weight": 5, "direction": "higher",
         "bands": [[10, 100], [5, 70], [3, 40], [0, 10]]},
        {"key": "payment_dbt", "label": "Days beyond terms (bureau)", "weight": 5, "direction": "lower",
         "bands": [[5, 100], [15, 70], [30, 40], [60, 10], [1e9, 0]]},
    ],
    "rating_scale": [[85, "A"], [78, "A-"], [72, "BBB+"], [66, "BBB"], [60, "BBB-"], [54, "BB+"],
                     [48, "BB"], [42, "BB-"], [36, "B+"], [30, "B"], [0, "CCC"]],
    "rules": {
        "knockout_min_dscr": 1.0,
        "knockout_max_leverage": 6.0,
        "knockout_min_bureau": 25,
        "refer_min_dscr": 1.25,
        "refer_worst_rating": "BB-",
        "refer_max_ltv": 0.80,
        "min_financial_years": 2,
        "authority_limit_usd_cents": 2_500_000_000,
    },
    "pricing_grid": {
        "A": [110, 45], "A-": [120, 50], "BBB+": [135, 55], "BBB": [150, 60], "BBB-": [165, 65],
        "BB+": [180, 70], "BB": [200, 78], "BB-": [215, 84], "B+": [240, 95], "B": [270, 110], "CCC": [320, 140],
    },
}

FIN_FIELDS = ["revenue_cents", "ebitda_cents", "interest_expense_cents", "total_debt_cents",
              "current_assets_cents", "current_liabilities_cents", "net_worth_cents", "debt_service_cents"]
SCALE = [r for _, r in DEFAULT_MODEL["rating_scale"]]


def _q(x: D | None) -> str | None:
    return None if x is None else str(x.quantize(D("0.0001"), rounding=ROUND_HALF_UP))


def _div(a: int, b: int) -> D | None:
    if b == 0:
        return None
    return D(a) / D(b)


def spread(financials: list[dict]) -> list[dict]:
    """Ratios per fiscal year, oldest first."""
    years = sorted(financials, key=lambda f: f.get("year", 0))
    out = []
    prev = None
    for f in years:
        for k in FIN_FIELDS:
            v = f.get(k)
            if isinstance(v, bool) or not isinstance(v, int):
                raise EngineError(f"financials[{f.get('year')}].{k} must be an integer (minor units)")
        ebitda = f["ebitda_cents"]
        r = {
            "year": f.get("year"),
            "dscr": _div(ebitda, f["debt_service_cents"]),
            "leverage": _div(f["total_debt_cents"], ebitda) if ebitda > 0 else None,
            "interest_cover": _div(ebitda, f["interest_expense_cents"]),
            "current_ratio": _div(f["current_assets_cents"], f["current_liabilities_cents"]),
            "ebitda_margin": _div(ebitda, f["revenue_cents"]),
            "revenue_growth": (D(f["revenue_cents"]) / D(prev["revenue_cents"]) - 1) if prev and prev["revenue_cents"] else None,
        }
        if ebitda <= 0:
            r["leverage_note"] = "EBITDA is zero or negative"
        out.append({"year": f.get("year"), **{k: (_q(v) if isinstance(v, D) else v) for k, v in r.items() if k != "year"}})
        prev = f
    return out


def _points(value: D | None, factor: dict) -> int:
    if value is None:
        return 0
    bands = factor["bands"]
    if factor.get("direction", "higher") == "higher":
        for threshold, pts in bands:
            if value >= D(str(threshold)):
                return int(pts)
        return 0
    for threshold, pts in bands:
        if value <= D(str(threshold)):
            return int(pts)
    return 0


def rating_for(score: D, scale: list) -> str:
    for floor, rating in scale:
        if score >= D(str(floor)):
            return rating
    return scale[-1][1]


def worse_than(rating: str, limit: str) -> bool:
    try:
        return SCALE.index(rating) > SCALE.index(limit)
    except ValueError:
        return False


def evaluate(body: dict) -> dict:
    model = body.get("model") or DEFAULT_MODEL
    rules = {**DEFAULT_MODEL["rules"], **(model.get("rules") or {})}
    financials = body.get("financials") or []
    if not financials:
        raise EngineError("at least one year of financials is required")
    profile = body.get("profile") or {}
    screening = body.get("screening") or {}
    try:
        requested = int(body.get("requested_limit_cents") or 0)
        collateral = int(body.get("collateral_value_cents") or 0)
        usd_amount = int(body.get("requested_usd_cents") or requested)
    except (TypeError, ValueError, InvalidOperation) as exc:
        raise EngineError("amounts must be integers") from exc

    spreads = spread(financials)
    latest = spreads[-1]
    values: dict[str, D | None] = {k: (D(latest[k]) if latest.get(k) is not None else None)
                                   for k in ("dscr", "leverage", "interest_cover", "current_ratio", "ebitda_margin", "revenue_growth")}
    for k in ("bureau_score", "years_trading", "payment_dbt"):
        v = profile.get(k)
        values[k] = D(str(v)) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    ltv = (D(requested) / D(collateral)) if collateral > 0 else None

    factors = []
    total_w = D(0)
    total = D(0)
    for f in model["factors"]:
        w = D(str(f["weight"]))
        pts = _points(values.get(f["key"]), f)
        contrib = w * pts / 100
        total_w += w
        total += contrib
        factors.append({"key": f["key"], "label": f["label"], "weight": int(w), "value": _q(values.get(f["key"])),
                        "points": pts, "contribution": _q(contrib)})
    score = (total / total_w * 100) if total_w else D(0)
    score = score.quantize(D("0.01"), rounding=ROUND_HALF_UP)
    rating = rating_for(score, model["rating_scale"])

    knockouts, refers = [], []
    if screening.get("sanctions_hit"):
        knockouts.append("Sanctions screening match - cannot proceed without compliance clearance")
    dscr = values["dscr"]
    if dscr is None or dscr < D(str(rules["knockout_min_dscr"])):
        knockouts.append(f"DSCR {_q(dscr) or 'n/a'} below hard minimum {rules['knockout_min_dscr']}")
    lev = values["leverage"]
    if lev is None:
        knockouts.append("Leverage cannot be assessed: EBITDA is zero or negative")
    elif lev > D(str(rules["knockout_max_leverage"])):
        knockouts.append(f"Debt/EBITDA {_q(lev)} above hard maximum {rules['knockout_max_leverage']}")
    bureau = values["bureau_score"]
    if bureau is not None and bureau < D(str(rules["knockout_min_bureau"])):
        knockouts.append(f"Bureau score {bureau} below hard minimum {rules['knockout_min_bureau']}")

    if screening.get("pep_hit"):
        refers.append("Politically exposed person among owners/directors - enhanced due diligence required")
    if screening.get("adverse_media"):
        refers.append("Adverse media found - review required")
    if dscr is not None and dscr < D(str(rules["refer_min_dscr"])):
        refers.append(f"DSCR {_q(dscr)} below auto-approval level {rules['refer_min_dscr']}")
    if worse_than(rating, rules["refer_worst_rating"]):
        refers.append(f"Rating {rating} is below {rules['refer_worst_rating']}")
    if ltv is not None and ltv > D(str(rules["refer_max_ltv"])):
        refers.append(f"LTV {_q(ltv)} above {rules['refer_max_ltv']}")
    if len(financials) < int(rules["min_financial_years"]):
        refers.append(f"Fewer than {rules['min_financial_years']} years of financials")
    if usd_amount > int(rules["authority_limit_usd_cents"]):
        refers.append("Requested limit exceeds delegated credit authority - credit committee approval required")
    if values["bureau_score"] is None:
        refers.append("No credit bureau score available")

    outcome = "DECLINE" if knockouts else "REFER" if refers else "APPROVE"
    grid = model.get("pricing_grid") or DEFAULT_MODEL["pricing_grid"]
    guidance = grid.get(rating)
    return {
        "score": str(score),
        "rating": rating,
        "outcome": outcome,
        "knockouts": knockouts,
        "refers": refers,
        "factors": factors,
        "spreads": spreads,
        "ltv": _q(ltv),
        "committee_required": usd_amount > int(rules["authority_limit_usd_cents"]),
        "pricing_guidance": {"investor_margin_bps": guidance[0], "sp_spread_bps": guidance[1]} if guidance else None,
    }
