// The plugin tree hash against the SHARED vectors, and the Windows rules around it.
//
// tests/fixtures/plugin-tree.json is a copy of bonez-core's libs/wire/contracts/computers/fixtures/plugin-tree.json:
// the vectors the gateway, the harness loader, the runner and this repo's tools must all reproduce. If these
// tests pass on a machine, the tools there give the gateway's hash for the same bytes. They run on Windows in
// CI (the windows-latest job), where the folder is walked with backslash paths and the files may be CRLF.
//
// Offline and dependency-free (Node's built-in runner).
// Run: node --test tests/plugin_tree.test.mjs   (or ./tests/test_windows.sh)
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { FolderError, listFolder, sha256, toTreePath, treeHash } from "../bin/lib/plugin-tree.mjs"
import { startFakePluginServer } from "./lib/fake-plugin-server.mjs"
import { symlinkOrSkip } from "./lib/fs-helpers.mjs"
import { VECTORS, decode, materialize } from "./lib/vectors.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const HASH = join(HERE, "..", "bin", "bonez-package-hash.mjs")
const PUSH = join(HERE, "..", "bin", "bonez-plugin-push.mjs")
const KEY = "bnz_" + "ab".repeat(24)

const roots = []
function freshDir(prefix = "tree") {
  const dir = mkdtempSync(join(tmpdir(), `bonez-${prefix}-`))
  roots.push(dir)
  return dir
}
process.on("exit", () => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))

function put(root, rel, content) {
  const abs = join(root, ...rel.split("/"))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

const hashCli = (folder) => spawnSync(process.execPath, [HASH, folder], { encoding: "utf8" })
const entriesOf = (files) => Object.entries(files).map(([path, bytes]) => ({ path, sha256: sha256(bytes) }))

describe("the shared vectors", () => {
  assert.ok(VECTORS.length >= 2, "the fixture must carry the 'hello' and 'ordering' vectors")

  for (const vector of VECTORS) {
    test(`${vector.name}: treeHash over the decoded bytes is the pinned hash`, () => {
      const files = decode(vector)
      assert.equal(Object.values(files).reduce((n, b) => n + b.length, 0), vector.size)
      assert.equal(treeHash(entriesOf(files)), vector.tree_sha256)
    })

    test(`${vector.name}: bonez-package-hash on the vector written out as a real folder`, () => {
      const r = hashCli(materialize(vector, freshDir(`vec-${vector.name}`)))
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, `${vector.tree_sha256}\n`)
      assert.equal(r.stderr, "")
    })

    test(`${vector.name}: Windows-style paths (backslashes) give the same hash, in any order`, () => {
      const winPaths = Object.entries(decode(vector)).map(([path, bytes]) => ({
        path: toTreePath(path.replaceAll("/", "\\"), true), // what path.relative() returns on Windows
        sha256: sha256(bytes),
      }))
      assert.ok(winPaths.every((e) => !e.path.includes("\\")))
      assert.equal(treeHash(winPaths), vector.tree_sha256)
      assert.equal(treeHash([...winPaths].reverse()), vector.tree_sha256)
    })

    test(`${vector.name}: the push CLI uploads exactly these forward-slash paths and this hash`, async () => {
      const server = await startFakePluginServer({ key: KEY })
      try {
        const folder = materialize(vector, freshDir(`push-${vector.name}`))
        const r = await new Promise((resolve) =>
          execFile(process.execPath, [PUSH, folder], { env: { ...process.env, BONEZ_URL: server.url, BONEZ_API_KEY: KEY }, encoding: "utf8" },
            (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })))
        assert.equal(r.status, 0, r.stderr)
        assert.equal(server.requests.length, 1)
        const seen = server.requests[0]
        assert.equal(seen.outcome, "ok")
        assert.deepEqual([...seen.paths].sort(), Object.keys(vector.files).sort())
        assert.equal(seen.claimed, vector.tree_sha256)
        assert.equal(seen.recomputed, vector.tree_sha256, "the gateway's own algorithm agrees")
        assert.ok(r.stdout.includes(`fingerprint: ${vector.tree_sha256}`), r.stdout)
      } finally {
        await server.close()
      }
    })
  }
})

describe("toTreePath", () => {
  test("on Windows every backslash becomes a slash, whatever the mix", () => {
    assert.equal(toTreePath("dist\\a\\b.js", true), "dist/a/b.js")
    assert.equal(toTreePath("dist\\a/b.js", true), "dist/a/b.js")
    assert.equal(toTreePath("package.json", true), "package.json")
  })

  test("off Windows a backslash is a character of the name and is left alone", () => {
    assert.equal(toTreePath("dist\\a.js", false), "dist\\a.js")
    assert.equal(toTreePath("dist/a.js", false), "dist/a.js")
  })

  test("the default follows this machine, and a real walk never yields a backslash", () => {
    const root = freshDir("walk")
    for (const rel of ["package.json", "dist/index.js", "dist/deep/er/x.js", "dist/B.js", "dist/a.js"]) put(root, rel, rel)
    const paths = listFolder(root).map((f) => f.path)
    assert.deepEqual(paths, ["dist/B.js", "dist/a.js", "dist/deep/er/x.js", "dist/index.js", "package.json"])
    assert.ok(paths.every((p) => !p.includes("\\")))
  })
})

describe("the hash is over bytes", () => {
  const expected = (files) =>
    createHash("sha256")
      .update(Buffer.concat(Object.keys(files).sort().map((p) => Buffer.from(`${p}\0${createHash("sha256").update(files[p]).digest("hex")}\n`))))
      .digest("hex")

  test("CRLF and LF are different files with different hashes: line endings are never normalised", () => {
    const lf = freshDir("lf")
    const crlf = freshDir("crlf")
    put(lf, "package.json", Buffer.from('{"name":"x"}\n'))
    put(crlf, "package.json", Buffer.from('{"name":"x"}\r\n'))
    const a = hashCli(lf).stdout.trim()
    const b = hashCli(crlf).stdout.trim()
    assert.notEqual(a, b)
    assert.equal(a, expected({ "package.json": Buffer.from('{"name":"x"}\n') }))
    assert.equal(b, expected({ "package.json": Buffer.from('{"name":"x"}\r\n') }))
  })

  test("a UTF-8 BOM is part of the bytes", () => {
    const withBom = freshDir("bom")
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"name":"x"}')])
    put(withBom, "package.json", bytes)
    assert.equal(hashCli(withBom).stdout.trim(), expected({ "package.json": bytes }))
  })

  test("non-UTF-8 bytes and an empty file survive untouched", () => {
    const root = freshDir("bin")
    const files = { "dist/blob.txt": Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a]), "dist/empty.txt": Buffer.alloc(0), "package.json": Buffer.from("{}") }
    for (const [p, b] of Object.entries(files)) put(root, p, b)
    assert.equal(hashCli(root).stdout.trim(), expected(files))
  })
})

describe("what is refused", () => {
  test("a symlink to a directory", (t) => {
    const root = freshDir("symdir")
    put(root, "package.json", "{}")
    put(root, "real/x.js", "x")
    if (!symlinkOrSkip(t, join(root, "real"), join(root, "link"), "dir")) return
    assert.throws(() => listFolder(root), (e) => e instanceof FolderError && /symlink not allowed: link/.test(e.message))
  })

  // A junction is what `mklink /J` makes and needs no privilege, so this one runs on every Windows
  // machine. (Windows only: a junction cannot be made elsewhere.)
  test("a Windows directory junction", { skip: process.platform !== "win32" && "Windows only" }, (t) => {
    const root = freshDir("junction")
    put(root, "package.json", "{}")
    put(root, "real/x.js", "x")
    if (!symlinkOrSkip(t, join(root, "real"), join(root, "junc"), "junction")) return
    const r = hashCli(root)
    assert.equal(r.status, 1, "a junction must be refused like a symlink")
    assert.match(r.stderr, /symlink not allowed: junc/)
    assert.equal(r.stdout, "")
  })

  test("node_modules/ anywhere, and a file named like it is fine", () => {
    const root = freshDir("nm")
    put(root, "package.json", "{}")
    put(root, "dist/node_modules/x/index.js", "x")
    assert.throws(() => listFolder(root), (e) => e instanceof FolderError && /node_modules\/ not allowed/.test(e.message))
    const ok = freshDir("nm-ok")
    put(ok, "package.json", "{}")
    put(ok, "node_modules.txt", "x")
    assert.deepEqual(listFolder(ok).map((f) => f.path), ["node_modules.txt", "package.json"])
  })
})
