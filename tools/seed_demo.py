"""Fill the database with 7 days of simulated history, so reports and charts have something to show.

  python tools/seed_demo.py --config config.json --days 7
"""

import argparse
import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from energylogger.config import load_config  # noqa: E402
from energylogger.db import Database  # noqa: E402
import time  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--config", default="config.json")
ap.add_argument("--days", type=int, default=7)
a = ap.parse_args()
cfg = load_config(a.config)
db = Database(cfg.database)
now = int(time.time()) - 120
start = now - a.days * 86400
step = int(max(60, cfg.log_seconds))
rows = []
for m in cfg.meters:
    if cfg.ports[m.port].kind != "simulator":
        continue
    rnd = random.Random(m.id)
    rated = m.contract_kva or 1000
    kwh, kvah, kvarh = rnd.uniform(1e5, 9e5), 0.0, 0.0
    kvah, kvarh = kwh * 1.08, kwh * 0.4
    pf0 = rnd.uniform(0.88, 0.96)
    first = len(rows)
    for ts in range(start, now, step):
        hour = (ts / 3600 + 5.5) % 24
        shift = 0.35 if 2 <= hour < 6 else 1.0  # lighter load at night
        load = max(0.03, shift * (0.55 + 0.3 * math.sin(ts / 1500 + rnd.random())) + rnd.uniform(-0.07, 0.07))
        kva = load * rated * 0.95
        pf = min(0.999, pf0 + rnd.uniform(-0.03, 0.03))
        kw = kva * pf
        kvar = math.sqrt(max(kva * kva - kw * kw, 0))
        kwh += kw * step / 3600; kvah += kva * step / 3600; kvarh += kvar * step / 3600
        v = 239 + rnd.uniform(-4, 4)
        i = kva * 1000 / (3 * v)
        rows.append({"ts": ts, "meter_id": m.id, "v_ln": v, "v_ll": v * 1.732, "v1": v, "v2": v + 1, "v3": v - 1,
                     "i_avg": i, "i1": i, "i2": i * 1.02, "i3": i * 0.98, "kw": kw, "kva": kva, "kvar": kvar, "pf": pf,
                     "hz": 50 + rnd.uniform(-0.05, 0.05), "kwh": kwh, "kvah": kvah, "kvarh": kvarh,
                     "thd_v": rnd.uniform(2, 5), "thd_i": rnd.uniform(8, 20)})
    # end exactly where the live simulator starts, so the energy register is continuous
    shift = random.Random(m.id).uniform(1e5, 9e5) - kwh
    for r in rows[first:]:
        r["kwh"] += shift
db.insert_many_readings(rows)
print(f"added {len(rows)} readings to {cfg.database}")
