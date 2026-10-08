// A stand-in for the gateway's plugin upload route (POST /api/admin/org/plugins), for the push CLI's
// tests and for tests/lib/push-smoke.mjs. It binds 127.0.0.1 only and makes no other network call.
//
// It judges an upload the way the real gateway does (services/gateway/.../computers/plugins.py in
// bonez-core): every path must match [A-Za-z0-9._/-]+ with no empty, ".", ".." or ".git" segment (so
// a backslash key, which is what a careless Windows walk produces, is refused), the bodies must be
// valid base64, and the tree hash is RECOMPUTED here and must equal the one claimed. The recomputation
// below is deliberately a second, independent implementation: it does not import bin/lib/plugin-tree.mjs.
import { createHash } from "node:crypto"
import { createServer } from "node:http"

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const PATH = /^[A-Za-z0-9._/-]+$/

// The gateway's tree_hash: one line per file, "<path>\0<hex sha256>\n", in plain byte order of the path.
export function gatewayTreeHash(files) {
  const paths = Object.keys(files)
    .filter((p) => !p.split("/").slice(0, -1).includes(".git"))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return sha(Buffer.concat(paths.map((p) => Buffer.from(`${p}\0${sha(files[p])}\n`))))
}

// options.key: the bearer the server accepts. options.computers: the number it reports.
export function startFakePluginServer({ key, computers = 2 } = {}) {
  const requests = [] // what arrived, in order: { auth, paths, claimed, recomputed, outcome }
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
      if (req.method !== "POST" || req.url !== "/api/admin/org/plugins") return refuse(404, "not_found", "Not Found")
      if (key && seen.auth !== `Bearer ${key}`) return refuse(401, "unauthenticated", "bad or missing API key")
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        return refuse(422, "plugin_invalid", "body is not JSON")
      }
      const { files, sha256 } = body ?? {}
      if (!files || typeof files !== "object") return refuse(422, "plugin_invalid", "no files")
      seen.paths = Object.keys(files)
      seen.claimed = sha256 ?? null
      const raw = {}
      for (const [path, text] of Object.entries(files)) {
        const parts = path.split("/")
        if (!PATH.test(path) || parts.some((p) => ["", ".", "..", ".git"].includes(p))) {
          return refuse(422, "plugin_invalid", `${JSON.stringify(path)}: not an allowed path (letters, digits and . _ - / only)`)
        }
        if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return refuse(422, "plugin_invalid", `${path}: not valid base64`)
        raw[path] = Buffer.from(text, "base64")
      }
      if (!raw["package.json"]) return refuse(422, "plugin_invalid", "package.json is missing")
      seen.recomputed = gatewayTreeHash(raw)
      if (seen.claimed !== seen.recomputed) {
        return refuse(422, "plugin_hash_mismatch", `files hash to ${seen.recomputed}, you sent ${seen.claimed}`)
      }
      let manifest
      try {
        manifest = JSON.parse(raw["package.json"].toString("utf8"))
      } catch {
        return refuse(422, "plugin_invalid", "package.json is not valid JSON")
      }
      seen.outcome = "ok"
      reply(res, 200, { name: manifest.name, version: manifest.version ?? "0.0.0", sha256: seen.recomputed, computers })
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
