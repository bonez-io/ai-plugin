// A stand-in for the gateway's plugin routes (POST /api/admin/org/plugins and GET /api/org/plugins), for the
// push CLI's tests and for tests/lib/push-smoke.mjs. It binds 127.0.0.1 only and makes no other network call.
//
// `vetUpload` is a line-for-line port of `vet()` and `_check_path()` in bonez-core's
// services/gateway/src/bonez_gateway/computers/plugins.py, with the same order of checks, the same limits
// and the same refusal codes and wording, so a package that passes the CLI's tests here cannot be refused by
// the real server for a rule this file does not know. Port a change to plugins.py here in the same pull
// request; tests/fake_plugin_server.test.mjs holds the cases of the real server's own test-suite
// (services/gateway/tests/computers/test_plugins.py).
//
// The tree-hash recomputation is deliberately a second, independent implementation: it does not import
// bin/lib/plugin-tree.mjs.
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { posix } from "node:path"

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")

// plugins.py: MAX_BYTES, MAX_FILES, MAX_NAME_LEN, MAX_PATH_LEN, NAME, PATH, DIST_EXTENSIONS, ENTRY_EXTENSIONS.
export const LIMITS = { MAX_BYTES: 8 * 1024 * 1024, MAX_FILES: 32, MAX_NAMES: 50, MAX_VERSIONS: 5, MAX_NAME_LEN: 128, MAX_PATH_LEN: 200 }
const NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PATH = /^[A-Za-z0-9._/-]+$/
export const DIST_EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".map", ".txt", ".md"]
const ENTRY_EXTENSIONS = [".js", ".mjs", ".cjs"]
// base64.b64decode(text, validate=True): the alphabet only, length a multiple of 4, "=" only as the last one or two.
// (Two checks, not one pattern: a regex that groups every 4 characters overflows the stack on an 8 MiB file.)
const validBase64 = (text) => text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text)

// The gateway's tree_hash: one line per file, "<path>\0<hex sha256>\n", in plain byte order of the path.
export function gatewayTreeHash(files) {
  const paths = Object.keys(files)
    .filter((p) => !p.split("/").slice(0, -1).includes(".git"))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return sha(Buffer.concat(paths.map((p) => Buffer.from(`${p}\0${sha(files[p])}\n`))))
}

// What a refusal is: a WireError (status, code, detail) of the gateway.
const refusal = (status, code, detail) => ({ error: { status, code, detail } })
const invalid = (detail) => refusal(422, "plugin_invalid", detail)
// Python's repr() of a str, near enough for a message: single quotes.
const pyRepr = (text) => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`

function checkPath(path) {
  const parts = path.split("/")
  if (parts.includes("node_modules")) {
    return refusal(422, "plugin_node_modules", `${path}: node_modules is not allowed; bundle the dependencies into the package`)
  }
  if (path.length > LIMITS.MAX_PATH_LEN || !PATH.test(path) || parts.some((part) => ["", ".", "..", ".git"].includes(part))) {
    return invalid(
      `${pyRepr(path.slice(0, 80))}: not an allowed path (letters, digits and . _ - / only, at most ${LIMITS.MAX_PATH_LEN} ` +
        "characters, no .. and no empty or .git segment)",
    )
  }
  if (path !== "package.json" && !(parts[0] === "dist" && parts.length > 1 && DIST_EXTENSIONS.some((ext) => path.endsWith(ext)))) {
    return invalid(`${path}: only package.json and files under dist/ ending in ${DIST_EXTENSIONS.join(" ")} are accepted`)
  }
  return null
}

// files: {path: base64 text}. Returns {error: {status, code, detail}} or {name, version, sha256, size, raw}.
export function vetUpload(files, { claimedSha256, claimedName, builtIn = [] } = {}) {
  const paths = Object.keys(files)
  if (paths.length === 0) return invalid("no files")
  if (paths.length > LIMITS.MAX_FILES) return invalid(`${paths.length} files; at most ${LIMITS.MAX_FILES}`)
  // Before decoding anything: base64 is 4 characters per 3 bytes.
  if (Object.values(files).reduce((n, text) => n + text.length, 0) > Math.floor((LIMITS.MAX_BYTES * 4) / 3) + 4 * LIMITS.MAX_FILES) {
    return refusal(422, "plugin_too_large", `over ${LIMITS.MAX_BYTES / (1024 * 1024)} MiB`)
  }
  const raw = {}
  for (const [path, text] of Object.entries(files)) {
    const bad = checkPath(path)
    if (bad) return bad
    if (!validBase64(text)) return invalid(`${path}: not valid base64`)
    raw[path] = Buffer.from(text, "base64")
  }
  const size = Object.values(raw).reduce((n, bytes) => n + bytes.length, 0)
  if (size > LIMITS.MAX_BYTES) {
    return refusal(422, "plugin_too_large", `${size} bytes; at most ${LIMITS.MAX_BYTES} (${LIMITS.MAX_BYTES / (1024 * 1024)} MiB)`)
  }
  for (const path of Object.keys(raw)) { // a path that is a file AND the folder of another cannot be written to a disk
    const parts = path.split("/")
    for (let end = 1; end < parts.length; end++) {
      if (Object.hasOwn(raw, parts.slice(0, end).join("/"))) return invalid(`${parts.slice(0, end).join("/")} is both a file and a folder`)
    }
  }

  if (!Object.hasOwn(raw, "package.json")) return invalid("package.json is missing")
  let manifest
  try {
    // ignoreBOM: keep a byte-order mark, which json.loads refuses and so must JSON.parse.
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw["package.json"]))
  } catch {
    return invalid("package.json is not valid JSON")
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return invalid("package.json must be a JSON object")
  const name = manifest.name
  if (typeof name !== "string" || name.length > LIMITS.MAX_NAME_LEN || !NAME.test(name)) {
    return invalid(
      `package.json name must be a lowercase npm-style name of at most ${LIMITS.MAX_NAME_LEN} characters, got ${pyRepr(String(name).slice(0, 80))}`,
    )
  }
  if (claimedName !== undefined && claimedName !== null && claimedName !== name) {
    return refusal(422, "plugin_name_mismatch", `package.json name ${pyRepr(name)} does not match the name you sent, ${pyRepr(claimedName)}`)
  }
  if (name.startsWith("@bonez/") || builtIn.includes(name)) {
    return refusal(
      422,
      "plugin_reserved_name",
      `${name} is reserved for plugins built into Bonez (@bonez/* and the compiled-in set); use your own scope`,
    )
  }
  const version = manifest.version
  if (typeof version !== "string" || version.length < 1 || version.length > 64) return invalid("package.json needs a version of 1-64 characters")

  // The entry, as the loader reads it: exports["."] when it is a string, else pi.extensions[0].
  const isDict = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  const main = isDict(manifest.exports) ? manifest.exports["."] : undefined
  const extensions = isDict(manifest.pi) ? manifest.pi.extensions : undefined
  const declared = typeof main === "string" ? main : Array.isArray(extensions) && extensions.length > 0 ? extensions[0] : undefined
  if (typeof declared !== "string" || !declared) return invalid('no entry file: need exports["."] as a string or pi.extensions[0]')
  const entry = posix.normalize(declared)
  if (!Object.hasOwn(raw, entry)) return invalid(`entry ${declared} is not among the uploaded files`)
  if (!(entry.startsWith("dist/") && ENTRY_EXTENSIONS.some((ext) => entry.endsWith(ext)))) {
    return invalid(`entry ${declared} must be a script under dist/ (${ENTRY_EXTENSIONS.join(" ")})`)
  }

  const recomputed = gatewayTreeHash(raw)
  if (typeof claimedSha256 === "string" && claimedSha256.trim().toLowerCase() !== recomputed) {
    return refusal(422, "plugin_hash_mismatch", `files hash to ${recomputed}, you sent ${claimedSha256.trim().slice(0, 80)}`)
  }
  return { name, version, sha256: recomputed, size, raw }
}

// options.key: the bearer the server accepts. options.computers: how many computers it says it rolls out to
// (each one is listed by GET /api/org/plugins in the state options.state, "ready" unless told otherwise).
// options.builtIn: plugin names compiled into this server, which an upload may not take.
export function startFakePluginServer({ key, computers = 2, state = "ready", builtIn = [] } = {}) {
  const requests = [] // what arrived, in order: { method, url, auth, paths, claimed, recomputed, outcome }
  const held = new Map() // name -> [{ version, sha256, size, active }]
  const reply = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const seen = { method: req.method, url: req.url, auth: req.headers.authorization ?? "", paths: [], claimed: null, recomputed: null, outcome: "" }
      requests.push(seen)
      const refuse = (status, code, detail) => {
        seen.outcome = code
        reply(res, status, { code, detail })
      }
      const known = (req.method === "POST" && req.url === "/api/admin/org/plugins") || (req.method === "GET" && req.url === "/api/org/plugins")
      if (!known) return refuse(404, "not_found", "Not Found")
      if (key && seen.auth !== `Bearer ${key}`) return refuse(401, "unauthenticated", "bad or missing API key")

      if (req.method === "GET") {
        seen.outcome = "ok"
        const fleet = Array.from({ length: computers }, (_, i) => ({ id: `c${i + 1}`, name: `computer-${i + 1}` }))
        const plugins = [...held].map(([name, versions]) => {
          const active = versions.find((v) => v.active)
          return {
            name,
            dir: name.replace("/", "__"),
            active: active?.sha256 ?? null,
            versions: [...versions].reverse(),
            computers: active ? fleet.map((c) => ({ ...c, status: "connected", state, error: null, sha256: active.sha256 })) : [],
          }
        })
        return reply(res, 200, { plugins, can_edit: true })
      }

      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        return reply(res, 422, { detail: [{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }] })
      }
      // PluginUpload: files (path -> base64), sha256 and name optional, unknown keys refused (extra="forbid").
      const problems = []
      for (const k of Object.keys(body ?? {})) if (!["files", "sha256", "name"].includes(k)) problems.push({ loc: ["body", k], msg: "Extra inputs are not permitted", type: "extra_forbidden" })
      const files = body?.files
      if (files === undefined) problems.push({ loc: ["body", "files"], msg: "Field required", type: "missing" })
      else if (files === null || typeof files !== "object" || Array.isArray(files) || Object.values(files).some((v) => typeof v !== "string")) {
        problems.push({ loc: ["body", "files"], msg: "Input should be a valid dictionary of strings", type: "dict_type" })
      }
      for (const k of ["sha256", "name"]) if (body?.[k] !== undefined && body[k] !== null && typeof body[k] !== "string") problems.push({ loc: ["body", k], msg: "Input should be a valid string", type: "string_type" })
      if (problems.length > 0) {
        seen.outcome = "request_invalid"
        return reply(res, 422, { detail: problems })
      }
      seen.paths = Object.keys(files)
      seen.claimed = body.sha256 ?? null
      const vetted = vetUpload(files, { claimedSha256: body.sha256 ?? undefined, claimedName: body.name, builtIn })
      if (vetted.error) {
        // The hash is known once the rules before it passed; a test reads it from `recomputed`.
        if (vetted.error.code === "plugin_hash_mismatch") seen.recomputed = /files hash to ([0-9a-f]{64})/.exec(vetted.error.detail)?.[1] ?? null
        return refuse(vetted.error.status, vetted.error.code, vetted.error.detail)
      }
      seen.recomputed = vetted.sha256
      seen.outcome = "ok"
      const versions = held.get(vetted.name) ?? []
      const identical = versions.some((v) => v.sha256 === vetted.sha256)
      for (const v of versions) v.active = false
      if (identical) versions.find((v) => v.sha256 === vetted.sha256).active = true
      else versions.push({ version: vetted.version, sha256: vetted.sha256, size: vetted.size, active: true })
      held.set(vetted.name, versions)
      reply(res, 200, { name: vetted.name, version: vetted.version, sha256: vetted.sha256, size: vetted.size, active: true, identical, computers })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
