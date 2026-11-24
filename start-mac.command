#!/bin/bash
# Energy Monitoring Management - start on macOS (or Linux). The first run installs what it needs (needs internet once).
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null; then
  echo "Python 3 is not installed. Install it from https://www.python.org/downloads/ and run this again."
  read -r -p "Press Enter to close"; exit 1
fi
if [ ! -d .venv ]; then
  echo "First start: installing, this takes a minute..."
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
fi
exec .venv/bin/python run.py "$@"
