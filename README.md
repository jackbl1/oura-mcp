# Oura MCP server

Read-only MCP server that gives Claude access to your Oura Ring data via the Oura API v2.

## Tools

| Tool | What it does |
|---|---|
| `get_daily_overview` | One row per day: sleep, readiness, activity, stress, resilience, SpO2, cardio age, VO2 max |
| `get_sleep_sessions` | Detailed sleep periods (stages, HR, HRV, latency, efficiency), incl. naps |
| `get_oura_data` | Any single data type; optional raw time series |
| `list_data_types` | Everything available |
| `export_all_data` | Dumps every data type to JSON files (default `~/oura-export`) |

Dates are `YYYY-MM-DD`, inclusive, defaulting to the last 7 days.

## Setup

**1. Install** (Python 3.10+)

    cd oura-mcp
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt

**2. Register an Oura app** at https://developer.ouraring.com/applications
- Redirect URI: `http://localhost:8080/callback` (exactly)
- The form asks for privacy policy / terms URLs; for a personal app any URL you control works.
- Copy the client ID and secret into `.env` (see `.env.example`).

**3. Authorize once**

    python authorize.py

Your browser opens, you approve, and tokens are saved to `~/.oura-mcp/tokens.json` (mode 600).
If the token exchange fails with 401 and your app is on the older portal, rerun with
`OURA_TOKEN_URL=https://api.ouraring.com/oauth/token python authorize.py`.

**4. Connect to Claude**

Claude Code:

    claude mcp add oura \
      -e OURA_CLIENT_ID=... -e OURA_CLIENT_SECRET=... \
      -- /full/path/to/oura-mcp/.venv/bin/python /full/path/to/oura-mcp/server.py

Claude Desktop: add to `claude_desktop_config.json`, then restart the app:

    {
      "mcpServers": {
        "oura": {
          "command": "/full/path/to/oura-mcp/.venv/bin/python",
          "args": ["/full/path/to/oura-mcp/server.py"],
          "env": { "OURA_CLIENT_ID": "...", "OURA_CLIENT_SECRET": "..." }
        }
      }
    }

## Notes

- **Refresh tokens are single-use.** Each refresh issues a new one and kills the old. The server
  writes the new pair atomically before using it. If you ever see "Token refresh failed", rerun
  `authorize.py`.
- **403 errors** mean a missing scope for that data type or an inactive Oura membership.
- Some types (VO2 max, cardiovascular age, resilience) depend on ring generation and features;
  missing ones are skipped in the overview.
- `OURA_USE_SANDBOX=true` points at Oura's sandbox for testing with mock data.
