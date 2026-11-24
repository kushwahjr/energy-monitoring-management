"""Energy insights: find waste and savings in the logged data, and explain them in plain words.

Everything here runs offline on the logged readings. Each finding says what was seen,
what to do, and (when a tariff is set) roughly what it is worth per month.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .reports import daily_report, day_range

DEFAULT_TARIFF = {
    "currency": "₹",
    "billing": "kvah",          # "kvah" (most Indian HT tariffs) or "kwh"
    "energy_rate": 7.5,         # per kVAh or kWh
    "demand_rate": 450.0,       # per kVA of contract or recorded demand, per month
    "pf_target": 0.95,
    "peak_hours": [[18, 22]],   # time-of-day peak window(s), local hours [start, end)
    "peak_extra": 1.5,          # surcharge per unit in the peak window
}

# Machines whose running time can usually be moved out of peak hours.
SHIFTABLE = {"compressor", "pump", "ro_plant", "etp", "workshop", "hr_slitter", "cr_slitter",
             "trimming_line", "cut_to_length", "cooling_tower", "lighting"}

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "good": 3}


def tariff_from(raw: dict | None) -> dict:
    t = dict(DEFAULT_TARIFF)
    for k, v in (raw or {}).items():
        if k in DEFAULT_TARIFF:
            t[k] = v
    return t


def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    i = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[i]


def _in_peak(hour: int, windows) -> bool:
    for a, b in windows or []:
        if (a <= hour < b) if a <= b else (hour >= a or hour < b):
            return True
    return False


def _money(x: float | None, cur: str) -> str:
    if x is None:
        return ""
    if x >= 1e7:
        return f"{cur}{x / 1e7:.2f} crore"
    if x >= 1e5:
        return f"{cur}{x / 1e5:.2f} lakh"
    return f"{cur}{x:,.0f}"


def analyse(meters: list[dict], db, tz: ZoneInfo, tariff_raw: dict | None, block_minutes: int = 15,
            days: int = 14, now: datetime | None = None) -> dict:
    """meters: [{id, name, area, is_main, contract_kva, machine}]. Looks at the last `days` days."""
    tariff = tariff_from(tariff_raw)
    cur = tariff["currency"]
    now = now or datetime.now(tz)
    end_day = now.date() - timedelta(days=1)  # whole days only; today is still running
    start_day = end_day - timedelta(days=days - 1)
    t0, t1 = day_range(start_day, end_day, tz)
    week_cut = int(datetime.combine(end_day - timedelta(days=6), datetime.min.time(), tz).timestamp())
    ids = [m["id"] for m in meters]
    rows = db.readings(ids, t0, t1) if ids else []
    daily = daily_report(rows, tz, block_minutes)
    by_id = {m["id"]: m for m in meters}

    # ---- one pass over the readings ----
    st: dict[str, dict] = defaultdict(lambda: {
        "kw": [], "kw_ts": [], "hour_kw": defaultdict(list), "i_unb": [], "v_unb": [], "thd_v": [], "thd_i": [],
        "v_ln": [], "dt": [],
    })
    prev_ts: dict[str, int] = {}
    for r in rows:
        if r["ts"] < week_cut:
            continue
        s = st[r["meter_id"]]
        dt = min(r["ts"] - prev_ts.get(r["meter_id"], r["ts"]), 900) or 60
        prev_ts[r["meter_id"]] = r["ts"]
        if r["kw"] is not None:
            s["kw"].append(abs(r["kw"]))
            s["dt"].append(dt)
            s["hour_kw"][datetime.fromtimestamp(r["ts"], tz).hour].append(abs(r["kw"]))
        i = [r["i1"], r["i2"], r["i3"]]
        if None not in i and sum(i) > 3:
            avg = sum(i) / 3
            s["i_unb"].append(max(abs(x - avg) for x in i) / avg * 100)
        v = [r["v1"], r["v2"], r["v3"]]
        if None not in v and sum(v) > 30:
            avg = sum(v) / 3
            s["v_unb"].append(max(abs(x - avg) for x in v) / avg * 100)
        for k in ("thd_v", "thd_i", "v_ln"):
            if r[k] is not None:
                s[k].append(r[k])

    # daily totals per meter, split into this week / previous week
    week: dict[str, dict] = defaultdict(lambda: {"kwh": 0.0, "kvah": 0.0, "kvarh": 0.0, "days": 0, "prev_kwh": 0.0, "prev_days": 0,
                                                  "md": None, "md_at": None, "daily": []})
    cut_day = (end_day - timedelta(days=6)).isoformat()
    for d in daily:
        w = week[d["meter_id"]]
        w["daily"].append((d["date"], d["kwh"]))
        if d["date"] >= cut_day:
            w["kwh"] += d["kwh"]; w["kvah"] += d["kvah"]; w["kvarh"] += d["kvarh"]; w["days"] += 1
        else:
            w["prev_kwh"] += d["kwh"]; w["prev_days"] += 1
        if d["md_kva"] is not None and (w["md"] is None or d["md_kva"] > w["md"]):
            w["md"], w["md_at"] = d["md_kva"], f'{d["date"]} {d["md_kva_at"]}'

    out: list[dict] = []

    def add(sev, cat, m, title, detail, action, saving=None):
        out.append({"severity": sev, "category": cat, "meter_id": m and m["id"], "meter_name": m and m["name"],
                    "machine": m and m.get("machine"), "title": title, "detail": detail, "action": action,
                    "saving_month": round(saving) if saving else None})

    peak_list: list[tuple[dict, float]] = []
    mains = [m for m in meters if m.get("is_main")] or []
    feeders = [m for m in meters if not m.get("is_main")]
    month = 30.0

    # ---- plant level: power factor and kVAh billing ----
    for m in mains:
        w = week.get(m["id"])
        if not w or not w["kvah"]:
            continue
        pf = w["kwh"] / w["kvah"]
        avg_kw = w["kwh"] / max(w["days"] * 24, 1)
        target = float(tariff["pf_target"])
        if pf < target:
            kvar = avg_kw * (math.tan(math.acos(min(pf, 0.999))) - math.tan(math.acos(0.99)))
            extra_units = (w["kvah"] - w["kwh"] / 0.99) / max(w["days"], 1) * month
            saving = extra_units * tariff["energy_rate"] if tariff["billing"] == "kvah" else None
            worst = sorted((f for f in feeders if week.get(f["id"]) and week[f["id"]]["kvah"]),
                           key=lambda f: week[f["id"]]["kwh"] / week[f["id"]]["kvah"])[:3]
            add("high" if pf < target - 0.03 else "medium", "Power factor", m,
                f"Power factor {pf:.3f} is below {target:.2f}",
                f"Over the last {w['days']} days {m['name']} averaged PF {pf:.3f}. "
                + (f"With kVAh billing you pay for about {extra_units:,.0f} extra units a month. " if saving else "")
                + (f"Lowest PF feeders: " + ", ".join(f"{f['name']} ({week[f['id']]['kwh'] / week[f['id']]['kvah']:.2f})" for f in worst) + "." if worst else ""),
                f"Add about {math.ceil(kvar / 25) * 25:.0f} kVAr of capacitor bank (APFC panel) to reach PF 0.99. "
                "Check that existing capacitor steps are healthy before buying new ones; place correction close to the lowest-PF feeders.",
                saving)
        else:
            add("good", "Power factor", m, f"Power factor is healthy at {pf:.3f}",
                f"{m['name']} averaged PF {pf:.3f} over {w['days']} days.", "Keep checking the APFC panel monthly.")

    # ---- plant level: maximum demand vs contract ----
    for m in mains:
        w = week.get(m["id"])
        c = m.get("contract_kva")
        if not w or w["md"] is None or not c:
            continue
        ratio = w["md"] / c
        if ratio >= 0.9:
            add("high" if ratio >= 1 else "medium", "Maximum demand", m,
                f"Demand reached {ratio * 100:.0f}% of the {c:,.0f} kVA contract",
                f"Highest {block_minutes}-minute demand was {w['md']:,.0f} kVA on {w['md_at']}. Going over the contract demand is billed as a penalty.",
                "Stagger the start of large lines (do not start two coating lines or a furnace together), and set a demand alarm at 90% so a shift can shed load in time.",
                None)
        elif ratio < 0.7:
            new_c = math.ceil(w["md"] * 1.15 / 50) * 50
            saving = (c - new_c) * tariff["demand_rate"] if new_c < c else None
            add("medium", "Maximum demand", m, f"Contract demand looks too high: only {ratio * 100:.0f}% used",
                f"Highest demand in the last {w['days']} days was {w['md']:,.0f} kVA against a contract of {c:,.0f} kVA. Fixed demand charges are paid on the contract.",
                f"Check a full year of demand first; if it stays low, ask the utility to reduce contract demand to about {new_c:,.0f} kVA.",
                saving)

    # ---- per machine ----
    for m in feeders + mains:
        s = st.get(m["id"])
        w = week.get(m["id"])
        if not s or len(s["kw"]) < 30:
            continue
        kw = s["kw"]
        p95 = _pct(kw, 0.95)
        rated = max(p95, (m.get("contract_kva") or 0) * 0.8, 1)

        # idle running: on, but drawing a small fraction of its normal load
        idle_lo, idle_hi = rated * 0.02, rated * 0.15
        idle_h = idle_kwh = 0.0
        for k, dt in zip(kw, s["dt"]):
            if idle_lo < k < idle_hi:
                idle_h += dt / 3600
                idle_kwh += k * dt / 3600
        total_h = sum(s["dt"]) / 3600 or 1
        if not m.get("is_main") and idle_h / total_h > 0.12 and idle_kwh > 50:
            per_month = idle_kwh / max(total_h / 24, 1) * month
            add("medium", "Idle running", m, f"{m['name']} idles {idle_h / total_h * 100:.0f}% of the time",
                f"It ran at under 15% of its normal load for {idle_h:,.0f} hours in the last week, using about {idle_kwh:,.0f} kWh while not producing.",
                "Switch off hydraulics, blowers, pumps and heaters when the line stops for more than 30 minutes; an interlock or timer on the line-stop signal does this automatically.",
                per_month * 0.5 * tariff["energy_rate"])

        # peak-hour use of shiftable machines
        if (m.get("machine") in SHIFTABLE) and tariff.get("peak_hours"):
            peak_kw = [k for h, ks in s["hour_kw"].items() if _in_peak(h, tariff["peak_hours"]) for k in ks]
            if peak_kw and kw:
                share = len(peak_kw) / len(kw)
                peak_kwh = statistics.mean(peak_kw) * sum(b - a for a, b in tariff["peak_hours"]) * month
                if peak_kwh > 300:
                    peak_list.append((m, peak_kwh))

        # week-on-week trend
        if w and w["days"] >= 3 and w["prev_days"] >= 3:
            a = w["kwh"] / w["days"]; b = w["prev_kwh"] / w["prev_days"]
            if b > 0 and (a - b) / b > 0.15 and a - b > 100:
                add("medium", "Trend", m, f"{m['name']} uses {(a - b) / b * 100:.0f}% more energy than last week",
                    f"{a:,.0f} kWh a day this week against {b:,.0f} kWh a day the week before.",
                    "Check whether production went up. If not, look for a dragging motor, a stuck valve, a leak (compressed air) or a furnace door left open.",
                    (a - b) * month * tariff["energy_rate"] * 0.5)

        # unusual days
        vals = [v for _, v in w["daily"]] if w else []
        if len(vals) >= 7:
            mu, sd = statistics.mean(vals[:-1]), statistics.pstdev(vals[:-1])
            if sd > 0:
                for day, v in w["daily"][-7:-1]:
                    if (v - mu) / sd > 2.5 and v - mu > 200:
                        add("low", "Unusual day", m, f"{m['name']} used unusually much on {day}",
                            f"{v:,.0f} kWh against a usual {mu:,.0f} kWh a day.",
                            "Compare with that day's production and maintenance log.")
                        break

        # electrical health
        if s["i_unb"] and statistics.mean(s["i_unb"]) > 10:
            add("medium", "Electrical health", m, f"Current unbalance {statistics.mean(s['i_unb']):.0f}% on {m['name']}",
                "Phase currents differ by more than 10%. This heats motors and cables and wastes energy.",
                "Check for a loose or burnt contact, a single-phase load on one phase, or a failing motor winding.")
        if s["v_unb"] and statistics.mean(s["v_unb"]) > 2:
            add("medium", "Electrical health", m, f"Voltage unbalance {statistics.mean(s['v_unb']):.1f}% on {m['name']}",
                "More than 2% voltage unbalance makes motors run hot and lose efficiency.",
                "Check transformer tap settings and spread single-phase loads evenly.")
        if s["thd_v"] and statistics.mean(s["thd_v"]) > 5:
            add("medium", "Electrical health", m, f"Voltage harmonics {statistics.mean(s['thd_v']):.1f}% on {m['name']}",
                "Voltage THD above 5% (IEEE 519) can overheat transformers and capacitor banks and trip drives.",
                "Fit detuned reactors on the capacitor bank or an active harmonic filter near the drives (VFDs, rectifiers).")
        if s["v_ln"]:
            v = statistics.mean(s["v_ln"])
            if v > 250 or v < 220:
                add("low", "Electrical health", m, f"Voltage {v:.0f} V L-N on {m['name']}",
                    "Voltage is outside 220 to 250 V L-N. High voltage wastes energy in motors and lighting; low voltage raises current.",
                    "Adjust the transformer tap to bring voltage near 230 to 240 V.")

    if peak_list:
        peak_list.sort(key=lambda x: -x[1])
        total = sum(k for _, k in peak_list)
        win = ", ".join(f"{a}:00 to {b}:00" for a, b in tariff["peak_hours"])
        add("low", "Peak hours", None, f"Move flexible machines out of peak hours ({win})",
            "These machines can usually run at another time but use energy in the peak window each month: "
            + ", ".join(f"{m['name']} about {k:,.0f} kWh" for m, k in peak_list) + ".",
            "Plan slitting, trimming, water treatment and workshop jobs in the night or morning shift, and keep the peak window for the coating lines.",
            total * 0.7 * tariff["peak_extra"])

    out.sort(key=lambda x: (SEVERITY_ORDER[x["severity"]], -(x["saving_month"] or 0)))

    # ---- summary numbers (also what the AI sees) ----
    plant_ids = [m["id"] for m in mains] or [m["id"] for m in feeders]
    kwh_week = sum(week[i]["kwh"] for i in plant_ids if i in week)
    billed_week = sum(week[i]["kvah" if tariff["billing"] == "kvah" else "kwh"] for i in plant_ids if i in week)
    days_week = max((week[i]["days"] for i in plant_ids if i in week), default=0)
    machines = []
    for m in meters:
        w = week.get(m["id"])
        s = st.get(m["id"])
        machines.append({
            "name": m["name"], "area": m.get("area"), "type": m.get("machine"), "main_incomer": bool(m.get("is_main")),
            "contract_kva": m.get("contract_kva"),
            "kwh_per_day": round(w["kwh"] / w["days"], 1) if w and w["days"] else None,
            "kwh_per_day_prev_week": round(w["prev_kwh"] / w["prev_days"], 1) if w and w["prev_days"] else None,
            "avg_pf": round(w["kwh"] / w["kvah"], 3) if w and w["kvah"] else None,
            "max_demand_kva": round(w["md"], 1) if w and w["md"] else None, "max_demand_at": w["md_at"] if w else None,
            "load_kw_p10_p50_p95": [round(_pct(s["kw"], q), 1) for q in (0.1, 0.5, 0.95)] if s and s["kw"] else None,
            "hourly_avg_kw": {h: round(statistics.mean(v), 1) for h, v in sorted(s["hour_kw"].items())} if s else None,
        })
    total_saving = sum(x["saving_month"] or 0 for x in out)
    return {
        "generated": now.isoformat(timespec="minutes"),
        "period": {"from": (end_day - timedelta(days=6)).isoformat(), "to": end_day.isoformat()},
        "tariff": tariff,
        "summary": {
            "kwh_per_day": round(kwh_week / days_week) if days_week else None,
            "cost_per_day": round(billed_week / days_week * tariff["energy_rate"]) if days_week else None,
            "possible_saving_month": round(total_saving),
            "possible_saving_text": _money(total_saving, cur),
            "findings": sum(1 for x in out if x["severity"] != "good"),
        },
        "insights": out,
        "machines": machines,
    }


# ---------------- optional: ask Claude ----------------

AI_SYSTEM = """You are an energy manager for a steel plant in India. You are given one week of measured
electricity data from multifunction meters (per machine and at the main incomer), the plant's tariff,
and findings already computed by rule-based checks.

Answer the plant team's question using only these numbers. Be specific: name machines, give kWh, kVA,
PF and rupee figures from the data, and say how you got any estimate. Prefer actions a plant can take
this month (operating practice, scheduling, maintenance, power factor correction) before capital spending.
If the data cannot answer the question, say what extra measurement would. Keep it short: plain sentences
and short bullet lists, no tables, under 300 words unless asked for more."""


def ask_claude(api_key: str, model: str, analysis: dict, question: str, plant_name: str) -> str:
    """Send the week's summary (not raw readings) and the question to Claude. Returns the answer text."""
    import json

    import anthropic  # optional dependency: pip install anthropic

    client = anthropic.Anthropic(api_key=api_key, timeout=120.0)
    context = json.dumps({k: analysis[k] for k in ("period", "tariff", "summary", "insights", "machines")}, ensure_ascii=False)
    response = client.beta.messages.create(
        model=model,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "medium"},
        system=AI_SYSTEM,
        messages=[{"role": "user", "content": f"Plant: {plant_name}\n\n<plant_data>\n{context}\n</plant_data>\n\nQuestion: {question}"}],
    )
    if response.stop_reason == "refusal":
        return "Claude could not answer this question. Try asking it differently."
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if response.stop_reason == "max_tokens":
        text += "\n\n(The answer was cut short.)"
    return text or "Claude returned no answer."
