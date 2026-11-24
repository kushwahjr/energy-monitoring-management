"""SQLite storage for meter readings and alarm events."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from .params import PARAM_KEYS


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        cols = ", ".join(f"{k} REAL" for k in PARAM_KEYS)
        with self.lock, self.conn:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute(f"CREATE TABLE IF NOT EXISTS readings (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, meter_id TEXT NOT NULL, {cols})")
            self.conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_meter_ts ON readings(meter_id, ts)")
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS meters (id TEXT PRIMARY KEY, plant_id TEXT NOT NULL, name TEXT NOT NULL,"
                " area TEXT NOT NULL, contract_kva REAL, is_main INTEGER NOT NULL DEFAULT 0, machine TEXT NOT NULL DEFAULT '', alarms TEXT NOT NULL DEFAULT '{}', updated INTEGER NOT NULL)"
            )
            # upgrade databases made by older versions
            have = {r[1] for r in self.conn.execute("PRAGMA table_info(meters)")}
            if "is_main" not in have:
                self.conn.execute("ALTER TABLE meters ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0")
            if "machine" not in have:
                self.conn.execute("ALTER TABLE meters ADD COLUMN machine TEXT NOT NULL DEFAULT ''")
            self.conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, meter_id TEXT NOT NULL, kind TEXT NOT NULL,"
                " message TEXT NOT NULL, active INTEGER NOT NULL)"
            )
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)")
            self.conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique ON events(meter_id, ts, kind, active)")

    def insert_reading(self, ts: int, meter_id: str, values: dict[str, float]):
        keys = [k for k in PARAM_KEYS if k in values]
        sql = f"INSERT OR IGNORE INTO readings (ts, meter_id{''.join(', ' + k for k in keys)}) VALUES ({', '.join('?' * (len(keys) + 2))})"
        with self.lock, self.conn:
            self.conn.execute(sql, [ts, meter_id, *[values[k] for k in keys]])

    def insert_event(self, ts: int, meter_id: str, kind: str, message: str, active: bool):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT OR IGNORE INTO events (ts, meter_id, kind, message, active) VALUES (?, ?, ?, ?, ?)",
                (ts, meter_id, kind, message, int(active)),
            )

    # ---- meter registry (used on the plant PC and on the cloud server) ----
    def upsert_meter(self, m: dict):
        import json, time
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO meters (id, plant_id, name, area, contract_kva, is_main, machine, alarms, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET plant_id=excluded.plant_id, name=excluded.name, area=excluded.area,"
                " contract_kva=excluded.contract_kva, is_main=excluded.is_main, machine=excluded.machine, alarms=excluded.alarms, updated=excluded.updated",
                (m["id"], m.get("plant_id", ""), m.get("name", m["id"]), m.get("area", ""), m.get("contract_kva"),
                 int(bool(m.get("is_main"))), str(m.get("machine") or "")[:40], json.dumps(m.get("alarms", {})), int(time.time())),
            )

    def meters(self):
        return self.query("SELECT * FROM meters ORDER BY plant_id, area, name")

    def latest_readings(self):
        return {r["meter_id"]: r for r in self.query(
            "SELECT r.* FROM readings r JOIN (SELECT meter_id, MAX(ts) AS ts FROM readings GROUP BY meter_id) x"
            " ON r.meter_id = x.meter_id AND r.ts = x.ts")}

    # ---- sync bookkeeping ----
    def get_kv(self, key: str, default: str = "") -> str:
        rows = self.query("SELECT value FROM kv WHERE key = ?", (key,))
        return rows[0]["value"] if rows else default

    def set_kv(self, key: str, value: str):
        with self.lock, self.conn:
            self.conn.execute("INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def rows_after(self, table: str, last_id: int, limit: int):
        assert table in ("readings", "events")
        return self.query(f"SELECT * FROM {table} WHERE id > ? ORDER BY id LIMIT ?", (last_id, limit))

    def insert_many_readings(self, rows: list[dict]):
        with self.lock, self.conn:
            for values in rows:
                keys = [k for k in PARAM_KEYS if values.get(k) is not None]
                self.conn.execute(
                    f"INSERT OR IGNORE INTO readings (ts, meter_id{''.join(', ' + k for k in keys)})"
                    f" VALUES ({', '.join('?' * (len(keys) + 2))})",
                    [int(values["ts"]), values["meter_id"], *[float(values[k]) for k in keys]],
                )

    def insert_many_events(self, rows: list[dict]):
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT OR IGNORE INTO events (ts, meter_id, kind, message, active) VALUES (?, ?, ?, ?, ?)",
                [(int(e["ts"]), e["meter_id"], str(e["kind"]), str(e["message"]), int(bool(e["active"]))) for e in rows],
            )

    def query(self, sql: str, args=()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def history(self, meter_id: str, param: str, start: int, end: int, max_points: int = 600):
        if param not in PARAM_KEYS:
            raise ValueError(param)
        span = max(end - start, 1)
        bucket = max(1, span // max_points)
        return self.query(
            f"SELECT (ts / ?) * ? AS t, AVG({param}) AS v, MIN({param}) AS lo, MAX({param}) AS hi FROM readings"
            f" WHERE meter_id = ? AND ts >= ? AND ts < ? AND {param} IS NOT NULL GROUP BY t ORDER BY t",
            (bucket, bucket, meter_id, start, end),
        )

    def readings(self, meter_ids: list[str], start: int, end: int):
        marks = ", ".join("?" * len(meter_ids))
        return self.query(
            f"SELECT * FROM readings WHERE meter_id IN ({marks}) AND ts >= ? AND ts < ? ORDER BY meter_id, ts",
            (*meter_ids, start, end),
        )

    def events(self, start: int, limit: int = 200):
        return self.query("SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?", (start, limit))
