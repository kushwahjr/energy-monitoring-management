"""Polls every meter, keeps the live values, logs to the database and raises alarms."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

from .config import Config, Meter
from .db import Database
from .plantsim import PlantSim
from .readers import ModbusPortReader, ReadError, SimulatedReader

log = logging.getLogger("energylogger")


@dataclass
class MeterState:
    online: bool = False
    last_ok: float | None = None
    last_error: str | None = None
    values: dict[str, float] = field(default_factory=dict)
    alarms: dict[str, str] = field(default_factory=dict)
    # running sums since the last log write, so logged values are averages, not snapshots
    acc: dict[str, float] = field(default_factory=dict)
    acc_n: int = 0
    last_log: float = 0.0


def check_alarms(meter: Meter, v: dict[str, float]) -> dict[str, str]:
    a = meter.alarms
    out: dict[str, str] = {}
    if a.pf_min is not None and "pf" in v and abs(v["pf"]) < a.pf_min:
        out["pf_low"] = f"Power factor {abs(v['pf']):.3f} below {a.pf_min}"
    if a.kva_max is not None and v.get("kva", 0) > a.kva_max:
        out["kva_high"] = f"Load {v['kva']:.0f} kVA above {a.kva_max:.0f} kVA"
    if a.kw_max is not None and v.get("kw", 0) > a.kw_max:
        out["kw_high"] = f"Load {v['kw']:.0f} kW above {a.kw_max:.0f} kW"
    if a.v_ln_min is not None and "v_ln" in v and v["v_ln"] < a.v_ln_min:
        out["v_low"] = f"Voltage {v['v_ln']:.1f} V below {a.v_ln_min} V"
    if a.v_ln_max is not None and "v_ln" in v and v["v_ln"] > a.v_ln_max:
        out["v_high"] = f"Voltage {v['v_ln']:.1f} V above {a.v_ln_max} V"
    if a.i_max is not None:
        imax = max((v.get(k, 0) for k in ("i1", "i2", "i3", "i_avg")), default=0)
        if imax > a.i_max:
            out["i_high"] = f"Current {imax:.0f} A above {a.i_max:.0f} A"
    if a.thd_v_max is not None and v.get("thd_v", 0) > a.thd_v_max:
        out["thd_v_high"] = f"Voltage THD {v['thd_v']:.1f}% above {a.thd_v_max}%"
    return out


class Collector:
    def __init__(self, config: Config, db: Database):
        self.config = config
        self.db = db
        self.state: dict[str, MeterState] = {m.id: MeterState() for m in config.meters}
        self.plant = PlantSim(config) if any(p.kind == "simulator" for p in config.ports.values()) else None
        self.sim = SimulatedReader(self.plant)
        self.watch = PlantWatch(config, db)
        self.port_readers = {
            name: ModbusPortReader(p) for name, p in config.ports.items() if p.kind != "simulator"
        }
        self._task: asyncio.Task | None = None
        self._wake: asyncio.Event | None = None

    def wake(self):
        """Poll again now (used by the demo power cut switch)."""
        if self._wake:
            self._wake.set()

    def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        for r in self.port_readers.values():
            await r.close()

    async def _run(self):
        while True:
            started = time.monotonic()
            # Meters on different ports are read in parallel; meters on one port take turns.
            await asyncio.gather(*(self.poll_meter(m) for m in self.config.meters if m.enabled))
            try:
                self.watch.update(self.state, time.time())
            except Exception:
                log.exception("plant event check failed")
            wait = self.config.poll_seconds
            if self.plant:  # demo: poll faster while the DGs start or change over, so the animation keeps up
                dt = self.plant.phase(time.time())["dt"]
                if dt is not None and dt < 70:
                    wait = min(wait, 1.5)
            if self._wake is None:
                self._wake = asyncio.Event()
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), max(0.2, wait - (time.monotonic() - started)))
            except asyncio.TimeoutError:
                pass

    async def poll_meter(self, meter: Meter):
        st = self.state[meter.id]
        now = time.time()
        try:
            port = self.config.ports[meter.port]
            if port.kind == "simulator":
                values = await self.sim.read(meter)
            else:
                values = await self.port_readers[meter.port].read(meter, self.config.profiles[meter.profile])
        except (ReadError, OSError, asyncio.TimeoutError) as e:
            if st.online or st.last_error is None:
                self.db.insert_event(int(now), meter.id, "offline", f"Offline: {e}", True)
                log.warning("%s offline: %s", meter.id, e)
            st.online = False
            st.last_error = str(e)
            return
        except Exception as e:  # never let one meter stop the loop
            log.exception("unexpected error reading %s", meter.id)
            st.online = False
            st.last_error = str(e)
            return

        if not st.online and st.last_error is not None:
            self.db.insert_event(int(now), meter.id, "offline", "Back online", False)
        st.online = True
        st.last_ok = now
        st.last_error = None
        st.values = values

        new_alarms = check_alarms(meter, values)
        for k, msg in new_alarms.items():
            if k not in st.alarms:
                self.db.insert_event(int(now), meter.id, k, msg, True)
        for k in st.alarms.keys() - new_alarms.keys():
            self.db.insert_event(int(now), meter.id, k, "Cleared", False)
        st.alarms = new_alarms

        for k, v in values.items():
            st.acc[k] = st.acc.get(k, 0.0) + v
        st.acc_n += 1
        if now - st.last_log >= self.config.log_seconds:
            row = {k: s / st.acc_n for k, s in st.acc.items()}
            # energy counters: store the latest register value, not an average
            for k in ("kwh", "kvah", "kvarh"):
                if k in values:
                    row[k] = values[k]
            self.db.insert_reading(int(now), meter.id, row)
            st.acc, st.acc_n, st.last_log = {}, 0, now


def has_voltage(v: dict) -> bool:
    return (v.get("v_ln") or 0) > 50 or (v.get("v_ll") or 0) > 90


def carries_load(v: dict) -> bool:
    return abs(v.get("kw") or 0) > 1 or (v.get("i_avg") or 0) > 2


def fmt_dur(sec: float) -> str:
    sec = int(sec)
    h, m = divmod(sec // 60, 60)
    return f"{h} h {m} min" if h else (f"{m} min {sec % 60} s" if m else f"{sec} s")


class PlantWatch:
    """Turns live values into plant events: power cut and restore, DG start and stop, PCC changeover.

    Works the same for real meters and the demo. Events go into the events table, so they are
    logged with time, show on the Alarms page and sync to the cloud.
    """

    def __init__(self, config: Config, db: Database):
        self.config, self.db = config, db
        self.grid = [m for m in config.meters if m.is_main and not m.is_dg and m.enabled]
        self.dgs = [m for m in config.meters if m.is_dg and m.enabled]
        names = {p["id"]: p["name"] for p in config.panels}
        self.panels: dict[str, list[Meter]] = {}
        for m in config.meters:
            if m.enabled and m.panel and m.position == "incomer" and not m.is_dg:
                self.panels.setdefault(m.panel, []).append(m)
        self.panels = {k: v for k, v in self.panels.items() if len(v) > 1}
        self.panel_names = names
        self.grid_up: bool | None = None
        self.cut_at: float | None = None
        self.dg_on: dict[str, float | None] = {}
        self.dg_kwh: dict[str, float] = {}
        self.active_inc: dict[str, str | None] = {}

    def update(self, state: dict, now: float):
        ts = int(now)
        if self.grid:
            vals = [(state[m.id].values if state[m.id].online else {}) for m in self.grid]
            up = any(has_voltage(v) for v in vals)
            if self.grid_up is None:
                self.grid_up = up
            elif up != self.grid_up:
                m = self.grid[0]
                if not up:
                    self.cut_at = now
                    self.db.insert_event(ts, m.id, "power_cut", "Power cut: grid supply lost", True)
                else:
                    took = f" after {fmt_dur(now - self.cut_at)}" if self.cut_at else ""
                    self.db.insert_event(ts, m.id, "power_cut", f"Power restored{took}", False)
                    self.cut_at = None
                self.grid_up = up
        for m in self.dgs:
            st = state[m.id]
            v = st.values if st.online else {}
            running = (v.get("hz") or 0) > 40 and has_voltage(v)
            was = self.dg_on.get(m.id, "unset")
            if was == "unset":
                self.dg_on[m.id] = now if running else None
                self.dg_kwh[m.id] = v.get("kwh") or 0
                continue
            if running and was is None:
                self.dg_on[m.id] = now
                self.dg_kwh[m.id] = v.get("kwh") or 0
                why = " (grid power cut)" if self.grid_up is False else ""
                self.db.insert_event(ts, m.id, "dg_run", f"{m.name} started{why}", True)
            elif not running and was is not None:
                kwh = max(0.0, (v.get("kwh") or self.dg_kwh.get(m.id, 0)) - self.dg_kwh.get(m.id, 0))
                self.db.insert_event(ts, m.id, "dg_run", f"{m.name} stopped after {fmt_dur(now - was)}, {kwh:,.0f} kWh", False)
                self.dg_on[m.id] = None
        for pid, incs in self.panels.items():
            live = [m for m in incs if state[m.id].online and carries_load(state[m.id].values)]
            cur = live[0].id if len(live) == 1 else None
            prev = self.active_inc.get(pid, "unset")
            self.active_inc[pid] = cur
            if prev == "unset" or cur == prev:
                continue
            name = self.panel_names.get(pid, pid)
            if cur is None and not live:
                self.db.insert_event(ts, incs[0].id, "changeover", f"{name}: no supply on either incomer", True)
            elif cur is not None:
                src = next(m for m in incs if m.id == cur)
                on_dg = src.fed_from in {d.panel for d in self.dgs} or src.fed_from in {d.id for d in self.dgs}
                self.db.insert_event(ts, cur, "changeover", f"{name} changed over to {'DG' if on_dg else 'transformer'} supply ({src.name})", False)
