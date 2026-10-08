// The tree hash of the built folder out/<name>/: the sha256 the push tool sends and the hash tool prints
// (bin/bonez-plugin-push.mjs and bin/bonez-package-hash.mjs of the Bonez plugin), and the pin an operator
// puts in BONEZ_PI_PACKAGES_SHA256. `bun run build:package` prints it. Same algorithm as those tools:
//   one line per regular file, "<relative path with />" NUL "<hex sha256 of its bytes>" "\n", sorted by the
//   path's UTF-8 bytes, hashed again with sha256. It is over bytes: line endings and a BOM are never touched.
// It refuses what those tools refuse: a symlink, a node_modules/ folder, and the files Finder and Explorer
// add (.DS_Store, Thumbs.db, desktop.ini), which the server does not accept. `.git/` is skipped.
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const FILE_MANAGER_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"])

export function treeHash(folder) {
  const files = []
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const path = `${prefix}${name}`
      const abs = join(dir, name)
      const stat = lstatSync(abs)
      if (stat.isSymbolicLink()) throw new Error(`symlink not allowed: ${path}`)
      if (stat.isDirectory()) {
        if (name === ".git") continue
        if (name === "node_modules") throw new Error(`node_modules/ not allowed (bundle the dependencies instead): ${path}`)
        walk(abs, `${path}/`)
      } else if (stat.isFile()) {
        if (FILE_MANAGER_FILES.has(name.toLowerCase())) throw new Error(`${path} was added by Finder or Explorer and the server refuses it: delete it, then build again`)
        files.push({ path, hash: sha256(readFileSync(abs)) })
      }
    }
  }
  walk(folder, "")
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  return sha256(Buffer.from(files.map((f) => `${f.path}\0${f.hash}\n`).join("")))
}
