"""Connecting real meters: RS485 on a virtual serial port, Test reading, plain-language errors, removing the demo.

The fake meter answers like a real one on a virtual serial port (Linux/Mac), so the RS485 path is tested
the same way a USB-RS485 converter is used on the plant PC.
"""

import json
import subprocess
import sys
import time

import httpx
import pytest

from test_end_to_end import ROOT, free_port, wait_for, wait_http

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="virtual serial ports need Linux or macOS")


def start_fake(*args) -> tuple[subprocess.Popen, str]:
    p = subprocess.Popen([sys.executable, str(ROOT / "tools/fake_meter.py"), *args], stdout=subprocess.PIPE, text=True)
    return p, p.stdout.readline().strip() if "--pty" in args else ""


@pytest.fixture(scope="module")
def plant(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("real")
    # a Selec MFM384 on RS485 that sends the two halves of each value swapped, and a Schneider meter on Ethernet without THD
    rtu, dev = start_fake("--pty", "--units", "1", "--profile", "selec_mfm384", "--word-order", "little")
    eth = free_port()
    tcp, _ = start_fake("--port", str(eth), "--units", "1", "--profile", "schneider_powerlogic_pm5000")
    gap = free_port()
    tcp2, _ = start_fake("--port", str(gap), "--units", "1", "--missing", "kvah", "kvarh")
    raw = json.loads((ROOT / "config.example.json").read_text())  # what a new installation starts with: the demo
    raw.update(database=str(tmp / "plant.db"), poll_seconds=0.5, log_seconds=1)
    (tmp / "plant.json").write_text(json.dumps(raw))
    web = free_port()
    srv = subprocess.Popen([sys.executable, str(ROOT / "run.py"), "--config", str(tmp / "plant.json"), "--port", str(web), "--host", "127.0.0.1"])
    url = f"http://127.0.0.1:{web}"
    wait_http(url + "/api/info")
    yield {"url": url, "dev": dev, "eth": eth, "gap": gap, "tmp": tmp}
    for p in (srv, rtu, tcp, tcp2):
        p.terminate()
    for p in (srv, rtu, tcp, tcp2):
        p.wait(5)


def try_meter(plant, meter, ports, profiles=None):
    body = {"meter": meter, "ports": ports}
    if profiles:
        body["profiles"] = profiles
    return httpx.post(plant["url"] + "/api/settings/test-meter", json=body, timeout=20).json()


def selec(plant, **kw):
    return {"meter": {"id": "ccl1", "name": "CCL line", "port": "com", "profile": "selec_mfm384", "unit_id": kw.get("unit", 1)},
            "ports": {"com": {"kind": "rs485", "serial_port": kw.get("dev", plant["dev"]), "baudrate": 9600, "parity": "N", "stopbits": 1, "timeout": 0.5}}}


def test_remove_demo_leaves_a_clean_plant(plant):
    u = plant["url"]
    wait_for(lambda: any(m["online"] for m in httpx.get(u + "/api/meters").json()["meters"]))
    time.sleep(1.5)  # let the demo log some history
    assert httpx.get(u + "/api/info").json()["demo"] is True
    r = httpx.post(u + "/api/settings/remove-demo", json={}, timeout=20).json()
    assert r["ok"] and r["removed"] > 20
    info = httpx.get(u + "/api/info").json()
    assert info["demo"] is False and info["panels"]  # the plant's panels stay
    cfg = httpx.get(u + "/api/settings").json()["config"]
    assert cfg["meters"] == [] and list(cfg["ports"]) == ["rs485_1"] and cfg["ports"]["rs485_1"]["kind"] == "rs485"
    assert httpx.get(u + "/api/meters").json()["meters"] == []
    assert httpx.get(u + "/api/reports/daily").json()["rows"] == []  # the made-up history is gone


def test_rs485_word_order_is_detected_and_fixed(plant):
    t = try_meter(plant, **selec(plant))
    assert t["ok"] and t["fix"] == {"profile": "selec_mfm384", "word_order": "little"}
    assert 49 < t["values"]["hz"] < 51 and 200 < t["values"]["v_ln"] < 260 and t["values"]["kwh"] > 900
    lib = httpx.get(plant["url"] + "/api/settings").json()["library_profiles"]["selec_mfm384"]
    fixed = try_meter(plant, **selec(plant), profiles={"selec_mfm384": {**lib, "word_order": "little"}})
    assert fixed["ok"] and fixed["fix"] is None and fixed["hint"] is None


def test_plain_language_errors(plant):
    wrong_id = try_meter(plant, **selec(plant, unit=7))
    assert not wrong_id["ok"] and "No answer from meter ID 7" in wrong_id["error"] and "9600 baud" in wrong_id["error"]
    no_port = try_meter(plant, **selec(plant, dev="COM42"))
    assert not no_port["ok"] and "COM42 was not found" in no_port["error"]
    wrong_model = try_meter(plant, {"id": "x", "port": "com", "profile": "secure_elite_440", "unit_id": 1}, selec(plant)["ports"])
    assert not wrong_model["ok"] and "meter model chosen is probably wrong" in wrong_model["error"]
    unreachable = try_meter(plant, {"id": "x", "port": "lan", "profile": "schneider_powerlogic_pm5000", "unit_id": 1},
                       {"lan": {"kind": "ethernet", "host": "127.0.0.1", "port": free_port(), "timeout": 0.5}})
    assert not unreachable["ok"] and "Cannot reach the meter at 127.0.0.1" in unreachable["error"]
    # the virtual port is still free afterwards: a failed test lets go of it
    assert try_meter(plant, **selec(plant))["ok"]


def test_values_a_meter_lacks_are_skipped(plant):
    t = try_meter(plant, {"id": "x", "port": "lan", "profile": "generic_float32_template", "unit_id": 1},
             {"lan": {"kind": "ethernet", "host": "127.0.0.1", "port": plant["gap"], "timeout": 0.5}})
    assert t["ok"] and set(t["skipped"]) == {"kvah", "kvarh"} and t["values"]["kwh"] > 0


def test_real_meters_log_after_saving(plant):
    u = plant["url"]
    cfg = httpx.get(u + "/api/settings").json()
    raw, lib = cfg["config"], cfg["library_profiles"]
    raw["ports"]["rs485_1"].update(serial_port=plant["dev"], timeout=0.5)
    raw["ports"]["lan"] = {"kind": "ethernet", "host": "127.0.0.1", "port": plant["eth"], "timeout": 0.5}
    raw["profiles"] = {"selec_mfm384": {**lib["selec_mfm384"], "word_order": "little"}}
    raw["meters"] = [
        {"id": "inc", "name": "Main incomer", "area": "HT", "port": "lan", "profile": "schneider_powerlogic_pm5000", "unit_id": 1, "is_main": True},
        {"id": "ccl1", "name": "CCL line", "area": "Coating", "port": "rs485_1", "profile": "selec_mfm384", "unit_id": 1},
    ]
    no_model = json.loads(json.dumps(raw))
    no_model["meters"][1]["profile"] = ""
    r = httpx.put(u + "/api/settings", json={"config": no_model})
    assert r.status_code == 400 and "choose its meter model" in r.json()["detail"]
    assert httpx.put(u + "/api/settings", json={"config": raw}, timeout=20).json()["ok"]
    ms = wait_for(lambda: (lambda ms: ms if all(m["online"] for m in ms.values()) else None)(
        {m["id"]: m for m in httpx.get(u + "/api/meters").json()["meters"]}))
    assert 49 < ms["ccl1"]["values"]["hz"] < 51 and ms["inc"]["values"]["kwh"] > 900
    # a test with other settings on the COM port the logger is using pauses the logger instead of failing
    t = try_meter(plant, {"id": "ccl1", "port": "rs485_1", "profile": "selec_mfm384", "unit_id": 1},
             {"rs485_1": {**raw["ports"]["rs485_1"], "timeout": 0.8}}, raw["profiles"])
    assert t["ok"] and t["fix"] is None
    wait_for(lambda: len(httpx.get(u + "/api/history", params={"meter": "ccl1", "param": "kw", "hours": 1}).json()["points"]) >= 2 or None)
    assert all(m["online"] for m in httpx.get(u + "/api/meters").json()["meters"])
