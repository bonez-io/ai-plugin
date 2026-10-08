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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
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

  test("an unreachable server is exit 3", async () => {
    reset(ok())
    const r = await push([plugin()], { BONEZ_URL: "http://127.0.0.1:1" })
    assert.equal(r.status, 3)
    assert.match(r.stderr, /cannot reach http:\/\/127\.0\.0\.1:1/)
    assert.ok(!r.stderr.includes(KEY))
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
