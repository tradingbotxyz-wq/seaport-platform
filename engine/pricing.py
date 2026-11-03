"""Invoice purchase pricing and late-payment charges.

  Purchase price  = face amount x advance ratio
  Tenor           = due date - funding date (calendar days)
  Rate bucket     = 1-30 / 31-90 / 91-180 / 181+ days, each with its own benchmark fixing
  All-in rate     = benchmark (bucket) + investor margin + Seaport (SP) spread
  Interest        = purchase price x all-in x tenor / day-count basis
  To investor     = purchase price x (benchmark + investor margin) x tenor / basis
  Seaport share   = interest - to investor
  Late charge     = shortfall x (benchmark + late margin) x days past maturity / basis

Rates are integer basis points (4.35% = 435). Money is integer cents. Decimal arithmetic with
round-half-up to the cent, so results reconcile exactly with the master-table definitions.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from errors import EngineError

BUCKETS = [("1-30", 1, 30), ("31-90", 31, 90), ("91-180", 91, 180), ("181+", 181, 10_000)]
BASIS = {"ACT/360": 360, "ACT/365": 365}


def _cents(x: Decimal) -> int:
    return int(x.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _d(s: str, field: str) -> date:
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError) as exc:
        raise EngineError(f"{field} must be an ISO date (YYYY-MM-DD)") from exc


def bucket_for(tenor: int) -> str:
    for name, lo, hi in BUCKETS:
        if lo <= tenor <= hi:
            return name
    return BUCKETS[-1][0]


def _int(obj: dict, key: str, lo: int = 0) -> int:
    v = obj.get(key)
    if isinstance(v, bool) or not isinstance(v, int) or v < lo:
        raise EngineError(f"{key} must be an integer >= {lo}")
    return v


def price_batch(funding_date: str, day_count: str, fixings: dict, invoices: list) -> dict:
    fund = _d(funding_date, "funding_date")
    if day_count not in BASIS:
        raise EngineError(f"day_count must be one of {', '.join(BASIS)}")
    basis = Decimal(BASIS[day_count])
    missing = [b for b, _, _ in BUCKETS if not isinstance(fixings.get(b), int)]
    if missing:
        raise EngineError(f"benchmark fixings missing for buckets: {', '.join(missing)}")

    results = []
    weighted, weight = Decimal(0), Decimal(0)
    for inv in invoices:
        face = _int(inv, "face_cents", 1)
        adv = _int(inv, "adv_bps", 1)
        margin = _int(inv, "investor_margin_bps")
        spread = _int(inv, "sp_spread_bps")
        due = _d(inv.get("due_date"), "due_date")
        tenor = (due - fund).days
        purchase = _cents(Decimal(face) * adv / 10000)
        row = {"id": inv.get("id"), "face_cents": face, "adv_bps": adv, "purchase_cents": purchase, "tenor_days": tenor,
               "investor_margin_bps": margin, "sp_spread_bps": spread}
        if tenor <= 0:
            row.update({"priceable": False, "reason": "Due date is on or before the funding date",
                        "bucket": None, "base_bps": None, "all_in_bps": None,
                        "interest_cents": 0, "investor_interest_cents": 0, "seaport_interest_cents": 0})
        else:
            bucket = bucket_for(tenor)
            base = fixings[bucket]
            all_in = base + margin + spread
            interest = _cents(Decimal(purchase) * all_in * tenor / (basis * 10000))
            to_investor = _cents(Decimal(purchase) * (base + margin) * tenor / (basis * 10000))
            row.update({"priceable": True, "reason": None, "bucket": bucket, "base_bps": base, "all_in_bps": all_in,
                        "interest_cents": interest, "investor_interest_cents": to_investor,
                        "seaport_interest_cents": interest - to_investor})
            weighted += Decimal(purchase) * tenor
            weight += purchase
        results.append(row)
    return {
        "funding_date": funding_date,
        "day_count": day_count,
        "invoices": results,
        "weighted_tenor_days": int((weighted / weight).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) if weight else 0,
    }


def late_charges(as_of: str, day_count: str, margin_bps: int, items: list) -> dict:
    today = _d(as_of, "as_of")
    if day_count not in BASIS:
        raise EngineError(f"day_count must be one of {', '.join(BASIS)}")
    basis = Decimal(BASIS[day_count])
    out = []
    total = 0
    for it in items:
        shortfall = _int(it, "shortfall_cents")
        base = _int(it, "base_bps")
        maturity = _d(it.get("maturity_date"), "maturity_date")
        days = max((today - maturity).days, 0)
        charge = _cents(Decimal(shortfall) * (base + margin_bps) * days / (basis * 10000)) if shortfall and days else 0
        total += charge
        out.append({"id": it.get("id"), "days_past_due": days, "rate_bps": base + margin_bps, "charge_cents": charge})
    return {"as_of": as_of, "items": out, "total_cents": total}
