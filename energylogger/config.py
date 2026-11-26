"""Load and validate the plant configuration file (config.json)."""

from __future__ import annotations

import re

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .params import PARAMS

DATA_TYPES = {"float32": 2, "int16": 1, "uint16": 1, "int32": 2, "uint32": 2, "float64": 4, "int64": 4, "uint64": 4}


KIND_ALIASES = {
    "ethernet": "ethernet", "tcp": "ethernet", "modbus_tcp": "ethernet",
    "rs485": "rs485", "rtu": "rs485", "modbus_rtu": "rs485",
    "gateway": "gateway",
    "simulator": "simulator",
}


class ConfigError(ValueError):
    pass


@dataclass
class Register:
    param: str
    address: int
    type: str = "float32"
    scale: float = 1.0
    transform: str = ""  # "pf_4q": decode 4-quadrant power factor (values 1..2 / -2..-1)

    @property
    def length(self) -> int:
        return DATA_TYPES[self.type]


@dataclass
class Profile:
    name: str
    register_type: str = "holding"  # "holding" (function 3) or "input" (function 4)
    word_order: str = "big"
    address_offset: int = 0  # use -1 when the manual lists 1-based register numbers
    max_block: int = 100
    registers: list[Register] = field(default_factory=list)


@dataclass
class Port:
    name: str
    kind: str  # "ethernet", "rs485", "gateway" or "simulator"
    framing: str = "tcp"  # gateway only: "tcp" (Modbus TCP gateway) or "rtu" (transparent serial-over-TCP server)
    host: str = ""
    tcp_port: int = 502
    serial_port: str = ""
    baudrate: int = 9600
    parity: str = "N"
    stopbits: int = 1
    bytesize: int = 8
    timeout: float = 2.0


@dataclass
class Alarms:
    pf_min: float | None = None
    kva_max: float | None = None
    kw_max: float | None = None
    v_ln_min: float | None = None
    v_ln_max: float | None = None
    i_max: float | None = None
    thd_v_max: float | None = None


@dataclass
class Meter:
    id: str
    name: str
    area: str
    port: str
    unit_id: int
    profile: str
    enabled: bool = True
    contract_kva: float | None = None
    is_main: bool = False  # main incomer: counted in the plant total (feeders are not, to avoid double counting)
    machine: str = ""  # picture shown on the plant diagram, e.g. "induction_furnace"; "dg_set" marks a generator
    alarms: Alarms = field(default_factory=Alarms)
    # where it sits on the single-line diagram
    panel: str = ""        # panel (bus) id from config "panels"; "" = the one plant bus
    position: str = ""     # "incomer" (above the bus) or "feeder" (below it)
    fed_from: str = ""     # incomers: the panel or meter id that supplies it
    feeds: str = ""        # feeders: the panel id it supplies, e.g. a transformer feeding a PCC

    @property
    def is_dg(self) -> bool:
        return not self.fed_from and is_dg(self.machine, self.name)  # something fed from elsewhere is not a generator


def is_dg(machine: str, name: str = "") -> bool:
    if machine:
        return machine == "dg_set"
    n = name or ""
    return bool(re.search(r"\bdg\b|genset|generator", n, re.I)) and not re.search(r"i/c|incom|feeder|pcc|mcc|panel", n, re.I)


@dataclass
class CloudSync:
    url: str
    api_key: str
    sync_seconds: float = 30
    batch_size: int = 2000


PAGES = ("plant", "insights", "dg", "reports", "alarms")


@dataclass
class User:
    username: str
    password_hash: str
    role: str = "viewer"  # "viewer" or "admin"
    name: str = ""
    designation: str = ""
    phone: str = ""
    panels: list[str] = field(default_factory=list)  # empty: every panel
    pages: list[str] = field(default_factory=lambda: list(PAGES))
    active: bool = True


def parse_users(raw_users: list) -> list[User]:
    out = []
    for u in raw_users or []:
        out.append(User(
            str(u["username"]), str(u["password_hash"]), u.get("role", "viewer") if u.get("role") in ("viewer", "admin") else "viewer",
            name=str(u.get("name", ""))[:80], designation=str(u.get("designation", ""))[:80], phone=str(u.get("phone", ""))[:30],
            panels=[str(x) for x in u.get("panels", [])], pages=[p for p in u.get("pages", PAGES) if p in PAGES] or ["plant"],
            active=bool(u.get("active", True)),
        ))
    return out


@dataclass
class Config:
    mode: str  # "plant" (reads meters) or "cloud" (receives data from plants)
    plant_id: str
    plant_name: str
    poll_seconds: float
    log_seconds: float
    database: Path
    listen_host: str
    listen_port: int
    demand_block_minutes: int
    ports: dict[str, Port]
    profiles: dict[str, Profile]
    meters: list[Meter]
    cloud: CloudSync | None = None
    ingest_keys: dict[str, str] = field(default_factory=dict)  # cloud mode: plant_id -> api key
    users: list[User] = field(default_factory=list)
    secret_key: str = ""
    panels: list[dict] = field(default_factory=list)  # [{"id", "name", "voltage", "note"}], in drawing order


def _req(d: dict, key: str, where: str) -> Any:
    if key not in d:
        raise ConfigError(f"{where}: missing '{key}'")
    return d[key]


PROFILE_DIR = Path(__file__).resolve().parent.parent / "profiles"


def library_profiles() -> dict[str, dict]:
    """Meter model profiles shipped in the profiles/ folder (one JSON file per model)."""
    out = {}
    for f in sorted(PROFILE_DIR.glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        out[f.stem] = data
    return out


def load_config(path: str | Path) -> Config:
    path = Path(path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    return parse_config(raw, path.parent)


def parse_config(raw: dict, base: Path) -> Config:
    """Validate a config dict. Profiles in config.json override library profiles of the same name."""
    all_profiles = {**library_profiles(), **raw.get("profiles", {})}
    profiles: dict[str, Profile] = {}
    for pname, p in all_profiles.items():
        regs = []
        for param, r in p.get("registers", {}).items():
            if param not in PARAMS:
                raise ConfigError(f"profile '{pname}': unknown parameter '{param}' (allowed: {', '.join(PARAMS)})")
            rtype = r.get("type", "float32")
            if rtype not in DATA_TYPES:
                raise ConfigError(f"profile '{pname}', {param}: unknown type '{rtype}'")
            regs.append(Register(param, int(_req(r, "address", f"profile '{pname}', {param}")), rtype,
                                 float(r.get("scale", 1.0)), str(r.get("transform", ""))))
        rt = p.get("register_type", "holding")
        if rt not in ("holding", "input"):
            raise ConfigError(f"profile '{pname}': register_type must be 'holding' or 'input'")
        profiles[pname] = Profile(
            name=pname,
            register_type=rt,
            word_order=p.get("word_order", "big"),
            address_offset=int(p.get("address_offset", 0)),
            max_block=int(p.get("max_block", 100)),
            registers=regs,
        )

    ports: dict[str, Port] = {}
    for name, p in raw.get("ports", {}).items():
        kind = KIND_ALIASES.get(_req(p, "kind", f"port '{name}'"))
        if kind is None:
            raise ConfigError(f"port '{name}': kind must be ethernet, rs485, gateway or simulator")
        framing = p.get("framing", "tcp")
        if framing not in ("tcp", "rtu"):
            raise ConfigError(f"port '{name}': framing must be tcp or rtu")
        if kind in ("ethernet", "gateway") and not p.get("host"):
            raise ConfigError(f"port '{name}': needs 'host' (IP address)")
        if kind == "rs485" and not p.get("serial_port"):
            raise ConfigError(f"port '{name}': needs 'serial_port' (for example COM3 or /dev/ttyUSB0)")
        ports[name] = Port(
            name=name,
            kind=kind,
            framing=framing,
            host=p.get("host", ""),
            tcp_port=int(p.get("port", 502)),
            serial_port=p.get("serial_port", ""),
            baudrate=int(p.get("baudrate", 9600)),
            parity=p.get("parity", "N"),
            stopbits=int(p.get("stopbits", 1)),
            bytesize=int(p.get("bytesize", 8)),
            timeout=float(p.get("timeout", 2.0)),
        )

    meters: list[Meter] = []
    seen = set()
    for m in raw.get("meters", []):
        mid = str(_req(m, "id", "meter")).strip()
        if not mid:
            raise ConfigError(f"machine '{m.get('name') or '(no name)'}': give it a Meter ID, a short code such as ccl1")
        if mid in seen:
            raise ConfigError(f"duplicate meter id '{mid}'")
        seen.add(mid)
        port = _req(m, "port", f"meter '{mid}'")
        if port not in ports:
            raise ConfigError(f"meter '{mid}': unknown port '{port}'")
        profile = m.get("profile", "simulated")
        if ports[port].kind != "simulator" and not profile:
            raise ConfigError(f"machine '{m.get('name') or mid}': choose its meter model")
        if ports[port].kind != "simulator" and profile not in profiles:
            raise ConfigError(f"meter '{mid}': unknown profile '{profile}'")
        alarms = Alarms(**{k: v for k, v in m.get("alarms", {}).items() if k in Alarms.__dataclass_fields__})
        meters.append(
            Meter(
                id=mid,
                name=m.get("name", mid),
                area=m.get("area", ""),
                port=port,
                unit_id=int(m.get("unit_id", 1)),
                profile=profile,
                enabled=bool(m.get("enabled", True)),
                contract_kva=m.get("contract_kva"),
                is_main=bool(m.get("is_main", False)),
                machine=str(m.get("machine", ""))[:40],
                alarms=alarms,
                panel=str(m.get("panel", ""))[:40],
                position=str(m.get("position") or ("incomer" if m.get("is_main") else "feeder")),
                fed_from=str(m.get("fed_from", ""))[:40],
                feeds=str(m.get("feeds", ""))[:40],
            )
        )

    db = Path(raw.get("database", "data/energy.db"))
    if not db.is_absolute():
        db = base / db

    mode = raw.get("mode", "plant")
    if mode not in ("plant", "cloud"):
        raise ConfigError("mode must be 'plant' or 'cloud'")
    cloud = None
    if raw.get("cloud_sync", {}).get("url"):
        c = raw["cloud_sync"]
        cloud = CloudSync(c["url"].rstrip("/"), _req(c, "api_key", "cloud_sync"),
                          float(c.get("sync_seconds", 30)), int(c.get("batch_size", 2000)))
    users = parse_users(raw.get("users", []))
    if mode == "cloud" and not users:
        raise ConfigError("cloud mode needs at least one user (run: python run.py hash-password)")
    if users and not raw.get("secret_key"):
        raise ConfigError("set 'secret_key' to a long random text when users are configured")

    return Config(
        mode=mode,
        plant_id=str(raw.get("plant_id", "plant1")),
        cloud=cloud,
        ingest_keys={str(k): str(v) for k, v in raw.get("ingest_keys", {}).items()},
        users=users,
        secret_key=raw.get("secret_key", ""),
        plant_name=raw.get("plant_name", "Steel Plant"),
        poll_seconds=float(raw.get("poll_seconds", 5)),
        log_seconds=float(raw.get("log_seconds", 60)),
        database=db,
        listen_host=raw.get("listen_host", "0.0.0.0"),
        listen_port=int(raw.get("listen_port", 8080)),
        demand_block_minutes=int(raw.get("demand_block_minutes", 15)),
        ports=ports,
        profiles=profiles,
        meters=meters,
        panels=[{"id": str(p["id"])[:40], "name": str(p.get("name", p["id"]))[:80], "voltage": str(p.get("voltage", ""))[:20],
                 "note": str(p.get("note", ""))[:200]} for p in raw.get("panels", []) if isinstance(p, dict) and p.get("id")],
    )
