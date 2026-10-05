/** MCP tools, served at /mcp behind the OAuth provider (ctx.props = OuraProps). */

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider'
import * as z from 'zod/v4'
import { ENDPOINTS, fetchOura, type OuraProps } from './oura'

export const MCP_SCOPE = 'oura:read'

// Fields holding dense per-interval samples. Dropped unless include_timeseries=true.
const TIMESERIES_KEYS = new Set([
  'heart_rate', 'hrv', 'movement_30_sec', 'sleep_phase_5_min', 'met', 'class_5_min', 'motion_count'
])

// Endpoints combined by get_daily_overview, keyed on each record's "day".
const OVERVIEW_ENDPOINTS = [
  'daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress',
  'daily_resilience', 'daily_spo2', 'daily_cardiovascular_age', 'vo2_max'
]

// claude.ai caps tool results at ~150k characters; stay under it with a clear message.
const MAX_RESULT_CHARS = 140_000

type Rec = Record<string, unknown>

function stripTimeseries(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripTimeseries)
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).filter(([k]) => !TIMESERIES_KEYS.has(k)).map(([k, v]) => [k, stripTimeseries(v)])
    )
  }
  return obj
}

/** Collapse raw heart rate samples into hourly min/avg/max per source. */
function hourlyHeartrate(samples: Rec[]) {
  const buckets = new Map<string, number[]>()
  for (const s of samples) {
    const key = `${String(s.timestamp).slice(0, 13)}:00|${s.source ?? '?'}`
    const list = buckets.get(key) ?? []
    list.push(Number(s.bpm))
    buckets.set(key, list)
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => {
    const [hour, source] = key.split('|')
    const avg = Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10
    return { hour, source, min: Math.min(...v), avg, max: Math.max(...v), n: v.length }
  })
}

function result(data: unknown) {
  const text = JSON.stringify(data, null, 1)
  if (text.length > MAX_RESULT_CHARS) {
    return errorResult(
      `Result is ${text.length.toLocaleString()} characters, over Claude's limit. ` +
        'Request a shorter date range, or leave include_timeseries / raw off.'
    )
  }
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

async function safely(run: () => Promise<unknown>) {
  try {
    return result(await run())
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e))
  }
}

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const range = {
  start_date: dateArg.optional().describe('First day, YYYY-MM-DD (inclusive). Default: 7 days before end_date.'),
  end_date: dateArg.optional().describe('Last day, YYYY-MM-DD (inclusive). Default: today (UTC).')
}
const readOnly = { readOnlyHint: true, openWorldHint: true }

function buildServer(props: OuraProps) {
  const server = new McpServer(
    { name: 'oura', version: '2.0.0' },
    {
      instructions:
        "Read-only access to the user's Oura Ring data. Dates are YYYY-MM-DD and inclusive. " +
        'Start with get_daily_overview for general questions; use get_oura_data for a specific ' +
        'data type. Call list_data_types to see everything available.'
    }
  )

  server.registerTool(
    'list_data_types',
    { description: 'List every Oura data type this server can fetch, with a short description.', annotations: readOnly },
    async () => result(Object.fromEntries(Object.entries(ENDPOINTS).map(([name, [, , desc]]) => [name, desc])))
  )

  server.registerTool(
    'get_oura_data',
    {
      description:
        'Fetch one Oura data type for a date range (defaults to the last 7 days). ' +
        'data_type is one of the names from list_data_types. ' +
        'Set include_timeseries=true for raw per-interval samples (HRV, HR, sleep phases); ' +
        'they are large, so only request them for short ranges. ' +
        'For heartrate, raw=false (default) returns hourly min/avg/max instead of every sample.',
      inputSchema: z.object({
        data_type: z.enum(Object.keys(ENDPOINTS) as [string, ...string[]]),
        ...range,
        include_timeseries: z.boolean().default(false),
        raw: z.boolean().default(false)
      }),
      annotations: readOnly
    },
    async ({ data_type, start_date, end_date, include_timeseries, raw }) =>
      safely(async () => {
        const data = await fetchOura(props, data_type, start_date, end_date)
        if (data_type === 'heartrate' && !raw) return hourlyHeartrate(data as Rec[])
        return include_timeseries ? data : stripTimeseries(data)
      })
  )

  server.registerTool(
    'get_daily_overview',
    {
      description:
        'One row per day combining sleep, readiness, activity, stress, resilience, SpO2, ' +
        'cardiovascular age and VO2 max scores. Best starting point for trends. Defaults to the last 7 days.',
      inputSchema: z.object(range),
      annotations: readOnly
    },
    async ({ start_date, end_date }) =>
      safely(async () => {
        const settled = await Promise.allSettled(
          OVERVIEW_ENDPOINTS.map((ep) => fetchOura(props, ep, start_date, end_date))
        )
        const days = new Map<string, Rec>()
        const unavailable: string[] = []
        settled.forEach((res, i) => {
          const ep = OVERVIEW_ENDPOINTS[i]
          if (res.status === 'rejected') {
            unavailable.push(ep) // e.g. no scope, or feature unavailable on this ring
            return
          }
          for (const rec of stripTimeseries(res.value) as Rec[]) {
            const day = rec.day as string | undefined
            if (!day) continue
            const { id: _id, day: _day, timestamp: _ts, ...rest } = rec
            days.set(day, { ...(days.get(day) ?? {}), [ep]: rest })
          }
        })
        if (unavailable.length === OVERVIEW_ENDPOINTS.length) {
          throw new Error((settled[0] as PromiseRejectedResult).reason?.message ?? 'All Oura requests failed')
        }
        const rows = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v }))
        return unavailable.length ? { days: rows, unavailable } : rows
      })
  )

  server.registerTool(
    'get_sleep_sessions',
    {
      description:
        'Detailed sleep sessions (bedtime, wake time, stage durations, avg HR, avg HRV, latency, ' +
        'efficiency). Includes naps. Defaults to the last 7 days.',
      inputSchema: z.object(range),
      annotations: readOnly
    },
    async ({ start_date, end_date }) =>
      safely(async () => stripTimeseries(await fetchOura(props, 'sleep', start_date, end_date)))
  )

  return server
}

export const mcpApiHandler = {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext & { props: OuraProps; auth: OAuthResourceAuth }) {
    if (!ctx.auth.scope.includes(MCP_SCOPE)) return insufficientScope(ctx.auth, [MCP_SCOPE])
    const handler = createMcpHandler(() => buildServer(ctx.props))
    return handler.fetch(request)
  }
}
