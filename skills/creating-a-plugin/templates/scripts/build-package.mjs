// Builds the folder you hand to Bonez: out/<name>/ holding package.json + dist/index.js, nothing else.
// Every dependency is bundled into dist/index.js (no --external), because the folder ships WITHOUT
// node_modules. The Pi import in src/index.ts is `import type`, so it is erased and nothing of Pi is bundled.
// Run it as `bun run build:package`. It ends by printing the tree hash of out/<name>/ (scripts/tree-hash.mjs):
// the value `bonez-package-hash.mjs` prints for that folder and `bonez-plugin-push.mjs` sends with it.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { treeHash } from "./tree-hash.mjs"

// Run it with bun (`bun run build:package`), and spawn that same bun: a `bun` found on PATH can be a
// .cmd shim on Windows (an npm global install), which spawnSync cannot start without a shell.
if (!process.versions.bun) {
  console.error("run this with bun: bun run build:package")
  process.exit(1)
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const name = pkg.name.replace(/^@[^/]+\//, "").replace(/^pi-/, "")
const out = `out/${name}`

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const build = spawnSync(process.execPath, ["build", "src/index.ts", "--target", "bun", "--outfile", `${out}/dist/index.js`], {
  stdio: "inherit",
})
if (build.status !== 0) {
  console.error("bun build failed")
  process.exit(build.status ?? 1)
}

// Same name and version; no scripts, devDependencies, peerDependencies or `pi` block (they point at files that are not shipped).
const slim = {
  name: pkg.name,
  version: pkg.version,
  type: "module",
  license: pkg.license,
  description: pkg.description,
  exports: { ".": "./dist/index.js" },
}
writeFileSync(`${out}/package.json`, `${JSON.stringify(slim, null, 2)}\n`)
console.log(`built ${out}`)

let hash
try {
  hash = treeHash(out)
} catch (err) {
  console.error(`cannot hash ${out}: ${err.message}`)
  process.exit(1)
}
console.log(`sha256: ${hash}`)
