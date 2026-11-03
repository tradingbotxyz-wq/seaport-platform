"""Servicing analytics: variable-rate amortisation schedules and workout (restructuring) scenario modelling.

amortize: level-payment schedule recomputed at each rate reset (the payment is re-solved on the
  remaining balance and remaining periods whenever the rate changes). Interest per period uses the
  day count between payment dates. The final payment clears the balance exactly.

workout: compares recovery options for a distressed exposure on a present-value basis:
  enforce   - recover recovery_rate x exposure after recovery_months, less legal costs
  extend    - full repayment after extension_days with a default probability, else enforce
  plan      - amortising instalment plan; each instalment is paid with (1 - monthly default prob)
              survival, remaining balance recovered at the enforcement rate on default
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from errors import EngineError

D = Decimal


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    days = [31, 29 if y % 4 == 0 and (y % 100 != 0 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return date(y, m, min(d.day, days))


def _cents(x: D) -> int:
    return int(x.quantize(D("1"), rounding=ROUND_HALF_UP))


def amortize(body: dict) -> dict:
    try:
        principal = int(body["principal_cents"])
        start = date.fromisoformat(body["start_date"])
        periods = int(body["periods"])
    except (KeyError, TypeError, ValueError) as exc:
        raise EngineError("principal_cents, start_date and periods are required") from exc
    freq = int(body.get("frequency_months") or 1)
    basis = D(360 if body.get("day_count", "ACT/360") == "ACT/360" else 365)
    margin = int(body.get("margin_bps") or 0)
    path = sorted(body.get("rate_path") or [{"from_period": 1, "base_bps": int(body.get("base_bps") or 0)}], key=lambda r: r["from_period"])
    if principal <= 0 or periods <= 0 or periods > 360:
        raise EngineError("principal must be positive and periods between 1 and 360")
    if path[0]["from_period"] != 1:
        raise EngineError("rate_path must start at period 1")

    def rate_for(k):
        r = path[0]["base_bps"]
        for p in path:
            if p["from_period"] <= k:
                r = p["base_bps"]
        return r + margin

    rows, bal, prev, payment, last_rate = [], D(principal), start, None, None
    total_interest = 0
    for k in range(1, periods + 1):
        due = _add_months(start, k * freq)
        days = (due - prev).days
        rate = rate_for(k)
        per_rate = D(rate) / D(10000) * D(days) / basis
        if rate != last_rate or payment is None:
            n = periods - k + 1
            payment = bal / n if per_rate == 0 else bal * per_rate / (1 - (1 + per_rate) ** -n)
            last_rate = rate
        interest = _cents(bal * per_rate)
        princ = _cents(payment) - interest
        if k == periods or princ > bal:
            princ = _cents(bal)
        bal -= princ
        total_interest += interest
        rows.append({"period": k, "due_date": due.isoformat(), "days": days, "rate_bps": rate, "payment_cents": interest + princ,
                     "interest_cents": interest, "principal_cents": princ, "balance_cents": _cents(bal)})
        prev = due
    return {"schedule": rows, "total_interest_cents": total_interest, "total_paid_cents": principal + total_interest,
            "final_date": rows[-1]["due_date"], "resets": len({r["rate_bps"] for r in rows})}


def workout(body: dict) -> dict:
    exposure = int(body.get("exposure_cents") or 0)
    if exposure <= 0:
        raise EngineError("exposure_cents must be positive")
    disc = float(body.get("discount_rate_bps") or 800) / 10000
    rec = float(body.get("recovery_rate", 0.55))
    rec_months = float(body.get("recovery_months", 9))
    legal = float(body.get("legal_cost_pct", 0.05))
    ext_days = int(body.get("extension_days", 90))
    ext_pd = float(body.get("extension_default_prob", 0.25))
    plan = body.get("plan") or {}
    plan_months = int(plan.get("months", 12))
    plan_rate = int(plan.get("rate_bps", 900))
    plan_mpd = float(plan.get("monthly_default_prob", 0.015))
    for name, v in (("recovery_rate", rec), ("legal_cost_pct", legal), ("extension_default_prob", ext_pd), ("monthly_default_prob", plan_mpd)):
        if not 0 <= v <= 1:
            raise EngineError(f"{name} must be between 0 and 1")

    pv = lambda amt, months: amt / (1 + disc) ** (months / 12)  # noqa: E731
    enforce_cash = exposure * rec * (1 - legal)
    options = [{"option": "Enforce / recover now", "expected_cash_cents": round(enforce_cash), "npv_cents": round(pv(enforce_cash, rec_months)),
                "timing_months": rec_months, "detail": f"{rec:.0%} recovery after {rec_months:g} months, {legal:.0%} legal costs"}]

    ext_m = ext_days / 30.4
    ext_cash = (1 - ext_pd) * exposure
    ext_npv = (1 - ext_pd) * pv(exposure, ext_m) + ext_pd * pv(enforce_cash, ext_m + rec_months)
    options.append({"option": f"Extend {ext_days} days", "expected_cash_cents": round(ext_cash + ext_pd * enforce_cash), "npv_cents": round(ext_npv),
                    "timing_months": round(ext_m, 1), "detail": f"{ext_pd:.0%} probability it still defaults, then enforcement"})

    sched = amortize({"principal_cents": exposure, "start_date": body.get("start_date") or date.today().isoformat(), "periods": plan_months,
                      "base_bps": plan_rate})["schedule"]
    survive, npv, cash = 1.0, 0.0, 0.0
    for r in sched:
        m = r["period"]
        npv += survive * (1 - plan_mpd) * pv(r["payment_cents"], m)
        cash += survive * (1 - plan_mpd) * r["payment_cents"]
        default_now = survive * plan_mpd
        recovered = (r["balance_cents"] + r["principal_cents"]) * rec * (1 - legal)
        npv += default_now * pv(recovered, m + rec_months)
        cash += default_now * recovered
        survive *= (1 - plan_mpd)
    options.append({"option": f"Instalment plan {plan_months} months @ {plan_rate / 100:.2f}%", "expected_cash_cents": round(cash), "npv_cents": round(npv),
                    "timing_months": plan_months, "detail": f"{plan_mpd:.1%} monthly default probability; balance recovered at {rec:.0%} on default",
                    "schedule": sched})
    best = max(options, key=lambda o: o["npv_cents"])
    for o in options:
        o["expected_loss_cents"] = exposure - o["npv_cents"]
        o["recommended"] = o is best
    return {"exposure_cents": exposure, "discount_rate_bps": round(disc * 10000), "options": options, "recommendation": best["option"]}
