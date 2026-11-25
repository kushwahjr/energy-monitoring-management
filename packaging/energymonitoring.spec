# PyInstaller recipe for the desktop app.  Build with:  pyinstaller packaging/energymonitoring.spec
# Windows: dist/EnergyMonitoring/EnergyMonitoring.exe (then packaging/windows/installer.iss makes the setup .exe)
# Mac:     dist/Energy Monitoring.app (then packaging/mac/make-dmg.sh makes the .dmg)
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

ROOT = Path(SPECPATH).parent
sys.path.insert(0, str(ROOT))
from energylogger import __version__

hidden = (collect_submodules("uvicorn") + collect_submodules("energylogger") + collect_submodules("pymodbus")
          + collect_submodules("serial") + ["anthropic"])
datas = [(str(ROOT / "web"), "web"), (str(ROOT / "profiles"), "profiles"),
         (str(ROOT / "config.example.json"), "."), (str(ROOT / "cloud.example.json"), ".")]
datas += collect_data_files("tzdata")
try:
    datas += collect_data_files("webview")
except Exception:
    pass

a = Analysis([str(ROOT / "desktop.py")], pathex=[str(ROOT)], hiddenimports=hidden, datas=datas,
             excludes=["tkinter", "matplotlib", "numpy", "PIL", "pytest"], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="EnergyMonitoring", console=False,
          icon=str(ROOT / "packaging" / ("icon.ico" if sys.platform == "win32" else "icon.icns")),
          version=None, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="EnergyMonitoring", upx=False)
if sys.platform == "darwin":
    app = BUNDLE(coll, name="Energy Monitoring.app", icon=str(ROOT / "packaging" / "icon.icns"),
                 bundle_identifier="com.energymonitoring.app",
                 info_plist={"CFBundleShortVersionString": __version__, "CFBundleVersion": __version__,
                             "NSHighResolutionCapable": True, "LSMinimumSystemVersion": "11.0",
                             "NSLocalNetworkUsageDescription": "Reads energy meters and serves the dashboard to phones on the plant network."})
