"""Energy Monitoring Management as a desktop app (the Windows .exe and the Mac .app use this).

Opening the app:
  1. starts the logger in the background if it is not already running, then
  2. shows the dashboard in its own window.

Closing the window does NOT stop logging: the logger keeps reading meters and serving phones and
other PCs on the network. It also starts by itself when the computer starts (Windows: chosen in
the installer; Mac: a login item that the app adds the first time). "Stop logging" stops it.

Settings, the database and pictures are kept in the user's app-data folder, so updating or
reinstalling the app never touches them:
  Windows  %LOCALAPPDATA%\\Energy Monitoring
  Mac      ~/Library/Application Support/Energy Monitoring

  EnergyMonitoring            open the dashboard (start logging if needed)
  EnergyMonitoring --server   run the logger only, no window (used at start-up)
  EnergyMonitoring --stop     stop the background logger
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

APP = "Energy Monitoring"
FROZEN = getattr(sys, "frozen", False)
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))  # where web/, profiles/ and the examples are
LAUNCH_AGENT = Path.home() / "Library/LaunchAgents/com.energymonitoring.logger.plist"


def data_dir() -> Path:
    if sys.platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
    elif sys.platform == "darwin":
        root = Path.home() / "Library/Application Support"
    else:
        root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    d = root / APP
    d.mkdir(parents=True, exist_ok=True)
    return d


def config_path() -> Path:
    cfg = data_dir() / "config.json"
    if not cfg.exists():
        raw = json.loads((BASE / "config.example.json").read_text(encoding="utf-8"))
        raw["database"] = "data/energy.db"  # next to config.json, in the app-data folder
        cfg.write_text(json.dumps(raw, indent=2), encoding="utf-8")
    return cfg


def port() -> int:
    try:
        return int(json.loads(config_path().read_text(encoding="utf-8")).get("listen_port", 8080))
    except (OSError, ValueError):
        return 8080


def running(p: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{p}/api/info", timeout=1.5) as r:
            return r.status == 200
    except OSError:
        return False


def self_command(*args: str) -> list[str]:
    return [sys.executable, *args] if FROZEN else [sys.executable, str(Path(__file__).resolve()), *args]


def start_background():
    log = open(data_dir() / "logger.log", "ab")
    kw: dict = {"stdout": log, "stderr": log, "stdin": subprocess.DEVNULL, "cwd": str(data_dir())}
    if sys.platform == "win32":
        kw["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # detached, own process group, no console window
    else:
        kw["start_new_session"] = True
    subprocess.Popen(self_command("--server"), **kw)


def serve():
    """The logger and web server, without a window."""
    import logging
    from logging.handlers import RotatingFileHandler

    sys.path.insert(0, str(BASE))
    handler = RotatingFileHandler(data_dir() / "logger.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=[handler])
    import uvicorn
    from energylogger.config import load_config
    from energylogger.server import create_app

    cfg_path = config_path()
    cfg = load_config(cfg_path)
    (data_dir() / "logger.pid").write_text(str(os.getpid()))
    uvicorn.run(create_app(cfg_path), host=cfg.listen_host, port=cfg.listen_port, log_level="warning", log_config=None)


def stop():
    pid_file = data_dir() / "logger.pid"
    try:
        pid = int(pid_file.read_text())
    except (OSError, ValueError):
        return
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    pid_file.unlink(missing_ok=True)
    if sys.platform == "darwin" and LAUNCH_AGENT.exists():  # otherwise macOS starts it again
        subprocess.run(["launchctl", "unload", str(LAUNCH_AGENT)], capture_output=True)


def mac_login_item():
    """Mac: start the logger at login and keep it running (once, the first time the app opens)."""
    if sys.platform != "darwin" or not FROZEN:
        return
    exe = sys.executable
    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.energymonitoring.logger</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>--server</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>WorkingDirectory</key><string>{data_dir()}</string>
  <key>StandardOutPath</key><string>{data_dir() / "logger.log"}</string>
  <key>StandardErrorPath</key><string>{data_dir() / "logger.log"}</string>
</dict></plist>
"""
    if LAUNCH_AGENT.exists() and LAUNCH_AGENT.read_text() == plist:
        subprocess.run(["launchctl", "load", str(LAUNCH_AGENT)], capture_output=True)
        return
    LAUNCH_AGENT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["launchctl", "unload", str(LAUNCH_AGENT)], capture_output=True)
    LAUNCH_AGENT.write_text(plist)
    subprocess.run(["launchctl", "load", str(LAUNCH_AGENT)], capture_output=True)


def open_window(url: str):
    try:
        import webview  # pywebview: Edge WebView2 on Windows, WebKit on Mac
    except ImportError:
        import webbrowser
        webbrowser.open(url)
        return
    webview.create_window(APP, url, width=1400, height=900, min_size=(400, 600), text_select=True)
    webview.start(private_mode=False, storage_path=str(data_dir() / "window"))


def main():
    args = sys.argv[1:]
    if "--server" in args:
        return serve()
    if "--stop" in args:
        return stop()
    p = port()
    if not running(p):
        mac_login_item()
        if not running(p):
            start_background()
        for _ in range(60):  # first start can take a few seconds
            if running(p):
                break
            time.sleep(0.5)
        else:
            raise SystemExit(f"The logger did not start. See {data_dir() / 'logger.log'}")
    open_window(f"http://127.0.0.1:{p}/")


if __name__ == "__main__":
    if FROZEN and sys.platform == "win32" and sys.stdout is None:  # windowed build has no console
        sys.stdout = sys.stderr = open(os.devnull, "w")
    main()
