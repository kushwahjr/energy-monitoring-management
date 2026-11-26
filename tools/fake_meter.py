"""A fake Modbus meter (or gateway with several meters) for testing without hardware.

  python tools/fake_meter.py --port 5020 --units 1 2 3
  python tools/fake_meter.py --port 5021 --framing rtu     (acts like a transparent gateway)
  python tools/fake_meter.py --profile siemens_pac3200        (pretends to be that meter model)
  python tools/fake_meter.py --pty                            (Linux/Mac: a virtual RS485 port, prints its name)
  python tools/fake_meter.py --serial COM5 --baud 9600        (answers on a real serial port, e.g. a second USB-RS485 adapter)

It answers "read holding/input registers" (function 3 and 4) with the registers of the
chosen model profile (default: generic_float32_template), filled with changing values.
"""

import argparse
import asyncio
import json
import math
import random
import struct
import sys
import time
from pathlib import Path

PROFILES = Path(__file__).resolve().parent.parent / "profiles"
PROFILE = json.loads((PROFILES / "generic_float32_template.json").read_text())
MISSING: set[int] = set()  # register addresses this meter does not have (--missing)
PACK = {"float32": ">f", "float64": ">d", "int16": ">h", "uint16": ">H", "int32": ">i", "uint32": ">I", "int64": ">q", "uint64": ">Q"}


def encode(value: float, reg: dict, word_order: str) -> list[int]:
    """Turn an engineering value into the meter's raw registers (inverse of the logger's decoding)."""
    t = reg.get("type", "float32")
    raw = value / reg.get("scale", 1.0)
    if reg.get("transform") == "pf_4q" and value < 0:
        raw = value  # keep simple: lagging/leading sign as-is
    if not t.startswith("float"):
        raw = int(round(raw))
    b = struct.pack(PACK[t], raw)
    words = [int.from_bytes(b[i:i + 2], "big") for i in range(0, len(b), 2)]
    return words[::-1] if word_order == "little" else words


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


class Meters:
    def __init__(self, units):
        self.units = units
        self.energy = {u: {"kwh": 1000.0 * u, "kvah": 1100.0 * u, "kvarh": 400.0 * u} for u in units}
        self.t = {u: time.time() for u in units}
        self.last: dict[int, dict] = {}

    def registers(self, unit: int) -> dict[int, int]:
        now = time.time()
        dt = now - self.t[unit]
        self.t[unit] = now
        kva = 400 * unit * (0.6 + 0.3 * math.sin(now / 60 + unit)) + random.uniform(-10, 10)
        pf = 0.92 + 0.03 * math.sin(now / 90)
        v = 240 + random.uniform(-3, 3)
        i = kva * 1000 / (3 * v)
        e = self.energy[unit]
        e["kwh"] += kva * pf * dt / 3600
        e["kvah"] += kva * dt / 3600
        e["kvarh"] += kva * math.sqrt(1 - pf * pf) * dt / 3600
        vals = {"v1": v, "v2": v + 1, "v3": v - 1, "v_ln": v, "v_ll": v * 1.732, "i1": i, "i2": i, "i3": i, "i_avg": i,
                "kw": kva * pf, "kva": kva, "kvar": kva * math.sqrt(1 - pf * pf), "pf": pf, "hz": 50.0, **e}
        vals["thd_v"], vals["thd_i"] = 3.2, 18.5
        self.last[unit] = vals
        regs = {}
        off = PROFILE.get("address_offset", 0)
        for param, r in PROFILE["registers"].items():
            for i, word in enumerate(encode(vals[param], r, PROFILE.get("word_order", "big"))):
                regs[r["address"] + off + i] = word
        return regs

    def answer(self, unit: int, fc: int, addr: int, count: int) -> bytes | None:
        if unit not in self.units:
            return None  # no meter at this address: stay silent like RS485
        want = 3 if PROFILE.get("register_type", "holding") == "holding" else 4
        if fc != want or not 1 <= count <= 125:
            return bytes([fc | 0x80, 1])
        if MISSING & set(range(addr, addr + count)):
            return bytes([fc | 0x80, 2])  # illegal data address, as a meter answers for a value it does not have
        regs = self.registers(unit)
        data = b"".join(struct.pack(">H", regs.get(a, 0)) for a in range(addr, addr + count))
        return bytes([fc, len(data)]) + data


def rtu_frames(read, write, meters: "Meters"):
    """Answer Modbus RTU requests on a byte stream (serial port or pty). Blocking; run in a thread."""
    buf = b""
    while True:
        chunk = read()
        if not chunk:
            continue
        buf += chunk
        while len(buf) >= 8:
            frame = buf[:8]
            if crc16(frame[:6]) != struct.unpack("<H", frame[6:])[0]:
                buf = buf[1:]  # out of step: drop a byte and look again
                continue
            buf = buf[8:]
            unit, fc, addr, count = struct.unpack(">BBHH", frame[:6])
            resp = meters.answer(unit, fc, addr, count)
            if resp is None:
                continue  # no meter at this address: stay silent like RS485
            body = bytes([unit]) + resp
            write(body + struct.pack("<H", crc16(body)))


def serve_serial(a, meters: "Meters"):
    if a.pty:
        import os
        import pty
        import tty
        master, slave = pty.openpty()
        tty.setraw(slave)
        print(os.ttyname(slave), flush=True)
        print(f"fake meter on virtual serial port {os.ttyname(slave)}, units {a.units}", file=sys.stderr, flush=True)
        rtu_frames(lambda: os.read(master, 256), lambda b: os.write(master, b), meters)
    import serial
    ser = serial.Serial(a.serial, a.baud, parity=a.parity, stopbits=a.stopbits, timeout=0.05)
    print(f"fake meter on {a.serial} at {a.baud} baud, units {a.units}", file=sys.stderr, flush=True)
    rtu_frames(lambda: ser.read(256), ser.write, meters)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5020)
    ap.add_argument("--units", type=int, nargs="+", default=[1])
    ap.add_argument("--framing", choices=["tcp", "rtu"], default="tcp")
    ap.add_argument("--profile", default="generic_float32_template")
    ap.add_argument("--word-order", choices=["big", "little"], help="answer in this word order instead of the profile's")
    ap.add_argument("--missing", nargs="*", default=[], help="parameters this meter does not have, e.g. thd_v thd_i")
    ap.add_argument("--pty", action="store_true", help="Linux/Mac: answer on a new virtual serial port")
    ap.add_argument("--serial", help="answer on this serial port, e.g. COM5 or /dev/ttyUSB1")
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--parity", default="N")
    ap.add_argument("--stopbits", type=int, default=1)
    a = ap.parse_args()
    global PROFILE
    PROFILE = json.loads((PROFILES / f"{a.profile}.json").read_text())
    if a.word_order:
        PROFILE["word_order"] = a.word_order
    for param in a.missing:
        r = PROFILE["registers"][param]
        start = r["address"] + PROFILE.get("address_offset", 0)
        MISSING.update(range(start, start + {"int16": 1, "uint16": 1, "float64": 4, "int64": 4, "uint64": 4}.get(r.get("type", "float32"), 2)))
    meters = Meters(a.units)
    if a.pty or a.serial:
        return await asyncio.to_thread(serve_serial, a, meters)

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                if a.framing == "tcp":
                    head = await reader.readexactly(7)
                    tid, _, length, unit = struct.unpack(">HHHB", head)
                    pdu = await reader.readexactly(length - 1)
                    fc, addr, count = struct.unpack(">BHH", pdu[:5])
                    resp = meters.answer(unit, fc, addr, count)
                    if resp is None:
                        resp = bytes([fc | 0x80, 0x0B])  # gateway: target device failed to respond
                    writer.write(struct.pack(">HHHB", tid, 0, len(resp) + 1, unit) + resp)
                else:
                    frame = await reader.readexactly(8)
                    unit, fc, addr, count, crc = struct.unpack(">BBHHH", frame)
                    if crc16(frame[:6]) != struct.unpack("<H", frame[6:])[0]:
                        continue
                    resp = meters.answer(unit, fc, addr, count)
                    if resp is None:
                        continue
                    body = bytes([unit]) + resp
                    writer.write(body + struct.pack("<H", crc16(body)))
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(handle, "0.0.0.0", a.port)
    print(f"fake meter on port {a.port}, units {a.units}, framing {a.framing}", file=sys.stderr, flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
