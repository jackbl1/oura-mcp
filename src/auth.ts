/**
 * Unprotected routes: the consent page at /authorize and Oura's redirect back
 * to /callback. Claude registers itself (DCR), the user approves here, signs
 * in to Oura, and the Oura tokens are stored encrypted in the grant's props.
 *
 * Only Oura accounts whose email is in ALLOWED_OURA_EMAILS may finish
 * connecting. An empty list lets nobody in.
 */

import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers
} from '@cloudflare/workers-oauth-provider'
import { MCP_SCOPE } from './mcp'
import {
  DEFAULT_OURA_SCOPES,
  OURA_AUTHORIZE_URL,
  exchangeOuraCode,
  fetchPersonalInfo,
  type OuraProps
} from './oura'

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers }

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const html = (body: string, headers = new Headers(), status = 200) => {
  headers.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oura MCP</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}
button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem;border-radius:.5rem;border:1px solid #888;cursor:pointer}
button[value=approve]{background:#111;color:#fff}.warn{background:#fff4d6;padding:.75rem;border-radius:.5rem}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button[value=approve]{background:#eee;color:#111}.warn{background:#4a3b00}}</style>
${body}`,
    { status, headers }
  )
}

function consentPage(details: ConsentDescription, handle: string, sandbox: boolean) {
  const name = escape(details.clientName)
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.'
  return `<h1>Allow ${name} to read your Oura data?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<p>${sandbox ? 'Local sandbox mode: no Oura sign-in, mock data only.' : 'Next you will sign in to Oura. Access is read-only: sleep, readiness, activity, heart rate and related data.'}</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button>
</form>`
}

/** Sandbox mode never applies off localhost, so a stray dev var can't open production. */
function sandboxEnabled(env: Env, url: URL) {
  return env.OURA_USE_SANDBOX === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
}

function allowedEmails(env: Env) {
  return (env.ALLOWED_OURA_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

async function showConsent(request: Request, env: AuthEnv, url: URL) {
  const oauth = env.OAUTH_PROVIDER
  const authRequest = await oauth.parseAuthRequest(request)
  const details = await oauth.describeConsent(authRequest) // first: a failed lookup leaves nothing in KV
  const consent = await oauth.beginConsent(authRequest)
  return html(consentPage(details, consent.handle, sandboxEnabled(env, url)), consent.headers)
}

async function handleDecision(request: Request, env: AuthEnv, url: URL) {
  const oauth = env.OAUTH_PROVIDER
  const form = await request.formData()
  const handle = String(form.get('handle'))
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle)
    return new Response(null, { status: 302, headers: denied.headers })
  }
  const approved = await oauth.approveConsent(request, handle, { scope: [MCP_SCOPE] })

  if (sandboxEnabled(env, url)) {
    const props: OuraProps = {
      accessToken: 'sandbox',
      refreshToken: 'sandbox',
      expiresAt: Date.now() + 86400_000,
      ouraUserId: 'sandbox',
      email: 'sandbox@localhost',
      sandbox: true
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: 'sandbox',
      metadata: { email: props.email },
      scope: [MCP_SCOPE],
      props
    })
    approved.headers.set('Location', redirectTo)
    return new Response(null, { status: 302, headers: approved.headers })
  }

  // Only now, after consent, start the Oura redirect.
  const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers })
  const ouraUrl = new URL(OURA_AUTHORIZE_URL)
  ouraUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.OURA_CLIENT_ID,
    redirect_uri: `${url.origin}/callback`,
    scope: env.OURA_SCOPES || DEFAULT_OURA_SCOPES,
    state
  }).toString()
  headers.set('Location', ouraUrl.toString())
  return new Response(null, { status: 302, headers })
}

async function handleCallback(request: Request, env: AuthEnv, url: URL) {
  const oauth = env.OAUTH_PROVIDER
  const { request: original, headers } = await oauth.finishUpstream(request)
  const deny = (description: string) => {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied', description))
    return new Response(null, { status: 302, headers })
  }

  const code = url.searchParams.get('code')
  if (url.searchParams.get('error') || !code) return deny('Oura sign-in was cancelled or failed')

  let tokens: Awaited<ReturnType<typeof exchangeOuraCode>>
  let me: Awaited<ReturnType<typeof fetchPersonalInfo>>
  try {
    tokens = await exchangeOuraCode(env, code, `${url.origin}/callback`)
    me = await fetchPersonalInfo(tokens.accessToken)
  } catch (error) {
    console.error('Oura sign-in failed', error instanceof Error ? error.message : error)
    return deny('Could not finish signing in to Oura')
  }
  if (!me.id || !allowedEmails(env).includes(me.email.toLowerCase())) {
    return deny('This Oura account is not allowed to use this server')
  }

  const props: OuraProps = { ...tokens, ouraUserId: me.id, email: me.email }
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: me.id,
    metadata: { email: me.email },
    scope: [MCP_SCOPE],
    props
  })
  headers.set('Location', redirectTo)
  return new Response(null, { status: 302, headers })
}

export const authHandler = {
  async fetch(request: Request, env: AuthEnv) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') return await showConsent(request, env, url)
      if (url.pathname === '/authorize' && request.method === 'POST') return await handleDecision(request, env, url)
      if (url.pathname === '/callback' && request.method === 'GET') return await handleCallback(request, env, url)
      if (url.pathname === '/') {
        return html('<h1>Oura MCP</h1><p>Add <code>' + escape(`${url.origin}/mcp`) + '</code> as a custom connector in Claude.</p>')
      }
      return new Response('Not found', { status: 404 })
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302)
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.'
        return html(`<h1>Sign-in failed</h1><p>${escape(message)}</p><p>Start connecting again from Claude.</p>`, undefined, 400)
      }
      throw error
    }
  }
}
