"""Minimal async client for the Oura API v2 with OAuth2 token management.

Oura refresh tokens are single-use: every refresh returns a NEW refresh token
and invalidates the old one. This client persists the new pair atomically
before using it, and serializes refreshes with a lock so concurrent tool calls
can't burn the same token twice.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

API_BASE = "https://api.ouraring.com/v2/usercollection"
SANDBOX_BASE = "https://api.ouraring.com/v2/sandbox/usercollection"

# Apps registered on the newer developer portal use the moi.* endpoint; older
# apps use api.* . Refresh tries both. Override with OURA_TOKEN_URL if needed.
TOKEN_URLS = [
    os.environ.get("OURA_TOKEN_URL", "https://moi.ouraring.com/oauth/v2/ext/oauth-token"),
    "https://api.ouraring.com/oauth/token",
]

TOKEN_FILE = Path(os.environ.get("OURA_TOKEN_FILE", Path.home() / ".oura-mcp" / "tokens.json"))

# endpoint name -> (path, query style, description)
#   "date"     -> start_date / end_date (YYYY-MM-DD)
#   "datetime" -> start_datetime / end_datetime (ISO 8601)
#   "none"     -> no date filter
ENDPOINTS: dict[str, tuple[str, str, str]] = {
    "personal_info": ("personal_info", "none", "Age, weight, height, biological sex, email"),
    "daily_sleep": ("daily_sleep", "date", "Daily sleep score and contributors"),
    "sleep": ("sleep", "date", "Detailed sleep periods: stages, HRV, HR, latency, efficiency"),
    "sleep_time": ("sleep_time", "date", "Recommended bedtime windows"),
    "daily_readiness": ("daily_readiness", "date", "Readiness score, temperature deviation, contributors"),
    "daily_activity": ("daily_activity", "date", "Steps, calories, activity score, MET minutes"),
    "daily_stress": ("daily_stress", "date", "Daytime stress and recovery minutes"),
    "daily_resilience": ("daily_resilience", "date", "Resilience level and contributors"),
    "daily_spo2": ("daily_spo2", "date", "Average blood oxygen during sleep, breathing disturbance index"),
    "daily_cardiovascular_age": ("daily_cardiovascular_age", "date", "Estimated vascular age"),
    "vo2_max": ("vO2_max", "date", "Estimated VO2 max"),
    "heartrate": ("heartrate", "datetime", "Time-series heart rate (5-min intervals or finer)"),
    "workout": ("workout", "date", "Workouts: type, duration, calories, intensity"),
    "session": ("session", "date", "Guided/unguided breathing and meditation sessions"),
    "enhanced_tag": ("enhanced_tag", "date", "User-entered tags (caffeine, alcohol, etc.)"),
    "rest_mode_period": ("rest_mode_period", "date", "Rest mode periods"),
    "ring_configuration": ("ring_configuration", "none", "Ring hardware, color, size, firmware"),
}


class OuraAuthError(RuntimeError):
    pass


def _write_tokens_atomic(tokens: dict[str, Any]) -> None:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=TOKEN_FILE.parent, prefix=".tokens-")
    with os.fdopen(fd, "w") as f:
        json.dump(tokens, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, TOKEN_FILE)  # atomic: a crash can't truncate the only copy


def load_tokens() -> dict[str, Any]:
    if not TOKEN_FILE.exists():
        raise OuraAuthError(
            f"No tokens at {TOKEN_FILE}. Run `python authorize.py` once to connect your Oura account."
        )
    return json.loads(TOKEN_FILE.read_text())


def save_token_response(resp: dict[str, Any]) -> dict[str, Any]:
    tokens = {
        "access_token": resp["access_token"],
        "refresh_token": resp.get("refresh_token"),
        # refresh a minute early to avoid edge-of-expiry failures
        "expires_at": time.time() + int(resp.get("expires_in", 86400)) - 60,
    }
    _write_tokens_atomic(tokens)
    return tokens


class OuraClient:
    def __init__(self) -> None:
        self.client_id = os.environ.get("OURA_CLIENT_ID", "")
        self.client_secret = os.environ.get("OURA_CLIENT_SECRET", "")
        self.sandbox = os.environ.get("OURA_USE_SANDBOX", "").lower() in ("1", "true", "yes")
        self.base = SANDBOX_BASE if self.sandbox else API_BASE
        self._http = httpx.AsyncClient(timeout=30)
        self._refresh_lock = asyncio.Lock()
        self._tokens: dict[str, Any] | None = None

    # ---------- auth ----------

    async def _access_token(self, force_refresh: bool = False) -> str:
        if self.sandbox:
            return "sandbox"
        if self._tokens is None:
            self._tokens = load_tokens()
        if force_refresh or time.time() >= self._tokens.get("expires_at", 0):
            await self._refresh()
        return self._tokens["access_token"]

    async def _refresh(self) -> None:
        async with self._refresh_lock:
            # Re-read: another process may have already rotated the token.
            disk = load_tokens()
            if disk.get("expires_at", 0) > time.time() and disk["access_token"] != (self._tokens or {}).get("access_token"):
                self._tokens = disk
                return
            refresh_token = disk.get("refresh_token")
            if not refresh_token:
                raise OuraAuthError("No refresh token stored. Re-run `python authorize.py`.")
            if not (self.client_id and self.client_secret):
                raise OuraAuthError("OURA_CLIENT_ID / OURA_CLIENT_SECRET must be set to refresh tokens.")

            last_err = ""
            for url in TOKEN_URLS:
                r = await self._http.post(
                    url,
                    data={
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token,
                        "client_id": self.client_id,
                        "client_secret": self.client_secret,
                    },
                )
                if r.status_code == 200:
                    self._tokens = save_token_response(r.json())
                    return
                last_err = f"{url} -> {r.status_code}"
            raise OuraAuthError(
                f"Token refresh failed ({last_err}). The refresh token may have been used or revoked; "
                "re-run `python authorize.py`."
            )

    # ---------- data ----------

    async def _get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        url = f"{self.base}/{path}"
        for attempt in range(3):
            token = await self._access_token(force_refresh=(attempt == 1))
            r = await self._http.get(url, params=params, headers={"Authorization": f"Bearer {token}"})
            if r.status_code == 401 and attempt == 0:
                continue  # expired early -> refresh and retry once
            if r.status_code == 429:
                await asyncio.sleep(min(int(r.headers.get("Retry-After", "5")), 30))
                continue
            if r.status_code == 403:
                raise PermissionError(
                    f"403 on {path}: missing OAuth scope for this data type, or Oura membership inactive."
                )
            r.raise_for_status()
            return r.json()
        r.raise_for_status()
        return r.json()

    async def fetch(
        self,
        endpoint: str,
        start: str | None = None,
        end: str | None = None,
    ) -> Any:
        """Fetch an endpoint, following next_token pagination. Dates are YYYY-MM-DD."""
        if endpoint not in ENDPOINTS:
            raise ValueError(f"Unknown endpoint '{endpoint}'. Options: {', '.join(ENDPOINTS)}")
        path, style, _ = ENDPOINTS[endpoint]

        if style == "none":
            return await self._get(path, {})

        today = date.today()
        start_d = date.fromisoformat(start) if start else today - timedelta(days=7)
        # Oura's end_date is exclusive-ish for some endpoints; +1 day makes "end" inclusive.
        end_d = date.fromisoformat(end) if end else today
        params: dict[str, str]
        if style == "date":
            params = {"start_date": start_d.isoformat(), "end_date": (end_d + timedelta(days=1)).isoformat()}
        else:
            s = datetime.combine(start_d, datetime.min.time(), tzinfo=timezone.utc)
            e = datetime.combine(end_d + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
            params = {"start_datetime": s.isoformat(), "end_datetime": e.isoformat()}

        items: list[Any] = []
        while True:
            page = await self._get(path, params)
            items.extend(page.get("data", []))
            nxt = page.get("next_token")
            if not nxt:
                break
            params = {**params, "next_token": nxt}
        return items

    async def aclose(self) -> None:
        await self._http.aclose()
