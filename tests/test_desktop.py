"""The desktop app moves the dashboard to another port when its port cannot be opened.

On a Windows laptop port 8080 was refused with "WinError 10013 ... forbidden by its access permissions" although
no program answered on it (Windows keeps port ranges for Hyper-V, WSL and Docker). Here a socket that is bound
but not listening plays that part: nothing answers on the port, yet it cannot be opened.
"""

import importlib.util
import json
import socket
import sys

import pytest

from test_end_to_end import ROOT, free_port, wait_for

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="uses XDG_DATA_HOME for the app-data folder")


@pytest.fixture()
def desktop(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    spec = importlib.util.spec_from_file_location("desktop_app", ROOT / "desktop.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    yield mod
    mod.stop()


def blocked_port() -> socket.socket:
    s = socket.socket()
    s.bind(("0.0.0.0", free_port()))  # bound, not listening: no answer, and it cannot be opened
    return s


def write_config(desktop, p: int):
    raw = json.loads((ROOT / "config.example.json").read_text())
    raw.update(listen_port=p, listen_host="0.0.0.0", poll_seconds=0.5)
    raw["database"] = "data/energy.db"
    (desktop.data_dir() / "config.json").write_text(json.dumps(raw))


def test_app_moves_off_a_port_it_cannot_open(desktop, monkeypatch):
    held = blocked_port()
    bad = held.getsockname()[1]
    write_config(desktop, bad)
    assert not desktop.port_taken(bad) and not desktop.can_listen(bad, "0.0.0.0")
    opened = []
    monkeypatch.setattr(desktop, "open_window", opened.append)
    monkeypatch.setattr(sys, "argv", ["EnergyMonitoring"])
    desktop.main()
    p = desktop.port()
    assert p != bad and opened == [f"http://127.0.0.1:{p}/"] and desktop.running(p)
    assert "cannot be used" in (desktop.data_dir() / "app.log").read_text()
    held.close()


def test_logger_started_with_the_computer_moves_too(desktop):
    held = blocked_port()
    bad = held.getsockname()[1]
    write_config(desktop, bad)
    desktop.start_background()  # what Windows runs at start-up: EnergyMonitoring --server
    p = wait_for(lambda: (lambda p: p if p != bad and desktop.running(p) else None)(desktop.port()), timeout=30)
    assert desktop.can_listen(bad, "0.0.0.0") is False and p != bad
    held.close()
