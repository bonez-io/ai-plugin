#!/usr/bin/env node
// Draws the Bonez wordmark (the mark and "bonez") as terminal art, for bin/lib/connect-tui.mjs and the installer
// (bonez-core services/gateway/src/bonez_gateway/mcp_install_assets/install.sh). Run by hand when the
// logo changes; nothing runs it at install time.
//
//   node scripts/terminal-mark.mjs <bonez-core>/libs/ui/src/components/logo.tsx
//
// It takes the SVG paths of `Logo` (viewBox 0 0 154 34) from logo.tsx, fills them on a
// canvas in headless Chrome (no dependency to install), and maps each terminal cell to a quadrant block
// (▘▝▀▖▌▞▛▗▚▐▜▄▙▟█): a cell is 2 x 2 subpixels, a subpixel is on when the shape covers more than 40% of it, and
// the drawing is stretched twice across so it keeps its proportions in cells twice as tall as wide.
// Prints the rows as JSON; the install.sh form (octal escapes, so the script stays ASCII) with --sh.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [logoTsx, flag] = process.argv.slice(2)
if (!logoTsx) {
  console.error("usage: node scripts/terminal-mark.mjs <path to libs/ui/src/components/logo.tsx> [--sh]")
  process.exit(1)
}
const d = [...readFileSync(logoTsx, "utf8").matchAll(/\sd="([^"]+)"/g)].map((m) => m[1])
const paths = { logo: d.slice(4, 13) } // the first four are `Mark`'s

const page = `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const P = ${JSON.stringify(paths)}
const Q = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"
function art(paths, vw, vh, rows, thresh) {
  const subH = rows * 2, scale = subH / vh, sx = scale * 2
  const cols = Math.ceil((vw * sx) / 2), S = 16
  const c = document.createElement("canvas"); c.width = cols * 2 * S; c.height = subH * S
  const g = c.getContext("2d")
  g.setTransform(sx * S, 0, 0, scale * S, ((cols * 2 - vw * sx) / 2) * S, 0)
  for (const p of paths) g.fill(new Path2D(p))
  const px = g.getImageData(0, 0, c.width, c.height).data
  const on = (x0, y0) => { let n = 0; for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) n += px[((y0 * S + y) * c.width + x0 * S + x) * 4 + 3] > 127; return n / (S * S) > thresh }
  const out = []
  for (let r = 0; r < rows; r++) { let l = ""; for (let k = 0; k < cols; k++) l += Q[on(2*k,2*r) | on(2*k+1,2*r)<<1 | on(2*k,2*r+1)<<2 | on(2*k+1,2*r+1)<<3]; out.push(l.replace(/\\s+$/, "")) }
  return out
}
document.getElementById("out").textContent = JSON.stringify({ wordmark: art(P.logo, 154, 34, 4, 0.4) })
</script>`
const dir = mkdtempSync(join(tmpdir(), "bonez-mark-"))
writeFileSync(join(dir, "mark.html"), page)
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const dom = execFileSync(chrome, ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--dump-dom", `file://${join(dir, "mark.html")}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
const art = JSON.parse(/<pre id="out">(.*)<\/pre>/s.exec(dom)[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))
// At four rows the e's crossbar falls across two subpixels and fills its counter; drawn by hand as one.
art.wordmark[2] = art.wordmark[2].replace("▐████▌", "▐█▀▀▀▘")

if (flag === "--sh") {
  const oct = (s) => [...Buffer.from(s)].map((b) => (b < 128 ? String.fromCharCode(b) : `\\${b.toString(8)}`)).join("")
  for (const [name, lines] of Object.entries(art)) console.log(`${name}:\n${lines.map((l) => `  '${oct(l)}'`).join("\n")}`)
} else {
  console.log(JSON.stringify(art, null, 2))
}
