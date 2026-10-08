// The shared tree-hash vectors (tests/fixtures/plugin-tree.json, copied from bonez-core's
// libs/wire/contracts/computers/fixtures/plugin-tree.json) as bytes and as folders on disk.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

export const VECTORS = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "plugin-tree.json"), "utf8")).vectors

// { "dist/a.js": Buffer }: the upload body of a vector, decoded.
export const decode = (vector) => Object.fromEntries(Object.entries(vector.files).map(([path, b64]) => [path, Buffer.from(b64, "base64")]))

// Write a vector out as a real folder under `root` (a native path per file: backslashes on Windows).
export function materialize(vector, root) {
  for (const [rel, bytes] of Object.entries(decode(vector))) {
    const abs = join(root, ...rel.split("/"))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, bytes)
  }
  return root
}
