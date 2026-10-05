# Oura MCP server

Read-only remote MCP server that gives Claude access to your Oura Ring data via the Oura API v2.
It runs on Cloudflare Workers, so it works as a custom connector in claude.ai (web, desktop and
mobile) as well as Claude Code.

## How it works

One Worker is both an OAuth 2.1 authorization server and the MCP endpoint at `/mcp`:

1. You add `https://<your-worker>/mcp` as a custom connector in Claude.
2. Claude registers itself (Dynamic Client Registration, or a Client ID Metadata Document) and
   opens the consent page.
3. You approve, then sign in to Oura. The Worker exchanges Oura's code for tokens and checks your
   Oura email against `ALLOWED_OURA_EMAILS`. Anyone else is turned away.
4. The Oura tokens are stored encrypted in the grant (Workers KV, via
   [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)).
   When Claude refreshes its token, the Worker refreshes Oura's in the same step. Oura refresh
   tokens are single-use, and this keeps exactly one copy.

## Tools

| Tool | What it does |
|---|---|
| `get_daily_overview` | One row per day: sleep, readiness, activity, stress, resilience, SpO2, cardio age, VO2 max |
| `get_sleep_sessions` | Detailed sleep periods (stages, HR, HRV, latency, efficiency), incl. naps |
| `get_oura_data` | Any single data type; optional raw time series |
| `list_data_types` | Everything available |

Dates are `YYYY-MM-DD`, inclusive, defaulting to the last 7 days (UTC).

## Deploy

Requires Node 22+ and a Cloudflare account.

**1. Install and log in**

    npm install
    npx wrangler login

**2. Deploy once to get your URL**

    npm run deploy

Wrangler creates the `OAUTH_KV` namespace on the first deploy and prints your URL, e.g.
`https://oura-mcp.<account>.workers.dev`.

**3. Register an Oura app** at https://developer.ouraring.com/applications
- Redirect URI: `https://oura-mcp.<account>.workers.dev/callback` (exactly)
- Privacy policy / terms URL: link to `PRIVACY.md` in this repo.

**4. Set secrets**

    npx wrangler secret put OURA_CLIENT_ID
    npx wrangler secret put OURA_CLIENT_SECRET
    npx wrangler secret put ALLOWED_OURA_EMAILS   # your Oura account email; comma-separate several

**5. Connect Claude**
- claude.ai: Settings → Connectors → Add custom connector → URL `https://oura-mcp.<account>.workers.dev/mcp`.
  Leave the OAuth client fields empty.
- Claude Code: `claude mcp add --transport http oura https://oura-mcp.<account>.workers.dev/mcp`, then `/mcp` to sign in.

## Local development

    cp .dev.vars.example .dev.vars        # fill in, or set OURA_USE_SANDBOX=true
    npm run dev                           # http://localhost:8787
    npx @modelcontextprotocol/inspector   # connect to http://localhost:8787/mcp

With `OURA_USE_SANDBOX=true` the consent page skips Oura sign-in and the tools read Oura's mock
sandbox data. This mode is ignored on any host other than localhost. To test real Oura sign-in
locally, add `http://localhost:8787/callback` as a second redirect URI on your Oura app.

`npm run typecheck` type-checks; rerun `npm run cf-typegen` after changing `wrangler.jsonc`.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` | secret | Your Oura app |
| `ALLOWED_OURA_EMAILS` | secret | Oura accounts allowed to connect. Empty = nobody |
| `OURA_SCOPES` | var, optional | Space-separated Oura scopes. Default includes `heart_health` (VO2 max, cardiovascular age); drop it if Oura rejects the sign-in with an invalid scope |
| `OURA_TOKEN_URL` | var, optional | Default `https://api.ouraring.com/oauth/token` |
| `OURA_USE_SANDBOX` | `.dev.vars` only | `true` = mock data, no Oura sign-in (localhost only) |

## Notes

- **Reconnecting.** If Oura access is revoked, Claude's next refresh fails and Claude asks you to
  reconnect. An idle connection expires after 30 days.
- **403 errors** mean a missing scope for that data type or an inactive Oura membership.
- Some types (VO2 max, cardiovascular age, resilience) depend on ring generation and features;
  missing ones are listed under `unavailable` in the overview.
- Tool results over ~140k characters are refused with a hint to narrow the range (claude.ai's
  limit is ~150k).
