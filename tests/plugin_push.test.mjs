// Tests for bin/bonez-plugin-push.mjs against a local http server standing in for the gateway.
//
// Offline and dependency-free (Node's built-in runner). The server records every request, so the
// tests can assert what went over the wire (path, bearer, body, hash) and what did NOT (no request
// at all for a bad folder or bad config; no key to a redirect target).
//
// Run: node --test tests/plugin_push.test.mjs   (or ./tests/test_plugin_push.sh)
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { createServer as createTlsServer } from "node:https"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { startFakePluginServer } from "./lib/fake-plugin-server.mjs"
import { trySymlink } from "./lib/fs-helpers.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PUSH = join(HERE, "..", "bin", "bonez-plugin-push.mjs")
const HASH = join(HERE, "..", "bin", "bonez-package-hash.mjs")

// The same pinned vector as package_hash.test.mjs: the push script must hash a folder exactly so.
const VECTOR_PACKAGE_JSON = '{"name":"@example/pi-hello","version":"1.2.0","exports":{".":"./dist/index.js"}}'
const VECTOR_INDEX_JS = "export default function () {}\n"

const KEY = "bnz_" + "ab".repeat(24)

const roots = []
function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "bonez-push-"))
  roots.push(dir)
  return dir
}
process.on("exit", () => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))

function put(root, rel, content) {
  const abs = join(root, ...rel.split("/"))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function plugin(extra = {}) {
  const root = freshDir()
  put(root, "package.json", VECTOR_PACKAGE_JSON)
  put(root, "dist/index.js", VECTOR_INDEX_JS)
  for (const [rel, content] of Object.entries(extra)) put(root, rel, content)
  return root
}

// A stand-in gateway. `answer` decides each reply; `calls` records what arrived.
let server
let base
let calls
let answer
before(async () => {
  server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      calls.push({ method: req.method, url: req.url, headers: req.headers, raw })
      const { status = 200, body = {}, headers = {}, text } = answer(req)
      res.writeHead(status, { "content-type": "application/json", ...headers })
      res.end(text ?? JSON.stringify(body))
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise((resolve) => server.close(resolve)))

function reset(fn) {
  calls = []
  answer = fn
}

// A port nothing listens on: connecting is refused. (Not port 1: fetch blocks it as a "bad port" before any connect.)
async function closedPort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// Async on purpose: the server above lives in this process, so a sync spawn would deadlock.
function push(args, env = {}) {
  return new Promise((resolve) => {
    // The parent's environment is inherited (a Windows child without SystemRoot cannot open a socket);
    // the three variables the tool reads are set here, so nothing of the developer's own leaks in.
    execFile(process.execPath, [PUSH, ...args], { env: { ...process.env, BONEZ_ALLOW_HTTP: "", BONEZ_URL: base, BONEZ_API_KEY: KEY, ...env }, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }))
  })
}

const ok = (extra = {}) => () => ({ body: { name: "@example/pi-hello", version: "1.2.0", sha256: undefined, computers: 3, ...extra } })

function treeHash(folder) {
  const r = spawnSync(process.execPath, [HASH, folder], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

describe("a successful push", () => {
  test("sends the files, the tree hash and the bearer to the upload route, and prints the result", async () => {
    const dir = plugin()
    const fingerprint = treeHash(dir)
    reset(ok({ sha256: fingerprint }))
    const r = await push([dir])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.equal(call.method, "POST")
    assert.equal(call.url, "/api/admin/org/plugins")
    assert.equal(call.headers.authorization, `Bearer ${KEY}`)
    assert.match(call.headers["content-type"], /^application\/json/)
    const body = JSON.parse(call.raw)
    assert.deepEqual(Object.keys(body).sort(), ["files", "sha256"])
    assert.equal(body.sha256, fingerprint)
    assert.deepEqual(body.files, {
      "dist/index.js": Buffer.from(VECTOR_INDEX_JS).toString("base64"),
      "package.json": Buffer.from(VECTOR_PACKAGE_JSON).toString("base64"),
    })
    assert.match(r.stdout, /pushed @example\/pi-hello 1\.2\.0\n/)
    assert.ok(r.stdout.includes(`fingerprint: ${fingerprint}`))
    assert.match(r.stdout, /rolling out to 3 computers/)
  })

  test("its fingerprint is bonez-package-hash's on a nested tree with unsorted, non-ASCII names", async () => {
    const dir = plugin({ "dist/b.js": "b", "dist/a/z.js": "z", "dist/é.json": "{}", "dist/Z.js": "Z", "dist/ab.js": "ab" })
    reset(ok())
    const r = await push([dir])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(calls[0].raw).sha256, treeHash(dir))
    assert.ok(r.stdout.includes(treeHash(dir)))
  })

  test("never prints the key, and says nothing it was not told when the server omits fields", async () => {
    reset(() => ({ body: { name: "@example/pi-hello", version: "1.2.0" } }))
    const r = await push([plugin()])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /rolling out to: \(the server did not say\)/)
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY))
  })

  test("counts one computer in the singular and accepts a list of them", async () => {
    reset(ok({ computers: [{ id: "c1" }] }))
    assert.match((await push([plugin()])).stdout, /rolling out to 1 computer\n/)
  })
})

describe("a refusal", () => {
  test("is shown with its code and detail as the server sent them, exit 1", async () => {
    reset(() => ({ status: 422, body: { code: "plugin_hash_mismatch", detail: "files hash to aaa, you sent bbb" } }))
    const r = await push([plugin()])
    assert.equal(r.status, 1)
    assert.equal(r.stdout, "")
    assert.ok(r.stderr.includes("HTTP 422: plugin_hash_mismatch: files hash to aaa, you sent bbb"), r.stderr)
    assert.ok(!r.stderr.includes(KEY))
  })

  test("a demoted owner, a bad key and a list-shaped validation error are all shown whole", async () => {
    for (const [status, body, shown] of [
      [403, { code: "api_key_owner_not_admin", detail: "the owner of this API key is no longer an admin of the organization" },
        "api_key_owner_not_admin: the owner of this API key is no longer an admin"],
      [401, { code: "unauthenticated", detail: "this API key has been revoked" }, "unauthenticated: this API key has been revoked"],
      [422, { detail: [{ loc: ["body", "files"], msg: "field required" }] }, '[{"loc":["body","files"],"msg":"field required"}]'],
    ]) {
      reset(() => ({ status, body }))
      const r = await push([plugin()])
      assert.equal(r.status, 1, shown)
      assert.ok(r.stderr.includes(shown), r.stderr)
    }
  })

  test("a 404 says the server may predate plugin upload", async () => {
    reset(() => ({ status: 404, body: { detail: "Not Found" } }))
    const r = await push([plugin()])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /predate plugin upload/)
  })

  test("a server that reflects the key back does not get it printed", async () => {
    reset(() => ({ status: 400, body: { code: "bad_request", detail: `rejected ${KEY} as given` } }))
    const r = await push([plugin()])
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes("rejected [key] as given"), r.stderr)
    assert.ok(!r.stderr.includes(KEY))
  })

  test("control characters from the server never reach the terminal", async () => {
    reset(() => ({ status: 400, text: "\u001b[31mred\u001b[0m" }))
    const r = await push([plugin()])
    assert.equal(r.status, 1)
    assert.ok(!r.stderr.includes("\u001b"))
  })
})

describe("what is not a clean answer", () => {
  test("a 500 is exit 3", async () => {
    reset(() => ({ status: 500, body: { code: "internal_error", detail: "internal server error" } }))
    const r = await push([plugin()])
    assert.equal(r.status, 3)
    assert.match(r.stderr, /internal_error: internal server error/)
  })

  test("a 200 that is not JSON is exit 3", async () => {
    reset(() => ({ text: "<html>welcome</html>" }))
    assert.equal((await push([plugin()])).status, 3)
  })

  test("a different fingerprint in the answer is exit 3", async () => {
    reset(ok({ sha256: "0".repeat(64) }))
    const r = await push([plugin()])
    assert.equal(r.status, 3)
    assert.match(r.stderr, /different fingerprint/)
  })

  test("a redirect is not followed, so the key goes nowhere else", async () => {
    reset(() => ({ status: 302, headers: { location: `${base}/elsewhere` }, body: {} }))
    const r = await push([plugin()])
    assert.equal(r.status, 3)
    assert.deepEqual(calls.map((c) => c.url), ["/api/admin/org/plugins"])
    assert.match(r.stderr, /redirected/)
  })

  test("an unreachable server is exit 3, and the message names the full address it tried and BONEZ_URL", async () => {
    reset(ok())
    const port = await closedPort()
    const r = await push([plugin()], { BONEZ_URL: `http://127.0.0.1:${port}` })
    assert.equal(r.status, 3)
    assert.ok(r.stderr.includes(`cannot reach http://127.0.0.1:${port}/api/admin/org/plugins: ECONNREFUSED`), r.stderr)
    assert.match(r.stderr, /check BONEZ_URL/)
    assert.ok(!r.stderr.includes(KEY))
  })

  test("a name that does not resolve is exit 3 with the full address and BONEZ_URL, and a bare host is tried over https", async () => {
    // `.invalid` can never resolve (RFC 2606). Offline, the resolver may answer EAI_AGAIN instead of ENOTFOUND.
    const r = await push([plugin()], { BONEZ_URL: "bonez-test.invalid" })
    assert.equal(r.status, 3)
    assert.match(r.stderr, /cannot reach https:\/\/bonez-test\.invalid\/api\/admin\/org\/plugins: (ENOTFOUND|EAI_AGAIN)/, r.stderr)
    assert.match(r.stderr, /check BONEZ_URL/)
    assert.ok(!r.stderr.includes(KEY))
  })
})

describe("BONEZ_URL as people write it", () => {
  const landed = () => calls.map((c) => c.url)

  test("the MCP address works: a trailing /mcp and slashes are dropped", async () => {
    for (const suffix of ["", "/", "//", "/mcp", "/mcp/", "/MCP"]) {
      reset(ok())
      const r = await push([plugin()], { BONEZ_URL: `${base}${suffix}` })
      assert.equal(r.status, 0, `${suffix}: ${r.stderr}`)
      assert.deepEqual(landed(), ["/api/admin/org/plugins"], suffix)
    }
  })

  test("a path in front of /mcp is kept, and a path that only ends like mcp is not touched", async () => {
    reset(ok())
    assert.equal((await push([plugin()], { BONEZ_URL: `${base}/bonez/mcp` })).status, 0)
    assert.equal((await push([plugin()], { BONEZ_URL: `${base}/bonez-mcp` })).status, 0)
    assert.deepEqual(landed(), ["/bonez/api/admin/org/plugins", "/bonez-mcp/api/admin/org/plugins"])
  })

  test("a bare host:port on this machine is tried over http, with or without /mcp", async () => {
    const bare = base.replace("http://", "")
    for (const url of [bare, `${bare}/mcp`]) {
      reset(ok())
      const r = await push([plugin()], { BONEZ_URL: url })
      assert.equal(r.status, 0, `${url}: ${r.stderr}`)
      assert.deepEqual(landed(), ["/api/admin/org/plugins"], url)
    }
  })

  test("localhost:PORT is read as http://localhost:PORT, never as a scheme called localhost", async () => {
    const port = await closedPort()
    const r = await push([plugin()], { BONEZ_URL: `localhost:${port}` })
    assert.equal(r.status, 3, r.stderr)
    assert.ok(r.stderr.includes(`cannot reach http://localhost:${port}/api/admin/org/plugins: ECONNREFUSED`), r.stderr)
    assert.ok(!r.stderr.includes("localhost://"))
  })

  test("[::1] and 127.0.0.1 count as this machine; any other bare host gets https", async () => {
    const port = await closedPort()
    const v6 = await push([plugin()], { BONEZ_URL: `[::1]:${port}` })
    assert.equal(v6.status, 3, v6.stderr) // refused, or no IPv6 here: either way it was tried over http
    assert.ok(v6.stderr.includes(`cannot reach http://[::1]:${port}/api/admin/org/plugins`), v6.stderr)
    const v4 = await push([plugin()], { BONEZ_URL: `127.0.0.1:${port}/mcp` })
    assert.ok(v4.stderr.includes(`cannot reach http://127.0.0.1:${port}/api/admin/org/plugins`), v4.stderr)
  })

  test("a bare host that is not this machine is never sent over http, even with a port", async () => {
    const r = await push([plugin()], { BONEZ_URL: "bonez-test.invalid:8080/mcp" })
    assert.equal(r.status, 3)
    assert.match(r.stderr, /cannot reach https:\/\/bonez-test\.invalid:8080\/api\/admin\/org\/plugins/, r.stderr)
  })

  test("a 404 names the address it asked, so a wrong BONEZ_URL can be told from an old server", async () => {
    reset(() => ({ status: 404, body: { detail: "Not Found" } }))
    const r = await push([plugin()], { BONEZ_URL: `${base}/elsewhere` })
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes(`POST ${base}/elsewhere/api/admin/org/plugins found nothing`), r.stderr)
    assert.match(r.stderr, /predate plugin upload/)
  })
})

// A self-signed certificate is what a server on a private network often has. Needs openssl to make one
// (the Windows runner has none on its PATH: the test says so and stops).
describe("a server whose certificate Node does not trust", () => {
  function selfSigned() {
    const dir = freshDir()
    const made = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { encoding: "utf8" })
    if (made.error || made.status !== 0) return null
    return { dir, key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")), file: join(dir, "cert.pem") }
  }

  test("exit 3 with the address and a hint about NODE_EXTRA_CA_CERTS; with that variable set the push goes through", async (t) => {
    const pair = selfSigned()
    if (!pair) return t.skip("openssl cannot make a certificate here")
    const seen = []
    const tls = createTlsServer({ key: pair.key, cert: pair.cert }, (req, res) => {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        seen.push(req.url)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ name: "@example/pi-hello", version: "1.2.0", computers: 1 }))
      })
    })
    await new Promise((resolve) => tls.listen(0, "127.0.0.1", resolve))
    try {
      const url = `https://localhost:${tls.address().port}`
      const refused = await push([plugin()], { BONEZ_URL: url, NODE_EXTRA_CA_CERTS: "" })
      assert.equal(refused.status, 3, refused.stderr)
      assert.ok(refused.stderr.includes(`cannot reach ${url}/api/admin/org/plugins:`), refused.stderr)
      assert.match(refused.stderr, /SELF_SIGNED/)
      assert.match(refused.stderr, /NODE_EXTRA_CA_CERTS/)
      assert.doesNotMatch(refused.stderr, /check BONEZ_URL/, "the address is right; the certificate is the problem")
      assert.deepEqual(seen, [], "the key must not reach a server whose certificate failed")
      assert.ok(!refused.stderr.includes(KEY))

      const trusted = await push([plugin()], { BONEZ_URL: url, NODE_EXTRA_CA_CERTS: pair.file })
      assert.equal(trusted.status, 0, trusted.stderr)
      assert.deepEqual(seen, ["/api/admin/org/plugins"])
    } finally {
      await new Promise((resolve) => tls.close(resolve))
    }
  })
})

describe("--status", () => {
  const listing = (plugins) => () => ({ body: { plugins, can_edit: true } })
  const demo = {
    name: "@acme/pi-demo", dir: "@acme__pi-demo", active: "a".repeat(64),
    versions: [{ version: "1.1.0", sha256: "a".repeat(64), size: 10, active: true }, { version: "1.0.0", sha256: "b".repeat(64), size: 9, active: false }],
    computers: [
      { id: "c1", name: "mac-mini", status: "connected", state: "ready", error: null, sha256: "a".repeat(64) },
      { id: "c2", name: "gpu-box", status: "connected", state: "failed", error: "hash mismatch", sha256: null },
    ],
  }

  test("asks GET /api/org/plugins with the key and prints each plugin and the state of each computer", async () => {
    reset(listing([demo]))
    const r = await push(["--status"])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, "GET")
    assert.equal(calls[0].url, "/api/org/plugins")
    assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`)
    assert.equal(r.stdout, `@acme/pi-demo 1.1.0  fingerprint ${"a".repeat(64)}\n  mac-mini: ready\n  gpu-box: failed (hash mismatch)\n  1 of 2 ready\n`)
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY))
  })

  test("takes the same BONEZ_URL spellings as a push", async () => {
    reset(listing([demo]))
    assert.equal((await push(["--status"], { BONEZ_URL: `${base}/mcp/` })).status, 0)
    assert.equal((await push(["--status"], { BONEZ_URL: base.replace("http://", "") })).status, 0)
    assert.deepEqual(calls.map((c) => c.url), ["/api/org/plugins", "/api/org/plugins"])
  })

  test("a name picks one plugin, and an unknown name is exit 1", async () => {
    reset(listing([demo, { ...demo, name: "@acme/pi-other" }]))
    const one = await push(["--status", "@acme/pi-other"])
    assert.equal(one.status, 0)
    assert.match(one.stdout, /^@acme\/pi-other 1\.1\.0 /)
    assert.doesNotMatch(one.stdout, /pi-demo/)
    const none = await push(["--status", "@acme/missing"])
    assert.equal(none.status, 1)
    assert.match(none.stderr, /holds no plugin named @acme\/missing/)
  })

  test("says so when the server holds nothing, when a plugin is retired and when no computer takes it", async () => {
    reset(listing([]))
    assert.match((await push(["--status"])).stdout, /holds no plugins yet/)
    reset(listing([{ ...demo, active: null, versions: [{ version: "1.0.0", sha256: "b".repeat(64), size: 9, active: false }], computers: [] }]))
    assert.match((await push(["--status"])).stdout, /@acme\/pi-demo {2}\(no active version: retired\)/)
    reset(listing([{ ...demo, computers: [] }]))
    assert.match((await push(["--status"])).stdout, /no computers are enrolled/)
  })

  test("a refusal, an old server and an unreadable answer are told apart like a push's", async () => {
    reset(() => ({ status: 403, body: { code: "api_key_owner_not_admin", detail: "the owner of this API key is no longer an admin" } }))
    const refused = await push(["--status"])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /api_key_owner_not_admin/)
    reset(() => ({ text: "<html>welcome</html>" }))
    assert.equal((await push(["--status"])).status, 3)
    reset(() => ({ status: 500, body: { detail: "boom" } }))
    assert.equal((await push(["--status"])).status, 3)
  })

  test("needs the same configuration, and takes at most one name", async () => {
    reset(listing([]))
    const noKey = await push(["--status"], { BONEZ_API_KEY: "" })
    assert.equal(noKey.status, 2)
    assert.match(noKey.stderr, /BONEZ_API_KEY is not set/)
    assert.equal((await push(["--status", "a", "b"])).status, 2)
    assert.equal(calls.length, 0, "no request may be sent")
  })

  test("after a real push to the stand-in gateway it shows the plugin as delivered", async () => {
    const server = await startFakePluginServer({ key: KEY, computers: 2, state: "ready" })
    try {
      const dir = plugin()
      const pushed = await push([dir], { BONEZ_URL: server.url })
      assert.equal(pushed.status, 0, pushed.stderr)
      const r = await push(["--status", "@example/pi-hello"], { BONEZ_URL: `${server.url}/mcp` })
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.stdout.startsWith("@example/pi-hello 1.2.0  fingerprint "), r.stdout)
      assert.match(r.stdout, /computer-1: ready\n {2}computer-2: ready\n {2}2 of 2 ready\n$/)
    } finally {
      await server.close()
    }
  })
})

describe("against the gateway's rules (the stand-in holds the real server's checks)", () => {
  async function pushTo(dir, options) {
    const server = await startFakePluginServer({ key: KEY, ...options })
    try {
      const r = await push([dir], { BONEZ_URL: server.url })
      return { ...r, requests: server.requests }
    } finally {
      await server.close()
    }
  }

  test("a built plugin is accepted", async () => {
    const r = await pushTo(plugin(), {})
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.requests[0].outcome, "ok")
  })

  test("a file the server does not accept is refused with the server's own words, exit 1", async () => {
    for (const [rel, phrase] of [["dist/addon.node", "only package.json and files under dist/"], ["README.md", "only package.json and files under dist/"], ["dist/a b.js", "not an allowed path"]]) {
      const r = await pushTo(plugin({ [rel]: "x" }), {})
      assert.equal(r.status, 1, `${rel}: ${r.stderr}`)
      assert.ok(r.stderr.includes("plugin_invalid") && r.stderr.includes(phrase), r.stderr)
    }
  })

  test("a folder Finder or Explorer has been in is refused before anything is sent (exit 2), and the message says what to delete", async () => {
    for (const rel of [".DS_Store", "dist/.DS_Store", "Thumbs.db", "dist/THUMBS.DB", "desktop.ini"]) {
      const r = await pushTo(plugin({ [rel]: "x" }), {})
      assert.equal(r.status, 2, `${rel}: ${r.stderr}`)
      assert.ok(r.stderr.includes(`${rel} was added by Finder or Explorer`), r.stderr)
      assert.match(r.stderr, /delete it/)
      assert.equal(r.requests.length, 0, "no request may be sent")
    }
  })

  test("a package.json without a version is refused by the server's rule, not accepted by a lax stand-in", async () => {
    const dir = freshDir()
    put(dir, "package.json", '{"name":"@example/pi-hello","exports":{".":"./dist/index.js"}}')
    put(dir, "dist/index.js", VECTOR_INDEX_JS)
    const r = await pushTo(dir, {})
    assert.equal(r.status, 1)
    assert.match(r.stderr, /needs a version of 1-64 characters/)
  })
})

describe("nothing is sent when the input is wrong (exit 2)", () => {
  async function refusedLocally(args, env, pattern) {
    reset(ok())
    const r = await push(args, env)
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, pattern)
    assert.equal(calls.length, 0, "no request may be sent")
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY))
  }

  test("usage", async () => {
    await refusedLocally([], {}, /usage: bonez-plugin-push <folder>/)
    await refusedLocally([plugin(), "extra"], {}, /usage/)
  })

  test("missing config", async () => {
    await refusedLocally([plugin()], { BONEZ_API_KEY: "" }, /BONEZ_API_KEY is not set/)
    await refusedLocally([plugin()], { BONEZ_URL: "" }, /BONEZ_URL is not set/)
  })

  test("a key that is not a bnz_ key is refused without being echoed", async () => {
    await refusedLocally([plugin()], { BONEZ_API_KEY: "sk-live-not-ours" }, /not a bnz_ key/)
    const r = await push([plugin()], { BONEZ_API_KEY: "sk-live-not-ours" })
    assert.ok(!r.stderr.includes("sk-live"))
  })

  test("a server URL that would send the key in clear", async () => {
    await refusedLocally([plugin()], { BONEZ_URL: "http://bonez.example.com" }, /must be https/)
    await refusedLocally([plugin()], { BONEZ_URL: "ftp://bonez.example.com" }, /must be https/)
    await refusedLocally([plugin()], { BONEZ_URL: "not a url" }, /not a valid URL/)
    await refusedLocally([plugin()], { BONEZ_URL: "https://admin:hunter2@bonez.example.com" }, /user name or password/)
  })

  test("a folder that cannot be a built plugin", async () => {
    await refusedLocally([join(tmpdir(), "bonez-push-does-not-exist")], {}, /cannot read/)
    await refusedLocally([PUSH], {}, /not a directory/)
    const noManifest = freshDir()
    put(noManifest, "dist/index.js", VECTOR_INDEX_JS)
    await refusedLocally([noManifest], {}, /no package.json/)
    await refusedLocally([plugin({ "node_modules/x/index.js": "x" })], {}, /node_modules\/ not allowed/)
    // Where symlinks are not allowed (Windows without Developer Mode) these two are left out.
    const withLink = plugin()
    if (trySymlink("/etc/hosts", join(withLink, "dist", "link.js"))) await refusedLocally([withLink], {}, /symlink not allowed/)
    const link = join(freshDir(), "link")
    if (trySymlink(plugin(), link)) await refusedLocally([link], {}, /symlink not allowed/)
  })
})
