"""DG set monitoring: run log, run hours, energy generated, fuel estimate and power cut log.

Runs are worked out from the logged readings (a DG counts as running while its frequency is above
40 Hz with voltage present, or while it carries load), so the same numbers come out on the plant PC
and on the cloud server.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

DEFAULT_FUEL = {
    # Generic diesel generator fuel line (HOMER default): litres/hour = a x rated kW + b x output kW.
    "idle_l_per_h_per_kw": 0.08145,
    "l_per_kwh": 0.246,
    "diesel_price": 92.0,  # per litre
}


def fuel_settings(raw: dict | None) -> dict:
    f = dict(DEFAULT_FUEL)
    for k, v in (raw or {}).items():
        if k in DEFAULT_FUEL:
            f[k] = float(v)
    return f


def is_running(r) -> bool:
    hz = r["hz"] or 0
    v = max(r["v_ln"] or 0, (r["v_ll"] or 0) / 1.732)
    return (hz > 40 and v > 50) or abs(r["kw"] or 0) > 2


def runs_for(rows, rated_kva: float | None, log_seconds: float, fuel: dict, now: float, tz: ZoneInfo) -> list[dict]:
    """rows: one DG's readings sorted by ts. Returns runs, oldest first."""
    gap = max(3 * log_seconds, 300)
    rated_kw = (rated_kva or 0) * 0.8
    out, cur, last = [], None, None
    for r in rows:
        on = is_running(r)
        if cur and (not on or r["ts"] - last["ts"] > gap):
            out.append(cur)
            cur = None
        if on:
            if cur is None:
                cur = {"start": r["ts"], "end": r["ts"], "kwh0": r["kwh"], "kwh1": r["kwh"], "kw_sum": 0.0, "kva_sum": 0.0, "n": 0,
                       "max_kw": 0.0, "int_kwh": 0.0, "pt": r["ts"]}
            dt = min(r["ts"] - cur["pt"], gap)
            cur["int_kwh"] += abs(r["kw"] or 0) * dt / 3600
            cur["pt"] = r["ts"]
            cur["end"] = r["ts"]
            if r["kwh"] is not None:
                cur["kwh1"] = r["kwh"] if cur["kwh0"] is not None else None
                cur["kwh0"] = cur["kwh0"] if cur["kwh0"] is not None else r["kwh"]
            cur["kw_sum"] += abs(r["kw"] or 0)
            cur["kva_sum"] += abs(r["kva"] or 0)
            cur["n"] += 1
            cur["max_kw"] = max(cur["max_kw"], abs(r["kw"] or 0))
        last = r
    if cur:
        cur["ongoing"] = now - cur["end"] < gap
        out.append(cur)
    result = []
    for c in out:
        dur = max(c["end"] - c["start"], log_seconds if c["n"] else 0)
        kwh = c["kwh1"] - c["kwh0"] if c["kwh0"] is not None and c["kwh1"] is not None and c["kwh1"] >= c["kwh0"] else c["int_kwh"]
        if kwh < 0 or (c["int_kwh"] and kwh > c["int_kwh"] * 3 + 5):
            kwh = c["int_kwh"]
        hours = dur / 3600
        litres = fuel["idle_l_per_h_per_kw"] * rated_kw * hours + fuel["l_per_kwh"] * kwh if rated_kw else fuel["l_per_kwh"] * kwh
        avg_kva = c["kva_sum"] / c["n"] if c["n"] else 0
        result.append({
            "start": c["start"], "end": None if c.get("ongoing") else c["end"], "ongoing": bool(c.get("ongoing")),
            "start_text": datetime.fromtimestamp(c["start"], tz).strftime("%d %b %H:%M"),
            "end_text": None if c.get("ongoing") else datetime.fromtimestamp(c["end"], tz).strftime("%d %b %H:%M"),
            "seconds": int(dur), "kwh": round(kwh, 1), "avg_kw": round(c["kw_sum"] / c["n"], 1) if c["n"] else 0,
            "max_kw": round(c["max_kw"], 1), "avg_load_pct": round(avg_kva / rated_kva * 100, 1) if rated_kva else None,
            "fuel_l": round(litres, 1), "fuel_cost": round(litres * fuel["diesel_price"]),
        })
    return result


def daily(runs: list[dict], tz: ZoneInfo) -> dict[str, dict]:
    """Split runs into calendar days: {date: {seconds, kwh, fuel_l, starts}} (kWh and fuel shared by time)."""
    out: dict[str, dict] = defaultdict(lambda: {"seconds": 0, "kwh": 0.0, "fuel_l": 0.0, "starts": 0})
    for r in runs:
        end = r["end"] or (r["start"] + r["seconds"])
        t = r["start"]
        first = True
        while t < end or first:
            d = datetime.fromtimestamp(t, tz)
            nxt = int(datetime.combine(d.date(), datetime.max.time(), tz).timestamp()) + 1
            seg = max(0, min(end, nxt) - t)
            frac = seg / r["seconds"] if r["seconds"] else 1
            day = out[d.date().isoformat()]
            day["seconds"] += seg
            day["kwh"] += r["kwh"] * frac
            day["fuel_l"] += r["fuel_l"] * frac
            if first:
                day["starts"] += 1
            first = False
            t = nxt
    return out


def power_cuts(events, tz: ZoneInfo) -> list[dict]:
    """Pair 'power_cut' events into cut / restore records, newest first."""
    evs = sorted((e for e in events if e["kind"] == "power_cut"), key=lambda e: e["ts"])
    out, open_cut = [], None
    for e in evs:
        if e["active"]:
            open_cut = e["ts"]
        elif open_cut is not None:
            out.append({"start": open_cut, "end": e["ts"], "seconds": e["ts"] - open_cut})
            open_cut = None
    if open_cut is not None:
        out.append({"start": open_cut, "end": None, "seconds": None})
    for c in out:
        c["start_text"] = datetime.fromtimestamp(c["start"], tz).strftime("%d %b %H:%M:%S")
        c["end_text"] = datetime.fromtimestamp(c["end"], tz).strftime("%d %b %H:%M:%S") if c["end"] else None
    return out[::-1]
