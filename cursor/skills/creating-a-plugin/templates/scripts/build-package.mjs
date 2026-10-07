// Builds the folder you hand to Bonez: out/<name>/ holding package.json + dist/index.js, nothing else.
// Every dependency is bundled into dist/index.js (no --external), because the folder ships WITHOUT
// node_modules. The Pi import in src/index.ts is `import type`, so it is erased and nothing of Pi is bundled.
// Run it as `bun run build:package`.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const name = pkg.name.replace(/^@[^/]+\//, "").replace(/^pi-/, "")
const out = `out/${name}`

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const build = spawnSync("bun", ["build", "src/index.ts", "--target", "bun", "--outfile", `${out}/dist/index.js`], {
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
