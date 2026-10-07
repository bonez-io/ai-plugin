#!/usr/bin/env node
// bonez-package-hash <folder> — prints the tree hash of a Bonez plugin folder (the sha256 an admin
// puts in BONEZ_PI_PACKAGES_SHA256). The loader in bonez-core implements this SAME algorithm:
//
//   1. Walk the folder recursively; collect every regular file, skipping anything under a `.git/` directory.
//   2. Any symlink -> refuse (exit 1). A `node_modules/` directory anywhere -> refuse (exit 1).
//   3. Sort the files by relative POSIX path (forward slashes), plain byte (UTF-8) order.
//   4. For each file build the line  <relpath> NUL <lowercase hex sha256 of the file bytes> "\n".
//   5. The tree hash is the lowercase hex sha256 of the concatenation of those lines.
//
// Prints the hash and a newline on stdout, nothing else. Errors go to stderr. Node built-ins only.
// Do not change this algorithm without changing the loader: a different hash means the package is rejected.
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

function die(message) {
  console.error(`bonez-package-hash: ${message}`)
  process.exit(1)
}

function collect(root) {
  const files = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) die(`symlink not allowed: ${relPath}`)
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue // never hashed, never descended
        if (entry.name === "node_modules") die(`node_modules/ not allowed (bundle the dependencies instead): ${relPath}`)
        walk(join(dir, entry.name), relPath)
      } else if (entry.isFile()) {
        files.push({ rel: relPath, abs: join(dir, entry.name) })
      } // sockets, fifos and devices are not regular files: skipped
    }
  }
  walk(root, "")
  return files
}

const folder = process.argv[2]
if (!folder || process.argv.length > 3) {
  console.error("usage: bonez-package-hash <folder>")
  process.exit(2)
}

let stat
try {
  stat = lstatSync(folder)
} catch (err) {
  die(`cannot read ${folder}: ${err.code ?? err.message}`)
}
if (stat.isSymbolicLink()) die(`symlink not allowed: ${folder}`)
if (!stat.isDirectory()) die(`not a directory: ${folder}`)

const files = collect(folder)
// Buffer.compare is UTF-8 byte order; the default string sort is UTF-16 code-unit order and differs for some non-ASCII names.
files.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)))

const tree = createHash("sha256")
for (const { rel, abs } of files) tree.update(`${rel}\0${sha256(readFileSync(abs))}\n`)
console.log(tree.digest("hex"))
