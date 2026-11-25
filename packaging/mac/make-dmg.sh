#!/bin/bash
# Makes dist/EnergyMonitoring-<version>-<arch>.dmg from "dist/Energy Monitoring.app" (built by the PyInstaller spec).
set -euo pipefail
VERSION="${1:-1.5.0}"
ARCH="$(uname -m)"
cd "$(dirname "$0")/../../dist"
rm -rf dmg && mkdir dmg
cp -R "Energy Monitoring.app" dmg/
ln -s /Applications dmg/Applications
cat > dmg/"Read me first.txt" <<TXT
Drag Energy Monitoring to Applications, then open it from Applications.

The first time, macOS may say it cannot check the app for malware, because it is not signed with an
Apple Developer certificate yet. Then: System Settings > Privacy & Security > scroll down > Open Anyway.
(On older macOS: right-click the app > Open > Open.)

Logging keeps running in the background after you close the window, and starts again when you log in.
Your settings and data are in ~/Library/Application Support/Energy Monitoring
TXT
# ad-hoc signature so Apple Silicon Macs will run it
codesign --force --deep --sign - "dmg/Energy Monitoring.app"
hdiutil create -volname "Energy Monitoring" -srcfolder dmg -ov -format UDZO "EnergyMonitoring-${VERSION}-mac-${ARCH}.dmg"
rm -rf dmg
