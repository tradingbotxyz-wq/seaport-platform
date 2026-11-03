"""Brokerage analytics: simulated multi-venue market data, best-execution routing, trade economics.

Market data is deterministic for a given (instrument, venue, minute) so routing decisions are
reproducible and auditable. Replace `quotes()` with a real feed adapter (FIX / vendor API) in production.

Prices are per 100 nominal with 4 decimals, carried as integers in 1/10,000 (99.8750 -> 998750).
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime

from errors import EngineError

VENUES = [
    {"code": "ALPHA", "name": "Venue Alpha (MTF, central limit order book)", "half_spread_bps": 4, "fee_bps": 0.5, "depth": 25_000_000},
    {"code": "BETA", "name": "Venue Beta (RFQ, multi-dealer)", "half_spread_bps": 6, "fee_bps": 0.25, "depth": 50_000_000},
    {"code": "GAMMA", "name": "Dealer Gamma (single dealer)", "half_spread_bps": 9, "fee_bps": 0.0, "depth": 100_000_000},
]
BASE_YIELD_BPS = {"TBILL": 430, "CP": 470, "BOND": 480, "POOL_NOTE": 560}


def _noise(*parts) -> float:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).digest()
    return (int.from_bytes(h[:4], "big") / 2**32) - 0.5  # -0.5 .. 0.5


def fair_price(inst: dict, as_of: date) -> float:
    mat = date.fromisoformat(inst["maturity_date"])
    days = max((mat - as_of).days, 1)
    y = (BASE_YIELD_BPS.get(inst["type"], 500) + int(inst.get("spread_bps") or 0)) / 10000
    if inst["type"] in ("TBILL", "CP"):
        return 100 * (1 - y * days / 360)
    coupon = (inst.get("coupon_bps") or 0) / 10000
    if inst["type"] == "POOL_NOTE":
        coupon = y - 0.0010  # floating note priced near par
    n = max(1, round(days / 182.5))
    c = coupon * 100 / 2
    r = y / 2
    return sum(c / (1 + r) ** k for k in range(1, n + 1)) + 100 / (1 + r) ** n


def accrued(inst: dict, settle: date, nominal: int) -> int:
    if inst["type"] not in ("BOND", "POOL_NOTE") or not inst.get("coupon_bps"):
        return 0
    mat = date.fromisoformat(inst["maturity_date"])
    # last coupon date: step back from maturity in 6-month periods
    y, m = mat.year, mat.month
    last = mat
    while last > settle:
        m -= 6
        if m <= 0:
            m += 12
            y -= 1
        last = date(y, m, min(mat.day, 28))
    days = (settle - last).days
    return round(nominal * inst["coupon_bps"] / 10000 * days / 360)


def quotes(inst: dict, ts: str) -> list[dict]:
    as_of = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    fair = fair_price(inst, as_of.date())
    minute = as_of.strftime("%Y-%m-%dT%H:%M")
    out = []
    for v in VENUES:
        mid = fair * (1 + _noise(inst["isin"], v["code"], minute) * 0.0006)
        hs = mid * v["half_spread_bps"] / 10000
        out.append({"venue": v["code"], "venue_name": v["name"], "bid": round((mid - hs) * 10000), "ask": round((mid + hs) * 10000),
                    "depth": v["depth"], "fee_bps": v["fee_bps"], "ts": minute})
    return out


def route(body: dict) -> dict:
    inst = body.get("instrument") or {}
    side = body.get("side")
    qty = body.get("quantity")
    if side not in ("BUY", "SELL"):
        raise EngineError("side must be BUY or SELL")
    if not isinstance(qty, int) or qty <= 0:
        raise EngineError("quantity (nominal, whole units) must be a positive integer")
    limit = body.get("limit_price")
    qs = quotes(inst, body.get("ts") or datetime.utcnow().isoformat())
    # Effective price including venue fee: buyers pay more, sellers receive less.
    def eff(q):
        px = q["ask"] if side == "BUY" else q["bid"]
        adj = px * q["fee_bps"] / 10000
        return px + adj if side == "BUY" else px - adj
    ranked = sorted(qs, key=eff, reverse=(side == "SELL"))
    fills, left = [], qty
    for q in ranked:
        if left <= 0:
            break
        px = q["ask"] if side == "BUY" else q["bid"]
        if limit is not None and ((side == "BUY" and px > limit) or (side == "SELL" and px < limit)):
            continue
        take = min(left, q["depth"])
        fills.append({"venue": q["venue"], "quantity": take, "price": px, "fee_bps": q["fee_bps"]})
        left -= take
    best = ranked[0]
    rationale = (f"Best effective {'offer' if side == 'BUY' else 'bid'} at {best['venue']} "
                 f"({(best['ask'] if side == 'BUY' else best['bid']) / 10000:.4f}, fee {best['fee_bps']} bps) of {len(qs)} venues polled at {best['ts']} UTC")
    return {"quotes": qs, "fills": fills, "unfilled": left, "rationale": rationale,
            "status": "FILLED" if left == 0 else ("PARTIALLY_FILLED" if fills else "NOT_FILLED")}


def economics(body: dict) -> dict:
    """Consideration, accrued interest, tiered commission, venue fees and introducer rebate for one fill."""
    inst = body["instrument"]
    qty = int(body["quantity"])
    price = int(body["price"])
    side = body["side"]
    settle = date.fromisoformat(body["settlement_date"])
    sched = body.get("schedule") or {"tiers": [[1_000_000, 25], [5_000_000, 15], [None, 8]], "min_cents": 25_000}
    principal = round(qty * 100 * price / 1_000_000)  # cents: qty (units) x price/100
    ai = accrued(inst, settle, qty * 100)
    notional = qty
    bps = sched["tiers"][-1][1]
    for cap, b in sched["tiers"]:
        if cap is None or notional <= cap:
            bps = b
            break
    commission = max(round(principal * bps / 10000), int(sched.get("min_cents") or 0))
    venue_fee = round(principal * float(body.get("fee_bps") or 0) / 10000)
    rebate = round(commission * int(body.get("rebate_bps_of_commission") or 0) / 10000)
    gross = principal + ai
    net = gross + commission + venue_fee if side == "BUY" else gross - commission - venue_fee
    return {"principal_cents": principal, "accrued_cents": ai, "commission_bps": bps, "commission_cents": commission,
            "venue_fee_cents": venue_fee, "rebate_cents": rebate, "net_cents": net}


def market(body: dict) -> dict:
    ts = body.get("ts") or datetime.utcnow().isoformat()
    out = []
    for inst in body.get("instruments") or []:
        qs = quotes(inst, ts)
        fair = fair_price(inst, datetime.fromisoformat(ts.replace("Z", "+00:00")).date())
        out.append({"isin": inst["isin"], "fair": round(fair * 10000), "best_bid": max(q["bid"] for q in qs), "best_ask": min(q["ask"] for q in qs), "quotes": qs})
    return {"ts": ts, "instruments": out, "venues": VENUES}
