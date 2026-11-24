import sys
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from energylogger.reports import daily_report  # noqa: E402
from energylogger.readers import plan_blocks  # noqa: E402
from energylogger.config import Profile, Register  # noqa: E402

TZ = ZoneInfo("Asia/Kolkata")
KEYS = ("kwh", "kvah", "kvarh", "kw", "kva", "pf")


def row(ts, **kw):
    return {"meter_id": "m", "ts": ts, **{k: kw.get(k) for k in KEYS}}


def test_energy_survives_meter_reset_and_md_uses_blocks():
    t0 = 1764000000 - 1764000000 % 900 + 900  # start of a 15-min block
    rows = [row(t0 + i * 60, kwh=100 + i, kvah=110 + i, kw=60, kva=100, pf=0.9) for i in range(15)]
    rows.append(row(t0 + 15 * 60, kwh=0.5, kvah=0.6, kw=60, kva=1000, pf=0.9))  # meter reset + a one-minute spike
    rows += [row(t0 + (16 + i) * 60, kwh=1.5 + i, kvah=1.6 + i, kw=60, kva=100, pf=0.9) for i in range(14)]
    out = daily_report(rows, TZ, 15)
    assert len(out) == 1
    d = out[0]
    assert abs(d["kwh"] - (14 + 1 + 13)) < 1e-6  # the reset step is skipped, not negative
    assert abs(d["md_kva"] - (1000 + 14 * 100) / 15) < 1e-6  # spike is averaged over its block
    assert d["peak_kw"] == 60


def test_registers_are_grouped_into_few_requests():
    p = Profile("x", registers=[Register("v1", 0), Register("v2", 2), Register("kw", 42), Register("kwh", 3000)], max_block=100)
    blocks = plan_blocks(p)
    assert [(b[0], b[1]) for b in blocks] == [(0, 4), (42, 2), (3000, 2)]


def test_impossible_energy_jump_is_skipped():
    # a replaced meter that starts at a much higher reading must not add 50,000 kWh in one minute
    rows = [row(1764000000 + i * 60, kwh=100 + i, kva=60, kw=60, pf=1) for i in range(5)]
    rows.append(row(1764000000 + 300, kwh=50104, kva=60, kw=60, pf=1))
    rows.append(row(1764000000 + 360, kwh=50105, kva=60, kw=60, pf=1))
    d = daily_report(rows, TZ, 15)[0]
    assert abs(d["kwh"] - 5) < 1e-6
