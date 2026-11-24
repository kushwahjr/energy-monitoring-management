"""End-to-end test: fake meters -> plant logger -> cloud server, plus login, reports and CSV.

Run with:  python -m pytest -q tests
"""

import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from energylogger.auth import hash_password  # noqa: E402


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_http(url: str, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            httpx.get(url, timeout=1)
            return
        except httpx.HTTPError:
            time.sleep(0.2)
    raise TimeoutError(url)


def wait_for(fn, timeout=20, step=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    raise AssertionError(f"condition not met, last={last!r}")


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("e2e")
    procs = []
    eth, gw, plant_port, cloud_port = free_port(), free_port(), free_port(), free_port()
    procs.append(subprocess.Popen([sys.executable, str(ROOT / "tools/fake_meter.py"), "--port", str(eth), "--units", "1", "2"]))
    procs.append(subprocess.Popen([sys.executable, str(ROOT / "tools/fake_meter.py"), "--port", str(gw), "--units", "5", "--framing", "rtu"]))

    cloud_cfg = {
        "mode": "cloud", "database": str(tmp / "cloud.db"), "timezone": "Asia/Kolkata", "secret_key": "test-secret-key-123",
        "ingest_keys": {"plantA": "key-A"},
        "users": [{"username": "boss", "password_hash": hash_password("pw123"), "role": "viewer"}],
        "ports": {}, "meters": [],
    }
    (tmp / "cloud.json").write_text(json.dumps(cloud_cfg))
    plant_cfg = {
        "mode": "plant", "plant_id": "plantA", "plant_name": "Plant A", "database": str(tmp / "plant.db"), "timezone": "Asia/Kolkata",
        "poll_seconds": 0.5, "log_seconds": 1,
        "ports": {"sim": {"kind": "simulator"},
                  "lan": {"kind": "ethernet", "host": "127.0.0.1", "port": eth, "timeout": 1},
                  "gw": {"kind": "gateway", "host": "127.0.0.1", "port": gw, "framing": "rtu", "timeout": 1}},
        "meters": [
            {"id": "furnace", "name": "Furnace", "area": "Melt", "port": "sim", "contract_kva": 2000, "alarms": {"pf_min": 0.999}},
            {"id": "m1", "name": "LAN meter 1", "area": "Mill", "port": "lan", "unit_id": 1, "profile": "generic_float32_template"},
            {"id": "m2", "name": "LAN meter 2", "area": "Mill", "port": "lan", "unit_id": 2, "profile": "generic_float32_template"},
            {"id": "g5", "name": "Gateway meter", "area": "Utilities", "port": "gw", "unit_id": 5, "profile": "generic_float32_template"},
            {"id": "dead", "name": "Missing meter", "area": "Utilities", "port": "lan", "unit_id": 9, "profile": "generic_float32_template"},
        ],
        "cloud_sync": {"url": f"http://127.0.0.1:{cloud_port}", "api_key": "key-A", "sync_seconds": 1},
    }
    (tmp / "plant.json").write_text(json.dumps(plant_cfg))
    procs.append(subprocess.Popen([sys.executable, str(ROOT / "run.py"), "--config", str(tmp / "cloud.json"), "--port", str(cloud_port), "--host", "127.0.0.1"]))
    procs.append(subprocess.Popen([sys.executable, str(ROOT / "run.py"), "--config", str(tmp / "plant.json"), "--port", str(plant_port), "--host", "127.0.0.1"]))
    wait_http(f"http://127.0.0.1:{cloud_port}/api/info")
    wait_http(f"http://127.0.0.1:{plant_port}/api/info")
    yield {"plant": f"http://127.0.0.1:{plant_port}", "cloud": f"http://127.0.0.1:{cloud_port}", "tmp": tmp}
    for p in procs:
        p.terminate()
    for p in procs:
        p.wait(5)


def test_plant_reads_all_connection_types(stack):
    def ready():
        ms = {m["id"]: m for m in httpx.get(stack["plant"] + "/api/meters").json()["meters"]}
        return ms if all(ms[i]["online"] for i in ("furnace", "m1", "m2", "g5")) else None
    ms = wait_for(ready)
    assert ms["m1"]["connection"] == "ethernet" and ms["g5"]["connection"] == "gateway"
    assert 200 < ms["m2"]["values"]["v_ln"] < 260
    assert ms["g5"]["values"]["kwh"] > 4000  # unit 5 starts at 5000 kWh
    assert not ms["dead"]["online"] and ms["dead"]["error"]
    assert any("Power factor" in a for a in ms["furnace"]["alarms"])


def test_history_reports_and_csv(stack):
    p = stack["plant"]
    pts = wait_for(lambda: len(httpx.get(p + "/api/history", params={"meter": "m1", "param": "kw", "hours": 1}).json()["points"]) >= 3 or None)
    assert pts
    time.sleep(2)
    rows = httpx.get(p + "/api/reports/daily").json()["rows"]
    by = {r["meter_id"]: r for r in rows}
    assert by["m1"]["kwh"] > 0 and by["m1"]["md_kva"] > 0 and 0.85 < by["m1"]["avg_pf"] < 0.99
    csv = httpx.get(p + "/api/export.csv", params={"kind": "readings"}).text
    assert csv.startswith("time,meter_id,meter_name,v_ln (V)") and "LAN meter 1" in csv
    daily = httpx.get(p + "/api/export.csv", params={"kind": "daily"}).text
    assert "md_kva" in daily.splitlines()[0]
    ev = httpx.get(p + "/api/events").json()["events"]
    assert any(e["meter_id"] == "dead" and e["kind"] == "offline" for e in ev)


def test_cloud_requires_login_and_gets_synced_data(stack):
    c = stack["cloud"]
    assert httpx.get(c + "/api/meters").status_code == 401
    assert httpx.post(c + "/api/login", json={"username": "boss", "password": "wrong"}).status_code == 401
    assert httpx.post(c + "/api/ingest", json={"plant_id": "plantA"}, headers={"X-Plant-Key": "bad"}).status_code == 401
    with httpx.Client(base_url=c) as s:
        assert s.post("/api/login", json={"username": "boss", "password": "pw123"}).status_code == 200

        def synced():
            ms = {m["id"]: m for m in s.get("/api/meters").json()["meters"]}
            return ms if "plantA.m1" in ms and ms["plantA.m1"]["online"] else None
        ms = wait_for(synced, timeout=30)
        assert ms["plantA.g5"]["plant_name"] == "Plant A"
        assert ms["plantA.m1"]["values"]["kw"] > 0
        rows = s.get("/api/reports/daily").json()["rows"]
        assert any(r["meter_id"] == "plantA.m1" and r["kwh"] > 0 for r in rows)
        assert s.get("/api/settings").status_code == 403  # viewer cannot change settings


def test_plant_sync_backlog_is_cleared(stack):
    def info():
        s = httpx.get(stack["plant"] + "/api/info").json()["cloud_sync"]
        return s if s["last_ok"] and s["backlog"] == 0 and not s["last_error"] else None
    assert wait_for(info, timeout=20)


def test_settings_change_from_plant_pc(stack):
    p = stack["plant"]
    cfg = httpx.get(p + "/api/settings").json()["config"]  # localhost without users = admin
    assert cfg["cloud_sync"]["api_key"] == "********"
    cfg["meters"].append({"id": "new1", "name": "New feeder", "area": "Mill", "port": "lan", "unit_id": 2, "profile": "generic_float32_template"})
    t = httpx.post(p + "/api/settings/test-meter", json={"meter": cfg["meters"][-1], "ports": cfg["ports"]}).json()
    assert t["ok"] and t["values"]["kw"] > 0
    bad = json.loads(json.dumps(cfg))
    bad["meters"][-1]["port"] = "nope"
    assert httpx.put(p + "/api/settings", json={"config": bad}).status_code == 400
    assert httpx.put(p + "/api/settings", json={"config": cfg}).json()["ok"]
    saved = json.loads((stack["tmp"] / "plant.json").read_text())
    assert saved["cloud_sync"]["api_key"] == "key-A"  # secret kept
    wait_for(lambda: any(m["id"] == "new1" and m["online"] for m in httpx.get(p + "/api/meters").json()["meters"]))


def test_branding_logo_and_machine_type(stack):
    import base64
    p = stack["plant"]
    png = base64.b64encode(bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000d49444154789c6360000002000005000155f5b0bb0000000049454e44ae426082")).decode()
    b = httpx.post(p + "/api/branding/logo", json={"data_url": "data:image/png;base64," + png}).json()
    assert b["logo_url"].startswith("/branding/logo.png")
    assert httpx.get(p + b["logo_url"]).headers["content-type"] == "image/png"
    assert httpx.post(p + "/api/branding/logo", json={"data_url": "data:text/html;base64,PGgxPg=="}).status_code == 400
    b = httpx.put(p + "/api/branding", json={"company_name": "Test Steel", "accent": "#2f9bff", "theme": "light"}).json()
    assert b["company_name"] == "Test Steel" and b["accent"] == "#2f9bff"
    assert httpx.put(p + "/api/branding", json={"accent": "red"}).status_code == 400
    assert httpx.get(p + "/api/info").json()["branding"]["theme"] == "light"
    # machine picture travels with the meter
    cfg = httpx.get(p + "/api/settings").json()["config"]
    cfg["meters"][0]["machine"] = "arc_furnace"
    assert httpx.put(p + "/api/settings", json={"config": cfg}).json()["ok"]
    ms = {m["id"]: m for m in httpx.get(p + "/api/meters").json()["meters"]}
    assert ms[cfg["meters"][0]["id"]]["machine"] == "arc_furnace"
    assert httpx.get(p + "/api/info").json()["branding"]["company_name"] == "Test Steel"  # settings save keeps branding


def test_rename_machine_and_own_picture(stack):
    import base64
    p = stack["plant"]
    mid = httpx.get(p + "/api/meters").json()["meters"][0]["id"]
    m = httpx.patch(p + f"/api/machines/{mid}", json={"name": "CGL Line 2", "area": "Coating", "machine": "cgl_line"}).json()
    assert (m["name"], m["area"], m["machine"]) == ("CGL Line 2", "Coating", "cgl_line")
    assert httpx.patch(p + f"/api/machines/{mid}", json={"name": "  "}).status_code == 400
    assert httpx.patch(p + "/api/machines/nope", json={"name": "x"}).status_code == 404
    cfg = httpx.get(p + "/api/settings").json()["config"]
    assert next(x for x in cfg["meters"] if x["id"] == mid)["name"] == "CGL Line 2"  # saved to config.json
    png = base64.b64encode(bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000d49444154789c6360000002000005000155f5b0bb0000000049454e44ae426082")).decode()
    url = httpx.post(p + f"/api/machines/{mid}/picture", json={"data_url": "data:image/png;base64," + png}).json()["picture_url"]
    assert url.startswith("/branding/machines/")
    r = httpx.get(p + url)
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and "default-src 'none'" in r.headers["content-security-policy"]
    assert next(x for x in httpx.get(p + "/api/meters").json()["meters"] if x["id"] == mid)["picture_url"] == url
    assert httpx.post(p + f"/api/machines/{mid}/picture", json={"data_url": "data:text/html;base64,PGgxPg=="}).status_code == 400
    assert httpx.get(p + "/branding/machines/..%2fconfig.json").status_code == 404
    # a full settings save keeps the uploaded picture
    assert httpx.put(p + "/api/settings", json={"config": cfg}).json()["ok"]
    after = next(x for x in httpx.get(p + "/api/meters").json()["meters"] if x["id"] == mid)
    assert after["picture_url"], (after, httpx.get(p + "/api/settings").json()["config"]["branding"])
    assert httpx.post(p + f"/api/machines/{mid}/picture", json={"remove": True}).json()["picture_url"] is None
    assert httpx.get(p + url).status_code == 404
