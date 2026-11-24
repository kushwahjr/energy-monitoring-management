"""Every shipped meter model profile must decode what a meter of that model would send.

This checks data types, scales, word order and the 1-based address handling of each profile
against a fake meter that encodes values the same way the profile describes. It cannot prove
the register addresses match the real meter: that needs Test reading on site.
"""

import asyncio
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from energylogger.config import parse_config  # noqa: E402
from energylogger.readers import ModbusPortReader  # noqa: E402

PROFILES = sorted(p.stem for p in (ROOT / "profiles").glob("*.json"))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.mark.parametrize("name", PROFILES)
def test_profile_round_trip(name):
    port = free_port()
    proc = subprocess.Popen([sys.executable, str(ROOT / "tools/fake_meter.py"), "--port", str(port), "--units", "1", "--profile", name],
                            stderr=subprocess.DEVNULL)
    try:
        cfg = parse_config({"ports": {"p": {"kind": "ethernet", "host": "127.0.0.1", "port": port, "timeout": 1}},
                            "meters": [{"id": "m", "port": "p", "profile": name}]}, ROOT)

        async def read():
            for _ in range(50):
                r = ModbusPortReader(cfg.ports["p"])
                try:
                    return await r.read(cfg.meters[0], cfg.profiles[name])
                except Exception:
                    await asyncio.sleep(0.1)
                finally:
                    await r.close()
            raise AssertionError("fake meter did not answer")

        v = asyncio.run(read())
        prof = json.loads((ROOT / "profiles" / f"{name}.json").read_text())
        for param in prof["registers"]:
            assert param in v, f"{name}: {param} missing"
        assert 49 <= v["hz"] <= 51, f"{name}: frequency decoded as {v['hz']}"
        if "kw" in v:
            assert 100 < v["kw"] < 2000, f"{name}: kW decoded as {v['kw']}"
        if "pf" in v:
            assert 0.85 < abs(v["pf"]) <= 1, f"{name}: PF decoded as {v['pf']}"
        for k in ("v1", "v_ln"):
            if k in prof["registers"]:
                assert 230 < v[k] < 250, f"{name}: {k} decoded as {v[k]}"
        if "kwh" in v:
            assert 900 < v["kwh"] < 1200, f"{name}: kWh decoded as {v['kwh']}"
    finally:
        proc.terminate()
        proc.wait(5)
