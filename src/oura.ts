/**
 * Minimal client for the Oura API v2, plus the OAuth calls this Worker makes
 * to Oura as an upstream provider.
 *
 * Oura refresh tokens are single-use: every refresh returns a NEW refresh
 * token and invalidates the old one. Tokens live in the grant's encrypted
 * props (see index.ts), and are refreshed only from tokenExchangeCallback,
 * which the OAuth provider runs once per Claude refresh.
 */

import { OAuthError } from '@cloudflare/workers-oauth-provider'

export const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize'
const DEFAULT_TOKEN_URL = 'https://api.ouraring.com/oauth/token'
const API_BASE = 'https://api.ouraring.com/v2/usercollection'
const SANDBOX_BASE = 'https://api.ouraring.com/v2/sandbox/usercollection'

export const DEFAULT_OURA_SCOPES =
  'email personal daily heartrate workout tag session spo2 heart_health'

/** What completeAuthorization() stores for a grant; tools read it as ctx.props. */
export type OuraProps = {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  ouraUserId: string
  email: string
  /** Local-dev only: tools read Oura's sandbox instead of a real account. */
  sandbox?: boolean
}

type QueryStyle = 'date' | 'datetime' | 'none'

// name -> [path, query style, description]
//   date     -> start_date / end_date (YYYY-MM-DD)
//   datetime -> start_datetime / end_datetime (ISO 8601)
//   none     -> no date filter
export const ENDPOINTS: Record<string, [string, QueryStyle, string]> = {
  personal_info: ['personal_info', 'none', 'Age, weight, height, biological sex, email'],
  daily_sleep: ['daily_sleep', 'date', 'Daily sleep score and contributors'],
  sleep: ['sleep', 'date', 'Detailed sleep periods: stages, HRV, HR, latency, efficiency'],
  sleep_time: ['sleep_time', 'date', 'Recommended bedtime windows'],
  daily_readiness: ['daily_readiness', 'date', 'Readiness score, temperature deviation, contributors'],
  daily_activity: ['daily_activity', 'date', 'Steps, calories, activity score, MET minutes'],
  daily_stress: ['daily_stress', 'date', 'Daytime stress and recovery minutes'],
  daily_resilience: ['daily_resilience', 'date', 'Resilience level and contributors'],
  daily_spo2: ['daily_spo2', 'date', 'Average blood oxygen during sleep, breathing disturbance index'],
  daily_cardiovascular_age: ['daily_cardiovascular_age', 'date', 'Estimated vascular age'],
  vo2_max: ['vO2_max', 'date', 'Estimated VO2 max'],
  heartrate: ['heartrate', 'datetime', 'Time-series heart rate (5-min intervals or finer)'],
  workout: ['workout', 'date', 'Workouts: type, duration, calories, intensity'],
  session: ['session', 'date', 'Guided/unguided breathing and meditation sessions'],
  enhanced_tag: ['enhanced_tag', 'date', 'User-entered tags (caffeine, alcohol, etc.)'],
  rest_mode_period: ['rest_mode_period', 'date', 'Rest mode periods'],
  ring_configuration: ['ring_configuration', 'none', 'Ring hardware, color, size, firmware']
}

export class OuraApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

// ---------- OAuth (upstream) ----------

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number }

function tokenUrl(env: Env): string {
  return env.OURA_TOKEN_URL || DEFAULT_TOKEN_URL
}

function toTokens(body: TokenResponse, previousRefreshToken = '') {
  return {
    accessToken: body.access_token,
    // Oura always rotates, but never drop a refresh token we still hold.
    refreshToken: body.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 86400) * 1000
  }
}

export async function exchangeOuraCode(env: Env, code: string, redirectUri: string) {
  const r = await fetch(tokenUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.OURA_CLIENT_ID,
      client_secret: env.OURA_CLIENT_SECRET
    })
  })
  if (!r.ok) throw new OuraApiError(r.status, `Oura token exchange failed (${r.status}): ${await r.text()}`)
  return toTokens(await r.json<TokenResponse>())
}

/**
 * Refresh the upstream Oura tokens. Throws OAuthError so the provider answers
 * Claude's refresh correctly: invalid_grant revokes this grant (Claude then
 * asks the user to reconnect); temporarily_unavailable keeps it for a retry.
 */
export async function refreshOuraTokens(env: Env, refreshToken: string) {
  let r: Response
  try {
    r = await fetch(tokenUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: env.OURA_CLIENT_ID,
        client_secret: env.OURA_CLIENT_SECRET
      })
    })
  } catch {
    throw new OAuthError('temporarily_unavailable', { description: 'Oura is unreachable', statusCode: 503 })
  }
  if (r.ok) return toTokens(await r.json<TokenResponse>(), refreshToken)
  if (r.status === 400 || r.status === 401) {
    throw new OAuthError('invalid_grant', { description: 'Oura access was revoked or expired; reconnect' })
  }
  throw new OAuthError('temporarily_unavailable', {
    description: `Oura token refresh failed (${r.status})`,
    statusCode: 503
  })
}

// ---------- data ----------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function ouraGet(props: OuraProps, path: string, params: Record<string, string>) {
  const base = props.sandbox ? SANDBOX_BASE : API_BASE
  const url = `${base}/${path}?${new URLSearchParams(params)}`
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${props.accessToken}` } })
    if (r.status === 429 && attempt < 2) {
      await sleep(Math.min(Number(r.headers.get('Retry-After')) || 5, 30) * 1000)
      continue
    }
    if (r.ok) return r.json<Record<string, unknown>>()
    if (r.status === 401) {
      throw new OuraApiError(401, 'Oura rejected the access token. Disconnect and reconnect the Oura connector.')
    }
    if (r.status === 403) {
      throw new OuraApiError(403, `403 on ${path}: missing OAuth scope for this data type, or Oura membership inactive.`)
    }
    if (r.status === 404) {
      throw new OuraApiError(404, `${path} is not available for this account.`)
    }
    throw new OuraApiError(r.status, `Oura API error ${r.status} on ${path}: ${(await r.text()).slice(0, 300)}`)
  }
}

export async function fetchPersonalInfo(accessToken: string) {
  const info = await ouraGet(
    { accessToken, refreshToken: '', expiresAt: 0, ouraUserId: '', email: '' },
    'personal_info',
    {}
  )
  return { id: String(info.id ?? ''), email: String(info.email ?? '') }
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return isoDate(d)
}

/** Fetch an endpoint, following next_token pagination. Dates are YYYY-MM-DD, inclusive. */
export async function fetchOura(props: OuraProps, endpoint: string, start?: string, end?: string): Promise<unknown> {
  const spec = ENDPOINTS[endpoint]
  if (!spec) throw new Error(`Unknown data type '${endpoint}'. Options: ${Object.keys(ENDPOINTS).join(', ')}`)
  const [path, style] = spec
  if (style === 'none') return ouraGet(props, path, {})

  const endDay = end ?? isoDate(new Date())
  const startDay = start ?? addDays(endDay, -7)
  // Oura's end bound is exclusive for some endpoints; +1 day makes `end` inclusive.
  let params: Record<string, string> =
    style === 'date'
      ? { start_date: startDay, end_date: addDays(endDay, 1) }
      : { start_datetime: `${startDay}T00:00:00Z`, end_datetime: `${addDays(endDay, 1)}T00:00:00Z` }

  const items: unknown[] = []
  for (;;) {
    const page = await ouraGet(props, path, params)
    items.push(...((page.data as unknown[]) ?? []))
    const next = page.next_token as string | undefined
    if (!next) return items
    params = { ...params, next_token: next }
  }
}
