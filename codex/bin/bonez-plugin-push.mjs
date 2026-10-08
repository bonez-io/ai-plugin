#!/usr/bin/env node
// bonez-plugin-push <folder> — publishes a built Bonez plugin (the out/<name>/ folder of the plugin
// creator) to your Bonez server in one command. The server vets it, stores it, and the org's
// computers pick it up on their next heartbeat.
// bonez-plugin-push --status [<package name>] — lists the plugins the server holds and, per computer,
// whether it has the active version yet (the server's GET /api/org/plugins; needs BONEZ_API_KEY for now).
// bonez-plugin-push --login | --logout — signs in to the server in the browser / forgets that sign-in.
//
//   BONEZ_URL       your server, e.g. https://bonez.example.com (or --server <url>, which wins). A trailing /mcp
//                   (the MCP address) and slashes are dropped; a bare host gets https:// (http:// for localhost,
//                   127.0.0.1, [::1]).
//   BONEZ_API_KEY   optional: a bnz_ key with the "plugins" scope, minted in the console by an org admin, for CI
//                   and machines without a browser. Without it you sign in once, in the browser (below).
//   BONEZ_CLIENT_ID    the OAuth application to sign in as (default: the public Bonez CLI app)
//   BONEZ_NO_BROWSER=1 do not try to open the browser (the address and code are printed either way)
//   BONEZ_ALLOW_HTTP=1   only for a plain-http server on a private network (the key or sign-in travels in clear)
//   NODE_EXTRA_CA_CERTS  Node's own variable: the CA file for a server with a self-signed or private-CA certificate
//
// Credentials, in this order:
//   1. BONEZ_API_KEY: POSTs {files: {<path>: <base64>}, sha256} to $BONEZ_URL/api/admin/org/plugins with
//      "Authorization: Bearer $BONEZ_API_KEY".
//   2. A saved sign-in (~/.bonez/plugin-login.json; lib/signin.mjs): calls the server's MCP endpoint, the
//      `vendor_operation` tool with operation bonez.plugin.publish.v1 and the same {files, sha256} (lib/mcp.mjs).
//   3. Otherwise it signs you in, in two runs: the first prints an address and a code and exits 4 at once; once
//      you have approved in the browser, running the same command again finishes the sign-in and publishes.
// The sha256 is the tree hash of bonez-package-hash.mjs, computed by the SAME code (lib/plugin-tree.mjs; the keys
// of `files` are its tree paths, with "/" on every OS, Windows included). The server recomputes it.
//
// Run it as `node bin/bonez-plugin-push.mjs <folder>`; the same on Windows (the shebang is POSIX only).
//
// stdout: the result (name, version, fingerprint, computers), or the address and code of a sign-in. stderr:
// everything else. A key or a token is never printed. Exit codes:
//   0  published (or listed, signed in, signed out)
//   1  the server refused it (prints the refusal code and detail as the server sent them; for a signed-in
//      account that is not an admin, one line saying so); with --status, also: the server holds no plugin of that name
//   2  nothing was sent: bad usage, missing or bad config, or a folder that cannot be uploaded
//   3  could not complete: server unreachable or erroring, a redirect, or an unreadable answer
//   4  waiting for you to approve the sign-in in the browser (or it was denied or expired): run the command again
// Node built-ins only (Node 18+).
import { lstatSync, readFileSync } from "node:fs"
import { callTool, HttpRefusal } from "./lib/mcp.mjs"
import { CliError, clean, fail, hide, isSecure, LOOPBACK, redirected, send } from "./lib/net.mjs"
import { FolderError, listFolder, sha256, treeHash } from "./lib/plugin-tree.mjs"
import { accessToken, SCOPE, startLogin, logout } from "./lib/signin.mjs"

const ROUTE = "/api/admin/org/plugins"
const LIST_ROUTE = "/api/org/plugins"
const OPERATION = "bonez.plugin.publish.v1"
// Memory guard only, not policy: the server's own cap (a few MiB) is far lower and it states the
// real limit in its refusal, so this must not be tightened to mirror it.
const MAX_READ_BYTES = 64 * 1024 * 1024

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

function readServer(given) {
  let raw = (given ?? "").trim()
  if (!raw) fail(2, "BONEZ_URL is not set (your Bonez server, e.g. https://bonez.example.com; or pass --server <url>)")
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
  if (!isSecure(url)) {
    fail(2, `BONEZ_URL must be https (the key or sign-in would travel in clear); got ${url.protocol}//${url.host}. ` +
      "For a plain-http server on a private network, set BONEZ_ALLOW_HTTP=1")
  }
  if (url.username || url.password) fail(2, "BONEZ_URL must not carry a user name or password")
  // The MCP address (https://host/mcp) is the one people have to hand: the API lives beside it, not under it.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/i, "").replace(/\/+$/, "")
  return { base: `${url.origin}${path}`, origin: url.origin, mcpPath: `${path}/mcp` }
}

function readKey() {
  const key = (process.env.BONEZ_API_KEY ?? "").trim()
  if (!key) return ""
  if (!key.startsWith("bnz_")) fail(2, "BONEZ_API_KEY is not a bnz_ key")
  hide(key, "key")
  return key
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

async function status(server, key, only) {
  const { res, text } = await send(`${server.base}${LIST_ROUTE}`, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" } })
  if (redirected(res)) fail(3, `${server.origin} redirected the request (HTTP ${res.status}); not following it with your key. Check BONEZ_URL`)
  if (res.status >= 500) fail(3, `the server failed: ${describeRefusal(res.status, text)}`)
  if (res.status >= 400) fail(1, `refused (${describeRefusal(res.status, text)})`)
  let answer
  try {
    answer = JSON.parse(text)
  } catch {
    fail(3, `HTTP ${res.status} but the answer is not JSON: ${clean(text.slice(0, 200))}`)
  }
  listPlugins(answer, only)
}

// ---- publish with a key: the console's upload route ----------------------------------------------

async function pushWithKey(server, key, { map, fingerprint, count, total }) {
  const endpoint = `${server.base}${ROUTE}`
  console.error(`bonez-plugin-push: uploading ${count} files (${total} bytes), fingerprint ${fingerprint}, to ${server.origin}`)
  const { res, text } = await send(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ files: map, sha256: fingerprint }),
  })
  if (redirected(res)) {
    fail(3, `${server.origin} redirected the upload (HTTP ${res.status}); not following it with your key. Check BONEZ_URL`)
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
  return answer
}

// ---- publish when signed in: the server's MCP endpoint -------------------------------------------

// A refusal of the operation (code and detail as the server sent them), in the CLI's words.
function refuse(code, detail) {
  const text = String(detail ?? "")
  if (code === "forbidden" || /admin role required/i.test(text)) fail(1, "your account is not an admin of this Bonez server")
  const hint = code === "operation_not_found"
    ? "\nThis server does not publish plugins from the tool (it may predate it). With BONEZ_API_KEY set to a plugins-scope key this tool uploads through the console's route instead."
    : ""
  fail(1, `refused (${clean(`${code ? `${code}: ` : ""}${text}`).slice(0, 2000)})${hint}`)
}

// What the tool call answered: a tool-level error ("[bonez] <code>: <detail>"), a failed operation, or its output.
function outcome(result) {
  const text = (Array.isArray(result?.content) ? result.content : []).filter((c) => c?.type === "text").map((c) => String(c.text)).join("\n")
  if (result?.isError) {
    const m = /^\[bonez\] ([A-Za-z0-9_.-]+): ([\s\S]*)$/.exec(text)
    return refuse(m?.[1], m ? m[2] : text)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return fail(3, `the answer is not JSON: ${clean(text.slice(0, 200))}`)
  }
  if (body?.status === "failed") return refuse(body.code, body.detail)
  if (body?.status !== "succeeded") fail(3, `the server did not finish the publish (status ${clean(body?.status ?? "missing")}): ${clean(text.slice(0, 200))}`)
  return body.output
}

async function pushSignedIn(server, { map, fingerprint, count, total }) {
  const url = `${server.origin}${server.mcpPath}`
  let renew = false
  for (;;) {
    const token = await accessToken(server.origin, server.mcpPath, { renew }) // ends the run with exit 4 until you have signed in
    hide(token, "token")
    console.error(`bonez-plugin-push: publishing ${count} files (${total} bytes), fingerprint ${fingerprint}, to ${server.origin}`)
    try {
      return outcome(await callTool(url, token, "vendor_operation", { operation_id: OPERATION, input: { files: map, sha256: fingerprint } }))
    } catch (err) {
      if (!(err instanceof HttpRefusal)) throw err
      // 401: the token. Once more with a fresh one, then a new sign-in.
      if (err.status === 401 && !renew) {
        renew = true
        continue
      }
      if (err.status === 401) return startLogin(server.origin, server.mcpPath)
      // 403 with a scope challenge: the sign-in was granted less than the publish needs. Sign in again asking for it.
      const needed = /insufficient_scope/.test(err.challenge) ? /scope="([^"]*)"/.exec(err.challenge)?.[1] : undefined
      if (err.status === 403 && needed) return startLogin(server.origin, server.mcpPath, [...new Set([...SCOPE.split(" "), ...needed.split(" ")])].join(" "))
      if (err.status >= 500) fail(3, `the server failed: ${describeRefusal(err.status, err.text)}`)
      if (err.status === 403) {
        let body
        try {
          body = JSON.parse(err.text)
        } catch {
          body = undefined
        }
        return refuse(body?.code, typeof body?.detail === "string" ? body.detail : err.text.slice(0, 500))
      }
      const hint = err.status === 404 ? `\nPOST ${url} found nothing: BONEZ_URL may not be your server's address.` : ""
      return fail(1, `refused (${describeRefusal(err.status, err.text)})${hint}`)
    }
  }
}

// ---- main ---------------------------------------------------------------------------------------

const usage = "usage: bonez-plugin-push <folder>  |  bonez-plugin-push --status [<package name>]  |  bonez-plugin-push --login  |  bonez-plugin-push --logout   " +
  "(BONEZ_URL or --server <url> names your server; BONEZ_API_KEY is optional: without it you sign in once, in the browser)"

async function main() {
  const args = process.argv.slice(2)
  let given = process.env.BONEZ_URL
  const flag = args.indexOf("--server")
  if (flag !== -1) {
    if (flag + 1 >= args.length) fail(2, usage)
    given = args[flag + 1]
    args.splice(flag, 2)
  }
  const [head, ...rest] = args
  const mode = new Map([["--status", "status"], ["--login", "login"], ["--logout", "logout"]]).get(head) ?? "push"
  if (!head || rest.length > (mode === "status" ? 1 : 0)) fail(2, usage)

  const server = readServer(given)

  if (mode === "logout") {
    console.log(logout(server.origin) ? `signed out of ${server.origin}` : `not signed in to ${server.origin}`)
    return
  }
  if (mode === "login") {
    await accessToken(server.origin, server.mcpPath) // exit 4 until approved
    console.log(`signed in to ${server.origin}`)
    return
  }

  const key = readKey()
  if (mode === "status") {
    if (!key) {
      fail(2, "--status needs BONEZ_API_KEY for now (a plugins-scope key): a signed-in session cannot list plugins yet. " +
        "A publish prints how many computers the plugin rolls out to; the Library page of the console shows the rest")
    }
    return status(server, key, rest[0])
  }

  const folder = readFolder(head)
  const answer = key ? await pushWithKey(server, key, folder) : await pushSignedIn(server, folder)
  report(answer, folder.fingerprint)
}

try {
  await main()
} catch (err) {
  if (!(err instanceof CliError)) throw err
  console.error(`bonez-plugin-push: ${err.message}`)
  process.exitCode = err.code
}
