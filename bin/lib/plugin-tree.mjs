// The plugin tree walk and tree hash, shared by bonez-package-hash.mjs and bonez-plugin-push.mjs.
// One copy, so the number the hash tool prints is the number the push tool sends, on every OS.
//
// The algorithm is pinned for four other implementations (the gateway, the harness loader, the
// runner; see libs/wire/contracts/computers/fixtures/plugin-tree.json in bonez-core) and tested
// against those vectors in tests/plugin_tree.test.mjs. Do not change it without changing them:
//
//   1. Walk the folder recursively; collect every regular file, skipping anything under a `.git/` directory.
//   2. Any symlink (or Windows junction) -> refuse. A `node_modules/` directory anywhere -> refuse.
//   3. Sort the files by relative POSIX path (forward slashes), plain byte (UTF-8) order.
//   4. For each file build the line  <relpath> NUL <lowercase hex sha256 of the file bytes> "\n".
//   5. The tree hash is the lowercase hex sha256 of the concatenation of those lines.
//
// The hash is over BYTES: never normalise line endings, never strip a BOM. Node built-ins only.
import { createHash } from "node:crypto"
import { lstatSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

// What the CLIs turn into their own exit code and message. Anything else thrown is a bug.
export class FolderError extends Error {}

// The path a file has in the tree: segments joined by "/" on every OS. `path.relative` gives the
// platform's own separator, so on Windows `dist\index.js` becomes `dist/index.js`. Only Windows is
// converted: on POSIX a backslash is an ordinary (if unwelcome) character of a file name, and
// rewriting it would make the tool hash a file that is not the one on disk. `win32` is a parameter
// so the tests can feed Windows-style paths on any machine.
export const toTreePath = (rel, win32 = process.platform === "win32") => (win32 ? rel.replaceAll("\\", "/") : rel)

// Plain UTF-8 byte order of the tree path. Buffer.compare, not the default string sort: that is
// UTF-16 code-unit order, which differs for some non-ASCII names. Locale never enters.
const byPath = (a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))

// Every regular file under `folder`, as [{ path: tree path, abs }], sorted. Throws FolderError.
// Classified with lstat, not the Dirent type from readdir: Windows reports every reparse point as a
// link there (a OneDrive placeholder included), and lstat tells a real symlink or junction apart.
export function listFolder(folder) {
  let top
  try {
    top = lstatSync(folder)
  } catch (err) {
    throw new FolderError(`cannot read ${folder}: ${err.code ?? err.message}`)
  }
  if (top.isSymbolicLink()) throw new FolderError(`symlink not allowed: ${folder}`)
  if (!top.isDirectory()) throw new FolderError(`not a directory: ${folder}`)

  const files = []
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch (err) {
      throw new FolderError(`cannot read ${toTreePath(relative(folder, dir)) || folder}: ${err.code ?? err.message}`)
    }
    for (const name of names) {
      const abs = join(dir, name)
      const path = toTreePath(relative(folder, abs))
      const stat = lstatSync(abs)
      if (stat.isSymbolicLink()) throw new FolderError(`symlink not allowed: ${path}`)
      if (stat.isDirectory()) {
        if (name === ".git") continue // never hashed, never descended
        if (name === "node_modules") throw new FolderError(`node_modules/ not allowed (bundle the dependencies instead): ${path}`)
        walk(abs)
      } else if (stat.isFile()) {
        files.push({ path, abs })
      } // sockets, fifos and devices are not regular files: skipped
    }
  }
  walk(folder)
  return files.sort(byPath)
}

// entries: [{ path, sha256 }] with tree paths, in any order. Returns the tree hash.
export function treeHash(entries) {
  const tree = createHash("sha256")
  for (const { path, sha256: hex } of [...entries].sort(byPath)) tree.update(`${path}\0${hex}\n`)
  return tree.digest("hex")
}
