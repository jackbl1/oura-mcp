/**
 * Oura Ring MCP server for Cloudflare Workers.
 *
 * One Worker is both the OAuth authorization server Claude signs in to and
 * the MCP endpoint at /mcp. Claude's tokens are this Worker's; the Oura
 * tokens behind them live in each grant's encrypted props.
 */

import { OAuthProvider, type TokenExchangeCallbackOptions } from '@cloudflare/workers-oauth-provider'
import { authHandler } from './auth'
import { MCP_SCOPE, mcpApiHandler } from './mcp'
import { refreshOuraTokens, type OuraProps } from './oura'

// Refresh Oura when its token has less than this left, so Claude's next
// access token never outlives the Oura token it carries.
const OURA_REFRESH_MARGIN_MS = 10 * 60_000

/** Claude's access token lasts up to an hour, and ends 5 minutes before Oura's does. */
function accessTokenTTL(props: OuraProps) {
  const left = Math.floor((props.expiresAt - Date.now()) / 1000) - 300
  return Math.max(60, Math.min(3600, left))
}

async function tokenExchangeCallback({ grantType, props, env }: TokenExchangeCallbackOptions<Env>) {
  const current = props as OuraProps
  if (grantType === 'authorization_code') return { accessTokenTTL: accessTokenTTL(current) }
  if (grantType !== 'refresh_token') return
  if (current.sandbox || current.expiresAt - Date.now() > OURA_REFRESH_MARGIN_MS) {
    return { accessTokenTTL: current.sandbox ? 3600 : accessTokenTTL(current) }
  }
  // Single-use upstream refresh: the new pair is stored as the grant's props
  // in the same step that answers Claude.
  const newProps: OuraProps = { ...current, ...(await refreshOuraTokens(env, current.refreshToken)) }
  return { newProps, accessTokenTTL: accessTokenTTL(newProps) }
}

// resourceMetadata.resource must be this Worker's exact public /mcp URL, which
// is known only per request (workers.dev, a custom domain, or localhost).
const providers = new Map<string, OAuthProvider<Env>>()

function providerFor(origin: string) {
  let provider = providers.get(origin)
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApiHandler as never,
      defaultHandler: authHandler as never,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [MCP_SCOPE, 'offline_access'],
      requiredScopes: [MCP_SCOPE],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      // A connection lasts while it is used: each refresh extends it 30 days.
      refreshTokenTTL: 30 * 86400,
      refreshTokenIdleTTL: 30 * 86400,
      tokenExchangeCallback
    })
    providers.set(origin, provider)
  }
  return provider
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx)
  }
} satisfies ExportedHandler<Env>
