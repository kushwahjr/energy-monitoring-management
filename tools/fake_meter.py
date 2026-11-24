"""A fake Modbus meter (or gateway with several meters) for testing without hardware.

  python tools/fake_meter.py --port 5020 --units 1 2 3
  python tools/fake_meter.py --port 5021 --framing rtu     (acts like a transparent gateway)

It answers "read holding/input registers" (function 3 and 4) with the registers of
profiles/generic_float32_template.json, filled with changing values.
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

PROFILE = json.loads((Path(__file__).resolve().parent.parent / "profiles" / "generic_float32_template.json").read_text())


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
        regs = {}
        for param, r in PROFILE["registers"].items():
            hi, lo = struct.unpack(">HH", struct.pack(">f", vals[param]))
            regs[r["address"]], regs[r["address"] + 1] = hi, lo
        return regs

    def answer(self, unit: int, fc: int, addr: int, count: int) -> bytes | None:
        if unit not in self.units:
            return None  # no meter at this address: stay silent like RS485
        if fc not in (3, 4) or not 1 <= count <= 125:
            return bytes([fc | 0x80, 1])
        regs = self.registers(unit)
        data = b"".join(struct.pack(">H", regs.get(a, 0)) for a in range(addr, addr + count))
        return bytes([fc, len(data)]) + data


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5020)
    ap.add_argument("--units", type=int, nargs="+", default=[1])
    ap.add_argument("--framing", choices=["tcp", "rtu"], default="tcp")
    a = ap.parse_args()
    meters = Meters(a.units)

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
