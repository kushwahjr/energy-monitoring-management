"""Demo plant behaviour: grid power cuts, DG auto start, PCC changeover.

Used by the simulator (live) and by tools/seed_demo.py (history), so both behave the same.
Real meters never pass through here.
"""

from __future__ import annotations

import time

from .config import Config, Meter

CRANK_S = 6        # DG cranking and building voltage
SYNC_S = 12        # DGs synchronised, breakers and PCC DG incomers close
BACK_S = 3         # after the grid returns, PCCs change back over
COOLDOWN_S = 45    # DGs run unloaded to cool down, then stop
DG_LOAD_SCALE = 0.4  # on DG only essential loads run


class PlantSim:
    def __init__(self, config: Config, cuts: list[list] | None = None):
        self.cuts: list[list] = cuts if cuts is not None else []  # [[start, end or None], ...]
        self.configure(config)

    def configure(self, config: Config):
        ms = config.meters
        self.dgs = [m.id for m in ms if m.is_dg]
        dg_panels = {m.panel for m in ms if m.is_dg and m.panel} or {"dg"}
        self.dg_inc = {m.id for m in ms if m.position == "incomer" and (m.fed_from in dg_panels or m.fed_from in self.dgs)}
        backed = {m.panel for m in ms if m.id in self.dg_inc}           # panels that can run on DG
        self.backed_feeders = {m.id for m in ms if m.panel in backed and m.position != "incomer"}
        self.grid_side_of_backed = {m.id for m in ms if (m.panel in backed and m.position == "incomer" and m.id not in self.dg_inc)
                                    or (m.feeds in backed)}

    # ---- the grid switch ----
    def grid_on(self, t: float | None = None) -> bool:
        return self.phase(t or time.time())["grid"]

    def set_grid(self, on: bool, t: float | None = None):
        t = t or time.time()
        if not on and self.grid_on(t):
            self.cuts.append([t, None])
        elif on and self.cuts and self.cuts[-1][1] is None:
            self.cuts[-1][1] = t

    def phase(self, t: float) -> dict:
        cut = None
        for c in reversed(self.cuts):
            if c[0] <= t:
                cut = c
                break
        if cut is None:
            return {"grid": True, "dg": "off", "dg_closed": False, "dt": None}
        start, end = cut
        if end is None or t < end:
            dt = t - start
            dg = "cranking" if dt < CRANK_S else "idle" if dt < SYNC_S else "loaded"
            return {"grid": False, "dg": dg, "dg_closed": dg == "loaded", "dt": dt}
        dt = t - end
        if dt < BACK_S and end - start >= SYNC_S:
            return {"grid": True, "dg": "loaded", "dg_closed": True, "dt": dt}
        if dt < COOLDOWN_S + BACK_S and end - start >= CRANK_S:
            return {"grid": True, "dg": "idle", "dg_closed": False, "dt": dt}
        return {"grid": True, "dg": "off", "dg_closed": False, "dt": dt}

    # ---- what one meter sees ----
    def meter_state(self, m: Meter, t: float) -> dict:
        """{'live': voltage present, 'scale': load multiplier, 'dg': DG engine state or None}"""
        ph = self.phase(t)
        if m.id in self.dgs:
            return {"live": ph["dg"] != "off", "scale": 0.0, "dg": ph["dg"], "dt": ph["dt"]}
        if m.id in self.dg_inc:
            return {"live": ph["dg_closed"], "scale": 1.0 if ph["dg_closed"] else 0.0, "dg": None}
        if m.id in self.grid_side_of_backed:
            on = ph["grid"] and not ph["dg_closed"]
            return {"live": ph["grid"], "scale": 1.0 if on else 0.0, "dg": None}
        if m.id in self.backed_feeders:
            if ph["dg_closed"]:
                return {"live": True, "scale": DG_LOAD_SCALE, "dg": None}
            return {"live": ph["grid"], "scale": 1.0 if ph["grid"] else 0.0, "dg": None}
        return {"live": ph["grid"], "scale": 1.0 if ph["grid"] else 0.0, "dg": None}
