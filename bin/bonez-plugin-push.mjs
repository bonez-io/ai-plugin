#!/usr/bin/env node
// bonez-plugin-push <folder> — uploads a built Bonez plugin (the out/<name>/ folder of the plugin
// creator) to your Bonez server in one command. The server vets it, stores it, and the org's
// computers pick it up on their next heartbeat.
//
//   BONEZ_URL       your server, e.g. https://bonez.example.com (no trailing path)
//   BONEZ_API_KEY   a bnz_ key with the "plugins" scope, minted in the console by an org admin
//   BONEZ_ALLOW_HTTP=1   only for a plain-http server on a private network (the key travels in clear)
//
// It POSTs {files: {<path>: <base64>}, sha256} to $BONEZ_URL/api/admin/org/plugins with
// "Authorization: Bearer $BONEZ_API_KEY". The sha256 is the tree hash of bonez-package-hash.mjs,
// computed here by the SAME algorithm (copied below: that script exits the process, so it cannot be
// imported; tests/plugin_push.test.mjs pins the two against each other). The server recomputes it.
//
// stdout: the result (name, version, fingerprint, computers). stderr: everything else. The key is
// never printed. Exit codes:
//   0  uploaded
//   1  the server refused it (prints the refusal code and detail as the server sent them)
//   2  nothing was sent: bad usage, missing or bad config, or a folder that cannot be uploaded
//   3  could not complete: server unreachable or erroring, a redirect, or an unreadable answer
// Node built-ins only (Node 18+).
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROUTE = "/api/admin/org/plugins"
const TIMEOUT_MS = 120_000
// Memory guard only, not policy: the server's own cap (a few MiB) is far lower and it states the
// real limit in its refusal, so this must not be tightened to mirror it.
const MAX_READ_BYTES = 64 * 1024 * 1024

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

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

// ---- the folder: same walk and tree hash as bonez-package-hash.mjs ------------------------------

function collect(root) {
  const files = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) fail(2, `symlink not allowed: ${relPath}`)
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue
        if (entry.name === "node_modules") fail(2, `node_modules/ not allowed (bundle the dependencies instead): ${relPath}`)
        walk(join(dir, entry.name), relPath)
      } else if (entry.isFile()) {
        files.push({ rel: relPath, abs: join(dir, entry.name) })
      }
    }
  }
  walk(root, "")
  return files
}

function readFolder(folder) {
  let stat
  try {
    stat = lstatSync(folder)
  } catch (err) {
    fail(2, `cannot read ${folder}: ${err.code ?? err.message}`)
  }
  if (stat.isSymbolicLink()) fail(2, `symlink not allowed: ${folder}`)
  if (!stat.isDirectory()) fail(2, `not a directory: ${folder}`)
  const files = collect(folder)
  // Buffer.compare is UTF-8 byte order, as in the hash script.
  files.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)))
  if (!files.some((f) => f.rel === "package.json")) {
    fail(2, `${folder} has no package.json: pass the built folder (out/<name>/), not the project`)
  }
  let total = 0
  for (const f of files) total += lstatSync(f.abs).size
  if (total > MAX_READ_BYTES) fail(2, `${folder} is ${total} bytes: too large to be a built plugin`)
  const tree = createHash("sha256")
  const map = {}
  for (const { rel, abs } of files) {
    const bytes = readFileSync(abs)
    tree.update(`${rel}\0${sha256(bytes)}\n`)
    map[rel] = bytes.toString("base64")
  }
  return { map, fingerprint: tree.digest("hex"), count: files.length, total }
}

// ---- config -------------------------------------------------------------------------------------

function readConfig() {
  const raw = (process.env.BONEZ_URL ?? "").trim()
  const key = (process.env.BONEZ_API_KEY ?? "").trim()
  if (!raw) fail(2, "BONEZ_URL is not set (your Bonez server, e.g. https://bonez.example.com)")
  if (!key) fail(2, "BONEZ_API_KEY is not set (a bnz_ key with the plugins scope, minted by an org admin in the console)")
  if (!key.startsWith("bnz_")) fail(2, "BONEZ_API_KEY is not a bnz_ key")
  let url
  try {
    url = new URL(raw)
  } catch {
    fail(2, "BONEZ_URL is not a valid URL")
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || process.env.BONEZ_ALLOW_HTTP === "1"))) {
    fail(2, `BONEZ_URL must be https (the key would travel in clear); got ${url.protocol}//${url.host}. ` +
      "For a plain-http server on a private network, set BONEZ_ALLOW_HTTP=1")
  }
  if (url.username || url.password) fail(2, "BONEZ_URL must not carry a user name or password")
  return { endpoint: `${url.origin}${url.pathname.replace(/\/+$/, "")}${ROUTE}`, origin: url.origin, key }
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

// ---- main ---------------------------------------------------------------------------------------

const folder = process.argv[2]
if (!folder || process.argv.length > 3) fail(2, "usage: bonez-plugin-push <folder>   (BONEZ_URL and BONEZ_API_KEY must be set)")

const config = readConfig()
secret = config.key
const { map, fingerprint, count, total } = readFolder(folder)
console.error(`bonez-plugin-push: uploading ${count} files (${total} bytes), fingerprint ${fingerprint}, to ${config.origin}`)

let res
let text
try {
  res = await fetch(config.endpoint, {
    method: "POST",
    redirect: "manual", // never carry the key to another place
    headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ files: map, sha256: fingerprint }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  text = await res.text()
} catch (err) {
  const why = err?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000}s` : (err?.cause?.code ?? err?.message ?? "unknown error")
  fail(3, `cannot reach ${config.origin}: ${clean(why)}`)
}

if (res.status >= 300 && res.status < 400) {
  fail(3, `${config.origin} redirected the upload (HTTP ${res.status}); not following it with your key. Check BONEZ_URL`)
}
if (res.status >= 500) fail(3, `the server failed: ${describeRefusal(res.status, text)}`)
if (res.status >= 400) {
  const hint = res.status === 404 ? "\nThis server may predate plugin upload; hand the plugin over by hand instead." : ""
  fail(1, `refused (${describeRefusal(res.status, text)})${hint}`)
}
let answer
try {
  answer = JSON.parse(text)
} catch {
  fail(3, `HTTP ${res.status} but the answer is not JSON: ${clean(text.slice(0, 200))}`)
}
report(answer, fingerprint)
