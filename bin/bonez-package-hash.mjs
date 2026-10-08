#!/usr/bin/env node
// bonez-package-hash <folder> — prints the tree hash of a Bonez plugin folder (the sha256 an admin
// puts in BONEZ_PI_PACKAGES_SHA256). The loader in bonez-core implements this SAME algorithm; the
// steps are written out in lib/plugin-tree.mjs, which this script and bonez-plugin-push.mjs share.
//
// Prints the hash and a newline on stdout, nothing else. Errors go to stderr: exit 1 for a folder
// that cannot be hashed (symlink, node_modules/, unreadable), 2 for bad usage. Node built-ins only.
// Do not change the algorithm without changing the loader: a different hash means the package is rejected.
// Run it as `node bin/bonez-package-hash.mjs <folder>` (the same on Windows; the shebang is for POSIX only).
import { readFileSync } from "node:fs"
import { FolderError, listFolder, sha256, treeHash } from "./lib/plugin-tree.mjs"

function die(message) {
  console.error(`bonez-package-hash: ${message}`)
  process.exit(1)
}

const folder = process.argv[2]
if (!folder || process.argv.length > 3) {
  console.error("usage: bonez-package-hash <folder>")
  process.exit(2)
}

let hash
try {
  hash = treeHash(listFolder(folder).map(({ path, abs }) => ({ path, sha256: sha256(readFileSync(abs)) })))
} catch (err) {
  // A file another program holds open (Windows: EBUSY, EPERM) is a refusal too, not a stack trace.
  die(err instanceof FolderError ? err.message : `cannot read ${err.path ?? folder}: ${err.code ?? err.message}`)
}
console.log(hash)
