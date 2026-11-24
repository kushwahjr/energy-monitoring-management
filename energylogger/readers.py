"""Read meters over Modbus TCP / RTU, or from a built-in simulator."""

from __future__ import annotations

import asyncio
import math
import random
import time

from .config import Meter, Port, Profile, Register


class ReadError(Exception):
    pass


def plan_blocks(profile: Profile, gap: int = 6) -> list[tuple[int, int, list[Register]]]:
    """Group registers into as few Modbus requests as possible.

    Returns (start_address, count, registers) tuples.
    """
    regs = sorted(profile.registers, key=lambda r: r.address)
    blocks: list[tuple[int, int, list[Register]]] = []
    for r in regs:
        start = r.address + profile.address_offset
        end = start + r.length
        if blocks:
            b_start, b_count, b_regs = blocks[-1]
            b_end = b_start + b_count
            if start - b_end <= gap and end - b_start <= profile.max_block:
                blocks[-1] = (b_start, max(b_end, end) - b_start, b_regs + [r])
                continue
        blocks.append((start, r.length, [r]))
    return blocks


def derive_missing(v: dict[str, float]) -> dict[str, float]:
    """Fill averages and totals that a meter model does not provide, from the values it does."""
    phases_v = [v[k] for k in ("v1", "v2", "v3") if k in v]
    phases_i = [v[k] for k in ("i1", "i2", "i3") if k in v]
    if "v_ln" not in v and len(phases_v) == 3:
        v["v_ln"] = sum(phases_v) / 3
    if "v_ll" not in v and "v_ln" in v:
        v["v_ll"] = v["v_ln"] * math.sqrt(3)  # balanced-system estimate
    if "i_avg" not in v and len(phases_i) == 3:
        v["i_avg"] = sum(phases_i) / 3
    if "kva" not in v and "kw" in v and "kvar" in v:
        v["kva"] = math.hypot(v["kw"], v["kvar"])
    if "pf" not in v and "kw" in v and v.get("kva"):
        v["pf"] = v["kw"] / v["kva"]
    return v


class ModbusPortReader:
    """One connection (TCP host or serial port), shared by all meters on it.

    Requests on one port run one at a time, as RS485 requires.
    """

    def __init__(self, port: Port):
        self.port = port
        self.lock = asyncio.Lock()
        self.client = None

    def _make_client(self):
        from pymodbus import FramerType
        from pymodbus.client import AsyncModbusSerialClient, AsyncModbusTcpClient

        p = self.port
        if p.kind == "ethernet" or (p.kind == "gateway" and p.framing == "tcp"):
            return AsyncModbusTcpClient(p.host, port=p.tcp_port, timeout=p.timeout, retries=1)
        if p.kind == "gateway":  # transparent gateway: raw RTU frames over a TCP socket
            return AsyncModbusTcpClient(p.host, port=p.tcp_port, framer=FramerType.RTU, timeout=p.timeout, retries=1)
        return AsyncModbusSerialClient(
            p.serial_port, baudrate=p.baudrate, parity=p.parity, stopbits=p.stopbits,
            bytesize=p.bytesize, timeout=p.timeout, retries=1,
        )

    async def _ensure(self):
        if self.client is None:
            self.client = self._make_client()
        if not self.client.connected:
            ok = await self.client.connect()
            if not ok:
                raise ReadError(f"cannot connect to {self.describe()}")

    def describe(self) -> str:
        p = self.port
        return p.serial_port if p.kind == "rs485" else f"{p.host}:{p.tcp_port}"

    async def read(self, meter: Meter, profile: Profile) -> dict[str, float]:
        from pymodbus.client import ModbusBaseClient

        async with self.lock:
            await self._ensure()
            fn = self.client.read_holding_registers if profile.register_type == "holding" else self.client.read_input_registers

            async def fetch(start: int, count: int):
                try:
                    return await fn(start, count=count, device_id=meter.unit_id)
                except Exception as e:  # timeouts, broken connection
                    self.client.close()
                    raise ReadError(f"{meter.id}: {e}") from e

            def decode(r: Register, words) -> None:
                dtype = getattr(ModbusBaseClient.DATATYPE, r.type.upper())
                v = float(ModbusBaseClient.convert_from_registers(words, dtype, word_order=profile.word_order))
                if r.transform == "pf_4q" and abs(v) > 1:
                    v = (2 - v) if v > 0 else (-2 - v)
                v *= r.scale
                if math.isfinite(v):
                    values[r.param] = v

            values: dict[str, float] = {}
            for start, count, regs in plan_blocks(profile):
                rr = await fetch(start, count)
                if rr.isError():
                    if len(regs) == 1:
                        raise ReadError(f"{meter.id}: Modbus error at {start} ({rr})")
                    # Some meters refuse a block that spans reserved registers: read one by one instead.
                    ok = 0
                    for r in regs:
                        one = await fetch(r.address + profile.address_offset, r.length)
                        if not one.isError():
                            decode(r, one.registers)
                            ok += 1
                    if ok == 0:
                        raise ReadError(f"{meter.id}: Modbus error at {start} ({rr})")
                    continue
                for r in regs:
                    off = r.address + profile.address_offset - start
                    decode(r, rr.registers[off: off + r.length])
            return derive_missing(values)

    async def close(self):
        if self.client is not None:
            self.client.close()


class SimulatedReader:
    """Generates realistic readings for a steel plant feeder (furnace-like load swings)."""

    def __init__(self):
        self.state: dict[str, dict] = {}

    def _base(self, meter: Meter) -> dict:
        rnd = random.Random(meter.id)
        rated = meter.contract_kva or rnd.choice([500, 800, 1250, 2000])
        return {"rated": rated, "kwh": rnd.uniform(1e5, 9e5), "kvah": 0.0, "kvarh": 0.0, "t": time.time(),
                "phase": rnd.uniform(0, 6.28), "pf0": rnd.uniform(0.86, 0.97)}

    async def read(self, meter: Meter, profile: Profile | None = None) -> dict[str, float]:
        s = self.state.setdefault(meter.id, self._base(meter))
        now = time.time()
        dt_h = (now - s["t"]) / 3600
        s["t"] = now
        cycle = 0.55 + 0.35 * math.sin(now / 300 + s["phase"]) + random.uniform(-0.08, 0.08)
        kva = max(0.02, cycle) * s["rated"]
        pf = min(0.999, max(0.6, s["pf0"] + random.uniform(-0.04, 0.03)))
        kw = kva * pf
        kvar = math.sqrt(max(kva * kva - kw * kw, 0))
        v_ln = 239 + random.uniform(-4, 4)
        v = [v_ln + random.uniform(-2, 2) for _ in range(3)]
        i_avg = kva * 1000 / (3 * v_ln)
        i = [i_avg * random.uniform(0.94, 1.06) for _ in range(3)]
        s["kwh"] += kw * dt_h
        s["kvah"] = s.get("kvah") or s["kwh"] / s["pf0"]
        s["kvah"] += kva * dt_h
        s["kvarh"] = s.get("kvarh") or s["kwh"] * 0.4
        s["kvarh"] += kvar * dt_h
        return {
            "v_ln": v_ln, "v_ll": v_ln * math.sqrt(3), "v1": v[0], "v2": v[1], "v3": v[2],
            "i_avg": i_avg, "i1": i[0], "i2": i[1], "i3": i[2],
            "kw": kw, "kva": kva, "kvar": kvar, "pf": pf, "hz": 50 + random.uniform(-0.08, 0.08),
            "kwh": s["kwh"], "kvah": s["kvah"], "kvarh": s["kvarh"],
            "thd_v": random.uniform(2, 6), "thd_i": random.uniform(8, 25),
        }

    async def close(self):
        pass
