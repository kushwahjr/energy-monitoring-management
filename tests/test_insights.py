"""Insights find the waste we plant into synthetic data."""

import math
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from energylogger.db import Database
from energylogger.insights import analyse

TZ = ZoneInfo("Asia/Kolkata")


def make_db(tmp_path: Path):
    db = Database(tmp_path / "t.db")
    now = datetime(2026, 11, 20, 12, 0, tzinfo=TZ)
    start = int((now - timedelta(days=14)).replace(hour=0, minute=0).timestamp())
    end = int(now.replace(hour=0, minute=0).timestamp())
    rows, e = [], {"inc": [0, 0], "line": [0, 0], "slit": [0, 0]}
    for ts in range(start, end, 300):
        hour = datetime.fromtimestamp(ts, TZ).hour
        this_week = ts >= end - 7 * 86400
        loads = {
            "line": (900 * (1.3 if this_week else 1.0), 0.97),          # CCL-like line, 30% more this week
            "slit": (15 if hour >= 22 or hour < 6 else 200, 0.95),        # idles at night
        }
        inc_kw = sum(k for k, _ in loads.values()) + 300
        loads["inc"] = (inc_kw, 0.88)                                     # poor PF at the incomer
        for mid, (kw, pf) in loads.items():
            kva = kw / pf
            e[mid][0] += kw * 300 / 3600
            e[mid][1] += kva * 300 / 3600
            i = kva * 1000 / (3 * 235)
            unb = 1.2 if mid == "slit" else 1.0
            rows.append({"ts": ts, "meter_id": mid, "kw": kw, "kva": kva, "kvar": math.sqrt(kva * kva - kw * kw), "pf": pf,
                         "kwh": e[mid][0], "kvah": e[mid][1], "kvarh": 0, "v_ln": 235, "v1": 235, "v2": 235, "v3": 235,
                         "i1": i * unb, "i2": i, "i3": i, "thd_v": 3, "thd_i": 10})
    db.insert_many_readings(rows)
    meters = [
        {"id": "inc", "name": "Incomer", "area": "", "is_main": True, "contract_kva": 3000, "machine": "transformer"},
        {"id": "line", "name": "CCL Line", "area": "", "is_main": False, "contract_kva": 1200, "machine": "ccl_line"},
        {"id": "slit", "name": "HR Slitter", "area": "", "is_main": False, "contract_kva": 250, "machine": "hr_slitter"},
    ]
    return db, meters, now


def test_finds_planted_problems(tmp_path):
    db, meters, now = make_db(tmp_path)
    a = analyse(meters, db, TZ, {"energy_rate": 8, "billing": "kvah"}, now=now)
    got = {(x["category"], x["meter_name"]) for x in a["insights"]}
    assert ("Power factor", "Incomer") in got
    assert ("Trend", "CCL Line") in got
    assert ("Idle running", "HR Slitter") in got
    assert ("Electrical health", "HR Slitter") in got   # current unbalance
    assert ("Maximum demand", "Incomer") in got         # ~1,900 kVA of a 3,000 kVA contract: too high
    pf = next(x for x in a["insights"] if x["category"] == "Power factor")
    assert pf["severity"] == "high" and pf["saving_month"] > 0 and "kVAr" in pf["action"]
    assert a["insights"][0]["severity"] == "high"
    assert a["summary"]["possible_saving_month"] > 0 and a["summary"]["kwh_per_day"] > 0
    line = next(m for m in a["machines"] if m["name"] == "CCL Line")
    assert line["kwh_per_day"] > line["kwh_per_day_prev_week"] * 1.2
    assert len(line["hourly_avg_kw"]) == 24


def test_no_data_is_quiet(tmp_path):
    db = Database(tmp_path / "e.db")
    a = analyse([{"id": "x", "name": "X", "is_main": True, "contract_kva": 100}], db, TZ, None)
    assert a["insights"] == [] and a["summary"]["findings"] == 0
