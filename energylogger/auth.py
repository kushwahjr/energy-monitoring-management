"""Password hashing and signed login tokens (no extra packages needed)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

ITERATIONS = 200_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt, digest = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2":
        return False
    test = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iters))
    return hmac.compare_digest(test.hex(), digest)


def make_token(secret: str, username: str, role: str, hours: float = 12) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"u": username, "r": role, "exp": time.time() + hours * 3600}).encode()).decode()
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def read_token(secret: str, token: str) -> dict | None:
    try:
        payload, sig = token.rsplit(".", 1)
    except ValueError:
        return None
    good = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(good, sig):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload.encode()))
    except Exception:
        return None
    if data.get("exp", 0) < time.time():
        return None
    return data
