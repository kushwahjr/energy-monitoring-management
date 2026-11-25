"""Daily energy reports: consumption, maximum demand, power factor."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


def day_range(start: date, end: date, tz: ZoneInfo) -> tuple[int, int]:
    s = datetime.combine(start, datetime.min.time(), tz)
    e = datetime.combine(end + timedelta(days=1), datetime.min.time(), tz)
    return int(s.timestamp()), int(e.timestamp())


def shift_of(ts: int, tz: ZoneInfo, shifts: list[dict]) -> tuple[str, str]:
    """(shift date, shift name). A shift that runs past midnight belongs to the date it started."""
    d = datetime.fromtimestamp(ts, tz)
    mins = d.hour * 60 + d.minute
    for sh in shifts:
        a, b = sh["_a"], sh["_b"]
        if a < b and a <= mins < b:
            return d.date().isoformat(), sh["name"]
        if a >= b and (mins >= a or mins < b):
            day = d.date() if mins >= a else d.date() - timedelta(days=1)
            return day.isoformat(), sh["name"]
    return d.date().isoformat(), "Outside shifts"


def parse_shifts(raw: list | None) -> list[dict]:
    out = []
    for sh in raw or []:
        try:
            ha, ma = (int(x) for x in str(sh["start"]).split(":"))
            hb, mb = (int(x) for x in str(sh["end"]).split(":"))
        except (KeyError, ValueError):
            continue
        if not (0 <= ha < 24 and 0 <= hb < 24 and 0 <= ma < 60 and 0 <= mb < 60):
            continue
        out.append({"name": str(sh.get("name", "?"))[:20], "start": f"{ha:02d}:{ma:02d}", "end": f"{hb:02d}:{mb:02d}",
                    "_a": ha * 60 + ma, "_b": hb * 60 + mb})
    return out


def shift_report(rows, tz: ZoneInfo, shifts: list[dict], block_minutes: int = 15) -> list[dict]:
    return daily_report(rows, tz, block_minutes, period=lambda ts: shift_of(ts, tz, shifts))


def daily_report(rows, tz: ZoneInfo, block_minutes: int = 15, period=None) -> list[dict]:
    """rows: readings sorted by meter_id, ts.

    Energy per day is the sum of positive steps of the meter's energy register,
    so a meter reset or replacement does not produce a negative or huge number:
    a step larger than the measured load could explain is skipped.
    Maximum demand is the highest average kVA (and kW) over fixed blocks,
    the way utilities bill it.
    """
    block = block_minutes * 60
    out: dict[tuple[str, str], dict] = {}
    blocks: dict[tuple[str, str, int], list] = defaultdict(lambda: [0.0, 0.0, 0])
    prev: dict[str, dict] = {}

    for r in rows:
        mid = r["meter_id"]
        ts = r["ts"]
        if period:
            day, shift = period(ts)
        else:
            day, shift = datetime.fromtimestamp(ts, tz).date().isoformat(), None
        d = out.setdefault((mid, day, shift), {
            "meter_id": mid, "date": day, "shift": shift, "kwh": 0.0, "kvah": 0.0, "kvarh": 0.0,
            "md_kva": None, "md_kva_at": None, "md_kw": None, "peak_kw": None,
            "pf_sum": 0.0, "pf_n": 0, "samples": 0,
        })
        d["samples"] += 1
        p = prev.get(mid)
        if p is not None:
            # Largest step that the measured load could explain (generous, for long gaps).
            power = max(abs(r["kva"] or r["kw"] or 0), abs(p.get("power") or 0))
            dt_h = max(ts - p["ts"], 1) / 3600
            limit = power * dt_h * 5 + 1 if power else None
            for k in ("kwh", "kvah", "kvarh"):
                if r[k] is not None and p.get(k) is not None:
                    step = r[k] - p[k]
                    if step >= 0 and (limit is None or step <= limit):
                        d[k] += step
        prev[mid] = {k: (r[k] if r[k] is not None else (p or {}).get(k)) for k in ("kwh", "kvah", "kvarh")}
        prev[mid]["ts"] = ts
        prev[mid]["power"] = r["kva"] or r["kw"] or (p or {}).get("power")
        if r["kw"] is not None:
            d["peak_kw"] = r["kw"] if d["peak_kw"] is None else max(d["peak_kw"], r["kw"])
        if r["pf"] is not None:
            d["pf_sum"] += abs(r["pf"])
            d["pf_n"] += 1
        if r["kva"] is not None or r["kw"] is not None:
            b = blocks[(mid, day, shift, ts // block)]
            b[0] += r["kva"] or 0
            b[1] += r["kw"] or 0
            b[2] += 1

    for (mid, day, shift, b_idx), (kva_sum, kw_sum, n) in blocks.items():
        d = out[(mid, day, shift)]
        kva, kw = kva_sum / n, kw_sum / n
        if d["md_kva"] is None or kva > d["md_kva"]:
            d["md_kva"] = kva
            d["md_kva_at"] = datetime.fromtimestamp(b_idx * block, tz).strftime("%H:%M")
        if d["md_kw"] is None or kw > d["md_kw"]:
            d["md_kw"] = kw

    result = []
    for d in out.values():
        if d["kvah"] > 0:
            d["avg_pf"] = d["kwh"] / d["kvah"]
        else:
            d["avg_pf"] = d["pf_sum"] / d["pf_n"] if d["pf_n"] else None
        del d["pf_sum"], d["pf_n"]
        result.append(d)
    result.sort(key=lambda d: (d["date"], d["shift"] or "", d["meter_id"]))
    return result
