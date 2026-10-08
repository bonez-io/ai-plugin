// Sign-in for bonez-plugin-push: the OAuth device flow (RFC 8628) as the public Bonez CLI app, and the saved
// sign-in. Node built-ins only (Node 18+).
//
// Two phases, because a coding agent's shell tool shows a command's output only when the command ends:
//   startLogin  asks the server's authorization server for a code, opens the browser, PRINTS the address and
//               the code, saves the pending flow and exits 4 straight away;
//   a later run finds the pending flow, polls the token endpoint for up to five minutes, saves the tokens and goes on.
//
// ~/.bonez/plugin-login.json (os.homedir(): %USERPROFILE%\.bonez\ on Windows), keyed by the server's origin:
//   { "<origin>": { client_id, token_endpoint, access_token, refresh_token, expires_at, scope, pending? } }
// pending = { device_code, expires_at, interval, user_code, url, scope } while a sign-in waits for the browser.
// Mode 0600 on POSIX; Windows has no such mode (see README): the file sits in your user profile.
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { clean, fail, hide, isSecure, redirected, send } from "./net.mjs"

// The public Bonez CLI application: an identifier, not a secret (RFC 8252 §8.5).
export const CLIENT_ID = "qFX0bzskdcDBhbJaBBwGoiLN5yWkBrMm"
export const SCOPE = "bonez:read bonez:write offline_access"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const SKEW_MS = 60_000 // refresh this long before the token runs out

// What the polling waits on. A field so the tests can drive the clock instead of sleeping.
export const clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  budgetMs: 5 * 60_000,
}

// ---- the saved sign-in ------------------------------------------------------------------------

export const loginFile = () => join(homedir(), ".bonez", "plugin-login.json")

// ponytail: an unreadable file reads as empty and the next save replaces it, other servers' sign-ins included.
function readStore() {
  try {
    const store = JSON.parse(readFileSync(loginFile(), "utf8"))
    return store && typeof store === "object" && !Array.isArray(store) ? store : {}
  } catch {
    return {}
  }
}

function load(origin) {
  const entry = readStore()[origin]
  if (entry === null || typeof entry !== "object") return undefined
  for (const value of [entry.access_token, entry.refresh_token, entry.pending?.device_code]) hide(value, "token")
  return entry
}

function save(origin, entry) {
  const store = readStore()
  if (entry) store[origin] = entry
  else delete store[origin]
  const file = loginFile()
  if (Object.keys(store).length === 0) return rmSync(file, { force: true })
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 })
  chmodSync(temp, 0o600) // the umask can only narrow the mode above; say it anyway
  renameSync(temp, file)
}

// Forget this server's sign-in. Returns whether there was one.
export function logout(origin) {
  const had = load(origin) !== undefined
  save(origin, undefined)
  return had
}

// ---- talking to the authorization server --------------------------------------------------------

async function getJson(url) {
  const { res, text } = await send(url, { method: "GET", headers: { accept: "application/json" } }, 30_000)
  if (redirected(res)) fail(3, `${url} redirected the request (HTTP ${res.status}); not following it`)
  if (res.status !== 200) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function form(url, fields) {
  const { res, text } = await send(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  }, 30_000)
  if (redirected(res)) fail(3, `${url} redirected the request (HTTP ${res.status}); not following it`)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: res.status, body, text }
}

const why = ({ status, body, text }) =>
  clean(body?.error ? `${body.error}${body.error_description ? `: ${body.error_description}` : ""}` : `HTTP ${status}: ${text.slice(0, 200).trim() || "(empty body)"}`)

// The server names its authorization server (RFC 9728), which names its two endpoints (RFC 8414, else OIDC).
// Nothing about either is held here, so a qa or a customer server needs no change.
async function discover(origin, mcpPath) {
  const prm = await getJson(`${origin}/.well-known/oauth-protected-resource${mcpPath}`)
  let issuer
  try {
    issuer = new URL(prm?.authorization_servers?.[0])
  } catch {
    fail(3, `${origin} does not say how to sign in (no protected-resource metadata, or no authorization server in it). Use BONEZ_API_KEY instead`)
  }
  if (typeof prm.resource !== "string") fail(3, `${origin}'s protected-resource metadata names no resource`)
  if (!isSecure(issuer)) fail(2, `the sign-in service ${issuer.origin} is not https; refusing to use it`)
  const dir = issuer.pathname.replace(/\/+$/, "")
  const meta = (await getJson(`${issuer.origin}/.well-known/oauth-authorization-server${dir}`)) ??
    (await getJson(`${issuer.origin}${dir}/.well-known/openid-configuration`))
  const device = meta?.device_authorization_endpoint
  const token = meta?.token_endpoint
  if (typeof device !== "string" || typeof token !== "string") fail(3, `${issuer.origin} does not offer sign-in from a command line (no device authorization endpoint)`)
  for (const endpoint of [device, token]) if (!isSecure(new URL(endpoint))) fail(2, `the sign-in endpoint ${endpoint} is not https; refusing to use it`)
  return { resource: prm.resource, device, token }
}

// Only a web address goes to the operating system's opener (rundll32 would start any scheme's handler), and
// never a failure: the address is printed anyway. BONEZ_NO_BROWSER=1 skips it (headless, tests).
function openBrowser(url) {
  if (process.env.BONEZ_NO_BROWSER || !/^https?:\/\//i.test(url)) return
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]]
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // the address is on stdout
  }
}

const shown = (pending) => {
  console.log(`sign in at: ${clean(pending.url)}`)
  console.log(`code: ${clean(pending.user_code)}`)
}

// Phase one. Never returns: it ends the run with exit 4 so the address and the code can be relayed.
export async function startLogin(origin, mcpPath, scope = SCOPE) {
  const clientId = process.env.BONEZ_CLIENT_ID?.trim() || CLIENT_ID
  const { resource, device, token } = await discover(origin, mcpPath)
  // `audience`, not RFC 8707 `resource`: Auth0's device-code endpoint is documented in terms of `audience`.
  const started = await form(device, { client_id: clientId, scope, audience: resource })
  if (started.status >= 500) fail(3, `the sign-in service failed: ${why(started)}`)
  const b = started.body
  const url = b?.verification_uri_complete || b?.verification_uri
  if (started.status !== 200 || typeof b?.device_code !== "string" || typeof b.user_code !== "string" || typeof url !== "string") {
    fail(started.status >= 400 ? 1 : 3, `the sign-in service refused to start a sign-in (${why(started)})`)
  }
  hide(b.device_code, "token")
  const pending = {
    device_code: b.device_code, user_code: b.user_code, url, scope,
    expires_at: clock.now() + (Number(b.expires_in) || 900) * 1000,
    interval: Number(b.interval) > 0 ? Number(b.interval) : 5,
  }
  save(origin, { client_id: clientId, token_endpoint: token, pending }) // older tokens are no use: they were refused
  openBrowser(url)
  shown(pending)
  fail(4, "waiting for you to approve the sign-in: open the address above (a browser tab was also opened if it could be) and check the code, then run this command again to finish")
}

// Phase two. Polls until approved, denied, expired or the five minutes are up (exit 4 in every case but success).
async function finishLogin(origin, entry) {
  const { pending } = entry
  const stop = Math.min(pending.expires_at, clock.now() + clock.budgetMs)
  let interval = pending.interval * 1000
  for (;;) {
    const r = await form(entry.token_endpoint, { grant_type: DEVICE_GRANT, device_code: pending.device_code, client_id: entry.client_id })
    if (r.status === 200 && typeof r.body?.access_token === "string") return store(origin, entry, r.body, pending.scope)
    const error = r.body?.error
    if (error === "access_denied" || error === "expired_token") {
      save(origin, { client_id: entry.client_id, token_endpoint: entry.token_endpoint })
      fail(4, error === "access_denied" ? "the sign-in was denied in the browser; run this command again to start over" : "the sign-in code expired before it was approved; run this command again to start over")
    }
    if (error === "slow_down") interval += 5000
    else if (error !== "authorization_pending") {
      save(origin, { client_id: entry.client_id, token_endpoint: entry.token_endpoint })
      fail(r.status >= 500 ? 3 : 1, `the sign-in failed (${why(r)}); run this command again to start over`)
    }
    if (clock.now() + interval >= stop) break
    await clock.sleep(interval)
  }
  shown(pending)
  fail(4, "still waiting for you to approve the sign-in: open the address above and check the code, then run this command again")
}

function store(origin, entry, body, scope) {
  hide(body.access_token, "token")
  hide(body.refresh_token, "token")
  const next = {
    client_id: entry.client_id, token_endpoint: entry.token_endpoint,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? entry.refresh_token, // Auth0 leaves it out when it does not rotate
    expires_at: clock.now() + (Number(body.expires_in) || 3600) * 1000,
    scope: body.scope ?? scope ?? entry.scope,
  }
  save(origin, next)
  return next
}

// A new access token from the refresh token, or undefined when the server will not give one (revoked, expired).
async function refresh(origin, entry) {
  if (!entry.refresh_token) return undefined
  const r = await form(entry.token_endpoint, { grant_type: "refresh_token", refresh_token: entry.refresh_token, client_id: entry.client_id })
  if (r.status === 200 && typeof r.body?.access_token === "string") return store(origin, entry, r.body)
  if (r.status >= 500) fail(3, `the sign-in service failed while refreshing: ${why(r)}`)
  return undefined
}

// The access token for this server. `renew` forces a refresh (the server just answered 401). Without a usable
// sign-in this ends the run with exit 4 (a code to approve, or one still waiting).
export async function accessToken(origin, mcpPath, { renew = false } = {}) {
  let entry = load(origin)
  if (entry?.pending) {
    if (entry.pending.expires_at > clock.now()) return (await finishLogin(origin, entry)).access_token // brand new: no refresh
    else {
      entry = { client_id: entry.client_id, token_endpoint: entry.token_endpoint }
      save(origin, entry)
    }
  }
  if (!entry?.access_token) return startLogin(origin, mcpPath)
  if (renew || entry.expires_at - clock.now() < SKEW_MS) {
    entry = await refresh(origin, entry)
    if (!entry) return startLogin(origin, mcpPath)
  }
  return entry.access_token
}
