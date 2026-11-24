#!/bin/bash
# Energy Monitoring Management - start on macOS (or Linux). First run installs what it needs.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
fi
exec .venv/bin/python run.py "$@"
