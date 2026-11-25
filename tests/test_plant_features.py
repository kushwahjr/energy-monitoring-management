"""DG sets, power cuts, PCC changeover, sign-in with per-person access, and shifts.

Run with:  python -m pytest -q tests
"""

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from energylogger import dg as dgmod  # noqa: E402
from energylogger.config import parse_config  # noqa: E402
from energylogger.plantsim import COOLDOWN_S, CRANK_S, SYNC_S, PlantSim  # noqa: E402
from energylogger.reports import parse_shifts, shift_of  # noqa: E402
from test_end_to_end import free_port, wait_for, wait_http  # noqa: E402

TZ = ZoneInfo("Asia/Kolkata")

PLANT = {
    "mode": "plant", "plant_id": "p1", "plant_name": "Test", "timezone": "Asia/Kolkata", "poll_seconds": 0.5, "log_seconds": 1,
    "panels": [{"id": "ht", "name": "HT panel"}, {"id": "dg", "name": "DG panel"}, {"id": "pcc", "name": "Line PCC"}],
    "ports": {"sim": {"kind": "simulator"}},
    "meters": [
        {"id": "inc", "name": "Grid incomer", "port": "sim", "is_main": True, "panel": "ht", "position": "incomer", "machine": "grid", "contract_kva": 5000},
        {"id": "tr", "name": "TR-1", "port": "sim", "panel": "ht", "position": "feeder", "feeds": "pcc", "contract_kva": 2000},
        {"id": "dg1", "name": "DG-1", "port": "sim", "is_main": True, "panel": "dg", "position": "incomer", "machine": "dg_set", "contract_kva": 1000},
        {"id": "ic1", "name": "PCC I/C-1", "port": "sim", "panel": "pcc", "position": "incomer", "fed_from": "tr", "contract_kva": 2000},
        {"id": "ic2", "name": "PCC I/C-2 (DG)", "port": "sim", "panel": "pcc", "position": "incomer", "fed_from": "dg", "contract_kva": 800},
        {"id": "line", "name": "Line drive", "port": "sim", "panel": "pcc", "position": "feeder", "contract_kva": 900},
        {"id": "office", "name": "Office", "port": "sim", "panel": "ht", "position": "feeder", "contract_kva": 100},
    ],
}


def test_plantsim_cut_sequence():
    cfg = parse_config(json.loads(json.dumps(PLANT)), ROOT)
    sim = PlantSim(cfg, cuts=[[1000, 1100]])
    m = {x.id: x for x in cfg.meters}
    assert sim.dgs == ["dg1"] and sim.dg_inc == {"ic2"}
    assert sim.meter_state(m["dg1"], 999)["dg"] == "off"
    assert sim.meter_state(m["dg1"], 1000 + CRANK_S / 2)["dg"] == "cranking"
    assert not sim.meter_state(m["line"], 1000 + 1)["live"]                       # dead until the DG closes on
    assert sim.meter_state(m["dg1"], 1000 + SYNC_S + 1)["dg"] == "loaded"
    assert sim.meter_state(m["ic2"], 1000 + SYNC_S + 1)["scale"] == 1.0           # PCC changed over to DG
    assert sim.meter_state(m["line"], 1000 + SYNC_S + 1)["live"]
    assert not sim.meter_state(m["office"], 1000 + SYNC_S + 1)["live"]            # not DG-backed
    assert sim.meter_state(m["ic1"], 1100 + 10)["scale"] == 1.0                   # back on the transformer
    assert sim.meter_state(m["dg1"], 1100 + 10)["dg"] == "idle"                   # cooling down
    assert sim.meter_state(m["dg1"], 1100 + COOLDOWN_S + 10)["dg"] == "off"


def test_dg_runs_fuel_and_cuts():
    rows = []
    for ts in range(0, 7200, 60):
        on = 600 <= ts < 2400  # 30 minutes
        rows.append({"ts": ts, "kw": 400.0 if on else 0.0, "kva": 470.0 if on else 0.0, "kwh": 1000 + max(0, min(ts, 2400) - 600) / 3600 * 400,
                     "hz": 50.0 if on else 0.0, "v_ln": 240.0 if on else 0.0, "v_ll": 415.0 if on else 0.0})
    runs = dgmod.runs_for(rows, 1000, 60, dgmod.DEFAULT_FUEL, 7200, TZ)
    assert len(runs) == 1
    r = runs[0]
    assert r["start"] == 600 and r["end"] == 2340 and not r["ongoing"]
    assert 190 <= r["kwh"] <= 200
    # fuel line: idle part x rated kW x hours + part per kWh x kWh
    assert r["fuel_l"] == pytest.approx(0.08145 * 800 * r["seconds"] / 3600 + 0.246 * r["kwh"], rel=0.01)
    cuts = dgmod.power_cuts([{"kind": "power_cut", "ts": 100, "active": 1}, {"kind": "power_cut", "ts": 400, "active": 0},
                             {"kind": "power_cut", "ts": 900, "active": 1}], TZ)
    assert cuts[0]["end"] is None and cuts[1]["seconds"] == 300


def test_night_shift_belongs_to_its_start_day():
    sh = parse_shifts([{"name": "A", "start": "06:00", "end": "14:00"}, {"name": "B", "start": "14:00", "end": "22:00"},
                       {"name": "C", "start": "22:00", "end": "06:00"}])
    at = lambda s: int(datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp())  # noqa: E731
    assert shift_of(at("2026-03-10T07:00"), TZ, sh) == ("2026-03-10", "A")
    assert shift_of(at("2026-03-10T23:30"), TZ, sh) == ("2026-03-10", "C")
    assert shift_of(at("2026-03-11T03:00"), TZ, sh) == ("2026-03-10", "C")
    assert parse_shifts([{"name": "X", "start": "25:00", "end": "06:00"}]) == []


@pytest.fixture(scope="module")
def plant(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("plantfeat")
    cfg = {**PLANT, "database": str(tmp / "p.db")}
    (tmp / "p.json").write_text(json.dumps(cfg))
    port = free_port()
    proc = subprocess.Popen([sys.executable, str(ROOT / "run.py"), "--config", str(tmp / "p.json"), "--port", str(port), "--host", "127.0.0.1"])
    url = f"http://127.0.0.1:{port}"
    wait_http(url + "/api/info")
    yield url
    proc.terminate()
    proc.wait(5)


def test_first_admin_then_everyone_signs_in(plant):
    info = httpx.get(plant + "/api/info").json()
    assert info["setup_needed"] and info["setup_here"]
    admin = httpx.Client(base_url=plant)
    r = admin.post("/api/setup", json={"username": "hod", "password": "secret-123", "name": "HOD", "designation": "HOD Electrical"})
    assert r.status_code == 200, r.text
    assert httpx.post(plant + "/api/setup", json={"username": "x", "password": "secret-123"}).status_code == 400
    assert httpx.get(plant + "/api/meters").status_code == 401                     # no cookie, no data
    me = admin.get("/api/info").json()["user"]
    assert me["role"] == "admin" and me["designation"] == "HOD Electrical"

    # a line in-charge who sees only the PCC, and only the Plant page
    r = admin.post("/api/users", json={"username": "line.ic", "password": "line-1234", "name": "Line In-charge", "designation": "Shift In-charge",
                                       "role": "viewer", "pages": ["plant"], "panels": ["pcc"]})
    assert r.status_code == 200, r.text
    v = httpx.Client(base_url=plant)
    assert v.post("/api/login", json={"username": "line.ic", "password": "wrong"}).status_code == 401
    assert v.post("/api/login", json={"username": "line.ic", "password": "line-1234"}).status_code == 200
    ids = {m["id"] for m in v.get("/api/meters").json()["meters"]}
    assert ids == {"ic1", "ic2", "line"}
    assert v.get("/api/history", params={"meter": "inc"}).status_code == 403
    assert v.get("/api/dg").status_code == 403
    assert v.get("/api/export.csv", params={"kind": "daily"}).status_code == 403    # no Reports page
    assert {r["meter_id"] for r in v.get("/api/reports/daily").json()["rows"]} <= ids  # today's kWh on the Plant page, own meters only
    assert v.post("/api/demo/grid", json={"on": False}).status_code == 403
    assert v.get("/api/users").status_code == 403

    # blocking the account stops it at once
    assert admin.put("/api/users/line.ic", json={"active": False}).status_code == 200
    assert v.get("/api/meters").status_code == 401
    assert admin.delete("/api/users/hod").status_code == 400                       # not yourself
    pytest.admin = admin


def test_power_cut_switch_logs_dg_and_changeover(plant):
    admin = pytest.admin
    wait_for(lambda: all(m["online"] for m in admin.get("/api/meters").json()["meters"]))
    assert admin.post("/api/demo/grid", json={"on": False}).json()["grid_on"] is False
    assert admin.get("/api/info").json()["cut_since"]

    def kinds():
        evs = admin.get("/api/events", params={"hours": 1}).json()["events"]
        return {(e["kind"], e["active"]) for e in evs}
    wait_for(lambda: {("power_cut", 1), ("dg_run", 1)} <= kinds(), timeout=20)
    wait_for(lambda: any(e["kind"] == "changeover" and "DG supply" in e["message"] for e in admin.get("/api/events", params={"hours": 1}).json()["events"]), timeout=25)
    ms = wait_for(lambda: (lambda d: d if d["dg1"]["values"].get("kw", 0) > 2 else None)({m["id"]: m for m in admin.get("/api/meters").json()["meters"]}), timeout=10)
    assert ms["dg1"]["running_since"]
    assert ms["inc"]["values"]["v_ln"] == 0
    dg = admin.get("/api/dg").json()
    assert dg["dgs"][0]["status"] == "running" and dg["power_cuts"][0]["end"] is None and dg["power_cuts"][0]["dg_start_s"] is not None

    admin.post("/api/demo/grid", json={"on": True})
    wait_for(lambda: ("power_cut", 0) in kinds(), timeout=20)
    assert admin.get("/api/dg").json()["power_cuts"][0]["seconds"] > 0


def test_shifts_and_shift_report(plant):
    admin = pytest.admin
    assert admin.get("/api/reports/shifts").status_code == 400                    # none set yet
    bad = admin.put("/api/shifts", json={"shifts": [{"name": "A", "start": "6", "end": "x"}]})
    assert bad.status_code == 400
    sh = [{"name": "Day", "start": "08:00", "end": "20:00"}, {"name": "Night", "start": "20:00", "end": "08:00"}]
    assert admin.put("/api/shifts", json={"shifts": sh}).json()["shifts"] == sh
    from datetime import date, timedelta
    r = admin.get("/api/reports/shifts", params={"start": (date.today() - timedelta(days=1)).isoformat(), "end": (date.today() + timedelta(days=1)).isoformat()}).json()
    assert r["rows"] and {x["shift"] for x in r["rows"]} <= {"Day", "Night"}
    assert all(x["kwh"] >= 0 for x in r["rows"])
