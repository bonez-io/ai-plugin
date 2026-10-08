// Tests for tests/lib/fake-plugin-server.mjs: the stand-in for the gateway that every push test talks to.
//
// The fake is only worth having if it refuses what the real server refuses. These cases are the rows of the
// real server's own suite (bonez-core: services/gateway/tests/computers/test_plugins.py, the parametrized
// `test_the_loaders_rules_are_applied_before_anything_is_stored` and its neighbours) plus the file-manager
// files and the Windows backslash key that this repo's tools have to keep out of an upload. When
// plugins.py changes a rule, this file and the fake change in the same pull request.
//
// Offline and dependency-free (Node's built-in runner).
// Run: node --test tests/fake_plugin_server.test.mjs
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { DIST_EXTENSIONS, LIMITS, gatewayTreeHash, startFakePluginServer, vetUpload } from "./lib/fake-plugin-server.mjs"
import { VECTORS, decode } from "./lib/vectors.mjs"

const b64 = (content) => Buffer.from(content).toString("base64")

// plugin_files() of the real suite: a valid plugin, package.json + dist/index.js.
function pluginFiles(name = "acme", version = "1.0.0", extra = {}) {
  const manifest = { name, version, exports: { ".": "./dist/index.js" } }
  return {
    "package.json": b64(JSON.stringify(manifest)),
    "dist/index.js": b64("export default function () {}\n"),
    ...Object.fromEntries(Object.entries(extra).map(([path, content]) => [path, b64(content)])),
  }
}
const withManifest = (manifest) => ({ ...pluginFiles(), "package.json": b64(typeof manifest === "string" ? manifest : JSON.stringify(manifest)) })

describe("a valid upload", () => {
  test("is accepted, and its hash is the gateway's", () => {
    const vetted = vetUpload(pluginFiles())
    assert.equal(vetted.error, undefined)
    assert.equal(vetted.name, "acme")
    assert.equal(vetted.version, "1.0.0")
    assert.equal(vetted.sha256, gatewayTreeHash(vetted.raw))
  })

  test("both shared vectors hash to their pinned tree hash", () => {
    for (const vector of VECTORS) assert.equal(gatewayTreeHash(decode(vector)), vector.tree_sha256, vector.name)
  })

  test("the 'ordering' vector is a valid upload (the real suite uploads it), 'hello' is not: it has no version", () => {
    const ordering = VECTORS.find((v) => v.name === "ordering")
    assert.equal(vetUpload(ordering.files, { claimedSha256: ordering.tree_sha256 }).error, undefined)
    const hello = VECTORS.find((v) => v.name === "hello")
    assert.match(vetUpload(hello.files).error.detail, /needs a version/)
  })

  test("the claim is optional, may be upper case and padded, and a name in the body must match", () => {
    const sha = vetUpload(pluginFiles()).sha256
    assert.equal(vetUpload(pluginFiles(), { claimedSha256: ` ${sha.toUpperCase()} ` }).error, undefined)
    assert.equal(vetUpload(pluginFiles(), { claimedName: "acme" }).error, undefined)
    assert.equal(vetUpload(pluginFiles(), { claimedName: "other" }).error.code, "plugin_name_mismatch")
  })

  test("the entry may come from pi.extensions, with a leading ./ normalised; exports['.'] as a string wins", () => {
    const manifest = { name: "acme", version: "1", pi: { extensions: ["./dist/main.mjs"] } }
    const files = { "package.json": b64(JSON.stringify(manifest)), "dist/main.mjs": b64("x") }
    assert.equal(vetUpload(files).error, undefined)
    const both = { ...files, "package.json": b64(JSON.stringify({ ...manifest, exports: { ".": "./dist/index.js" } })) }
    assert.match(vetUpload(both).error.detail, /not among the uploaded files/)
  })
})

describe("the loader's rules are applied before anything is stored", () => {
  // [what, files, code, a phrase the detail must hold]
  const cases = [
    ["no files", {}, "plugin_invalid", "no files"],
    ["too many files", { ...pluginFiles(), ...Object.fromEntries(Array.from({ length: LIMITS.MAX_FILES }, (_, i) => [`dist/f${i}.js`, b64("x")])) }, "plugin_invalid", "at most 32"],
    ["a .. segment", { ...pluginFiles(), "../evil.js": b64("x") }, "plugin_invalid", "not an allowed path"],
    ["a .. segment in dist", { ...pluginFiles(), "dist/../evil.js": b64("x") }, "plugin_invalid", "not an allowed path"],
    ["an absolute path", { ...pluginFiles(), "/etc/passwd": b64("x") }, "plugin_invalid", "not an allowed path"],
    ["an empty segment", { ...pluginFiles(), "dist//x.js": b64("x") }, "plugin_invalid", "not an allowed path"],
    ["a space", { ...pluginFiles(), "dist/a b.js": b64("x") }, "plugin_invalid", "not an allowed path"],
    ["a non-ASCII name", { ...pluginFiles(), "dist/é.js": b64("x") }, "plugin_invalid", "not an allowed path"],
    ["a .git segment", { ...pluginFiles(), "dist/.git/HEAD": b64("x") }, "plugin_invalid", "not an allowed path"],
    ["a path over 200 characters", { ...pluginFiles(), [`${"dist/x".repeat(60)}.js`]: b64("x") }, "plugin_invalid", "not an allowed path"],
    ["a backslash key, which is what a careless Windows walk sends", { ...pluginFiles(), "dist\\index.js": b64("x") }, "plugin_invalid", "not an allowed path"],
    ["a native addon", { ...pluginFiles(), "dist/addon.node": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    ["a shared library", { ...pluginFiles(), "dist/lib.so": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    ["a wasm file", { ...pluginFiles(), "dist/m.wasm": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    ["a shell script", { ...pluginFiles(), "dist/run.sh": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    ["a README outside dist", { ...pluginFiles(), "README.md": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    ["the source", { ...pluginFiles(), "src/index.ts": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    ["an extension in capitals", { ...pluginFiles(), "dist/INDEX.JS": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    [".DS_Store at the top", { ...pluginFiles(), ".DS_Store": b64("\0\0\0\u0001Bud1") }, "plugin_invalid", "only package.json and files under dist/"],
    [".DS_Store inside dist", { ...pluginFiles(), "dist/.DS_Store": b64("\0\0\0\u0001Bud1") }, "plugin_invalid", "only package.json and files under dist/"],
    ["Thumbs.db", { ...pluginFiles(), "dist/Thumbs.db": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    ["desktop.ini", { ...pluginFiles(), "desktop.ini": b64("x") }, "plugin_invalid", "only package.json and files under dist/"],
    ["text that is not base64", { ...pluginFiles(), "dist/bad.js": "not base64!" }, "plugin_invalid", "not valid base64"],
    ["unpadded base64", { ...pluginFiles(), "dist/bad.js": "YQ" }, "plugin_invalid", "not valid base64"],
    ["no package.json", Object.fromEntries(Object.entries(pluginFiles()).filter(([k]) => k !== "package.json")), "plugin_invalid", "package.json is missing"],
    ["a package.json that is not JSON", withManifest("{nope"), "plugin_invalid", "not valid JSON"],
    ["a package.json with a byte-order mark", withManifest(`﻿${JSON.stringify({ name: "acme", version: "1", exports: { ".": "./dist/index.js" } })}`), "plugin_invalid", "not valid JSON"],
    ["a package.json that is a list", withManifest("[]"), "plugin_invalid", "must be a JSON object"],
    ["a name in capitals", withManifest({ name: "Acme/Demo", version: "1" }), "plugin_invalid", "lowercase npm-style name"],
    ["a name that is a path", withManifest({ name: "../x", version: "1" }), "plugin_invalid", "lowercase npm-style name"],
    ["no name", withManifest({ version: "1" }), "plugin_invalid", "lowercase npm-style name"],
    ["a name over 128 characters", withManifest({ name: "a".repeat(129), version: "1" }), "plugin_invalid", "at most 128"],
    ["no version", withManifest({ name: "acme", exports: { ".": "./dist/index.js" } }), "plugin_invalid", "needs a version"],
    ["a version over 64 characters", withManifest({ name: "acme", version: "1".repeat(65), exports: "x" }), "plugin_invalid", "needs a version"],
    ["a version that is a number", withManifest({ name: "acme", version: 1, exports: { ".": "./dist/index.js" } }), "plugin_invalid", "needs a version"],
    ["no entry", withManifest({ name: "acme", version: "1" }), "plugin_invalid", "no entry file"],
    ["a conditional exports map", withManifest({ name: "acme", version: "1", exports: { ".": { import: "./dist/index.js" } } }), "plugin_invalid", "no entry file"],
    ["an entry that was not uploaded", withManifest({ name: "acme", version: "1", exports: { ".": "./dist/missing.js" } }), "plugin_invalid", "not among the uploaded files"],
    ["an entry outside the folder", withManifest({ name: "acme", version: "1", exports: { ".": "../outside.js" } }), "plugin_invalid", "not among the uploaded files"],
    ["an entry that is the manifest", withManifest({ name: "acme", version: "1", exports: { ".": "./package.json" } }), "plugin_invalid", "must be a script under dist/"],
    ["a file that is also a folder", { ...pluginFiles(), "dist/index.js/x.js": b64("y") }, "plugin_invalid", "both a file and a folder"],
    ["node_modules at the top", { ...pluginFiles(), "node_modules/dep/index.js": b64("x") }, "plugin_node_modules", "bundle the dependencies"],
    ["node_modules inside dist", { ...pluginFiles(), "dist/node_modules/dep.js": b64("x") }, "plugin_node_modules", "bundle the dependencies"],
    ["a bonez-scoped name", withManifest({ name: "@bonez/x", version: "1", exports: { ".": "./dist/index.js" } }), "plugin_reserved_name", "reserved"],
  ]
  for (const [what, files, code, phrase] of cases) {
    test(`refuses ${what}`, () => {
      const { error } = vetUpload(files)
      assert.ok(error, "must be refused")
      assert.equal(error.status, 422)
      assert.equal(error.code, code)
      assert.ok(error.detail.includes(phrase), `${JSON.stringify(error.detail)} should mention ${phrase}`)
    })
  }

  test("refuses a name the server has compiled in, whatever its scope", () => {
    assert.equal(vetUpload(pluginFiles("video-review"), { builtIn: ["video-review"] }).error.code, "plugin_reserved_name")
    assert.equal(vetUpload(pluginFiles("video-review")).error, undefined)
  })

  test("refuses a wrong hash and names both", () => {
    const sha = vetUpload(pluginFiles()).sha256
    const { error } = vetUpload(pluginFiles(), { claimedSha256: "0".repeat(64) })
    assert.equal(error.code, "plugin_hash_mismatch")
    assert.equal(error.detail, `files hash to ${sha}, you sent ${"0".repeat(64)}`)
  })

  test("accepts exactly the size cap and refuses one byte over", () => {
    const base = pluginFiles()
    const used = Buffer.from(base["package.json"], "base64").length + Buffer.from(base["dist/index.js"], "base64").length
    const room = LIMITS.MAX_BYTES - used
    const at = vetUpload({ ...base, "dist/data.txt": Buffer.alloc(room).toString("base64") })
    assert.equal(at.error, undefined)
    assert.equal(at.size, LIMITS.MAX_BYTES)
    const over = vetUpload({ ...base, "dist/data.txt": Buffer.alloc(room + 1).toString("base64") })
    assert.equal(over.error.code, "plugin_too_large")
  })

  test("every extension the server lists is accepted under dist/", () => {
    for (const ext of DIST_EXTENSIONS) assert.equal(vetUpload({ ...pluginFiles(), [`dist/asset${ext}`]: b64("x") }).error, undefined, ext)
  })

  test("a key such as 'constructor' is a missing file, not one found on the prototype", () => {
    const { error } = vetUpload(withManifest({ name: "acme", version: "1", exports: { ".": "constructor" } }))
    assert.match(error.detail, /not among the uploaded files/)
  })
})

describe("over http", () => {
  async function call(server, method, path, { key, body } = {}) {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }

  test("a refusal carries the gateway's code and detail; the framework's own 422 carries a list", async () => {
    const server = await startFakePluginServer()
    try {
      const refused = await call(server, "POST", "/api/admin/org/plugins", { body: { files: { ...pluginFiles(), ".DS_Store": b64("x") } } })
      assert.equal(refused.status, 422)
      assert.equal(refused.body.code, "plugin_invalid")
      const extra = await call(server, "POST", "/api/admin/org/plugins", { body: { files: pluginFiles(), env: { HYDRA_URL: "http://x" } } })
      assert.equal(extra.status, 422)
      assert.equal(extra.body.detail[0].type, "extra_forbidden")
      const none = await call(server, "POST", "/api/admin/org/plugins", { body: {} })
      assert.equal(none.status, 422)
      assert.equal(none.body.detail[0].loc.join("."), "body.files")
      assert.equal((await call(server, "POST", "/api/admin/org/plugins/x", { body: {} })).status, 404)
    } finally {
      await server.close()
    }
  })

  test("an upload is listed as the active version, with each computer's state; the same files again are identical", async () => {
    const key = "bnz_" + "ab".repeat(24)
    const server = await startFakePluginServer({ key, computers: 2, state: "syncing" })
    try {
      assert.equal((await call(server, "GET", "/api/org/plugins")).status, 401)
      const first = await call(server, "POST", "/api/admin/org/plugins", { key, body: { files: pluginFiles("@acme/pi-demo", "1.0.0") } })
      assert.equal(first.status, 200)
      assert.deepEqual({ ...first.body, sha256: undefined }, { name: "@acme/pi-demo", version: "1.0.0", sha256: undefined, size: first.body.size, active: true, identical: false, computers: 2 })
      const again = await call(server, "POST", "/api/admin/org/plugins", { key, body: { files: pluginFiles("@acme/pi-demo", "1.0.0") } })
      assert.equal(again.body.identical, true)
      await call(server, "POST", "/api/admin/org/plugins", { key, body: { files: pluginFiles("@acme/pi-demo", "1.1.0") } })
      const listed = (await call(server, "GET", "/api/org/plugins", { key })).body.plugins
      assert.equal(listed.length, 1)
      assert.equal(listed[0].versions.find((v) => v.active).version, "1.1.0")
      assert.deepEqual(listed[0].computers.map((c) => c.state), ["syncing", "syncing"])
    } finally {
      await server.close()
    }
  })
})
