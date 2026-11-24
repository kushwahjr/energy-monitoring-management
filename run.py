"""Start the Steel Energy Logger.

  python run.py                       start with config.json
  python run.py --config cloud.json   start with another config file
  python run.py hash-password         make a password hash for the "users" list
  python run.py new-key               make a random key (secret_key, api_key)
"""

import argparse
import getpass
import logging
import secrets
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description="Steel Energy Logger")
    ap.add_argument("command", nargs="?", default="serve", choices=["serve", "hash-password", "new-key"])
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    args = ap.parse_args()

    if args.command == "hash-password":
        from energylogger.auth import hash_password
        pw = getpass.getpass("Password: ")
        if pw != getpass.getpass("Again: "):
            sys.exit("Passwords do not match")
        print(hash_password(pw))
        return
    if args.command == "new-key":
        print(secrets.token_urlsafe(32))
        return

    cfg_path = Path(args.config)
    if not cfg_path.exists():
        example = HERE / "config.example.json"
        shutil.copy(example, cfg_path)
        print(f"Created {cfg_path} from the example (simulated meters). Edit it or use the Settings page.")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    import uvicorn
    from energylogger.config import load_config
    from energylogger.server import create_app

    cfg = load_config(cfg_path)
    app = create_app(cfg_path)
    host = args.host or cfg.listen_host
    port = args.port or cfg.listen_port
    print(f"\n  Steel Energy Logger ({cfg.mode} mode) on http://{'localhost' if host == '0.0.0.0' else host}:{port}\n")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
