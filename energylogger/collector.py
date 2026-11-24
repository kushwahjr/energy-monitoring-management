"""Polls every meter, keeps the live values, logs to the database and raises alarms."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

from .config import Config, Meter
from .db import Database
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
        self.sim = SimulatedReader()
        self.port_readers = {
            name: ModbusPortReader(p) for name, p in config.ports.items() if p.kind != "simulator"
        }
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
        for r in self.port_readers.values():
            await r.close()

    async def _run(self):
        while True:
            started = time.monotonic()
            # Meters on different ports are read in parallel; meters on one port take turns.
            await asyncio.gather(*(self.poll_meter(m) for m in self.config.meters if m.enabled))
            await asyncio.sleep(max(0.2, self.config.poll_seconds - (time.monotonic() - started)))

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
                self.db.insert_event(int(now), meter.id, "offline", f"No response: {e}", True)
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
