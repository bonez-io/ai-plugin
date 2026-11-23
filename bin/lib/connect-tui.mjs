// The installer's terminal view (1SI-4098): what `connect` prints while it waits for the person in the
// browser, and the demo that plays the whole installer, install.sh's part included, with fake timing
// (`connect --demo [mark|wordmark]`).
//
// Bonez's look, as in libs/ui/DESIGN.md §2 of bonez-core: ink and paper, sentence case, colour only for
// state. Titles are bold, everything secondary is dim, and only the marks are coloured: ✓ green (done),
// ✗ red (failed), the spinner yellow (working), · and – grey (to do, skipped). Words and the Bonez mark are
// never coloured. Everything sits on one left margin and stays inside the terminal's width.
//
// It degrades on its own: with no terminal (a pipe, a log, CI) or TERM=dumb there is no spinner, no
// redraw and no escape code, only plain lines; NO_COLOR drops the colour and keeps the spinner. A
// Windows console that is not Windows Terminal gets ASCII marks and the word "bonez" for the mark.
// Links are OSC 8 hyperlinks only in terminals known to show them; elsewhere the URL is printed whole.

const ESC = "\x1b["

// The Bonez wordmark, the mark and "bonez" (`Logo` in bonez-core libs/ui/src/components/logo.tsx, viewBox
// 0 0 154 34), drawn in quadrant blocks by scripts/terminal-mark.mjs from its SVG paths, 4 rows tall (at 3 its
// letters do not read). Regenerate with that script when the logo changes, and copy the --sh form into install.sh.
export const WORDMARK = [
  "▝▀▙▄▟▛▘ ▐▌",
  "▗█▀ ▀█▖ ▐█▀▀▜▄ ▟▛▀▜▄▗█▞▀▜▙▗▟▀▀█▖▀▀▀█▌",
  "▝▜▄ ▄▛▘ ▐▌   █▐█   █▐█  ▐█▐█▀▀▀▘ ▄▛▘",
  "▗▟▀ ▀▙▖ ▐█▄▄▟▀ ▜▙▄▟▀▝█  ▐█▝▜▄▄▟▘▟█▄▄▖",
]
export const SUBTITLE = "Connecting your coding tools"

const LINK_TERMINALS = new Set(["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "Tabby", "rio"])

export function terminalCaps({ stream = process.stdout, env = process.env, platform = process.platform } = {}) {
  const tty = Boolean(stream?.isTTY) && env.TERM !== "dumb" && !env.CI
  const unicode = platform !== "win32" || Boolean(env.WT_SESSION || env.TERM_PROGRAM)
  const links =
    tty &&
    (LINK_TERMINALS.has(env.TERM_PROGRAM) ||
      Boolean(env.WT_SESSION || env.KONSOLE_VERSION) ||
      /kitty/.test(env.TERM ?? "") ||
      Number(env.VTE_VERSION) >= 5000)
  return {
    live: tty,
    color: tty && env.NO_COLOR === undefined,
    unicode,
    links,
    width: Math.max(60, Math.min(Number(stream?.columns) || Number(env.COLUMNS) || 80, 120)),
  }
}

const GLYPHS = {
  unicode: { done: "✓", failed: "✗", skipped: "–", todo: "·", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], full: "━", empty: "─", box: ["╭", "╮", "╰", "╯", "─", "│"], ellipsis: "…", sep: "›", out: "↗", to: "→" },
  ascii: { done: "+", failed: "x", skipped: "-", todo: ".", spinner: ["|", "/", "-", "\\"], full: "=", empty: "-", box: ["+", "+", "+", "+", "-", "|"], ellipsis: "...", sep: ">", out: "", to: "->" },
}

// Visible length: escape codes (SGR, OSC 8) take no room.
const strip = (s) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
const visible = (s) => [...strip(s)].length

// Word wrap of plain text to `width`.
function wrap(text, width) {
  const out = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  out.push(line)
  return out
}

const NAME_W = 12
const STATE_W = 10
const M = "  " // the one left margin

export function createView({ out = process.stdout, err = process.stderr, caps = terminalCaps({ stream: out }) } = {}) {
  const g = caps.unicode ? GLYPHS.unicode : GLYPHS.ascii
  const sgr = (code, s) => (caps.color ? `${ESC}${code}m${s}${ESC}0m` : s)
  const st = {
    bold: (s) => sgr("1", s),
    dim: (s) => sgr("2", s),
    green: (s) => sgr("32", s),
    red: (s) => sgr("31", s),
    yellow: (s) => sgr("33", s),
    grey: (s) => sgr("90", s),
  }
  const mark = { done: st.green(g.done), failed: st.red(g.failed), skipped: st.grey(g.skipped), todo: st.grey(g.todo) }
  const link = (label, url) => (caps.links ? `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\` : undefined)
  out.on?.("error", () => {}) // a closed pipe or terminal: stop drawing, never crash
  let live // { text: () => string } while a live line is on screen
  let timer
  let frame = 0
  let drawn = false

  const write = (s) => {
    try {
      out.write(s)
    } catch {
      /* a closed terminal: nothing to draw on */
    }
  }
  const clearLive = () => {
    if (drawn) write(`\r${ESC}2K`)
    drawn = false
  }
  const drawLive = () => {
    if (!live || !caps.live) return
    write(`\r${ESC}2K${live.text()}`)
    drawn = true
  }
  // A permanent line: under a live line, it takes the live line's place and the live line comes back under it.
  const line = (s = "") => {
    clearLive()
    write(`${s}\n`)
    drawLive()
  }
  const spinner = () => st.yellow(g.spinner[frame % g.spinner.length])

  const startLive = (textFn) => {
    live = { text: textFn }
    if (!caps.live) return
    if (!timer) {
      write(`${ESC}?25l`) // hide the cursor while the spinner turns
      timer = setInterval(() => {
        frame++
        drawLive()
      }, 80)
      timer.unref?.()
    }
    drawLive()
  }
  const stopLive = () => {
    clearLive()
    live = undefined
    if (timer) {
      clearInterval(timer)
      timer = undefined
      write(`${ESC}?25h`)
    }
  }

  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
  }
  const bar = (done, total, width) => {
    const n = total ? Math.round((done / total) * width) : 0
    return `${g.full.repeat(n)}${st.dim(g.empty.repeat(width - n))}`
  }
  // The panel's width; a status line's detail ends where the panel does.
  const panelW = () => Math.min(caps.width - M.length * 2, 76)
  // A status line with its dim detail at the right, under the panel's right edge.
  const status = (lead, text, right) => {
    const left = `${M}${lead} ${text}`
    if (!right) return left
    const gap = Math.max(2, M.length + panelW() - visible(left) - visible(right))
    return `${left}${" ".repeat(gap)}${st.dim(right)}`
  }

  // A rounded panel: a bold title in its top edge, rows of plain text wrapped to fit. A row is
  // [prefix, text, style]; a wrapped row hangs under its text, not its prefix.
  function panel(title, rows) {
    const inner = panelW() - 2
    const textW = inner - 4
    const [tl, tr, bl, br, h, v] = g.box
    // Plain output (a log, a pipe) gets the words without the frame.
    if (!caps.live) {
      const plain = [title]
      for (const [prefix = "", text = ""] of rows) {
        const pw = visible(prefix)
        wrap(text, textW - pw).forEach((p, i) => plain.push(p ? `${i === 0 ? prefix : " ".repeat(pw)}${p}` : ""))
      }
      return plain
    }
    const lines = [`${tl}${h} ${st.bold(title)} ${h.repeat(Math.max(1, inner - title.length - 3))}${tr}`, `${v}${" ".repeat(inner)}${v}`]
    for (const [prefix = "", text = "", style = (s) => s] of rows) {
      const pw = visible(prefix)
      wrap(text, textW - pw).forEach((p, i) => {
        const lead = i === 0 ? prefix : " ".repeat(pw)
        // A URL is a link where the terminal has them (the escapes take no room).
        const body = /^https?:\/\//.test(p) ? (link(style(p), p) ?? style(p)) : style(p)
        lines.push(`${v}  ${lead}${body}${" ".repeat(Math.max(0, textW - pw - p.length))}  ${v}`)
      })
    }
    lines.push(`${v}${" ".repeat(inner)}${v}`, `${bl}${h.repeat(inner)}${br}`)
    return lines
  }

  const view = {
    caps,
    st,
    mark,
    line,
    blank: () => line(""),

    // install.sh draws this itself; the demo draws it here, the same way: the wordmark in ink, the dim line under it.
    header() {
      line()
      if (!caps.unicode) {
        line(`${M}${st.bold("bonez")}  ${st.dim(SUBTITLE)}`)
      } else {
        for (const row of WORDMARK) line(`${M}${row}`)
        line()
        line(`${M}${st.dim(SUBTITLE)}`)
      }
      line()
    },

    // One tool: mark, name, state, and what to do next, dim, in columns. A next step too long for the width
    // goes under the state; details (a failure's own words) go under the name.
    tool(state, name, word, next, details = []) {
      const head = `${M}${mark[state]} ${name.padEnd(NAME_W)}  ${word.padEnd(STATE_W)}`
      const nextText = next ? st.dim(next) : ""
      if (!next) line(head.trimEnd())
      else if (visible(head) + 1 + visible(nextText) <= caps.width) line(`${head} ${nextText}`)
      else {
        line(head.trimEnd())
        line(`${" ".repeat(M.length + 2 + NAME_W + 2)}${nextText}`)
      }
      for (const d of [].concat(details)) line(`${M}  ${st.dim(d)}`)
    },
    // The Claude app is optional: one dim line, a link to the prefilled connector where the terminal has links,
    // else the place to add it, short enough for 80 columns.
    claudeApp(url) {
      const linked = link(`Optional: add Bonez to the Claude app ${g.out}`.trim(), url)
      line(`${M}${mark.todo} ${st.dim(linked ?? `Optional: Claude app ${g.to} claude.ai/customize/connectors`)}`)
    },
    // As install.sh draws it: a still yellow dot (a POSIX shell has no spinner), replaced by the result.
    toolWorking(name) {
      if (!caps.live) return
      clearLive()
      write(`${M}${st.yellow(g.todo)} ${name.padEnd(NAME_W)}  ${st.dim(`adding${g.ellipsis}`)}`)
      drawn = true
    },

    // "Finish in your browser": the steps, and why the terminal should stay open, in one panel.
    finish({ joining, url, opened }) {
      const first = joining
        ? "Continue in the Bonez page you started from"
        : opened
          ? "Sign in on the Bonez page that just opened"
          : "Open the Bonez page below and sign in"
      const steps = [first, "Sign in to Bonez in each tool when it asks", "Choose whether Bonez saves your sessions"]
      const rows = steps.map((s, i) => [`${st.bold(String(i + 1))}  `, s])
      // The page's link under step 1, inside the panel when it fits; a link where the terminal has them.
      const textW = panelW() - 6 - 3
      const showUrl = !joining && url
      const urlInside = showUrl && url.length <= textW
      if (urlInside) rows.splice(1, 0, ["   ", url, opened ? st.dim : (s) => s])
      rows.push([], ["", "Keep this terminal open.", st.bold], ["", "It finishes setup when you answer in the browser."])
      rows.push(["", "Closing it is safe: it finishes the next time you use a coding tool.", st.dim])
      line()
      for (const r of panel("Finish in your browser", rows)) line(`${M}${r}`)
      if (showUrl && !urlInside) line(`${M}${url}`)
      line()
    },

    // The loader while the browser is away: spinner, words, and the time waited and left, dim.
    waiting(text, expiresAt) {
      if (!caps.live) return line(`${M}${mark.todo} ${text}`)
      const t0 = Date.now()
      startLive(() => {
        const left = expiresAt ? ` · ${Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000))} min left` : ""
        return status(spinner(), text, `${clock(Date.now() - t0)}${left}`)
      })
    },
    done(text, detail) {
      line(`${M}${mark.done} ${text}${detail ? `  ${st.dim(detail)}` : ""}`)
    },
    skipped(text, detail) {
      line(`${M}${mark.skipped} ${text}${detail ? `  ${st.dim(detail)}` : ""}`)
    },
    note(text) {
      line(`${M}  ${st.dim(text)}`)
    },
    // A failure ends the run: on a terminal it is a ✗ line; otherwise the bare words on stderr.
    fail(text) {
      stopLive()
      if (caps.live) write(`${M}${mark.failed} ${text}\n`)
      else {
        try {
          err.write(`${text}\n`)
        } catch {
          /* nowhere to say it */
        }
      }
    },
    // Adding the recent sessions: a thin bar and the count. Plain output gets the result line only.
    progress(done, total) {
      startLive(() => {
        const count = `${done} of ${total}`
        const label = "Adding recent sessions"
        // The bar runs to the panel's right edge, the count last.
        const barW = Math.max(10, panelW() - 2 - label.length - 2 - 2 - count.length)
        return `${M}${spinner()} ${label}  ${bar(done, total, barW)}  ${st.dim(count)}`
      })
    },
    stopLive,
    // Stop the spinner where it is and keep the line (the demo's screenshots).
    freeze() {
      if (timer) clearInterval(timer)
      timer = undefined
      if (drawn) write("\n")
      drawn = false
      live = undefined
      if (caps.live) write(`${ESC}?25h`)
    },
    allSet(text = "You can close this terminal and the setup page.") {
      stopLive()
      line()
      line(`${M}${st.bold("All set.")} ${st.dim(text)}`)
      line()
    },
    close: stopLive,
  }
  return view
}

// ------------------------------------------------------------------------------------------- demo

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

export const CLAUDE_CONNECTOR_DEMO_URL =
  "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Bonez&connectorUrl=https%3A%2F%2Fgateway.bonez.io%2Fmcp"

// Plays the whole installer, install.sh's rows included, with fake timing. No network, no file, no tool is
// touched. `until` stops at one stage and leaves it on screen (for screenshots): adding, tools, waiting,
// signin, backfill, done.
export async function playDemo({ until, speed = 1, joining = false, out = process.stdout, caps } = {}) {
  const view = createView({ out, ...(caps && { caps }) })
  const g = view.caps.unicode ? GLYPHS.unicode : GLYPHS.ascii
  const t = (ms) => pause(ms / speed)
  const stopAt = async (stage) => {
    if (until !== stage) return false
    await t(1200)
    view.freeze()
    return true
  }
  view.header()
  // install.sh's rows, word for word.
  const tools = [
    ["Claude Code", "added", `Next: /mcp ${g.sep} bonez ${g.sep} Authenticate`],
    ["Codex", "added", "Signed in"],
    ["Cursor", "added", `Next: reload, then MCPs ${g.sep} bonez ${g.sep} Authenticate`],
  ]
  for (const [name, word, next] of tools) {
    view.toolWorking(name)
    if (name === "Cursor" && (await stopAt("adding"))) return
    await t(700)
    view.tool("done", name, word, next)
  }
  view.tool("skipped", "OpenCode", view.st.dim("not found"))
  view.claudeApp(CLAUDE_CONNECTOR_DEMO_URL)
  if (await stopAt("tools")) return

  const expiresAt = Date.now() + 30 * 60_000
  view.finish({ joining, url: "https://app.bonez.io/settings/connect-tools?pair=K7QM-4XPA", opened: !joining })
  view.waiting(`Waiting for you in the browser${g.ellipsis}`, expiresAt)
  if (until === "waiting") await t(2400) // a few seconds on the clock
  if (await stopAt("waiting")) return
  await t(1800)
  if (!joining) view.done("Signed in to Bonez in the browser")
  for (const name of ["Claude Code", "Cursor"]) {
    await t(900)
    view.done(`${name} signed in`)
  }
  if (await stopAt("signin")) return
  await t(1200)
  view.done("Session saving is on")
  const total = 37
  for (let i = 0; i <= total; i++) {
    view.progress(i, total)
    if (until === "backfill" && i === 23) {
      await stopAt("backfill")
      return
    }
    await t(70)
  }
  view.stopLive()
  view.done(`Added ${total} recent sessions`, "from the last 14 days")
  view.allSet()
  if (until === "done") await t(400)
  view.close()
}
