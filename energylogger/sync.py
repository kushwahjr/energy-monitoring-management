"""Pushes logged readings and events from the plant PC to the cloud server.

Data is kept in the local database first, so nothing is lost when the internet
drops. The sync loop remembers the last row it sent and catches up the backlog
once the connection is back.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import time

import httpx

from .config import Config
from .db import Database
from .params import PARAM_KEYS

log = logging.getLogger("energylogger.sync")


class CloudSyncer:
    def __init__(self, config: Config, db: Database):
        assert config.cloud is not None
        self.config = config
        self.cloud = config.cloud
        self.db = db
        self.status = {"enabled": True, "url": self.cloud.url, "last_ok": None, "last_error": None, "backlog": 0}
        self._task: asyncio.Task | None = None

    def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def _meters_payload(self):
        return [
            {"id": m.id, "name": m.name, "area": m.area, "contract_kva": m.contract_kva, "is_main": m.is_main, "machine": m.machine,
             "panel": m.panel, "position": m.position, "fed_from": m.fed_from, "feeds": m.feeds,
             "alarms": {k: v for k, v in dataclasses.asdict(m.alarms).items() if v is not None}}
            for m in self.config.meters
        ]

    def _backlog(self) -> int:
        last = int(self.db.get_kv("sync_readings_id", "0"))
        return self.db.query("SELECT COUNT(*) AS n FROM readings WHERE id > ?", (last,))[0]["n"]

    async def sync_once(self, client: httpx.AsyncClient) -> bool:
        """Send one batch. Returns True when more rows are waiting."""
        r_last = int(self.db.get_kv("sync_readings_id", "0"))
        e_last = int(self.db.get_kv("sync_events_id", "0"))
        n = self.cloud.batch_size
        readings = self.db.rows_after("readings", r_last, n)
        events = self.db.rows_after("events", e_last, n)
        body = {
            "plant_id": self.config.plant_id,
            "plant_name": self.config.plant_name,
            "meters": self._meters_payload(),
            "panels": self.config.panels,
            "readings": [{k: r[k] for k in ("ts", "meter_id", *PARAM_KEYS) if r[k] is not None} for r in readings],
            "events": [{k: e[k] for k in ("ts", "meter_id", "kind", "message", "active")} for e in events],
        }
        resp = await client.post(
            f"{self.cloud.url}/api/ingest", json=body,
            headers={"X-Plant-Key": self.cloud.api_key}, timeout=30,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"cloud answered {resp.status_code}: {resp.text[:200]}")
        if readings:
            self.db.set_kv("sync_readings_id", str(readings[-1]["id"]))
        if events:
            self.db.set_kv("sync_events_id", str(events[-1]["id"]))
        return len(readings) == n or len(events) == n

    async def _run(self):
        async with httpx.AsyncClient() as client:
            while True:
                try:
                    while await self.sync_once(client):
                        pass
                    self.status["last_ok"] = time.time()
                    self.status["last_error"] = None
                except Exception as e:
                    self.status["last_error"] = str(e) or type(e).__name__
                    log.warning("cloud sync failed, will retry: %s", self.status["last_error"])
                self.status["backlog"] = self._backlog()
                await asyncio.sleep(self.cloud.sync_seconds)
