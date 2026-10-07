// Tests for bin/bonez-package-hash.mjs and the plugin-creator template's build script.
//
// Offline and dependency-free (Node's built-in runner). The hash cases need only node; the template
// build case needs `bun` and skips itself when it is missing. A loader in bonez-core implements the same
// tree-hash algorithm, so the pinned vector below must never change without that loader changing too.
//
// Run: node --test tests/package_hash.test.mjs   (or ./tests/test_package_hash.sh)
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..")
const SCRIPT = join(REPO_ROOT, "bin", "bonez-package-hash.mjs")
const TEMPLATES = join(REPO_ROOT, "skills", "creating-a-plugin", "templates")

// Spec test vector: two files, hash computed by the algorithm in the script header.
const VECTOR_PACKAGE_JSON = '{"name":"@example/pi-hello","exports":{".":"./dist/index.js"}}' // no trailing newline
const VECTOR_INDEX_JS = "export default function () {}\n"
const VECTOR_HASH = "5dcf9ea45d1b202f72be9c654527081bb0ce0ed403902e92bf1f8f178bce72cb"

const roots = []
function freshDir(prefix = "pkg-hash") {
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

function hash(folder) {
  const r = spawnSync(process.execPath, [SCRIPT, folder], { encoding: "utf8" })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function hashOk(folder) {
  const r = hash(folder)
  assert.equal(r.status, 0, `hash failed: ${r.stderr}`)
  assert.match(r.stdout, /^[0-9a-f]{64}\n$/, "stdout must be exactly the hash and a newline")
  assert.equal(r.stderr, "", "stderr must be empty on success")
  return r.stdout.trim()
}

// The algorithm written out independently of the script: files given in the order they must sort.
function expectedHash(filesInOrder) {
  const tree = createHash("sha256")
  for (const [rel, content] of filesInOrder) {
    tree.update(`${rel}\0${createHash("sha256").update(content).digest("hex")}\n`)
  }
  return tree.digest("hex")
}

function vectorTree(root = freshDir("vector")) {
  put(root, "package.json", VECTOR_PACKAGE_JSON)
  put(root, "dist/index.js", VECTOR_INDEX_JS)
  return root
}

describe("tree hash", () => {
  test("test vector", () => {
    assert.equal(hashOk(vectorTree()), VECTOR_HASH)
    assert.equal(
      expectedHash([
        ["dist/index.js", VECTOR_INDEX_JS],
        ["package.json", VECTOR_PACKAGE_JSON],
      ]),
      VECTOR_HASH,
    )
  })

  test("deterministic: creation order, mtimes and a trailing slash do not matter", () => {
    const a = freshDir("order-a")
    put(a, "package.json", VECTOR_PACKAGE_JSON)
    put(a, "dist/index.js", VECTOR_INDEX_JS)
    put(a, "dist/deep/x.txt", "x")
    const b = freshDir("order-b")
    put(b, "dist/deep/x.txt", "x")
    put(b, "dist/index.js", VECTOR_INDEX_JS)
    put(b, "package.json", VECTOR_PACKAGE_JSON)
    assert.equal(hashOk(a), hashOk(b))
    assert.equal(hashOk(a), hashOk(`${a}/`))
  })

  test("sorts by full relative path in byte order, not per directory and not by locale", () => {
    const root = freshDir("sort")
    // Naive sorts get these wrong: per-directory order puts "a/b" before "a.b" ('/' is 0x2f, '.' is 0x2e);
    // locale order puts "a.txt" before "B.txt"; UTF-16 order puts the emoji before U+FF5E (surrogates are 0xD8xx).
    const files = [
      ["B.txt", "1"],
      ["a.b", "2"],
      ["a.txt", "3"],
      ["a/b", "4"],
      ["z.txt", "5"],
      ["é.txt", "6"],
      ["\u{1F600}.txt", "7"],
      ["～.txt", "8"],
    ]
    for (const [rel, content] of files) put(root, rel, content)
    const byBytes = [...files].sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])))
    assert.deepEqual(
      byBytes.map((f) => f[0]),
      ["B.txt", "a.b", "a.txt", "a/b", "z.txt", "é.txt", "～.txt", "\u{1F600}.txt"],
    )
    assert.equal(hashOk(root), expectedHash(byBytes))
  })

  test("content, name and extra files all change the hash", () => {
    const base = hashOk(vectorTree())
    const edited = vectorTree()
    put(edited, "dist/index.js", `${VECTOR_INDEX_JS} `)
    assert.notEqual(hashOk(edited), base)
    const renamed = freshDir("renamed")
    put(renamed, "package.json", VECTOR_PACKAGE_JSON)
    put(renamed, "dist/main.js", VECTOR_INDEX_JS)
    assert.notEqual(hashOk(renamed), base)
    const extra = vectorTree()
    put(extra, "README.md", "hi")
    assert.notEqual(hashOk(extra), base)
  })

  test(".git/ is never hashed, even with a symlink inside it; a .git FILE is hashed", () => {
    const root = vectorTree()
    put(root, ".git/HEAD", "ref: refs/heads/main\n")
    put(root, "sub/.git/config", "x")
    symlinkSync("/nonexistent", join(root, ".git", "link"))
    assert.equal(hashOk(root), VECTOR_HASH)
    put(root, "sub/.git2", "x") // only a directory named exactly .git is skipped
    assert.notEqual(hashOk(root), VECTOR_HASH)
  })

  test("an empty folder hashes to the sha256 of the empty string", () => {
    assert.equal(hashOk(freshDir("empty")), createHash("sha256").update("").digest("hex"))
  })
})

describe("refusals", () => {
  function refuses(root, pattern) {
    const r = hash(root)
    assert.notEqual(r.status, 0, "must exit non-zero")
    assert.equal(r.stdout, "", "must print no hash")
    assert.match(r.stderr, pattern)
  }

  test("symlink to a file", () => {
    const root = vectorTree()
    symlinkSync(join(root, "package.json"), join(root, "link.json"))
    refuses(root, /symlink not allowed: link\.json/)
  })

  test("symlink to a directory, nested", () => {
    const root = vectorTree()
    symlinkSync(join(root, "dist"), join(root, "dist", "loop"))
    refuses(root, /symlink not allowed: dist\/loop/)
  })

  test("dangling symlink", () => {
    const root = vectorTree()
    symlinkSync("/nonexistent/target", join(root, "dangling"))
    refuses(root, /symlink not allowed: dangling/)
  })

  test("the folder argument itself being a symlink", () => {
    const root = vectorTree()
    const link = join(freshDir("linkroot"), "pkg")
    symlinkSync(root, link)
    refuses(link, /symlink not allowed/)
  })

  test("node_modules at the top level and nested", () => {
    const top = vectorTree()
    put(top, "node_modules/left-pad/index.js", "x")
    refuses(top, /node_modules\/ not allowed/)
    const nested = vectorTree()
    put(nested, "dist/vendor/node_modules/x/index.js", "x")
    refuses(nested, /node_modules\/ not allowed/)
    const empty = vectorTree()
    mkdirSync(join(empty, "node_modules"))
    refuses(empty, /node_modules\/ not allowed/)
  })

  test("a file merely named like node_modules is fine", () => {
    const root = vectorTree()
    put(root, "node_modules.txt", "x")
    assert.match(hash(root).stdout, /^[0-9a-f]{64}\n$/)
  })

  test("missing folder, a file instead of a folder, no argument, too many arguments", () => {
    refuses(join(freshDir("missing"), "nope"), /cannot read/)
    refuses(join(vectorTree(), "package.json"), /not a directory/)
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" })
    assert.equal(none.status, 2)
    assert.match(none.stderr, /usage/)
    const two = spawnSync(process.execPath, [SCRIPT, "a", "b"], { encoding: "utf8" })
    assert.equal(two.status, 2)
  })
})

// The template's build script: needs bun (not installed in CI), no network (the Pi import is type-only).
const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0

describe("template build:package", { skip: !hasBun && "bun not installed" }, () => {
  function instantiate() {
    const dir = freshDir("template")
    cpSync(TEMPLATES, dir, { recursive: true })
    const pkgPath = join(dir, "package.json")
    writeFileSync(
      pkgPath,
      readFileSync(pkgPath, "utf8").replace("__PACKAGE_NAME__", "@example/pi-hello").replace("__DESCRIPTION__", "Hello plugin"),
    )
    return dir
  }

  function build(dir) {
    const r = spawnSync("bun", ["run", "build:package"], { cwd: dir, encoding: "utf8" })
    assert.equal(r.status, 0, `build failed: ${r.stdout}${r.stderr}`)
  }

  test("template has no placeholder left after the two are filled in, and the scripts exist", () => {
    const dir = instantiate()
    for (const f of ["package.json", "src/index.ts"]) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /__[A-Z_]+__/)
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    for (const s of ["test", "typecheck", "build:package"]) assert.ok(pkg.scripts[s], `scripts.${s}`)
  })

  test("out/<name>/ holds only package.json and dist/index.js, and hashes the same after a rebuild", () => {
    const dir = instantiate()
    build(dir)
    const out = join(dir, "out", "hello")
    const listing = []
    const walk = (d, rel = "") => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        e.isDirectory() ? walk(join(d, e.name), `${rel}${e.name}/`) : listing.push(`${rel}${e.name}`)
      }
    }
    walk(out)
    assert.deepEqual(listing.sort(), ["dist/index.js", "package.json"])
    assert.ok(!existsSync(join(out, "node_modules")))

    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"))
    assert.deepEqual(pkg, {
      name: "@example/pi-hello",
      version: "0.1.0",
      type: "module",
      license: "MIT",
      description: "Hello plugin",
      exports: { ".": "./dist/index.js" },
    })

    const bundle = readFileSync(join(out, "dist", "index.js"), "utf8")
    assert.doesNotMatch(bundle, /pi-coding-agent/, "the Pi types are type-only: nothing of Pi is bundled")
    assert.match(bundle, /export\s*\{[^}]*as default/, "default export survives the bundle")

    const first = hashOk(out)
    build(dir)
    assert.equal(hashOk(out), first)
  })

  test("a failing build stops with a non-zero exit and leaves no half-built package.json", () => {
    const dir = instantiate()
    writeFileSync(join(dir, "src", "index.ts"), "export default function ( {\n")
    const r = spawnSync("bun", ["run", "build:package"], { cwd: dir, encoding: "utf8" })
    assert.notEqual(r.status, 0)
    assert.ok(!existsSync(join(dir, "out", "hello", "package.json")))
  })
})
