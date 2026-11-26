"""Read meters over Modbus TCP / RTU, or from a built-in simulator."""

from __future__ import annotations

import asyncio
import logging
import math
import random
import re
import time

from .config import Meter, Port, Profile, Register

# pymodbus logs every timeout with a hex dump; the collector logs one plain line when a meter goes offline instead.
logging.getLogger("pymodbus").setLevel(logging.CRITICAL)


class ReadError(Exception):
    pass


def serial_ports() -> list[dict]:
    """Serial (COM) ports on this computer, USB-RS485 converters first."""
    try:
        from serial.tools import list_ports
        found = list_ports.comports()
    except Exception:
        return []
    out = []
    for p in found:
        desc = p.description if p.description and p.description != "n/a" else ""
        desc = re.sub(rf"\s*\({re.escape(p.device)}\)$", "", desc)  # Windows: "USB-SERIAL CH340 (COM4)"
        usb = p.vid is not None
        if not usb and not desc and not p.device.upper().startswith("COM"):
            continue  # Linux lists many unused on-board ttyS ports
        out.append({"device": p.device, "description": desc, "usb": usb})
    out.sort(key=lambda x: (not x["usb"], x["device"]))
    return out


def ports_text() -> str:
    found = serial_ports()
    if not found:
        return "No serial ports were found on this PC: plug in the USB-RS485 converter and install its driver (CH340, CP210x, FTDI or PL2303)."
    return "Serial ports on this PC: " + ", ".join(f"{p['device']}" + (f" ({p['description']})" if p["description"] and p["description"] != p["device"] else "") for p in found) + "."


MODBUS_EXCEPTIONS = {
    1: "it does not support this kind of read (function {fc}). The meter model chosen is probably wrong",
    2: "register {addr} does not exist on it. The meter model chosen is probably wrong, or its register numbers are off by one",
    3: "it cannot send {count} registers in one go. Lower \"max_block\" for this model",
    4: "it reported an internal failure",
    6: "it is busy. It will be tried again",
    10: "the gateway has no route to this meter. Check the gateway's settings",
    11: "the gateway got no answer from the meter behind it (ID {unit}). Check the meter's ID, the gateway's RS485 baud rate and parity, and the A/B wires",
}


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


PARITY = {"N": "none", "E": "even", "O": "odd"}


class ModbusPortReader:
    """One connection (TCP host or serial port), shared by all meters on it.

    Requests on one port run one at a time, as RS485 requires.
    """

    def __init__(self, port: Port):
        self.port = port
        self.lock = asyncio.Lock()
        self.client = None
        self.skipped: dict[str, list[str]] = {}  # meter id -> parameters its meter refused at the last read

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
                self.drop()
                raise ReadError(self.connect_problem())

    def drop(self):
        """Close the connection; the next read opens a fresh one."""
        if self.client is not None:
            try:
                self.client.close()
            except Exception:
                pass
        self.client = None

    def describe(self) -> str:
        p = self.port
        return p.serial_port if p.kind == "rs485" else f"{p.host}:{p.tcp_port}"

    def connect_problem(self) -> str:
        p = self.port
        if p.kind != "rs485":
            what = "the gateway" if p.kind == "gateway" else "the meter"
            return (f"Cannot reach {what} at {p.host} port {p.tcp_port}. Check the IP address, the network cable, and that this PC "
                    f"is on the same network (in a Command Prompt: ping {p.host}).")
        why = ""
        try:  # pymodbus does not say why a serial port would not open, so try it once directly
            import serial
            serial.Serial(p.serial_port, p.baudrate, timeout=0.1).close()
        except Exception as e:
            why = str(e)
        if "denied" in why.lower() or "busy" in why.lower() or "permission" in why.lower():
            return (f"{p.serial_port} is in use by another program. Close any other meter or Modbus software "
                    f"(and the meter's own PC tool), then try again.")
        if not any(x["device"].upper() == p.serial_port.upper() for x in serial_ports()):
            return f"{p.serial_port} was not found. {ports_text()}"
        return f"Cannot open {p.serial_port}{': ' + why if why else ''}. {ports_text()}"

    def no_answer(self, meter: Meter) -> str:
        p = self.port
        if p.kind == "rs485":
            return (f"No answer from meter ID {meter.unit_id} on {p.serial_port} at {p.baudrate} baud, parity {PARITY.get(p.parity, p.parity)}, "
                    f"{p.stopbits} stop bit. Check that the meter's own communication settings show the same ID, baud rate and parity, "
                    f"and check the A(+) and B(-) wires (if unsure, swap them).")
        if p.kind == "gateway":
            return (f"The gateway at {p.host} gave no answer for meter ID {meter.unit_id}. Check the meter's ID, the gateway's RS485 "
                    f"settings (baud rate, parity) and its type: Modbus TCP gateway or transparent.")
        return (f"The meter at {p.host} is reachable but gave no Modbus answer for ID {meter.unit_id}. Check the meter's Modbus ID "
                f"(many Ethernet meters use 1 or 255) and that Modbus TCP is switched on in the meter.")

    def refused(self, meter: Meter, rr, fc: int, addr: int, count: int) -> str:
        code = getattr(rr, "exception_code", None)
        why = MODBUS_EXCEPTIONS.get(code, f"error code {code}").format(fc=fc, addr=addr, count=count, unit=meter.unit_id)
        return f"Meter ID {meter.unit_id} answered, but {why}."

    async def read(self, meter: Meter, profile: Profile) -> dict[str, float]:
        from pymodbus.client import ModbusBaseClient
        from pymodbus.exceptions import ConnectionException, ModbusIOException

        async with self.lock:
            await self._ensure()
            holding = profile.register_type == "holding"
            fn = self.client.read_holding_registers if holding else self.client.read_input_registers

            async def fetch(start: int, count: int):
                try:
                    return await fn(start, count=count, device_id=meter.unit_id)
                except (ModbusIOException, asyncio.TimeoutError, TimeoutError) as e:
                    self.drop()  # also clears any late reply, so it cannot be taken as the next meter's answer
                    raise ReadError(self.no_answer(meter)) from e
                except ConnectionException as e:
                    self.drop()
                    raise ReadError(f"Connection to {self.describe()} was lost ({e}). It will be opened again.") from e
                except Exception as e:  # anything else from the connection
                    self.drop()
                    raise ReadError(f"{self.describe()}: {e}") from e

            def decode(r: Register, words) -> None:
                dtype = getattr(ModbusBaseClient.DATATYPE, r.type.upper())
                v = float(ModbusBaseClient.convert_from_registers(words, dtype, word_order=profile.word_order))
                if r.transform == "pf_4q" and abs(v) > 1:
                    v = (2 - v) if v > 0 else (-2 - v)
                v *= r.scale
                if math.isfinite(v):
                    values[r.param] = v

            values: dict[str, float] = {}
            skipped: list[str] = []
            first_refusal = None
            for start, count, regs in plan_blocks(profile):
                rr = await fetch(start, count)
                if not rr.isError():
                    for r in regs:
                        off = r.address + profile.address_offset - start
                        decode(r, rr.registers[off: off + r.length])
                    continue
                if first_refusal is None:
                    first_refusal = self.refused(meter, rr, 3 if holding else 4, start, count)
                if getattr(rr, "exception_code", None) in (4, 6, 10, 11):
                    raise ReadError(first_refusal)  # the meter (or gateway) itself has a problem, not this block
                # Some meters refuse a block that spans reserved registers, or lack a value that a sister model
                # has (for example THD): read one by one, keep what the meter has and skip the rest.
                for r in regs:
                    one = rr if len(regs) == 1 else await fetch(r.address + profile.address_offset, r.length)
                    if one.isError():
                        skipped.append(r.param)
                    else:
                        decode(r, one.registers)
            if not values:
                raise ReadError(first_refusal or f"Meter ID {meter.unit_id} sent no usable values.")
            self.skipped[meter.id] = skipped
            return derive_missing(values)

    async def close(self):
        self.drop()


class SimulatedReader:
    """Generates realistic readings for a steel plant feeder (furnace-like load swings).

    With a PlantSim attached it also follows the demo grid switch: dead feeders during a power cut,
    DGs starting and carrying the PCCs they back up, and PCCs changing over.
    """

    def __init__(self, plant=None):
        self.state: dict[str, dict] = {}
        self.plant = plant  # PlantSim or None

    def _base(self, meter: Meter) -> dict:
        rnd = random.Random(meter.id)
        rated = meter.contract_kva or rnd.choice([500, 800, 1250, 2000])
        return {"rated": rated, "kwh": rnd.uniform(1e5, 9e5), "kvah": 0.0, "kvarh": 0.0, "t": time.time(),
                "phase": rnd.uniform(0, 6.28), "pf0": rnd.uniform(0.86, 0.97), "kw_now": 0.0}

    async def read(self, meter: Meter, profile: Profile | None = None) -> dict[str, float]:
        s = self.state.setdefault(meter.id, self._base(meter))
        now = time.time()
        dt_h = (now - s["t"]) / 3600
        s["t"] = now
        ps = self.plant.meter_state(meter, now) if self.plant else {"live": True, "scale": 1.0, "dg": None}
        v_nom, hz = 239 + random.uniform(-4, 4), 50 + random.uniform(-0.08, 0.08)
        pf = min(0.999, max(0.6, s["pf0"] + random.uniform(-0.04, 0.03)))
        if ps["dg"] is not None:  # a generator
            dg = ps["dg"]
            if dg == "off":
                v_nom, hz, kva = 0.0, 0.0, 0.0
            elif dg == "cranking":
                f = min(1.0, (ps.get("dt") or 0) / 6)
                v_nom, hz, kva = v_nom * f, 50 * f, 0.0
            elif dg == "idle":
                kva = 0.012 * s["rated"]
                pf = 0.3
            else:
                share = sum(self.state.get(i, {}).get("kw_now", 0.0) for i in self.plant.dg_inc) / max(len(self.plant.dgs), 1)
                kw_dg = share * random.uniform(0.97, 1.03)
                pf = 0.86 + random.uniform(-0.02, 0.02)
                kva = kw_dg / pf
        else:
            cycle = 0.55 + 0.35 * math.sin(now / 300 + s["phase"]) + random.uniform(-0.08, 0.08)
            kva = max(0.02, cycle) * s["rated"] * ps["scale"]
            if not ps["live"]:
                v_nom, hz = 0.0, 0.0
        kw = kva * pf
        kvar = math.sqrt(max(kva * kva - kw * kw, 0))
        s["kw_now"] = kw
        v = [v_nom + (random.uniform(-2, 2) if v_nom else 0) for _ in range(3)]
        i_avg = kva * 1000 / (3 * v_nom) if v_nom > 20 else 0.0
        i = [i_avg * random.uniform(0.94, 1.06) for _ in range(3)]
        s["kvah"] = s.get("kvah") or s["kwh"] / s["pf0"]
        s["kvarh"] = s.get("kvarh") or s["kwh"] * 0.4
        s["kwh"] += kw * dt_h
        s["kvah"] += kva * dt_h
        s["kvarh"] += kvar * dt_h
        out = {
            "v_ln": v_nom, "v_ll": v_nom * math.sqrt(3), "v1": v[0], "v2": v[1], "v3": v[2],
            "i_avg": i_avg, "i1": i[0], "i2": i[1], "i3": i[2],
            "kw": kw, "kva": kva, "kvar": kvar, "hz": hz,
            "kwh": s["kwh"], "kvah": s["kvah"], "kvarh": s["kvarh"],
        }
        if kva > 0:
            out.update(pf=pf, thd_v=random.uniform(2, 6), thd_i=random.uniform(8, 25))
        return out

    async def close(self):
        pass
