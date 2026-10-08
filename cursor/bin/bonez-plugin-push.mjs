#!/usr/bin/env node
// bonez-plugin-push <folder> — uploads a built Bonez plugin (the out/<name>/ folder of the plugin
// creator) to your Bonez server in one command. The server vets it, stores it, and the org's
// computers pick it up on their next heartbeat.
// bonez-plugin-push --status [<package name>] — lists the plugins the server holds and, per computer,
// whether it has the active version yet (the server's GET /api/org/plugins; the same key reaches it).
//
//   BONEZ_URL       your server, e.g. https://bonez.example.com. A trailing /mcp (the MCP address) and
//                   slashes are dropped; a bare host gets https:// (http:// for localhost, 127.0.0.1, [::1]).
//   BONEZ_API_KEY   a bnz_ key with the "plugins" scope, minted in the console by an org admin
//   BONEZ_ALLOW_HTTP=1   only for a plain-http server on a private network (the key travels in clear)
//   NODE_EXTRA_CA_CERTS  Node's own variable: the CA file for a server with a self-signed or private-CA certificate
//
// It POSTs {files: {<path>: <base64>}, sha256} to $BONEZ_URL/api/admin/org/plugins with
// "Authorization: Bearer $BONEZ_API_KEY". The sha256 is the tree hash of bonez-package-hash.mjs,
// computed by the SAME code (lib/plugin-tree.mjs; the keys of `files` are its tree paths, with "/"
// on every OS, Windows included). The server recomputes it.
//
// Run it as `node bin/bonez-plugin-push.mjs <folder>`; the same on Windows (the shebang is POSIX only).
//
// stdout: the result (name, version, fingerprint, computers). stderr: everything else. The key is
// never printed. Exit codes:
//   0  uploaded (or listed)
//   1  the server refused it (prints the refusal code and detail as the server sent them); with
//      --status, also: the server holds no plugin of that name
//   2  nothing was sent: bad usage, missing or bad config, or a folder that cannot be uploaded
//   3  could not complete: server unreachable or erroring, a redirect, or an unreadable answer
// Node built-ins only (Node 18+).
import { lstatSync, readFileSync } from "node:fs"
import { FolderError, listFolder, sha256, treeHash } from "./lib/plugin-tree.mjs"

const ROUTE = "/api/admin/org/plugins"
const LIST_ROUTE = "/api/org/plugins"
const TIMEOUT_MS = 120_000
// Memory guard only, not policy: the server's own cap (a few MiB) is far lower and it states the
// real limit in its refusal, so this must not be tightened to mirror it.
const MAX_READ_BYTES = 64 * 1024 * 1024

function fail(code, message) {
  console.error(`bonez-plugin-push: ${message}`)
  process.exit(code)
}

// Server text goes to a terminal: drop control characters (escape sequences) but keep newlines, and
// never echo the key even if a server (or a proxy in front of it) reflects the request.
let secret = ""
const clean = (text) => {
  const shown = String(text).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "?")
  return secret ? shown.split(secret).join("[key]") : shown
}

// ---- the folder: same walk and tree hash as bonez-package-hash.mjs (lib/plugin-tree.mjs) -------

function readFolder(folder) {
  let files
  try {
    files = listFolder(folder)
  } catch (err) {
    if (err instanceof FolderError) fail(2, err.message)
    throw err
  }
  if (!files.some((f) => f.path === "package.json")) {
    fail(2, `${folder} has no package.json: pass the built folder (out/<name>/), not the project`)
  }
  let total = 0
  for (const f of files) total += lstatSync(f.abs).size
  if (total > MAX_READ_BYTES) fail(2, `${folder} is ${total} bytes: too large to be a built plugin`)
  const map = {}
  const entries = []
  try {
    for (const { path, abs } of files) {
      const bytes = readFileSync(abs)
      entries.push({ path, sha256: sha256(bytes) })
      map[path] = bytes.toString("base64")
    }
  } catch (err) {
    // A file another program holds open (Windows: EBUSY, EPERM) is "nothing was sent", not a stack trace.
    fail(2, `cannot read ${err.path ?? folder}: ${err.code ?? err.message}`)
  }
  return { map, fingerprint: treeHash(entries), count: files.length, total }
}

// ---- config -------------------------------------------------------------------------------------

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"]
// What node's TLS says when it does not know the server's certificate authority.
const UNTRUSTED_CERT = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED",
])
const WRONG_ADDRESS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])

function readConfig() {
  let raw = (process.env.BONEZ_URL ?? "").trim()
  const key = (process.env.BONEZ_API_KEY ?? "").trim()
  if (!raw) fail(2, "BONEZ_URL is not set (your Bonez server, e.g. https://bonez.example.com)")
  if (!key) fail(2, "BONEZ_API_KEY is not set (a bnz_ key with the plugins scope, minted by an org admin in the console)")
  if (!key.startsWith("bnz_")) fail(2, "BONEZ_API_KEY is not a bnz_ key")
  if (!HAS_SCHEME.test(raw)) {
    // A bare host such as `localhost:4000` or `bonez.example.com`. `new URL("localhost:4000")` would read
    // "localhost:" as a scheme, so a scheme is added first: http for this machine, https for everything else.
    let host
    try {
      host = new URL(`https://${raw}`).hostname
    } catch {
      fail(2, "BONEZ_URL is not a valid URL")
    }
    raw = `${LOOPBACK.includes(host) ? "http" : "https"}://${raw}`
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    fail(2, "BONEZ_URL is not a valid URL")
  }
  const loopback = LOOPBACK.includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || process.env.BONEZ_ALLOW_HTTP === "1"))) {
    fail(2, `BONEZ_URL must be https (the key would travel in clear); got ${url.protocol}//${url.host}. ` +
      "For a plain-http server on a private network, set BONEZ_ALLOW_HTTP=1")
  }
  if (url.username || url.password) fail(2, "BONEZ_URL must not carry a user name or password")
  // The MCP address (https://host/mcp) is the one people have to hand: the API lives beside it, not under it.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/i, "").replace(/\/+$/, "")
  return { base: `${url.origin}${path}`, origin: url.origin, key }
}

// POST/GET to `endpoint`; exits 3 with a message that names what was tried when nothing came back.
async function send(endpoint, init) {
  try {
    const res = await fetch(endpoint, {
      redirect: "manual", // never carry the key to another place
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
      headers: { authorization: `Bearer ${secret}`, accept: "application/json", ...init.headers },
    })
    return { res, text: await res.text() }
  } catch (err) {
    const code = err?.cause?.code ?? err?.code
    const why = err?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000}s` : (code ?? err?.message ?? "unknown error")
    let hint = ""
    if (WRONG_ADDRESS.has(code)) hint = ". That address did not answer: check BONEZ_URL"
    else if (UNTRUSTED_CERT.has(code)) {
      hint = ". The server's certificate is not signed by an authority Node trusts (a self-signed or private-CA certificate). " +
        "Point NODE_EXTRA_CA_CERTS at your CA's .pem file and run this again " +
        '(bash: export NODE_EXTRA_CA_CERTS=/path/ca.pem; PowerShell: $env:NODE_EXTRA_CA_CERTS = "C:\\path\\ca.pem"). ' +
        "Do not switch certificate checking off: the key would go to whoever answers"
    }
    fail(3, `cannot reach ${endpoint}: ${clean(why)}${hint}`)
  }
}

// ---- the answer ---------------------------------------------------------------------------------

// The server's refusal is {code, detail} (gateway) or {detail} (framework); show it as sent.
function describeRefusal(status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return `HTTP ${status}: ${clean(text.slice(0, 500)).trim() || "(empty body)"}`
  }
  const detail = body?.detail
  const shown = typeof detail === "string" ? detail : detail === undefined ? JSON.stringify(body) : JSON.stringify(detail)
  const code = typeof body?.code === "string" ? `${body.code}: ` : ""
  return `HTTP ${status}: ${clean(code + shown).slice(0, 2000)}`
}

const first = (obj, keys) => keys.map((k) => obj?.[k]).find((v) => v !== undefined && v !== null)

function report(answer, fingerprint) {
  const name = first(answer, ["name"]) ?? "(unnamed)"
  const version = first(answer, ["version"]) ?? "(no version)"
  const theirs = first(answer, ["sha256", "tree_sha256", "fingerprint"])
  if (theirs !== undefined && theirs !== fingerprint) {
    fail(3, `the server stored a different fingerprint (${clean(theirs)}) than the one sent (${fingerprint}); do not trust this upload`)
  }
  const reach = first(answer, ["computers", "computer_count", "rolling_out_to"]) ?? answer?.rollout?.computers
  const computers = Array.isArray(reach) ? reach.length : reach
  console.log(`pushed ${clean(name)} ${clean(version)}`)
  console.log(`fingerprint: ${fingerprint}`)
  console.log(typeof computers === "number" ? `rolling out to ${computers} ${computers === 1 ? "computer" : "computers"}` : "rolling out to: (the server did not say)")
}

// ---- --status: what the server holds, and who has it ----------------------------------------

// GET /api/org/plugins: {plugins: [{name, active, versions: [{version, sha256, active}], computers: [{name, state, error}]}]}.
// A computer's `state` is ready once it holds and has pinned the active version; until its next heartbeat it is
// not_delivered, and syncing / pending / failed are the runner's own words.
function listPlugins(answer, only) {
  const plugins = (Array.isArray(answer?.plugins) ? answer.plugins : []).filter((p) => only === undefined || p?.name === only)
  if (only !== undefined && plugins.length === 0) fail(1, `the server holds no plugin named ${clean(only)}`)
  if (plugins.length === 0) console.log("the server holds no plugins yet")
  for (const plugin of plugins) {
    const active = (Array.isArray(plugin.versions) ? plugin.versions : []).find((v) => v?.active)
    console.log(active ? `${clean(plugin.name)} ${clean(active.version)}  fingerprint ${clean(active.sha256)}` : `${clean(plugin.name)}  (no active version: retired)`)
    const computers = active && Array.isArray(plugin.computers) ? plugin.computers : []
    for (const c of computers) console.log(`  ${clean(c.name)}: ${clean(c.state)}${c.error ? ` (${clean(c.error)})` : ""}`)
    if (active) {
      const ready = computers.filter((c) => c.state === "ready").length
      console.log(computers.length === 0 ? "  no computers are enrolled: nothing takes this plugin yet" : `  ${ready} of ${computers.length} ready`)
    }
  }
}

// ---- main ---------------------------------------------------------------------------------------

const usage = "usage: bonez-plugin-push <folder>  |  bonez-plugin-push --status [<package name>]   (BONEZ_URL and BONEZ_API_KEY must be set)"
const statusMode = process.argv[2] === "--status"
const folder = process.argv[2]
if (!folder || process.argv.length > (statusMode ? 4 : 3)) fail(2, usage)

const config = readConfig()
secret = config.key

if (statusMode) {
  const { res, text } = await send(`${config.base}${LIST_ROUTE}`, { method: "GET" })
  if (res.status >= 300 && res.status < 400) fail(3, `${config.origin} redirected the request (HTTP ${res.status}); not following it with your key. Check BONEZ_URL`)
  if (res.status >= 500) fail(3, `the server failed: ${describeRefusal(res.status, text)}`)
  if (res.status >= 400) fail(1, `refused (${describeRefusal(res.status, text)})`)
  let answer
  try {
    answer = JSON.parse(text)
  } catch {
    fail(3, `HTTP ${res.status} but the answer is not JSON: ${clean(text.slice(0, 200))}`)
  }
  listPlugins(answer, process.argv[3])
  process.exit(0)
}

const endpoint = `${config.base}${ROUTE}`
const { map, fingerprint, count, total } = readFolder(folder)
console.error(`bonez-plugin-push: uploading ${count} files (${total} bytes), fingerprint ${fingerprint}, to ${config.origin}`)

const { res, text } = await send(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ files: map, sha256: fingerprint }),
})

if (res.status >= 300 && res.status < 400) {
  fail(3, `${config.origin} redirected the upload (HTTP ${res.status}); not following it with your key. Check BONEZ_URL`)
}
if (res.status >= 500) fail(3, `the server failed: ${describeRefusal(res.status, text)}`)
if (res.status >= 400) {
  const hint = res.status === 404
    ? `\nPOST ${endpoint} found nothing: this server may predate plugin upload (hand the plugin over by hand instead), or BONEZ_URL is not your server's address.`
    : ""
  fail(1, `refused (${describeRefusal(res.status, text)})${hint}`)
}
let answer
try {
  answer = JSON.parse(text)
} catch {
  fail(3, `HTTP ${res.status} but the answer is not JSON: ${clean(text.slice(0, 200))}`)
}
report(answer, fingerprint)
