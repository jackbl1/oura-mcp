"""Run once to connect your Oura account. Saves tokens to ~/.oura-mcp/tokens.json.

Requires OURA_CLIENT_ID and OURA_CLIENT_SECRET (env vars or a .env file in this folder).
Your Oura app's redirect URI must be exactly http://localhost:8080/callback
"""

from __future__ import annotations

import os
import secrets
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx

# Tiny .env loader so you don't need python-dotenv
env_file = Path(__file__).with_name(".env")
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

from oura_client import TOKEN_FILE, TOKEN_URLS, save_token_response  # noqa: E402

AUTH_URL = "https://cloud.ouraring.com/oauth/authorize"
REDIRECT_URI = "http://localhost:8080/callback"
SCOPES = "email personal daily heartrate workout tag session spo2 heart_health"

client_id = os.environ.get("OURA_CLIENT_ID")
client_secret = os.environ.get("OURA_CLIENT_SECRET")
if not (client_id and client_secret):
    sys.exit("Set OURA_CLIENT_ID and OURA_CLIENT_SECRET first (env vars or .env).")

state = secrets.token_urlsafe(16)
result: dict[str, str] = {}
done = threading.Event()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if q.get("state", [""])[0] != state:
            result["error"] = "state mismatch"
        elif "error" in q:
            result["error"] = q["error"][0]
        else:
            result["code"] = q.get("code", [""])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        msg = "Connected! You can close this tab." if "code" in result else f"Failed: {result.get('error')}"
        self.wfile.write(f"<h2>{msg}</h2>".encode())
        done.set()

    def log_message(self, *args):
        pass


server = HTTPServer(("localhost", 8080), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

url = AUTH_URL + "?" + urllib.parse.urlencode(
    {"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT_URI, "scope": SCOPES, "state": state}
)
print(f"Opening browser to authorize...\nIf it doesn't open, visit:\n{url}\n")
webbrowser.open(url)
done.wait(timeout=300)
server.shutdown()

if "code" not in result:
    sys.exit(f"Authorization failed: {result.get('error', 'timed out')}")

# Authorization codes are single-use, and a rejected attempt can burn the code,
# so we only try the first token URL here. Set OURA_TOKEN_URL to switch.
r = httpx.post(
    TOKEN_URLS[0],
    data={
        "grant_type": "authorization_code",
        "code": result["code"],
        "redirect_uri": REDIRECT_URI,
        "client_id": client_id,
        "client_secret": client_secret,
    },
    timeout=30,
)
if r.status_code != 200:
    sys.exit(
        f"Token exchange failed ({r.status_code}): {r.text}\n"
        f"If your app was registered on the older portal, retry with:\n"
        f"  OURA_TOKEN_URL={TOKEN_URLS[1]} python authorize.py"
    )

save_token_response(r.json())
print(f"Success. Tokens saved to {TOKEN_FILE}")
