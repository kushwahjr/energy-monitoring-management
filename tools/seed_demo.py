"""Fill the database with simulated history, so reports, charts, DG logs and Insights have something to show.

  python tools/seed_demo.py --config config.json --days 14

The demo plant gets a few grid power cuts (DGs start, PCCs change over to DG and back), and some
machines get habits for Insights to find: slitters and pickling idle at night instead of switching
off, the CCL line uses more energy this week, and the compressor has an unbalanced phase.
"""

import argparse
import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from energylogger.collector import fmt_dur  # noqa: E402
from energylogger.config import load_config  # noqa: E402
from energylogger.db import Database  # noqa: E402
from energylogger.plantsim import BACK_S, COOLDOWN_S, CRANK_S, SYNC_S, PlantSim  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--config", default="config.json")
ap.add_argument("--days", type=int, default=14)
a = ap.parse_args()
cfg = load_config(a.config)
db = Database(cfg.database)
now = int(time.time()) - 120
start = now - a.days * 86400
step = int(max(60, cfg.log_seconds))
meters = [m for m in cfg.meters if m.enabled and cfg.ports[m.port].kind == "simulator"]

# a few power cuts: about one a day, 4 to 55 minutes, never in the last hour
rnd = random.Random(7)
cuts, t = [], start + 3 * 3600
while t < now - 3 * 3600:
    t += rnd.uniform(14, 40) * 3600
    if t < now - 3 * 3600:
        cuts.append([t, t + rnd.uniform(4, 55) * 60])
plant = PlantSim(cfg, cuts=cuts)

# generators come last so they can add up what their PCC incomers draw
meters.sort(key=lambda m: m.is_dg)
base = {}
for m in meters:
    r = random.Random(m.id)
    base[m.id] = {"rnd": r, "rated": m.contract_kva or 500, "kwh": r.uniform(1e5, 9e5), "kvah": 0.0, "kvarh": 0.0,
                  "pf0": r.uniform(0.88, 0.96), "ph": r.random() * 6}
    base[m.id]["kvah"], base[m.id]["kvarh"] = base[m.id]["kwh"] * 1.08, base[m.id]["kwh"] * 0.4

rows = []
for ts in range(start, now, step):
    hour = (ts / 3600 + 5.5) % 24
    kw_now = {}
    for m in meters:
        b, r = base[m.id], base[m.id]["rnd"]
        ps = plant.meter_state(m, ts)
        v_nom, hz = 239 + r.uniform(-4, 4), 50 + r.uniform(-0.05, 0.05)
        pf = min(0.999, b["pf0"] + r.uniform(-0.03, 0.03))
        if m.is_dg:
            if ps["dg"] == "off":
                v_nom, hz, kva = 0.0, 0.0, 0.0
            elif ps["dg"] == "loaded":
                kw = sum(kw_now.get(i, 0) for i in plant.dg_inc) / max(len(plant.dgs), 1) * r.uniform(0.97, 1.03)
                pf = 0.86 + r.uniform(-0.02, 0.02)
                kva = kw / pf
            else:
                kva, pf = 0.012 * b["rated"], 0.3
        else:
            shift = 0.35 if 2 <= hour < 6 else 1.0  # lighter load at night
            load = max(0.03, shift * (0.55 + 0.3 * math.sin(ts / 1500 + b["ph"])) + r.uniform(-0.07, 0.07))
            if m.machine in ("hr_slitter", "cr_slitter", "pickling_line", "trimming_line") and (hour >= 22 or hour < 6):
                load = r.uniform(0.06, 0.10)  # line stopped, drives and hydraulics left running
            if m.machine == "ccl_line" and ts > now - 6 * 86400:
                load *= 1.25  # this week's extra use
            kva = load * b["rated"] * 0.95 * ps["scale"]
            if not ps["live"]:
                v_nom, hz = 0.0, 0.0
        kw = kva * pf
        kw_now[m.id] = kw
        kvar = math.sqrt(max(kva * kva - kw * kw, 0))
        b["kwh"] += kw * step / 3600; b["kvah"] += kva * step / 3600; b["kvarh"] += kvar * step / 3600
        i = kva * 1000 / (3 * v_nom) if v_nom > 20 else 0.0
        row = {"ts": ts, "meter_id": m.id, "v_ln": v_nom, "v_ll": v_nom * 1.732, "v1": v_nom, "v2": v_nom + (1 if v_nom else 0),
               "v3": v_nom - (1 if v_nom else 0), "i_avg": i, "i1": i * (1.16 if m.machine == "compressor" else 1), "i2": i * 1.02,
               "i3": i * 0.98, "kw": kw, "kva": kva, "kvar": kvar, "hz": hz, "kwh": b["kwh"], "kvah": b["kvah"], "kvarh": b["kvarh"]}
        if kva > 0:
            row.update(pf=pf, thd_v=r.uniform(2, 5), thd_i=r.uniform(8, 20))
        rows.append(row)

# end exactly where the live simulator starts, so energy registers are continuous
for m in meters:
    shift = random.Random(m.id).uniform(1e5, 9e5) - base[m.id]["kwh"]
    for row in rows:
        if row["meter_id"] == m.id:
            row["kwh"] += shift
db.insert_many_readings(rows)

# the events the plant watcher would have logged
grid = next((m for m in cfg.meters if m.is_main and not m.is_dg and m.enabled), None)
dgs = [m for m in cfg.meters if m.is_dg and m.enabled]
names = {p["id"]: p["name"] for p in cfg.panels}
backed = {}
for m in cfg.meters:
    if m.enabled and m.position == "incomer" and not m.is_dg and m.panel:
        backed.setdefault(m.panel, []).append(m)
events = []
for c0, c1 in cuts:
    c0, c1 = int(c0), int(c1)
    if grid:
        events.append({"ts": c0, "meter_id": grid.id, "kind": "power_cut", "message": "Power cut: grid supply lost", "active": 1})
        events.append({"ts": c1, "meter_id": grid.id, "kind": "power_cut", "message": f"Power restored after {fmt_dur(c1 - c0)}", "active": 0})
    for d in dgs:
        events.append({"ts": c0 + CRANK_S, "meter_id": d.id, "kind": "dg_run", "message": f"{d.name} started (grid power cut)", "active": 1})
        stop = c1 + BACK_S + COOLDOWN_S
        events.append({"ts": stop, "meter_id": d.id, "kind": "dg_run", "message": f"{d.name} stopped after {fmt_dur(stop - c0 - CRANK_S)}", "active": 0})
    for pid, incs in backed.items():
        dg_in = next((x for x in incs if x.id in plant.dg_inc), None)
        tr_in = next((x for x in incs if x.id not in plant.dg_inc), None)
        if dg_in and tr_in:
            events.append({"ts": c0, "meter_id": tr_in.id, "kind": "changeover", "message": f"{names.get(pid, pid)}: no supply on either incomer", "active": 1})
            events.append({"ts": c0 + SYNC_S, "meter_id": dg_in.id, "kind": "changeover", "message": f"{names.get(pid, pid)} changed over to DG supply ({dg_in.name})", "active": 0})
            events.append({"ts": c1 + BACK_S, "meter_id": tr_in.id, "kind": "changeover", "message": f"{names.get(pid, pid)} changed over to transformer supply ({tr_in.name})", "active": 0})
db.insert_many_events(events)
print(f"added {len(rows)} readings, {len(cuts)} power cuts and {len(events)} events to {cfg.database}")
