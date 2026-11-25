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
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import auth
from .collector import Collector, check_alarms
from .config import PAGES, Alarms, Config, ConfigError, Meter, is_dg, library_profiles, parse_config, parse_users
from . import dg as dgmod
from .db import Database
from .params import PARAM_KEYS, PARAMS
from .insights import analyse, ask_claude, tariff_from
from .reports import daily_report, day_range, parse_shifts, shift_report
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
                    "picture_url": self.picture_url(m.id), "is_dg": m.is_dg,
                    "panel": m.panel, "position": m.position, "fed_from": m.fed_from, "feeds": m.feeds,
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
            lay = json.loads(m["layout"] or "{}")
            pre = f'{m["plant_id"]}.'
            out.append({
                "panel": pre + lay["panel"] if lay.get("panel") else "", "position": lay.get("position") or ("incomer" if m["is_main"] else "feeder"),
                "fed_from": pre + lay["fed_from"] if lay.get("fed_from") else "", "feeds": pre + lay["feeds"] if lay.get("feeds") else "",
                "is_dg": not lay.get("fed_from") and is_dg(m["machine"], m["name"]),
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

    def panels(self) -> list[dict]:
        if self.config.mode == "plant":
            return self.config.panels
        out = []
        plants = sorted({m["plant_id"] for m in self.db.meters()})
        for pl in plants:
            for p in json.loads(self.db.get_kv(f"panels:{pl}", "[]")):
                out.append({**p, "id": f"{pl}.{p['id']}", "plant_id": pl})
        return out

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
    def is_local(request: Request) -> bool:
        return bool(request.client and request.client.host in ("127.0.0.1", "::1"))

    def current_user(request: Request) -> dict | None:
        """Signed-in user with their access, or None. Before the first admin is created, only the PC itself gets in."""
        cfg = state.config
        if not cfg.users:
            if is_local(request):
                return {"u": "local", "r": "admin", "name": "", "designation": "", "pages": list(PAGES), "panels": [], "setup": True}
            return None
        token = request.cookies.get(COOKIE) or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        data = auth.read_token(cfg.secret_key, token) if token else None
        if not data:
            return None
        u = next((x for x in cfg.users if x.username == data.get("u")), None)
        if u is None or not u.active:
            return None
        admin = u.role == "admin"
        return {"u": u.username, "r": u.role, "name": u.name, "designation": u.designation,
                "pages": list(PAGES) if admin else u.pages, "panels": [] if admin else u.panels}

    def allowed_ids(user: dict) -> set[str] | None:
        """Meter ids this user may see; None means all."""
        if not user.get("panels"):
            return None
        want = set(user["panels"])
        return {m["id"] for m in state.meter_list() if m.get("panel") in want}

    def can_see(user: dict, meter_id: str) -> bool:
        ids = allowed_ids(user)
        return ids is None or meter_id in ids

    def need_page(page: str):
        def dep(user: dict = Depends(need_user)) -> dict:
            if page not in user.get("pages", PAGES):
                raise HTTPException(403, "Your account does not have access to this page. Ask an admin.")
            return user
        return dep

    def need_user(request: Request) -> dict:
        user = current_user(request)
        if user is None:
            raise HTTPException(401, "Please sign in")
        return user

    def need_admin(user: dict = Depends(need_user)) -> dict:
        if user.get("r") != "admin":
            raise HTTPException(403, "Only an admin can do this.")
        return user

    @api.post("/api/login")
    async def login(body: dict, response: Response, request: Request):
        for u in state.config.users:
            if u.active and u.username == body.get("username") and auth.verify_password(str(body.get("password", "")), u.password_hash):
                state.db.set_kv(f"last_login:{u.username}", str(int(time.time())))
                token = auth.make_token(state.config.secret_key, u.username, u.role)
                response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=12 * 3600,
                                    secure=request.url.scheme == "https")
                return {"ok": True, "username": u.username, "role": u.role}
        raise HTTPException(401, "Wrong username or password")

    @api.post("/api/logout")
    async def logout(response: Response):
        response.delete_cookie(COOKIE)
        return {"ok": True}

    def cut_since():
        p = state.collector.plant if state.collector else None
        if p and p.cuts and p.cuts[-1][1] is None:
            return p.cuts[-1][0]
        return None

    @api.get("/api/info")
    async def info(request: Request):
        cfg = state.config
        user = current_user(request)
        return {
            "mode": cfg.mode, "plant_name": cfg.plant_name if cfg.mode == "plant" else state.raw.get("plant_name", "All plants"),
            "login_required": bool(cfg.users), "setup_needed": not cfg.users, "setup_here": not cfg.users and is_local(request),
            "user": user and {"username": user["u"], "role": user["r"], "name": user.get("name", ""), "designation": user.get("designation", ""),
                              "pages": user.get("pages", list(PAGES)), "panels": user.get("panels", [])},
            "panels": state.panels() if user else [],
            "demo": bool(state.collector and state.collector.plant),
            "grid_on": state.collector.plant.grid_on() if state.collector and state.collector.plant else None,
            "cut_since": cut_since(),
            "has_dg": any(m.get("is_dg") for m in state.meter_list()) if user else None,
            "params": PARAMS, "demand_block_minutes": cfg.demand_block_minutes,
            "poll_seconds": cfg.poll_seconds, "log_seconds": cfg.log_seconds,
            "timezone": str(state.tz), "cloud_sync": state.syncer.status if state.syncer else None,
            "branding": branding_public(),
            "ai_enabled": bool(state.raw.get("ai", {}).get("api_key")),
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

    # ---------- insights and AI advice ----------
    insight_cache: dict = {}

    def insight_meters(user: dict | None = None) -> list[dict]:
        ids = allowed_ids(user) if user else None
        return [m for m in _insight_meters() if ids is None or m["id"] in ids]

    def _insight_meters() -> list[dict]:
        if state.config.mode == "plant":
            return [{"id": m.id, "name": m.name, "area": m.area, "is_main": m.is_main, "contract_kva": m.contract_kva,
                     "machine": m.machine, "is_dg": m.is_dg} for m in state.config.meters if m.enabled]
        return [{"id": m["id"], "name": m["name"], "area": m["area"], "is_main": bool(m["is_main"]),
                 "contract_kva": m["contract_kva"], "machine": m["machine"], "is_dg": not json.loads(m["layout"] or "{}").get("fed_from") and is_dg(m["machine"], m["name"])} for m in state.db.meters()]

    async def current_analysis(fresh: bool = False, user: dict | None = None) -> dict:
        import asyncio
        ms = insight_meters(user)
        key = json.dumps([state.raw.get("tariff"), [m["name"] for m in ms]], sort_keys=True)
        hit = insight_cache.get(key)
        if not fresh and hit and hit[0] == key and time.time() - hit[1] < 300:
            return hit[2]
        a = await asyncio.to_thread(analyse, ms, state.db, state.tz, state.raw.get("tariff"),
                                    state.config.demand_block_minutes, fuel=state.raw.get("dg_fuel"))
        insight_cache[key] = (key, time.time(), a)
        return a

    @api.get("/api/insights")
    async def insights(fresh: bool = False, user=Depends(need_page("insights"))):
        return {**await current_analysis(fresh, user), "ai_enabled": bool(state.raw.get("ai", {}).get("api_key"))}

    @api.put("/api/tariff")
    async def put_tariff(body: dict, _=Depends(need_admin)):
        t = tariff_from(state.raw.get("tariff"))
        try:
            for k in ("energy_rate", "demand_rate", "pf_target", "peak_extra"):
                if k in body:
                    t[k] = float(body[k])
                    if t[k] < 0 or (k == "pf_target" and not 0.8 <= t[k] <= 1):
                        raise ValueError(k)
            if "billing" in body:
                if body["billing"] not in ("kvah", "kwh"):
                    raise ValueError("billing")
                t["billing"] = body["billing"]
            if "currency" in body:
                t["currency"] = str(body["currency"])[:4]
            if "peak_hours" in body:
                ph = [[int(a), int(b)] for a, b in body["peak_hours"]]
                if any(not (0 <= a <= 23 and 0 <= b <= 24) for a, b in ph):
                    raise ValueError("peak_hours")
                t["peak_hours"] = ph
        except (TypeError, ValueError) as e:
            raise HTTPException(400, f"Check the value of {e}")
        state.raw["tariff"] = t
        save_raw()
        insight_cache.clear()
        return t

    @api.put("/api/ai")
    async def put_ai(body: dict, _=Depends(need_admin)):
        ai = dict(state.raw.get("ai", {}))
        if "api_key" in body and body["api_key"] != "********":
            ai["api_key"] = str(body["api_key"]).strip()
        if body.get("model"):
            ai["model"] = str(body["model"]).strip()[:60]
        state.raw["ai"] = ai
        save_raw()
        return {"ai_enabled": bool(ai.get("api_key")), "model": ai.get("model", "claude-opus-5-5")}

    @api.post("/api/insights/ask")
    async def ask(body: dict, user=Depends(need_page("insights"))):
        import asyncio
        ai = state.raw.get("ai", {})
        if not ai.get("api_key"):
            raise HTTPException(400, "Claude is not switched on. An admin can add an API key on the Insights page.")
        q = str(body.get("question", "")).strip()[:1000]
        if not q:
            raise HTTPException(400, "Type a question first")
        a = await current_analysis(user=user)
        try:
            answer = await asyncio.to_thread(ask_claude, ai["api_key"], ai.get("model") or "claude-opus-5-5", a, q,
                                             state.raw.get("plant_name", ""))
        except ImportError:
            raise HTTPException(500, "The Claude library is missing. Run: pip install anthropic")
        except Exception as e:  # network, key, rate limit: show the reason to the user
            log.warning("Claude request failed: %s", e)
            msg = getattr(e, "message", None) or str(e)
            raise HTTPException(502, f"Claude could not be reached: {msg[:300]}")
        return {"answer": answer}


    # ---------- users and sign-in ----------
    def user_public(u: dict) -> dict:
        last = state.db.get_kv(f"last_login:{u['username']}", "")
        return {"username": u["username"], "name": u.get("name", ""), "designation": u.get("designation", ""), "phone": u.get("phone", ""),
                "role": u.get("role", "viewer"), "panels": u.get("panels", []), "pages": u.get("pages", list(PAGES)),
                "active": u.get("active", True), "last_login": int(last) if last else None}

    def clean_user(body: dict, old: dict | None) -> dict:
        u = dict(old or {})
        if old is None:
            name = str(body.get("username", "")).strip().lower()
            if not re.fullmatch(r"[a-z0-9._-]{3,32}", name):
                raise HTTPException(400, "User ID: 3 to 32 letters, numbers, dots or dashes")
            if any(x["username"] == name for x in state.raw.get("users", [])):
                raise HTTPException(400, "That user ID is taken")
            u["username"] = name
        for k, n in (("name", 80), ("designation", 80), ("phone", 30)):
            if k in body:
                u[k] = str(body[k]).strip()[:n]
        if "role" in body:
            if body["role"] not in ("admin", "viewer"):
                raise HTTPException(400, "Role must be admin or viewer")
            u["role"] = body["role"]
        if "panels" in body:
            u["panels"] = [str(x) for x in body["panels"]][:100]
        if "pages" in body:
            u["pages"] = [x for x in body["pages"] if x in PAGES] or ["plant"]
        if "active" in body:
            u["active"] = bool(body["active"])
        if body.get("password"):
            if len(str(body["password"])) < 8:
                raise HTTPException(400, "Password must be at least 8 characters")
            u["password_hash"] = auth.hash_password(str(body["password"]))
        if "password_hash" not in u:
            raise HTTPException(400, "Set a password")
        u.setdefault("role", "viewer")
        return u

    def save_users(users: list[dict]):
        if not any(x.get("role") == "admin" and x.get("active", True) for x in users):
            raise HTTPException(400, "Keep at least one active admin")
        state.raw["users"] = users
        if not state.raw.get("secret_key"):
            import secrets
            state.raw["secret_key"] = secrets.token_hex(32)
        state.config.users = parse_users(users)
        state.config.secret_key = state.raw["secret_key"]
        save_raw()

    @api.post("/api/setup")
    async def setup(body: dict, request: Request, response: Response):
        """First admin account. Only from the PC itself, and only while no user exists."""
        if state.config.users:
            raise HTTPException(400, "Already set up. Sign in instead.")
        if not is_local(request):
            raise HTTPException(403, "Create the first admin on the plant PC itself")
        u = clean_user({**body, "role": "admin", "pages": list(PAGES), "panels": []}, None)
        save_users([u])
        token = auth.make_token(state.config.secret_key, u["username"], "admin")
        response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=12 * 3600, secure=request.url.scheme == "https")
        return {"ok": True}

    @api.get("/api/users")
    async def list_users(_=Depends(need_admin)):
        return {"users": [user_public(u) for u in state.raw.get("users", [])], "pages": list(PAGES), "panels": state.panels()}

    @api.post("/api/users")
    async def add_user(body: dict, _=Depends(need_admin)):
        u = clean_user(body, None)
        save_users([*state.raw.get("users", []), u])
        return user_public(u)

    @api.put("/api/users/{username}")
    async def edit_user(username: str, body: dict, me=Depends(need_admin)):
        users = list(state.raw.get("users", []))
        i = next((i for i, x in enumerate(users) if x["username"] == username), None)
        if i is None:
            raise HTTPException(404, "No such user")
        users[i] = clean_user(body, users[i])
        save_users(users)
        return user_public(users[i])

    @api.delete("/api/users/{username}")
    async def delete_user(username: str, me=Depends(need_admin)):
        if username == me["u"]:
            raise HTTPException(400, "You cannot remove your own account")
        users = [x for x in state.raw.get("users", []) if x["username"] != username]
        save_users(users)
        return {"ok": True}

    @api.post("/api/me/password")
    async def my_password(body: dict, me=Depends(need_user)):
        users = list(state.raw.get("users", []))
        i = next((i for i, x in enumerate(users) if x["username"] == me["u"]), None)
        if i is None:
            raise HTTPException(400, "Create an admin account first")
        if not auth.verify_password(str(body.get("old", "")), users[i]["password_hash"]):
            raise HTTPException(400, "Current password is wrong")
        users[i] = clean_user({"password": body.get("new", "")}, users[i])
        save_users(users)
        return {"ok": True}

    # ---------- shifts ----------
    @api.get("/api/shifts")
    async def get_shifts(_=Depends(need_user)):
        return {"shifts": [{k: v for k, v in x.items() if not k.startswith("_")} for x in parse_shifts(state.raw.get("shifts"))]}

    @api.put("/api/shifts")
    async def put_shifts(body: dict, _=Depends(need_admin)):
        sh = parse_shifts(body.get("shifts"))
        if len(sh) != len(body.get("shifts") or []):
            raise HTTPException(400, "Each shift needs a name and times like 06:00")
        state.raw["shifts"] = [{k: v for k, v in x.items() if not k.startswith("_")} for x in sh]
        save_raw()
        return {"shifts": state.raw["shifts"]}

    @api.get("/api/reports/shifts")
    async def report_shifts(start: str | None = None, end: str | None = None, meters: str | None = None, user=Depends(need_page("reports"))):
        shifts = parse_shifts(state.raw.get("shifts"))
        if not shifts:
            raise HTTPException(400, "No shifts set yet. An admin can set them in Settings, Shifts.")
        s, e = _parse_range(start, end)
        ids = _ids(meters, user)
        t0, t1 = day_range(s, e + timedelta(days=1), state.tz)  # a night shift ends the next morning
        rows = state.db.readings(ids, t0, t1) if ids else []
        out = [r for r in shift_report(rows, state.tz, shifts, state.config.demand_block_minutes) if s.isoformat() <= r["date"] <= e.isoformat()]
        # DG hours and power cuts per shift
        order = {x["name"]: i for i, x in enumerate(shifts)}
        extra: dict = {}
        fuel = dgmod.fuel_settings(state.raw.get("dg_fuel"))
        for m in state.meter_list():
            if not m.get("is_dg") or m["id"] not in ids:
                continue
            runs = dgmod.runs_for(state.db.readings([m["id"]], t0, t1), m.get("contract_kva"), state.config.log_seconds, fuel, time.time(), state.tz)
            for r in runs:
                k = shift_of_key(r["start"], shifts)
                x = extra.setdefault(k, {"dg_seconds": 0, "dg_kwh": 0.0, "dg_fuel_l": 0.0})
                x["dg_seconds"] += r["seconds"]; x["dg_kwh"] += r["kwh"]; x["dg_fuel_l"] += r["fuel_l"]
        for c in dgmod.power_cuts([dict(e) for e in state.db.query("SELECT * FROM events WHERE kind='power_cut' AND ts >= ? AND ts < ?", (t0, t1))], state.tz):
            k = shift_of_key(c["start"], shifts)
            x = extra.setdefault(k, {"dg_seconds": 0, "dg_kwh": 0.0, "dg_fuel_l": 0.0})
            x["cuts"] = x.get("cuts", 0) + 1
            x["cut_seconds"] = x.get("cut_seconds", 0) + (c["seconds"] or 0)
        return {"start": s.isoformat(), "end": e.isoformat(), "shifts": [{k: v for k, v in x.items() if not k.startswith("_")} for x in shifts],
                "rows": sorted(out, key=lambda r: (r["date"], order.get(r["shift"], 99), r["meter_id"])),
                "shift_extra": [{"date": k[0], "shift": k[1], **v} for k, v in sorted(extra.items(), key=lambda kv: (kv[0][0], order.get(kv[0][1], 99)))
                                if s.isoformat() <= k[0] <= e.isoformat()]}

    def shift_of_key(ts: int, shifts: list[dict]) -> tuple[str, str]:
        from .reports import shift_of
        return shift_of(ts, state.tz, shifts)

    # ---------- DG sets ----------
    @api.get("/api/dg")
    async def dg_status(days: int = 30, user=Depends(need_page("dg"))):
        import asyncio
        days = max(1, min(days, 400))
        ids = allowed_ids(user)
        dgs = [m for m in state.meter_list() if m.get("is_dg") and (ids is None or m["id"] in ids)]
        fuel = dgmod.fuel_settings(state.raw.get("dg_fuel"))
        now = time.time()
        t0 = int(now - days * 86400)
        today0 = int(datetime.combine(datetime.now(state.tz).date(), datetime.min.time(), state.tz).timestamp())
        offsets = state.raw.get("dg_hours", {})

        def work():
            out, all_runs, per_day = [], [], {}
            for m in dgs:
                all_rows = state.db.query("SELECT ts, kw, kva, kwh, hz, v_ln, v_ll FROM readings WHERE meter_id = ? AND ts >= ? ORDER BY ts", (m["id"], t0))
                runs = dgmod.runs_for(all_rows, m.get("contract_kva"), state.config.log_seconds, fuel, now, state.tz)
                tot = state.db.query("SELECT ts, kw, kva, kwh, hz, v_ln, v_ll FROM readings WHERE meter_id = ? ORDER BY ts", (m["id"],)) if days < 400 else all_rows
                logged_h = sum(r["seconds"] for r in dgmod.runs_for(tot, m.get("contract_kva"), state.config.log_seconds, fuel, now, state.tz)) / 3600
                v = m.get("values") or {}
                live_running = m["online"] and (((v.get("hz") or 0) > 40 and ((v.get("v_ln") or 0) > 50 or (v.get("v_ll") or 0) > 90)) or abs(v.get("kw") or 0) > 2)
                since = state.collector.watch.dg_on.get(m["id"]) if state.collector else None
                if live_running and not isinstance(since, (int, float)):
                    since = runs[-1]["start"] if runs and runs[-1]["ongoing"] else None
                d = dgmod.daily(runs, state.tz)
                today = d.get(datetime.now(state.tz).date().isoformat(), {"seconds": 0, "kwh": 0, "fuel_l": 0, "starts": 0})
                rated = m.get("contract_kva")
                out.append({
                    "id": m["id"], "name": m["name"], "rated_kva": rated, "picture_url": m.get("picture_url"), "machine": m.get("machine"),
                    "status": "running" if live_running else ("stopped" if m["online"] else "offline"),
                    "since": since if live_running else None, "error": m.get("error"),
                    "values": v, "load_pct": round(abs(v.get("kva") or 0) / rated * 100, 1) if rated and live_running else None,
                    "today": {k: (round(x, 1) if isinstance(x, float) else x) for k, x in today.items()},
                    "last_start": runs[-1]["start"] if runs else None, "last_stop": next((r["end"] for r in reversed(runs) if r["end"]), None),
                    "run_hours_total": round(float(offsets.get(m["id"], 0)) + logged_h, 1), "hour_meter_offset": float(offsets.get(m["id"], 0)),
                    "period": {"seconds": sum(r["seconds"] for r in runs), "kwh": round(sum(r["kwh"] for r in runs), 1),
                               "fuel_l": round(sum(r["fuel_l"] for r in runs), 1), "starts": len(runs)},
                })
                all_runs += [{**r, "meter_id": m["id"], "name": m["name"]} for r in runs]
                for day, x in d.items():
                    per_day.setdefault(day, {})[m["id"]] = {k: (round(y, 2) if isinstance(y, float) else y) for k, y in x.items()}
            evs = [dict(e) for e in state.db.query("SELECT * FROM events WHERE ts >= ? AND kind IN ('power_cut', 'dg_run', 'changeover') ORDER BY ts", (t0,))]
            cuts = dgmod.power_cuts(evs, state.tz)
            for c in cuts:  # how fast the DGs picked up
                st = next((e for e in evs if e["kind"] == "dg_run" and e["active"] and c["start"] <= e["ts"] <= c["start"] + 600), None)
                c["dg_start_s"] = st["ts"] - c["start"] if st else None
            return {"dgs": out, "runs": sorted(all_runs, key=lambda r: -r["start"])[:500], "daily": per_day, "power_cuts": cuts,
                    "events": evs[-200:][::-1], "fuel": fuel, "days": days, "grid_on": state.collector.plant.grid_on() if state.collector and state.collector.plant else None}
        return await asyncio.to_thread(work)

    @api.put("/api/dg/settings")
    async def dg_settings(body: dict, _=Depends(need_admin)):
        f = dgmod.fuel_settings(state.raw.get("dg_fuel"))
        try:
            for k in dgmod.DEFAULT_FUEL:
                if k in body:
                    f[k] = float(body[k])
                    if f[k] < 0:
                        raise ValueError
            hours = dict(state.raw.get("dg_hours", {}))
            for k, v in (body.get("hour_meter_offset") or {}).items():
                hours[str(k)] = max(0.0, float(v))
        except (TypeError, ValueError):
            raise HTTPException(400, "Use plain numbers")
        state.raw["dg_fuel"] = f
        state.raw["dg_hours"] = hours
        save_raw()
        insight_cache.clear()
        return {"fuel": f, "dg_hours": hours}

    # ---------- demo: grid power switch ----------
    @api.post("/api/demo/grid")
    async def demo_grid(body: dict, _=Depends(need_admin)):
        if not (state.collector and state.collector.plant):
            raise HTTPException(400, "The power cut switch is for the demo (simulated meters) only")
        state.collector.plant.set_grid(bool(body.get("on")))
        state.collector.wake()
        return {"grid_on": state.collector.plant.grid_on(), "cut_since": cut_since()}

    # ---------- live data and history ----------
    @api.get("/api/meters")
    async def meters(user=Depends(need_user)):
        ids = allowed_ids(user)
        ms = state.meter_list()
        if state.collector:
            for m in ms:
                if m.get("is_dg"):
                    t = state.collector.watch.dg_on.get(m["id"])
                    m["running_since"] = t if isinstance(t, (int, float)) else None
        return {"time": time.time(), "meters": ms if ids is None else [m for m in ms if m["id"] in ids]}

    @api.get("/api/history")
    async def history(meter: str, param: str = "kw", hours: float = 24, user=Depends(need_user)):
        if not can_see(user, meter):
            raise HTTPException(403, "Your account does not have access to this machine")
        if param not in PARAMS:
            raise HTTPException(400, f"unknown parameter {param}")
        end = int(time.time()) + 1
        start = end - int(hours * 3600)
        rows = state.db.history(meter, param, start, end)
        return {"meter": meter, "param": param, "points": [[r["t"], r["v"], r["lo"], r["hi"]] for r in rows]}

    @api.get("/api/events")
    async def events(hours: float = 72, user=Depends(need_page("alarms"))):
        ids = allowed_ids(user)
        rows = state.db.events(int(time.time() - hours * 3600), limit=500)
        return {"events": [dict(r) for r in rows if ids is None or r["meter_id"] in ids]}

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

    def _ids(meters: str | None, user: dict | None = None) -> list[str]:
        ids = state.meter_ids()
        ok = allowed_ids(user) if user else None
        if ok is not None:
            ids = [i for i in ids if i in ok]
        if meters:
            want = set(meters.split(","))
            ids = [i for i in ids if i in want]
        return ids

    @api.get("/api/reports/daily")
    async def report_daily(start: str | None = None, end: str | None = None, meters: str | None = None, user=Depends(need_user)):
        s, e = _parse_range(start, end)
        ids = _ids(meters, user)
        t0, t1 = day_range(s, e, state.tz)
        rows = state.db.readings(ids, t0, t1) if ids else []
        return {"start": s.isoformat(), "end": e.isoformat(), "block_minutes": state.config.demand_block_minutes,
                "rows": daily_report(rows, state.tz, state.config.demand_block_minutes)}

    @api.get("/api/export.csv")
    async def export_csv(start: str | None = None, end: str | None = None, meters: str | None = None,
                         kind: str = "readings", user=Depends(need_page("reports"))):
        s, e = _parse_range(start, end)
        ids = _ids(meters, user)
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
        if isinstance(body.get("panels"), list):
            state.db.set_kv(f"panels:{plant}", json.dumps([{k: str(p.get(k, ""))[:200] for k in ("id", "name", "voltage", "note")}
                                                           for p in body["panels"][:100] if isinstance(p, dict) and p.get("id")]))
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
        if raw.get("ai", {}).get("api_key"):
            raw["ai"]["api_key"] = "********"
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
        for k in ("tariff", "ai", "shifts", "dg_fuel", "dg_hours"):  # managed on their own pages
            if k in state.raw:
                raw[k] = state.raw[k]
            else:
                raw.pop(k, None)
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
