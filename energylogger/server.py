"""Web server: dashboard, API, login, cloud ingest and settings."""

from __future__ import annotations

import base64
import csv
import re
import dataclasses
import hashlib
import hmac
import io
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import auth
from .collector import Collector, check_alarms
from .config import Alarms, Config, ConfigError, Meter, library_profiles, parse_config
from .db import Database
from .params import PARAM_KEYS, PARAMS
from .reports import daily_report, day_range
from .sync import CloudSyncer

log = logging.getLogger("energylogger")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
COOKIE = "el_session"
OFFLINE_AFTER = 300  # cloud mode: a meter with no data for 5 minutes shows as offline


class App:
    def __init__(self, config_path: Path):
        self.config_path = config_path
        self.raw = json.loads(config_path.read_text(encoding="utf-8"))
        self.config: Config = parse_config(self.raw, config_path.parent)
        self.tz = ZoneInfo(self.raw.get("timezone", "Asia/Kolkata"))
        self.db = Database(self.config.database)
        self.collector: Collector | None = None
        self.syncer: CloudSyncer | None = None

    async def start(self):
        if self.config.mode == "plant":
            self.collector = Collector(self.config, self.db)
            self.collector.start()
            if self.config.cloud:
                self.syncer = CloudSyncer(self.config, self.db)
                self.syncer.start()

    async def stop(self):
        if self.collector:
            await self.collector.stop()
        if self.syncer:
            await self.syncer.stop()

    async def apply_settings(self, raw: dict):
        new = parse_config(raw, self.config_path.parent)  # raises ConfigError if invalid
        if new.mode != self.config.mode or new.database != self.config.database:
            raise ConfigError("mode and database can only be changed in config.json, followed by a restart")
        await self.stop()
        tmp = self.config_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(raw, indent=2), encoding="utf-8")
        tmp.replace(self.config_path)
        self.raw, self.config = raw, new
        self.tz = ZoneInfo(raw.get("timezone", "Asia/Kolkata"))
        await self.start()

    # ---- meters as the dashboard sees them ----
    def meter_list(self) -> list[dict]:
        if self.config.mode == "plant":
            out = []
            for m in self.config.meters:
                st = self.collector.state.get(m.id) if self.collector else None
                port = self.config.ports[m.port]
                out.append({
                    "id": m.id, "name": m.name, "area": m.area, "plant_id": self.config.plant_id,
                    "plant_name": self.config.plant_name, "contract_kva": m.contract_kva, "is_main": m.is_main, "machine": m.machine,
                    "picture_url": self.picture_url(m.id),
                    "enabled": m.enabled, "connection": port.kind, "profile": m.profile,
                    "online": bool(st and st.online), "last_seen": st.last_ok if st else None,
                    "error": st.last_error if st else None,
                    "values": st.values if st else {}, "alarms": list(st.alarms.values()) if st else [],
                })
            return out

        latest = self.db.latest_readings()
        now = time.time()
        out = []
        for m in self.db.meters():
            r = latest.get(m["id"])
            values = {k: r[k] for k in PARAM_KEYS if r is not None and r[k] is not None}
            alarms_cfg = json.loads(m["alarms"] or "{}")
            meter = Meter(m["id"], m["name"], m["area"], "", 1, "", contract_kva=m["contract_kva"],
                          alarms=Alarms(**{k: v for k, v in alarms_cfg.items() if k in Alarms.__dataclass_fields__}))
            online = r is not None and now - r["ts"] < OFFLINE_AFTER
            out.append({
                "id": m["id"], "name": m["name"], "area": m["area"], "plant_id": m["plant_id"],
                "plant_name": self.db.get_kv(f"plant_name:{m['plant_id']}", m["plant_id"]),
                "contract_kva": m["contract_kva"], "is_main": bool(m["is_main"]), "machine": m["machine"], "enabled": True, "connection": "cloud",
                "online": online, "last_seen": r["ts"] if r is not None else None,
                "error": None if online else "No data from plant in the last 5 minutes",
                "values": values, "alarms": list(check_alarms(meter, values).values()) if online else [],
            })
        return out

    def picture_url(self, meter_id: str) -> str | None:
        name = self.raw.get("branding", {}).get("machine_pictures", {}).get(meter_id)
        if not name:
            return None
        f = self.config.database.parent / "branding" / "machines" / name
        return f"/branding/machines/{name}?v={int(f.stat().st_mtime)}" if f.exists() else None

    def meter_ids(self) -> list[str]:
        if self.config.mode == "plant":
            return [m.id for m in self.config.meters]
        return [m["id"] for m in self.db.meters()]


def create_app(config_path: str | Path) -> FastAPI:
    state = App(Path(config_path))

    @asynccontextmanager
    async def lifespan(_):
        await state.start()
        yield
        await state.stop()

    api = FastAPI(title="Energy Monitoring Management", lifespan=lifespan)
    api.state.app = state

    # ---------- login ----------
    def current_user(request: Request) -> dict | None:
        cfg = state.config
        if not cfg.users:
            return {"u": "local", "r": "admin" if request.client and request.client.host in ("127.0.0.1", "::1") else "viewer"}
        token = request.cookies.get(COOKIE) or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        return auth.read_token(cfg.secret_key, token) if token else None

    def need_user(request: Request) -> dict:
        user = current_user(request)
        if user is None:
            raise HTTPException(401, "Please sign in")
        return user

    def need_admin(user: dict = Depends(need_user)) -> dict:
        if user.get("r") != "admin":
            raise HTTPException(403, "Only an admin can change settings. Without users in config.json, open the app on the plant PC itself.")
        return user

    @api.post("/api/login")
    async def login(body: dict, response: Response, request: Request):
        for u in state.config.users:
            if u.username == body.get("username") and auth.verify_password(str(body.get("password", "")), u.password_hash):
                token = auth.make_token(state.config.secret_key, u.username, u.role)
                response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=12 * 3600,
                                    secure=request.url.scheme == "https")
                return {"ok": True, "username": u.username, "role": u.role}
        raise HTTPException(401, "Wrong username or password")

    @api.post("/api/logout")
    async def logout(response: Response):
        response.delete_cookie(COOKIE)
        return {"ok": True}

    @api.get("/api/info")
    async def info(request: Request):
        cfg = state.config
        user = current_user(request)
        return {
            "mode": cfg.mode, "plant_name": cfg.plant_name if cfg.mode == "plant" else state.raw.get("plant_name", "All plants"),
            "login_required": bool(cfg.users), "user": user and {"username": user["u"], "role": user["r"]},
            "params": PARAMS, "demand_block_minutes": cfg.demand_block_minutes,
            "poll_seconds": cfg.poll_seconds, "log_seconds": cfg.log_seconds,
            "timezone": str(state.tz), "cloud_sync": state.syncer.status if state.syncer else None,
            "branding": branding_public(),
        }

    # ---------- branding (company name, logo, colours) ----------
    LOGO_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "jpg": "image/jpeg", "svg+xml": "image/svg+xml", "webp": "image/webp"}

    def branding_dir() -> Path:
        return state.config.database.parent / "branding"

    def branding_public() -> dict:
        b = state.raw.get("branding", {})
        logo = b.get("logo")
        has_logo = bool(logo) and (branding_dir() / logo).exists()
        return {
            "company_name": b.get("company_name", ""),
            "accent": b.get("accent", "#ff7a1a"),
            "theme": b.get("theme", "dark"),
            "logo_url": f"/branding/{logo}?v={int((branding_dir() / logo).stat().st_mtime)}" if has_logo else None,
        }

    def save_raw():
        tmp = state.config_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state.raw, indent=2), encoding="utf-8")
        tmp.replace(state.config_path)

    @api.put("/api/branding")
    async def put_branding(body: dict, _=Depends(need_admin)):
        b = dict(state.raw.get("branding", {}))
        if "company_name" in body:
            b["company_name"] = str(body["company_name"]).strip()[:80]
        if "plant_name" in body and str(body["plant_name"]).strip():
            state.raw["plant_name"] = str(body["plant_name"]).strip()[:80]
            state.config.plant_name = state.raw["plant_name"]
        if "accent" in body:
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(body["accent"])):
                raise HTTPException(400, "Pick the colour as a 6-digit hex code like #ff7a1a")
            b["accent"] = body["accent"].lower()
        if "theme" in body:
            if body["theme"] not in ("dark", "light", "auto"):
                raise HTTPException(400, "Theme must be dark, light or auto")
            b["theme"] = body["theme"]
        state.raw["branding"] = b
        save_raw()
        return branding_public()

    def decode_image(body: dict, what: str) -> tuple[bytes, str]:
        m = re.fullmatch(r"data:image/(png|jpeg|jpg|svg\+xml|webp);base64,([A-Za-z0-9+/=\s]+)", str(body.get("data_url", "")))
        if not m:
            raise HTTPException(400, "Upload a PNG, JPG, SVG or WebP image")
        data = base64.b64decode(m.group(2))
        if len(data) > 1_000_000:
            raise HTTPException(400, f"The {what} must be smaller than 1 MB")
        return data, {"jpeg": "jpg", "svg+xml": "svg"}.get(m.group(1), m.group(1))

    def image_response(path: Path):
        media = LOGO_TYPES.get(path.suffix[1:].replace("svg", "svg+xml"), "application/octet-stream")
        # SVG files may not run scripts
        return FileResponse(path, media_type=media,
                            headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "Cache-Control": "max-age=86400"})

    def raw_meter(meter_id: str) -> dict:
        if state.config.mode != "plant":
            raise HTTPException(400, "Machines are changed on the plant PC")
        for rm in state.raw.get("meters", []):
            if rm.get("id") == meter_id:
                return rm
        raise HTTPException(404, "No machine with that ID")

    @api.patch("/api/machines/{meter_id}")
    async def edit_machine(meter_id: str, body: dict, _=Depends(need_admin)):
        """Rename a machine or change its picture without restarting logging."""
        rm = raw_meter(meter_id)
        live = next(m for m in state.config.meters if m.id == meter_id)
        if "name" in body:
            name = str(body["name"]).strip()[:60]
            if not name:
                raise HTTPException(400, "The machine needs a name")
            rm["name"] = live.name = name
        if "area" in body:
            rm["area"] = live.area = str(body["area"]).strip()[:60]
        if "machine" in body:
            rm["machine"] = live.machine = str(body["machine"] or "")[:40]
        save_raw()
        return next(x for x in state.meter_list() if x["id"] == meter_id)

    @api.post("/api/machines/{meter_id}/picture")
    async def machine_picture(meter_id: str, body: dict, _=Depends(need_admin)):
        """Body: {"data_url": ...} to use your own photo or drawing, or {"remove": true} to go back to the built-in one."""
        raw_meter(meter_id)
        b = state.raw.setdefault("branding", {})
        pics = b.setdefault("machine_pictures", {})
        d = branding_dir() / "machines"
        data, ext = (None, None) if body.get("remove") else decode_image(body, "picture")  # check before removing the old one
        if pics.get(meter_id):
            (d / pics[meter_id]).unlink(missing_ok=True)
            pics.pop(meter_id)
        if data is not None:
            safe = re.sub(r"[^A-Za-z0-9_-]", "_", meter_id)[:40] + "-" + hashlib.sha1(meter_id.encode()).hexdigest()[:6]
            d.mkdir(parents=True, exist_ok=True)
            pics[meter_id] = f"{safe}.{ext}"
            (d / pics[meter_id]).write_bytes(data)
        save_raw()
        return {"picture_url": state.picture_url(meter_id)}

    @api.get("/branding/machines/{name}")
    async def machine_picture_file(name: str):
        if name not in state.raw.get("branding", {}).get("machine_pictures", {}).values():
            raise HTTPException(404)
        f = branding_dir() / "machines" / name
        if not f.exists():
            raise HTTPException(404)
        return image_response(f)

    @api.post("/api/branding/logo")
    async def put_logo(body: dict, _=Depends(need_admin)):
        """Body: {"data_url": "data:image/png;base64,..."} or {"remove": true}."""
        b = dict(state.raw.get("branding", {}))
        d = branding_dir()
        if body.get("remove"):
            if b.get("logo"):
                (d / b["logo"]).unlink(missing_ok=True)
            b.pop("logo", None)
        else:
            data, ext = decode_image(body, "logo")
            d.mkdir(parents=True, exist_ok=True)
            if b.get("logo"):
                (d / b["logo"]).unlink(missing_ok=True)
            b["logo"] = f"logo.{ext}"
            (d / b["logo"]).write_bytes(data)
        state.raw["branding"] = b
        save_raw()
        return branding_public()

    @api.get("/branding/{name}")
    async def branding_file(name: str):
        logo = state.raw.get("branding", {}).get("logo")
        if not logo or name != logo or not (branding_dir() / logo).exists():
            raise HTTPException(404)
        return image_response(branding_dir() / logo)

    # ---------- live data and history ----------
    @api.get("/api/meters")
    async def meters(_=Depends(need_user)):
        return {"time": time.time(), "meters": state.meter_list()}

    @api.get("/api/history")
    async def history(meter: str, param: str = "kw", hours: float = 24, _=Depends(need_user)):
        if param not in PARAMS:
            raise HTTPException(400, f"unknown parameter {param}")
        end = int(time.time()) + 1
        start = end - int(hours * 3600)
        rows = state.db.history(meter, param, start, end)
        return {"meter": meter, "param": param, "points": [[r["t"], r["v"], r["lo"], r["hi"]] for r in rows]}

    @api.get("/api/events")
    async def events(hours: float = 72, _=Depends(need_user)):
        rows = state.db.events(int(time.time() - hours * 3600))
        return {"events": [dict(r) for r in rows]}

    # ---------- reports ----------
    def _parse_range(start: str | None, end: str | None) -> tuple[date, date]:
        today = datetime.now(state.tz).date()
        try:
            s = date.fromisoformat(start) if start else today
            e = date.fromisoformat(end) if end else s
        except ValueError:
            raise HTTPException(400, "dates must look like 2026-11-24")
        if e < s:
            s, e = e, s
        if (e - s).days > 370:
            raise HTTPException(400, "pick a range of one year or less")
        return s, e

    def _ids(meters: str | None) -> list[str]:
        ids = state.meter_ids()
        if meters:
            want = set(meters.split(","))
            ids = [i for i in ids if i in want]
        return ids

    @api.get("/api/reports/daily")
    async def report_daily(start: str | None = None, end: str | None = None, meters: str | None = None, _=Depends(need_user)):
        s, e = _parse_range(start, end)
        ids = _ids(meters)
        t0, t1 = day_range(s, e, state.tz)
        rows = state.db.readings(ids, t0, t1) if ids else []
        return {"start": s.isoformat(), "end": e.isoformat(), "block_minutes": state.config.demand_block_minutes,
                "rows": daily_report(rows, state.tz, state.config.demand_block_minutes)}

    @api.get("/api/export.csv")
    async def export_csv(start: str | None = None, end: str | None = None, meters: str | None = None,
                         kind: str = "readings", _=Depends(need_user)):
        s, e = _parse_range(start, end)
        ids = _ids(meters)
        t0, t1 = day_range(s, e, state.tz)
        names = {m["id"]: m["name"] for m in state.meter_list()}
        buf = io.StringIO()
        w = csv.writer(buf)
        if kind == "daily":
            rows = daily_report(state.db.readings(ids, t0, t1) if ids else [], state.tz, state.config.demand_block_minutes)
            cols = ["date", "meter_id", "kwh", "kvah", "kvarh", "md_kva", "md_kva_at", "md_kw", "peak_kw", "avg_pf", "samples"]
            w.writerow(["date", "meter_id", "meter_name", *cols[2:]])
            for r in rows:
                w.writerow([r["date"], r["meter_id"], names.get(r["meter_id"], ""),
                            *[("" if r[c] is None else round(r[c], 4) if isinstance(r[c], float) else r[c]) for c in cols[2:]]])
        else:
            w.writerow(["time", "meter_id", "meter_name", *[f"{k} ({PARAMS[k]['unit']})" if PARAMS[k]["unit"] else k for k in PARAM_KEYS]])
            for r in (state.db.readings(ids, t0, t1) if ids else []):
                w.writerow([datetime.fromtimestamp(r["ts"], state.tz).strftime("%Y-%m-%d %H:%M:%S"), r["meter_id"],
                            names.get(r["meter_id"], ""), *["" if r[k] is None else round(r[k], 4) for k in PARAM_KEYS]])
        fname = f"energy-{kind}-{s.isoformat()}-to-{e.isoformat()}.csv"
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{fname}"'})

    # ---------- cloud ingest (cloud mode only) ----------
    @api.post("/api/ingest")
    async def ingest(body: dict, request: Request):
        if state.config.mode != "cloud":
            raise HTTPException(404, "this server is not in cloud mode")
        plant = str(body.get("plant_id", ""))
        key = state.config.ingest_keys.get(plant)
        given = request.headers.get("x-plant-key", "")
        if not key or not hmac.compare_digest(key, given):
            raise HTTPException(401, "unknown plant or wrong key")
        prefix = f"{plant}."
        if body.get("plant_name"):
            state.db.set_kv(f"plant_name:{plant}", str(body["plant_name"])[:200])
        for m in body.get("meters", [])[:1000]:
            state.db.upsert_meter({**m, "id": prefix + str(m["id"]), "plant_id": plant})
        readings = body.get("readings", [])[:10000]
        state.db.insert_many_readings([{**r, "meter_id": prefix + str(r["meter_id"])} for r in readings])
        events = body.get("events", [])[:10000]
        state.db.insert_many_events([{**e, "meter_id": prefix + str(e["meter_id"])} for e in events])
        return {"ok": True, "readings": len(readings), "events": len(events)}

    # ---------- settings (plant mode) ----------
    @api.get("/api/settings")
    async def get_settings(_=Depends(need_admin)):
        raw = json.loads(json.dumps(state.raw))
        if raw.get("cloud_sync", {}).get("api_key"):
            raw["cloud_sync"]["api_key"] = "********"
        raw.pop("secret_key", None)
        return {"config": raw, "library_profiles": library_profiles()}

    @api.put("/api/settings")
    async def put_settings(body: dict, _=Depends(need_admin)):
        if state.config.mode != "plant":
            raise HTTPException(400, "settings can be edited on the plant PC only")
        raw = body.get("config")
        if not isinstance(raw, dict):
            raise HTTPException(400, "missing config")
        # keep secrets the browser never saw
        if raw.get("cloud_sync", {}).get("api_key") == "********":
            raw["cloud_sync"]["api_key"] = state.raw.get("cloud_sync", {}).get("api_key", "")
        if "secret_key" in state.raw:
            raw["secret_key"] = state.raw["secret_key"]
        raw["users"] = state.raw.get("users", [])  # users are managed in config.json only
        raw["branding"] = state.raw.get("branding", {})  # managed on the Branding tab
        try:
            await state.apply_settings(raw)
        except ConfigError as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    @api.post("/api/settings/test-meter")
    async def test_meter(body: dict, _=Depends(need_admin)):
        """Read one meter once with the given (unsaved) settings, so a technician can check wiring."""
        raw = json.loads(json.dumps(state.raw))
        raw["ports"] = body.get("ports", raw.get("ports", {}))
        raw["profiles"] = {**raw.get("profiles", {}), **body.get("profiles", {})}
        raw["meters"] = [body["meter"]]
        try:
            cfg = parse_config(raw, state.config_path.parent)
        except ConfigError as e:
            raise HTTPException(400, str(e))
        tmp = Collector(cfg, state.db)
        m = cfg.meters[0]
        port = cfg.ports[m.port]
        try:
            if port.kind == "simulator":
                values = await tmp.sim.read(m)
            else:
                # share the live port lock so a test does not collide with polling on RS485
                live = state.collector.port_readers.get(m.port) if state.collector else None
                reader = live if live and dataclasses.asdict(live.port) == dataclasses.asdict(port) else tmp.port_readers[m.port]
                prof = cfg.profiles[m.profile]
                values = await reader.read(m, prof)
                hint = None
                # Many manuals do not say which 16-bit word comes first. Frequency must be 45-65 Hz,
                # so if it is not, try the other order and tell the technician which one works.
                if "hz" in {r.param for r in prof.registers} and not 45 <= values.get("hz", 0) <= 65:
                    other = "little" if prof.word_order == "big" else "big"
                    alt = await reader.read(m, dataclasses.replace(prof, word_order=other))
                    if 45 <= alt.get("hz", 0) <= 65:
                        values = alt
                        hint = (f"Readings only make sense with word order '{other}'. Add \"word_order\": \"{other}\" "
                                f"to the '{m.profile}' model, or copy it under a new name with that change.")
                    else:
                        hint = ("Frequency does not read as 45-65 Hz in either word order. Check the Modbus address, "
                                "the register map for this model, and the 1-based/0-based address setting.")
                if reader is not live:
                    await reader.close()
                return {"ok": True, "values": values, "hint": hint}
        except Exception as e:
            return {"ok": False, "error": str(e) or type(e).__name__}
        return {"ok": True, "values": values}

    # ---------- web app ----------
    @api.get("/")
    async def index():
        return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    api.mount("/", StaticFiles(directory=WEB_DIR), name="web")
    return api
