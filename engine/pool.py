"""Pool analytics: loan selection under concentration limits, cash-flow projection, tranche waterfall,
stress testing and break-even analysis for pools of short-dated purchased receivables.

Loan input (amounts in minor units):
  {id, obligor, program, country, rating, outstanding_cents (amount due), principal_cents (purchase price
   outstanding), yield_bps (annualised all-in), days (remaining days to maturity, <0 = past due)}

Model (deterministic, scenario-based):
  * Default probability over the remaining life = annual PD(rating) x scenario multiplier x max(days, 30)/365,
    capped at 100%. Past-due loans use the scenario's past-due PD.
  * Loss = principal x PD x LGD + dilution x principal. Collections = due - loss, delayed by the scenario delay.
  * Waterfall: losses write down tranches in reverse seniority (equity first). Pool income (discount) pays
    senior then mezzanine coupons for the weighted remaining life; equity receives the excess spread.
  * Break-even: the PD multiplier at which a tranche takes its first loss (bisection).
"""

from __future__ import annotations

from errors import EngineError

PD = {"AAA": 0.0002, "AA+": 0.0003, "AA": 0.0004, "AA-": 0.0005, "A+": 0.0007, "A": 0.0010, "A-": 0.0015,
      "BBB+": 0.0022, "BBB": 0.0030, "BBB-": 0.0045, "BB+": 0.0075, "BB": 0.0110, "BB-": 0.0160,
      "B+": 0.0250, "B": 0.0350, "B-": 0.0500, "CCC": 0.1200}
RATING_ORDER = list(PD.keys())
SUB_IG = set(RATING_ORDER[RATING_ORDER.index("BB+"):])
SENIORITY = {"SENIOR": 0, "MEZZANINE": 1, "EQUITY": 2}

DEFAULT_SCENARIOS = [
    {"name": "Base", "pd_mult": 1.0, "lgd": 0.45, "dilution": 0.005, "delay_days": 5, "past_due_pd": 0.25},
    {"name": "Moderate stress", "pd_mult": 3.0, "lgd": 0.55, "dilution": 0.01, "delay_days": 15, "past_due_pd": 0.40},
    {"name": "Severe stress", "pd_mult": 8.0, "lgd": 0.65, "dilution": 0.02, "delay_days": 30, "past_due_pd": 0.60},
    {"name": "Top 3 obligors default", "top_n_default": 3, "pd_mult": 1.0, "lgd": 0.60, "dilution": 0.005, "delay_days": 5, "past_due_pd": 0.25},
]


def _loans(loans):
    if not isinstance(loans, list):
        raise EngineError("loans must be a list")
    for i, l in enumerate(loans):
        for k in ("outstanding_cents", "principal_cents", "days"):
            if not isinstance(l.get(k), int) or isinstance(l.get(k), bool):
                raise EngineError(f"loans[{i}].{k} must be an integer")
        if l.get("rating") not in PD:
            raise EngineError(f"loans[{i}].rating '{l.get('rating')}' is not on the rating scale")
    return loans


def concentration(loans, limits, target_cents):
    """Current concentration vs limits, measured on principal against max(target, current size)."""
    base = max(target_cents, sum(l["principal_cents"] for l in loans)) or 1
    out = []

    def agg(key):
        d = {}
        for l in loans:
            d[l[key]] = d.get(l[key], 0) + l["principal_cents"]
        return d

    checks = [("max_obligor_bps", "Single obligor", agg("obligor")),
              ("max_program_bps", "Single program", agg("program")),
              ("max_country_bps", "Single country", agg("country"))]
    for key, label, groups in checks:
        lim = limits.get(key)
        if not lim:
            continue
        name, amt = max(groups.items(), key=lambda kv: kv[1]) if groups else ("—", 0)
        bps = round(amt * 10000 / base)
        out.append({"key": key, "label": label, "limit_bps": lim, "largest": name, "amount_cents": amt, "bps": bps, "status": _status(bps, lim)})
    lim = limits.get("max_sub_ig_bps")
    if lim is not None:
        amt = sum(l["principal_cents"] for l in loans if l["rating"] in SUB_IG)
        bps = round(amt * 10000 / base)
        out.append({"key": "max_sub_ig_bps", "label": "Sub-investment grade (BB+ and below)", "limit_bps": lim, "largest": "BB+ or lower", "amount_cents": amt, "bps": bps, "status": _status(bps, lim)})
    return out


def _status(bps, lim):
    if bps > lim:
        return "Breach"
    if bps * 100 >= lim * 90:
        return "Tight"
    return "Good"


def select(body):
    """Greedy build: highest yield first, adding a loan only if every concentration limit still holds."""
    pool = _loans(body.get("current") or [])
    candidates = sorted(_loans(body.get("candidates") or []), key=lambda l: (-l.get("yield_bps", 0), l["days"]))
    target = int(body.get("target_size_cents") or 0)
    limits = body.get("limits") or {}
    if target <= 0:
        raise EngineError("target_size_cents must be positive")
    chosen, skipped = [], []
    size = sum(l["principal_cents"] for l in pool)
    for c in candidates:
        if size + c["principal_cents"] > target:
            skipped.append({"id": c["id"], "reason": "would exceed target size"})
            continue
        trial = pool + chosen + [c]
        breaches = [x for x in concentration(trial, limits, target) if x["status"] == "Breach"]
        if breaches:
            skipped.append({"id": c["id"], "reason": f"{breaches[0]['label']} limit ({breaches[0]['largest']})"})
            continue
        chosen.append(c)
        size += c["principal_cents"]
    return {"selected": [c["id"] for c in chosen], "skipped": skipped, "size_cents": size,
            "concentration": concentration(pool + chosen, limits, target)}


def _scenario_losses(loans, sc):
    mult, lgd, dil = float(sc.get("pd_mult", 1)), float(sc.get("lgd", 0.45)), float(sc.get("dilution", 0))
    defaulted = set()
    n = int(sc.get("top_n_default") or 0)
    if n:
        exp = {}
        for l in loans:
            exp[l["obligor"]] = exp.get(l["obligor"], 0) + l["principal_cents"]
        defaulted = {o for o, _ in sorted(exp.items(), key=lambda kv: -kv[1])[:n]}
    rows = []
    for l in loans:
        if l["obligor"] in defaulted:
            pd = 1.0
        elif l["days"] < 0:
            pd = float(sc.get("past_due_pd", 0.25))
        else:
            pd = min(1.0, PD[l["rating"]] * mult * max(l["days"], 30) / 365)
        loss = l["principal_cents"] * (pd * lgd + dil)
        rows.append((l, pd, loss))
    return rows


def run(loans, tranches, sc, as_of_days_basis=360):
    rows = _scenario_losses(loans, sc)
    principal = sum(l["principal_cents"] for l in loans)
    # Discount income is only earned on loans that pay: defaulted share of income is lost.
    income = sum((l["outstanding_cents"] - l["principal_cents"]) * (1 - pd) for l, pd, _ in rows)
    loss = sum(r[2] for r in rows)
    wal_days = (sum(max(l["days"], 0) * l["principal_cents"] for l in loans) / principal) if principal else 0
    ordered = sorted(tranches, key=lambda t: SENIORITY[t["name"]])
    tr = []
    attach = 10000
    for t in ordered:
        size = principal * t["pct_bps"] / 10000
        detach = attach
        attach = attach - t["pct_bps"]
        tr.append({"name": t["name"], "size": size, "coupon_bps": t.get("coupon_bps", 0), "attach_bps": attach, "detach_bps": detach, "loss": 0.0, "interest": 0.0})
    remaining = loss
    for t in reversed(tr):
        wd = min(remaining, t["size"])
        t["loss"] = wd
        remaining -= wd
    avail = income
    for t in tr:
        if t["name"] == "EQUITY":
            continue
        due = (t["size"] - t["loss"]) * t["coupon_bps"] / 10000 * wal_days / as_of_days_basis
        paid = min(avail, due)
        t["interest"] = paid
        t["shortfall"] = due - paid
        avail -= paid
    excess = avail
    for t in tr:
        if t["name"] == "EQUITY":
            t["interest"] = excess
            t["shortfall"] = 0.0
    return {
        "scenario": sc,
        "pool": {"principal_cents": round(principal), "expected_income_cents": round(income), "loss_cents": round(loss),
                 "loss_pct": round(loss / principal * 100, 3) if principal else 0, "excess_spread_cents": round(excess),
                 "wal_days": round(wal_days, 1)},
        "tranches": [{"name": t["name"], "size_cents": round(t["size"]), "attach_pct": t["attach_bps"] / 100, "detach_pct": t["detach_bps"] / 100,
                      "coupon_bps": t["coupon_bps"], "loss_cents": round(t["loss"]), "loss_pct": round(t["loss"] / t["size"] * 100, 3) if t["size"] else 0,
                      "interest_cents": round(t["interest"]), "interest_shortfall_cents": round(t.get("shortfall", 0)), "impaired": t["loss"] >= 1} for t in tr],
    }


def breakeven(loans, tranches, base):
    """PD multiplier (with base LGD) at which each debt tranche first loses principal."""
    out = {}
    for name in ("SENIOR", "MEZZANINE"):
        if not any(t["name"] == name for t in tranches):
            continue
        lo, hi = 0.0, 1000.0

        def hit(m):
            r = run(loans, tranches, {**base, "pd_mult": m, "top_n_default": 0})
            return next(t for t in r["tranches"] if t["name"] == name)["impaired"]

        if not hit(hi):
            out[name] = None
            continue
        for _ in range(40):
            mid = (lo + hi) / 2
            lo, hi = (lo, mid) if hit(mid) else (mid, hi)
        out[name] = round(hi, 2)
    return out


def cashflows(loans, sc, bucket_days=7, horizon_buckets=26):
    rows = _scenario_losses(loans, sc)
    delay = int(sc.get("delay_days", 0))
    buckets = [0.0] * horizon_buckets
    overdue = 0.0
    beyond = 0.0
    for l, _pd, loss in rows:
        cash = max(0.0, l["outstanding_cents"] - loss)
        day = l["days"] + delay
        if l["days"] < 0:
            overdue += cash
            continue
        idx = day // bucket_days
        if idx < horizon_buckets:
            buckets[idx] += cash
        else:
            beyond += cash
    return {"bucket_days": bucket_days, "overdue_cents": round(overdue), "beyond_cents": round(beyond),
            "buckets": [{"week": i + 1, "amount_cents": round(v)} for i, v in enumerate(buckets)]}


def stress(body):
    loans = _loans(body.get("loans") or [])
    tranches = body.get("tranches") or []
    if not loans:
        raise EngineError("the pool has no loans")
    if tranches and sum(t["pct_bps"] for t in tranches) != 10000:
        raise EngineError("tranche percentages must total 100%")
    for t in tranches:
        if t.get("name") not in SENIORITY:
            raise EngineError(f"unknown tranche {t.get('name')}")
    scenarios = body.get("scenarios") or DEFAULT_SCENARIOS
    for s in scenarios:
        for k in ("lgd", "dilution"):
            v = s.get(k, 0)
            if not isinstance(v, (int, float)) or not 0 <= v <= 1:
                raise EngineError(f"scenario {s.get('name')}: {k} must be between 0 and 1")
        if not isinstance(s.get("pd_mult", 1), (int, float)) or s.get("pd_mult", 1) < 0:
            raise EngineError(f"scenario {s.get('name')}: pd_mult must be >= 0")
    tranches = tranches or [{"name": "EQUITY", "pct_bps": 10000, "coupon_bps": 0}]
    return {
        "results": [run(loans, tranches, s) for s in scenarios],
        "breakeven_pd_multiple": breakeven(loans, tranches, scenarios[0]),
        "cashflows": cashflows(loans, scenarios[0]),
        "pd_table": PD,
    }
