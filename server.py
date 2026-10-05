"""Oura Ring MCP server (MCP Python SDK 2.x, stdio transport)."""

from __future__ import annotations

import asyncio
import json
import os
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer

from oura_client import ENDPOINTS, OuraClient

mcp = MCPServer(
    name="oura",
    instructions=(
        "Read-only access to the user's Oura Ring data. Dates are YYYY-MM-DD and inclusive. "
        "Start with get_daily_overview for general questions; use get_oura_data for a specific "
        "data type. Call list_data_types to see everything available."
    ),
)
oura = OuraClient()

# Fields holding dense per-interval samples. Dropped unless include_timeseries=True.
TIMESERIES_KEYS = {"heart_rate", "hrv", "movement_30_sec", "sleep_phase_5_min", "met", "class_5_min", "motion_count"}

# Endpoints combined by get_daily_overview, keyed on each record's "day".
OVERVIEW_ENDPOINTS = [
    "daily_sleep", "daily_readiness", "daily_activity", "daily_stress",
    "daily_resilience", "daily_spo2", "daily_cardiovascular_age", "vo2_max",
]


def _strip_timeseries(obj: Any) -> Any:
    if isinstance(obj, list):
        return [_strip_timeseries(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _strip_timeseries(v) for k, v in obj.items() if k not in TIMESERIES_KEYS}
    return obj


def _hourly_heartrate(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse raw heart rate samples into hourly min/avg/max per source."""
    buckets: dict[tuple[str, str], list[int]] = defaultdict(list)
    for s in samples:
        hour = s["timestamp"][:13] + ":00"
        buckets[(hour, s.get("source", "?"))].append(s["bpm"])
    return [
        {"hour": h, "source": src, "min": min(v), "avg": round(sum(v) / len(v), 1), "max": max(v), "n": len(v)}
        for (h, src), v in sorted(buckets.items())
    ]


@mcp.tool(description="List every Oura data type this server can fetch, with a short description.")
async def list_data_types() -> dict[str, str]:
    return {name: desc for name, (_, _, desc) in ENDPOINTS.items()}


@mcp.tool(
    description=(
        "Fetch one Oura data type for a date range (defaults to the last 7 days). "
        "data_type is one of the names from list_data_types. "
        "Set include_timeseries=true for raw per-interval samples (HRV, HR, sleep phases); "
        "they are large, so only request them for short ranges. "
        "For heartrate, raw=false (default) returns hourly min/avg/max instead of every sample."
    )
)
async def get_oura_data(
    data_type: str,
    start_date: str | None = None,
    end_date: str | None = None,
    include_timeseries: bool = False,
    raw: bool = False,
) -> Any:
    data = await oura.fetch(data_type, start_date, end_date)
    if data_type == "heartrate" and not raw:
        return _hourly_heartrate(data)
    return data if include_timeseries else _strip_timeseries(data)


@mcp.tool(
    description=(
        "One row per day combining sleep, readiness, activity, stress, resilience, SpO2, "
        "cardiovascular age and VO2 max scores. Best starting point for trends. "
        "Defaults to the last 7 days."
    )
)
async def get_daily_overview(start_date: str | None = None, end_date: str | None = None) -> list[dict[str, Any]]:
    results = await asyncio.gather(
        *(oura.fetch(ep, start_date, end_date) for ep in OVERVIEW_ENDPOINTS), return_exceptions=True
    )
    days: dict[str, dict[str, Any]] = defaultdict(dict)
    for ep, res in zip(OVERVIEW_ENDPOINTS, results):
        if isinstance(res, Exception):
            continue  # e.g. no scope or feature unavailable on this ring
        for rec in _strip_timeseries(res):
            day = rec.get("day")
            if day:
                rec = {k: v for k, v in rec.items() if k not in ("id", "day", "timestamp")}
                days[day][ep] = rec
    return [{"day": d, **v} for d, v in sorted(days.items())]


@mcp.tool(
    description=(
        "Detailed sleep sessions (bedtime, wake time, stage durations, avg HR, avg HRV, latency, "
        "efficiency). Includes naps. Defaults to the last 7 days."
    )
)
async def get_sleep_sessions(start_date: str | None = None, end_date: str | None = None) -> list[dict[str, Any]]:
    return _strip_timeseries(await oura.fetch("sleep", start_date, end_date))


@mcp.tool(
    description=(
        "Export ALL available Oura data types for a date range to JSON files on disk "
        "(full detail, including time series). Returns file paths and record counts. "
        "Use for bulk ingestion or backups, not for answering questions."
    )
)
async def export_all_data(start_date: str, end_date: str | None = None, directory: str | None = None) -> dict[str, Any]:
    out = Path(directory or os.environ.get("OURA_EXPORT_DIR", Path.home() / "oura-export")).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    end_date = end_date or date.today().isoformat()
    summary: dict[str, Any] = {}
    for ep in ENDPOINTS:
        try:
            data = await oura.fetch(ep, start_date, end_date)
            path = out / f"{ep}_{start_date}_{end_date}.json"
            path.write_text(json.dumps(data, indent=2))
            summary[ep] = {"file": str(path), "records": len(data) if isinstance(data, list) else 1}
        except Exception as e:  # keep going; some types may be unavailable for this ring/scope
            summary[ep] = {"error": str(e)}
    return summary


if __name__ == "__main__":
    mcp.run()  # stdio
