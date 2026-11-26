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
  EnergyMonitoring --window-test FILE   open and close a test window, write "ok" or the error to FILE (used by the build)

If the app's own window cannot open (for example Microsoft Edge WebView2 is missing on Windows), the dashboard
opens in the default web browser instead. Anything that stops the app from starting is shown in a message box and
written to app.log in the app-data folder.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import traceback
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


def note(msg: str):
    """A line in app.log, so a start-up problem can be found afterwards."""
    try:
        with open(data_dir() / "app.log", "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg.rstrip() + "\n")
    except OSError:
        pass


def alert(msg: str):
    """Show a message the person can read (the app has no console window)."""
    note("MESSAGE: " + msg)
    try:
        if sys.platform == "win32":
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, msg, APP, 0x10 | 0x10000)  # error icon, on top
        elif sys.platform == "darwin":
            text = msg.replace("\\", "\\\\").replace('"', '\\"')
            subprocess.run(["osascript", "-e", f'display alert "{APP}" message "{text}" as critical'], capture_output=True)
        else:
            print(msg, file=sys.stderr)
    except Exception:
        pass


def port() -> int:
    try:
        return int(json.loads(config_path().read_text(encoding="utf-8")).get("listen_port", 8080))
    except (OSError, ValueError):
        return 8080


def set_port(p: int):
    cfg = config_path()
    raw = json.loads(cfg.read_text(encoding="utf-8"))
    raw["listen_port"] = p
    cfg.write_text(json.dumps(raw, indent=2), encoding="utf-8")


def running(p: int) -> bool:
    """Is this app's logger answering on port p (not some other program)?"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{p}/api/info", timeout=1.5) as r:
            return r.status == 200 and "mode" in json.loads(r.read().decode("utf-8", "replace"))
    except (OSError, ValueError):
        return False


def port_taken(p: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", p)) == 0


def free_port(start: int) -> int | None:
    for p in range(start + 1, start + 40):
        if not port_taken(p):
            return p
    return None


def log_tail(lines: int = 12) -> str:
    out = []
    for name in ("logger.log", "logger-console.log", "app.log"):
        try:
            out += (data_dir() / name).read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
        except OSError:
            pass
    return "\n".join(out[-lines:])


def self_command(*args: str) -> list[str]:
    return [sys.executable, *args] if FROZEN else [sys.executable, str(Path(__file__).resolve()), *args]


def start_background():
    log = open(data_dir() / "logger-console.log", "ab")  # the logger itself writes logger.log
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


def open_browser(url: str, why: str):
    import webbrowser
    note(f"opening the dashboard in the web browser instead of the app window: {why}")
    if not webbrowser.open(url) and sys.platform == "win32":
        os.startfile(url)


def open_window(url: str):
    """The dashboard in its own window; the web browser when that window cannot open."""
    shown = []
    started = time.monotonic()
    try:
        import webview  # pywebview: Edge WebView2 on Windows, WebKit on Mac
        w = webview.create_window(APP, url, width=1400, height=900, min_size=(400, 600), text_select=True)
        w.events.shown += lambda *a: shown.append(True)
        webview.start(private_mode=False, storage_path=str(data_dir() / "window"))
    except Exception as e:  # no pywebview, no WebView2 runtime, .NET problem, ...
        note("app window failed:\n" + traceback.format_exc())
        return open_browser(url, f"{type(e).__name__}: {e}")
    if not shown and time.monotonic() - started < 10:
        open_browser(url, "the app window closed before it was shown")


def window_test(out: str):
    """Build check: open a real window, wait for a page to load, close it. Writes "ok" or the error to out."""
    import threading
    result = ["timeout: the window did not load a page within 60 seconds"]
    done = threading.Event()
    try:
        import webview
        w = webview.create_window(APP, html="<h1>Window test</h1>", width=600, height=400)

        def loaded(*a):
            result[0] = "ok"
            done.set()
            w.destroy()

        def give_up():
            if not done.wait(60):
                w.destroy()

        w.events.loaded += loaded
        webview.start(give_up, private_mode=True)
    except Exception:
        result[0] = "error:\n" + traceback.format_exc()
    Path(out).write_text(result[0], encoding="utf-8")


def main():
    args = sys.argv[1:]
    if "--server" in args:
        return serve()
    if "--stop" in args:
        return stop()
    if "--window-test" in args:
        return window_test(args[args.index("--window-test") + 1])
    p = port()
    if not running(p):
        mac_login_item()
        if not running(p) and port_taken(p):
            # Another program already uses this port: move to a free one (saved, so start-up uses it too).
            new = free_port(p)
            if new is None:
                return alert(f"Port {p} and the ones after it are used by other programs, so the dashboard cannot start.")
            note(f"port {p} is used by another program, moving to port {new}")
            set_port(new)
            p = new
        if not running(p):
            start_background()
        for _ in range(180):  # the first start can take a while, for example while antivirus checks the files
            if running(p):
                break
            time.sleep(0.5)
        else:
            tail = log_tail()
            return alert("Energy Monitoring could not start its logger.\n\n"
                         + (f"Last lines of the log:\n{tail}\n\n" if tail else "")
                         + f"The full log is in {data_dir()}. Please send logger.log and app.log from that folder.")
    open_window(f"http://127.0.0.1:{p}/")


if __name__ == "__main__":
    if FROZEN and sys.platform == "win32" and sys.stdout is None:  # windowed build has no console
        sys.stdout = sys.stderr = open(os.devnull, "w")
    try:
        main()
    except Exception:
        note("start-up failed:\n" + traceback.format_exc())
        if "--server" not in sys.argv:
            alert(f"Energy Monitoring could not start:\n\n{traceback.format_exc(limit=3)}\n\nDetails are in {data_dir() / 'app.log'}.")
        sys.exit(1)
